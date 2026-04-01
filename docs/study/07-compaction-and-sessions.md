# Phase 4: 上下文压缩与会话管理

## 概述

当对话历史超出 LLM 上下文窗口时，pi 通过**上下文压缩**来保持对话继续。
同时，**会话管理**以树形结构存储对话，支持分支和导航。

## 上下文压缩系统

> **源码对照**: `packages/coding-agent/src/core/compaction/compaction.ts` — compact L715, findCutPoint L386, generateSummary L530

### 触发条件

```typescript
function shouldCompact(contextTokens, contextWindow, settings): boolean {
  if (!settings.enabled) return false
  return contextTokens > contextWindow - settings.reserveTokens
}
```

| 设置 | 默认值 | 含义 |
|------|--------|------|
| `enabled` | `true` | 是否启用压缩 |
| `reserveTokens` | `16384` | 预留给提示词和回复的 token |
| `keepRecentTokens` | `20000` | 保留多少近期 token 不压缩 |

**示例**: 128K 上下文窗口 → 当 contextTokens > 112K 时触发压缩。

### Token 估算

```
estimateTokens(message):
  - 基于 chars/4 启发式（每 4 字符约 1 token）
  - 不同角色分别计算:
    - user: 文本长度
    - assistant: 文本 + 推理 + 工具调用（名称 + JSON 参数）
    - toolResult: 文本块；图片固定 4800 字符（~1200 token）
    - bashExecution: 命令 + 输出
    - 摘要类型: 摘要文本长度

estimateContextTokens(messages):
  - 优先使用最后一个有 usage 的 assistant 消息的实际用量
  - 找不到 → 回退到对所有消息估算
  - 返回: { tokens, usageTokens, trailingTokens, lastUsageIndex }
```

### 压缩流程

```
                                检测
contextTokens > threshold?  ───→  是
       │
       ▼
prepareCompaction(pathEntries, settings)
       │
       ├── 1. 找到上一次压缩位置（boundaryStart）
       ├── 2. 估算 tokensBefore
       ├── 3. findCutPoint() → 确定保留哪些消息
       │      └── 从最新消息往回走
       │          累积 token 直到 keepRecentTokens
       │          在合法位置切割（不在 toolResult 中间）
       ├── 4. 分割消息:
       │      - messagesToSummarize: 要压缩的
       │      - turnPrefixMessages: 被切分的 turn 的前缀
       └── 5. 提取文件操作记录
       │
       ▼
compact(preparation)
       │
       ├── generateSummary(messagesToSummarize, previousSummary?)
       │   └── 发给 LLM，请求结构化摘要:
       │       ## Goal
       │       ## Constraints & Preferences
       │       ## Progress
       │       ### Done / In Progress / Blocked
       │       ## Key Decisions
       │       ## Next Steps
       │       ## Critical Context
       │
       ├── 如果有 turnPrefixMessages:
       │   └── generateSummary(turnPrefixMessages)
       │       → 合并到主摘要中
       │
       ├── 追加文件操作列表:
       │   <read-files>...</read-files>
       │   <modified-files>...</modified-files>
       │
       └── 返回 CompactionResult:
           { summary, firstKeptEntryId, tokensBefore, details }
       │
       ▼
SessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details)
       │
       └── 追加 compaction 条目到会话
           （旧条目保留在文件中，但不再参与 LLM 上下文）
```

### 切割点算法 (findCutPoint)

```
合法切割位置: user, assistant, custom, branchSummary, compactionSummary, bashExecution,
             branch_summary（条目类型）, custom_message（条目类型）
不合法: toolResult（不能在工具调用和结果之间切割）

算法:
1. 从最新消息往回走，累积 token
   重要: 只有 type === "message" 的条目贡献 token 计数
   branch_summary / custom_message 条目是合法切割点但不计入 token
2. 当累积 ≥ keepRecentTokens 时，在该位置或之后找最近的合法切割点
3. 边界滑动: 切割点可以向前滑动以包含紧邻的非消息条目
   （thinking_level_change, model_change），在遇到 compaction 或 message 时停止
4. 如果切在 turn 中间 → isSplitTurn
   findTurnStartIndex 找到 turn 起始点（user、bashExecution、branch_summary 或 custom_message）

Split turn 处理:
  一个 turn = user 消息 + assistant 回复 + 工具调用/结果
  如果切在非 user 消息处:
  - 历史消息 和 turn 前缀消息 分别范围化
  - compact() 可以并行生成 generateSummary 和 generateTurnPrefixSummary
  - 合并时使用 "Turn Context (split turn)" 分隔区段
```

### 文件操作追踪

压缩过程中追踪被操作的文件，持久化到 `CompactionResult.details`:

```
extractFileOperations(previousDetails, toolCalls):
  - 从前一次 pi 压缩的 details 继承累积的 readFiles/modifiedFiles
  - 从工具调用中提取新的文件操作
  - computeFileLists / formatFileOperations 格式化为:
    <read-files>...</read-files>
    <modified-files>...</modified-files>
  - details.readFiles / details.modifiedFiles 存入 CompactionResult

注意: 只有 !fromHook 的 pi 压缩的 details 才参与文件操作累积。
扩展 hook 生成的压缩的 details 不被合并。
```

### 迭代压缩

如果之前已经有过压缩，新的压缩不是从零开始：

```
第一次压缩:
  messages [1..50] → 生成 summary_1

第二次压缩:
  summary_1 + messages [30..80] → 生成 summary_2
  （使用 UPDATE_SUMMARIZATION_PROMPT）
  
  更新规则:
  - 保留之前摘要的内容
  - 添加新的进展/决策/上下文
  - 把 "In Progress" 的项移到 "Done"
  - 更新 "Next Steps"
  - 保留文件路径、函数名、错误消息

注意: prepareCompaction 如果发现路径上最后一个条目已经是 compaction，
返回 undefined 防止双重压缩。

推理模型使用 reasoning: "high"（如果支持）生成摘要。
```

### 分支摘要 (Branch Summarization)

当用户在会话树中导航到不同分支时：

```
collectEntriesForBranchSummary(session, oldLeafId, targetId):
  1. 找到两个分支的最深公共祖先
  2. 从 oldLeafId 回溯到公共祖先
  3. 收集这些条目（不在压缩边界处停止 — 压缩条目也包含在集合中）
  4. 反转为时间顺序

getMessageFromEntry(entry):
  - 跳过 toolResult（工具结果上下文通过 assistant 工具调用提供）
  - 处理 message, custom_message, branch_summary, compaction
  - 忽略 thinking/model/custom/label/session_info

prepareBranchEntries(entries, tokenBudget):
  第一遍: 从所有 branch_summary 条目（!fromHook）收集文件操作
  第二遍: 从最新到最旧遍历
    - 累积消息 token 直到 tokenBudget
    - compaction / branch_summary 条目可在 < 90% 预算时强制包含
      （优先保留摘要性上下文）

generateBranchSummary(entries, options):
  - tokenBudget = (model.contextWindow || 128000) - reserveTokens
  - reserveTokens 默认 16384（可通过 options.reserveTokens 覆盖）
  - 使用 BRANCH_SUMMARY_PROMPT
  - options.replaceInstructions=true + customInstructions: 替换默认提示词
  - 前缀: BRANCH_SUMMARY_PREAMBLE（"用户探索了另一个对话分支后回到了这里"）
  - 结构化摘要（Goal, Constraints, Progress, Decisions, Next Steps）
  - 固定 maxTokens: 2048
  - 追加文件操作列表（BranchSummaryDetails 格式）
```

### 压缩 vs 分支摘要的文件操作追踪

| | 压缩 | 分支摘要 |
|--|------|----------|
| **文件操作来源** | 工具调用 + 前一次 pi 压缩 details | 工具调用 + 前一次 pi branch_summary details |
| **fromHook 过滤** | 跳过 hook 压缩的 details | 跳过 hook 分支摘要的 details |
| **存储位置** | CompactionResult.details | BranchSummaryDetails |

## 会话管理系统

> **源码对照**: `packages/coding-agent/src/core/session-manager.ts` — SessionManager L664, appendMessage L829, getBranch L1029, branch L1120

### SessionEntry 类型

```
CURRENT_SESSION_VERSION = 3

迁移历史:
  v1 → v2: 添加 id，firstKeptEntryIndex → firstKeptEntryId
  v2 → v3: 消息角色 hookMessage → custom

SessionEntry 类型:
├── message          — AgentMessage（用户/助手/工具结果/自定义）
├── thinking_level_change — 思考级别变更
├── model_change     — 模型变更
├── compaction       — 压缩摘要（summary, firstKeptEntryId, tokensBefore, details?, fromHook?）
├── branch_summary   — 分支摘要（fromId, summary, details?, fromHook?）
├── custom           — 扩展状态（不发给 LLM）
├── custom_message   — 扩展消息（发给 LLM）
├── label            — 标签（标记重要位置）
└── session_info     — 会话名称等元数据

fromHook 标记:
  compaction 和 branch_summary 条目可标记 fromHook，
  表示由扩展 hook（而非 pi 核心）生成。
  fromHook 的 details 不参与文件操作的累积合并。
```

每个条目包含:
```typescript
interface SessionEntryBase {
  type: string
  id: string           // 唯一 ID
  parentId: string | null  // 父条目 ID（树形结构）
  timestamp: string
}
```

### 树形存储

```
条目在内存中以数组存储（fileEntries），通过 parentId 构成树:

                    root (user message)
                    /           \
            assistant_1      assistant_2  ← 两个分支
               |                 |
           toolResult_1     toolResult_2
               |                 |
            user_2            user_3
               |                 |
           assistant_3      assistant_4 ← leafId 指向当前分支的末端
```

**线性视图**: `getEntries()` = `fileEntries` 过滤掉 session header
**树形视图**: `getTree()` 通过 parentId 构建 `SessionTreeNode[]`
**分支视图**: `getBranch(leafId)` 从 leafId 回溯到 root

### 持久化

```
文件格式: JSONL（每行一个 JSON 对象）

位置: ~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<id>.jsonl

写入策略:
  - 追加模式（append-only）
  - 第一次写入: 全量写入所有条目
  - 后续写入: 只追加新条目
  - 保护: 至少有一个 assistant 消息后才开始写入
  - 使用 appendFileSync（同步写入）
```

**文件结构**:
```
行 1: {"type":"session","version":3,"id":"...","cwd":"/path","timestamp":"..."}
行 2: {"type":"message","id":"abc","parentId":null,"message":{...}}
行 3: {"type":"message","id":"def","parentId":"abc","message":{...}}
...
```

### 分支操作

```
branch(branchFromId):
  - 只移动 leafId 指针
  - 不创建新条目
  - 后续追加的条目以 branchFromId 为 parent

branchWithSummary(branchFromId, summary, details?, fromHook?):
  - 移动 leafId
  - 追加 branch_summary 条目（记录离开的分支的摘要）
  - 支持 fromId: "root"（当 branchFromId 为 null 时）
  - fromHook 标记区分扩展生成 vs pi 核心生成

createBranchedSession(leafId):
  - 从 root 到 leafId 提取路径
  - 创建新的 session 文件（线性化的分支）
  - parentSession 指向原文件

forkFrom(sourcePath, targetCwd):
  - 复制所有条目到新 cwd 的新 session
```

### 上下文构建 (buildSessionContext)

从 session 条目构建发给 LLM 的 `AgentMessage[]`:

```
解析 root → leaf 路径，追踪:
  - 最新的 thinking_level_change（影响 agent 配置，不发给 LLM）
  - 最新的 model_change（影响 agent 配置，不发给 LLM）
  - 路径上最后一个 compaction 条目

如果有 compaction:
  1. 输出 CompactionSummaryMessage（摘要）
  2. 保留的消息: 从 firstKeptEntryId 到 compaction 条目（不含）
     通过 appendMessage 处理 message / custom_message / branch_summary
  3. 从 compaction 条目之后到 leafId: 输出所有消息

如果没有 compaction:
  输出所有 message 类型条目的消息

如果 leafId === null:
  返回空 messages（导航到第一个条目"之前"的状态）
  
条目 → 消息映射:
  - message → AgentMessage
  - branch_summary → BranchSummaryMessage
  - custom_message → CustomMessage
  - compaction → CompactionSummaryMessage
  - thinking_level_change / model_change → 跳过（配置层面）
  - label / session_info / custom → 跳过
```

### 持久化数据模型

历史条目是**追加式**的：压缩不删除旧条目。`firstKeptEntryId` 控制哪些条目
对 LLM **可见**。`buildSessionContext` 根据此 ID 选择性输出消息。

### 并发安全

```
当前实现:
  - 所有持久化使用 appendFileSync（同步 I/O）
  - 没有文件级锁
  - 假设单进程单线程访问
  - 多个 pi 实例写同一个 session 文件 → 可能损坏

保护措施:
  - _compactionAbortController: 压缩期间如果有新的 turn 开始，中止压缩
  - _overflowRecoveryAttempted: 防止 overflow 恢复死循环

appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?):
  - 持久化压缩条目，支持扩展元数据和 hook 来源标记
```

## 完整数据流：消息到 LLM

```
用户输入 "fix the bug"
       │
       ▼
SessionManager.appendMessage(userMessage)
       │  parentId = 当前 leafId
       │  leafId = 新条目 ID
       │
       ▼
buildSessionContext(entries, leafId)
       │
       ├── 如果有 compaction:
       │   1. CompactionSummaryMessage
       │   2. 保留的消息
       │   3. 后续消息
       │
       └── AgentMessage[]
           │
           ▼
    convertToLlm(agentMessages)
           │
           ├── user → user
           ├── assistant → assistant
           ├── toolResult → toolResult
           ├── compactionSummary → user (含 <summary>)
           ├── branchSummary → user (含 <summary>)
           ├── bashExecution → user
           ├── custom → user
           │
           └── Message[]
               │
               ▼
        streamSimple(model, { messages, tools, systemPrompt })
               │
               └── LLM API
```
