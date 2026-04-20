# Compaction 深度对比: Claude Code vs Pi

> 源码对照:
> - Claude Code: `src/services/compact/` (11 files, ~4000 LOC)
> - Pi: `packages/coding-agent/src/core/compaction/`（4 files: `compaction.ts`、`branch-summarization.ts`、`utils.ts`、`index.ts`）

## 架构总览

### Claude Code: 4 层压缩管线

```
API 调用前管线 (query.ts 中每次请求前执行):
┌──────────────────────────────────────────────────────────────────────┐
│ 1. Tool result budget          截断单个工具结果到字节上限            │
│ 2. History Snip                删除旧消息 (feature-gated)           │
│ 3. MicroCompact                清除旧工具结果 (两条路径)             │
│ 4. Context Collapse            语义折叠 (feature-gated, 替代 AC)    │
│ 5. AutoCompact                 完整 LLM 总结                       │
└──────────────────────────────────────────────────────────────────────┘

阶段 3 (MicroCompact) 内部分两条路径:
┌──────────────────────────────┐ ┌──────────────────────────────────┐
│ Time-based MC (cache 已冷)   │ │ Cached MC (cache 热)             │
│ - 直接修改消息 content       │ │ - 不修改本地消息                 │
│ - 替换为占位符文本           │ │ - 通过 API cache_edits 指令      │
│ - 已破坏 cache，不影响      │ │ - 服务端从 KV cache 删除内容     │
│ 优先判断, 短路后续路径      │ │ - 需要 Anthropic API beta 支持   │
└──────────────────────────────┘ └──────────────────────────────────┘

阶段 5 (AutoCompact) 内部先尝试:
┌──────────────────────────────┐ ┌──────────────────────────────────┐
│ Session Memory Compact       │ │ Full Compact (传统 LLM 总结)     │
│ - 使用预构建的会话记忆       │ │ - forked agent 执行              │
│ - 不调用 LLM                 │ │ - PreCompact → 总结 → PostCompact│
│ - 修剪到 minTokens~maxTokens │ │ - 补水: 文件/skills/plan/MCP    │
└──────────────────────────────┘ └──────────────────────────────────┘
```

### Pi: 单层压缩

```
自动压缩由 `AgentSession._checkCompaction()` 负责（在 `agent_end` 后或发送新用户消息前调用）:
┌──────────────────────────────────────────────────────────────────────┐
│ shouldCompact(contextTokens, contextWindow, settings)?               │
│    │                                                                 │
│    └── AgentSession.compact()                                        │
│         ├── session_before_compact 事件 → 扩展可取消/自定义            │
│         │                                                             │
│         ├── prepareCompaction()                                       │
│         │   ├── 找上一次 compaction 位置                               │
│         │   ├── findCutPoint() → 保留 keepRecentTokens                │
│         │   ├── 分割 messagesToSummarize / turnPrefixMessages          │
│         │   └── extractFileOperations()                               │
│         │                                                             │
│         ├── compact()                                                 │
│         │   ├── generateSummary() → LLM 调用 (`await completeSimple`) │
│         │   ├── generateTurnPrefixSummary() (并行, 如果 split turn)    │
│         │   └── formatFileOperations() → 追加到 summary               │
│         │                                                             │
│         └── SessionManager.appendCompaction()                         │
│             └── 追加 compaction 条目, 保留旧消息但不再发给 LLM         │
└──────────────────────────────────────────────────────────────────────┘
```

## 逐维度对比

### 1. 触发机制

| 维度 | Claude Code | Pi |
|------|------------|-----|
| **自动触发条件** | `tokens > contextWindow - maxOutput(20K) - 13K` | `tokens > contextWindow - reserveTokens(16K)` |
| **手动触发** | `/compact` 命令 (3K buffer) | `/compact`、`AgentSession.compact()`、RPC `compact` |
| **MicroCompact 触发** | 每次 API 调用前; time-based + count-based | 无 |
| **熔断器** | 3 次连续失败后停止自动压缩 | 无 |
| **递归守卫** | `querySource` 为 `session_memory`/`compact`/`marble_origami` 时跳过 | 无 (单层无递归风险) |
| **环境变量覆盖** | `DISABLE_COMPACT`, `DISABLE_AUTO_COMPACT`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `CompactionSettings.enabled` |
| **告警阶梯** | warning (-20K), error (-20K), auto-compact (-13K), blocking (-3K) | 无告警系统 |
| **Partial compact** | `partialCompactConversation()` — 从指定消息前/后压缩 | 无 |

**Claude Code 的阈值计算 (`autoCompact.ts`)**:

```
effectiveContextWindow = contextWindow - min(maxOutputTokens, 20000)
autoCompactThreshold   = effectiveContextWindow - 13000

例: Sonnet 4, 200K context, 16K max output:
  effective = 200000 - 16000 = 184000
  threshold = 184000 - 13000 = 171000
  → 当 token 用量超过 171K 时自动压缩
```

**Pi 的阈值计算 (`compaction.ts`)**:

```
shouldCompact = contextTokens > contextWindow - reserveTokens

例: 200K context, reserveTokens = 16384:
  threshold = 200000 - 16384 = 183616
  → 当 token 用量超过 ~184K 时触发压缩
```

Pi 的阈值实际上更接近上限 — 没有额外的 buffer layer。

### 2. Token 估算

| 维度 | Claude Code | Pi |
|------|------------|-----|
| **基础算法** | `roughTokenCountEstimation()` — chars/4 | `estimateTokens()` — chars/4 |
| **填充系数** | MicroCompact 用 4/3 倍保守填充 | 无填充 |
| **图片 / 非文本附件估算** | 固定 2000 tokens | `image` block 固定 +4800 chars（PDF 在这条估算路径里没有单独分支） |
| **实际用量参考** | `tokenCountWithEstimation()` — 优先使用 API 返回的 `usage`, 回退估算 | `estimateContextTokens()` — 优先使用最后一个 assistant message 的 usage, 回退估算 |
| **thinking block** | 计算 thinking text, 不计 signature/wrapper | `estimateTokens()` 会把 `thinking` 文本长度计入估算 |

两者都采用类似策略: 优先用 API 返回的实际 token 数, 对于尚未发送的消息用启发式估算。
Pi 对图片使用更高的字符估算（4800 chars，折合约 1200 tokens）；这条逻辑针对 `image` block，本身不等于“Pi 对 PDF 也有同样的专门估算分支”。

### 3. 切割点算法

#### Claude Code: API-round 分组 (`grouping.ts`)

```
分组规则:
  - 按 assistant message ID 分界
  - 同一个 API 轮次的所有消息 (user, assistant, tool_result) 在同一组
  - 分界点: 新的 assistant message ID 出现时
  - 允许 malformed 输入 (dangling tool_use), ensureToolResultPairing 修复

截断规则:
  - truncateHeadForPTLRetry(): 按组从最旧开始删除
  - 计算需要删除多少 token (从 PTL 错误中解析), 或 fallback 删 20%
  - 保证至少保留 1 组
  - 如果删后首条是 assistant, 插入 synthetic user marker

额外保护:
  - adjustIndexToPreserveAPIInvariants(): 不孤立 thinking, 不拆 tool_use/result
  - 消息不可变: normalizeMessagesForAPI() + clone-before-yield
```

#### Pi: 反向遍历 + 有效切割位置 (`compaction.ts`)

```
切割规则:
  合法切割位置: user, assistant, custom, branchSummary, compactionSummary, bashExecution
  不合法: toolResult (不能在 tool_use 和 result 之间切)

算法:
  1. 预计算所有合法切割位置 (findValidCutPoints)
  2. 从最新消息往回走, 累积 token (只计 type === "message" 的条目)
  3. 累积 ≥ keepRecentTokens(20K) 时, 找最近的合法切割位置
  4. 边界滑动: 包含紧邻的非消息条目 (thinking_level_change, model_change)
  5. Split turn 检测: 切在非 user 消息处时, findTurnStartIndex 找 turn 起始
```

**关键差异**: Claude Code 按 API-round 分组 (粗粒度, 但 prompt cache 友好); Pi 按单条消息粒度寻找切割位置 (更精确, 但没有 cache 对齐考虑)。

### 4. 总结生成

#### Claude Code (`compact.ts` + `prompt.ts`)

```
模型选择:
  - forked agent 执行 (独立上下文, 不影响主线程)
  - 使用 cacheSafeParams 复用主对话的 prompt cache
  - maxTurns: 1, 禁止工具调用 (NO_TOOLS_PREAMBLE)

Prompt 结构 (prompt.ts):
  NO_TOOLS_PREAMBLE (强制纯文本响应)
  + DETAILED_ANALYSIS_INSTRUCTION (分析步骤)
  + BASE_COMPACT_PROMPT (输出格式):
    1. Primary Request and Intent
    2. Key Technical Concepts
    3. Files and Code Sections (含完整代码片段)
    4. Errors and fixes
    5. Problem Solving
    6. All user messages (逐条列出)
    7. Pending Tasks
    8. Current Work (含文件名和代码)
    9. Optional Next Step (含原文引用)

  输出包裹: <analysis>...</analysis> + <summary>...</summary>
  后处理: formatCompactSummary() 剥离 <analysis> 草稿, 只保留 <summary>

预处理:
  - stripImagesFromMessages(): 替换图片为 [image] 占位符
  - stripReinjectedAttachments(): 移除 skill_discovery/skill_listing

错误恢复:
  - PTL (prompt_too_long) → 最多重试 3 次, 每次删最旧 API-round 组
  - 流式响应失败 → 最多重试 2 次
  - forked agent 返回空 → 回退到流式路径
```

#### Pi (`compaction.ts`)

```
模型选择:
  - 直接使用 completeSimple() (pi-ai 层)
  - 使用与主对话相同的模型和 API key
  - 推理模型复用当前 session 的 `thinkingLevel`
    - 只有 `thinkingLevel` 已设置且不为 `off` 时，才会传 `reasoning: thinkingLevel`
    - `generateSummary()` 和 `generateTurnPrefixSummary()` 都遵循这条规则

Prompt 结构:
  SUMMARIZATION_SYSTEM_PROMPT (系统提示, 定义角色)
  + SUMMARIZATION_PROMPT / UPDATE_SUMMARIZATION_PROMPT:
    1. Goal
    2. Constraints & Preferences
    3. Progress (Done / In Progress / Blocked)
    4. Key Decisions
    5. Next Steps
    6. Critical Context

  更新规则 (迭代压缩):
    - 保留已有信息
    - 添加新进展/决策
    - In Progress → Done
    - 保留文件路径、函数名、错误消息

Split turn 处理:
  - TURN_PREFIX_SUMMARIZATION_PROMPT: 简化的上下文摘要
  - 与主摘要并行生成
  - 合并: summary + "---" + "Turn Context (split turn)" + turnPrefixSummary

预处理:
  - convertToLlm() + serializeConversation(): 转为纯文本
  - 图片不会作为原始附件继续传给总结模型；`serializeConversation` 只保留可序列化的文本内容
```

**关键差异**:

| 维度 | Claude Code | Pi |
|------|------------|-----|
| **执行方式** | forked agent (独立进程) | `await completeSimple(...)`（非流式单次调用） |
| **草稿剥离** | `<analysis>` + `<summary>` 两段式 | 无草稿段 |
| **摘要详细度** | 9 个分节, 含代码片段和原文引用 | 6 个分节, 更简洁 |
| **PTL 恢复** | 3 次重试, 渐进截断 | 无 PTL 恢复 |
| **图片处理** | 替换为 [image] | 不做 Claude 那种占位符替换；总结输入里只保留序列化后的文本内容 |
| **Cache 复用** | forked agent 复用主对话 cache prefix | 无 cache 复用 |

### 5. MicroCompact (Claude Code 独有)

> 源码: `src/services/compact/microCompact.ts`, `cachedMicrocompact.ts`, `timeBasedMCConfig.ts`

Pi 没有 MicroCompact 层。这是 Claude Code 最显著的 compaction 优势之一。

#### 设计目标

在不进行完整 LLM 总结的情况下, 释放工具结果占用的 token。长对话中 Read/Bash/Grep 等工具的输出累积迅速, 但旧的工具结果对当前任务价值递减。

#### 可压缩工具集

```typescript
const COMPACTABLE_TOOLS = new Set([
  FILE_READ_TOOL_NAME,   // Read
  ...SHELL_TOOL_NAMES,   // Bash variants
  GREP_TOOL_NAME,        // Grep
  GLOB_TOOL_NAME,        // Glob
  WEB_SEARCH_TOOL_NAME,  // WebSearch
  WEB_FETCH_TOOL_NAME,   // WebFetch
  FILE_EDIT_TOOL_NAME,   // Edit
  FILE_WRITE_TOOL_NAME,  // Write
])
```

注意: Agent Tool 和 MCP 工具的结果**不被 MicroCompact 处理**。只有内置的 coding agent 工具在白名单中。

#### 两条路径

**路径 1: Time-based MicroCompact**

```
检查条件: 距上次 assistant 响应时间 > 阈值 (GrowthBook 配置)
判定: cache 已冷 (过期) → 直接修改消息内容更高效

执行:
  1. 收集所有 COMPACTABLE_TOOLS 的 tool_result
  2. 保留最近 N 个 tool_result
  3. 将超出的 tool_result 内容替换为 TIME_BASED_MC_CLEARED_MESSAGE
     ("[Old tool result content cleared]")
  4. 修改后的消息返回给 API
  
优先级: 先于 Cached MC 检查, 命中则短路
```

**路径 2: Cached MicroCompact (cache_edits)**

```
前提: feature('CACHED_MICROCOMPACT') 开启
      + 模型支持 cache editing
      + querySource 是主线程 (不是 sub-agent)

执行:
  1. 收集所有 COMPACTABLE_TOOLS 的 tool_use ID
  2. 注册到 CachedMCState (跟踪哪些已发送过 API)
  3. getToolResultsToDelete() 决定删除哪些
  4. 创建 cache_edits block:
     {
       type: 'cache_edits',
       edits: [{ type: 'delete', cache_reference: 'toolu_xxx' }]
     }
  5. 将 cache_edits 插入最后一条 user message 的 content
  6. API 响应返回 cache_deleted_input_tokens (累积值)

状态管理:
  - registeredTools: 已注册的 tool IDs
  - sentToAPITools: 已发送过 API 的 tool IDs (只删已发送的)
  - pinnedEdits: 之前发送的 cache_edits, 必须每次请求重新发送
  - baselineCacheDeletedTokens: 上次的累积删除量, 用于计算 delta

关键约束:
  - cache_edits 只作用于 Anthropic 1P API (Bedrock/Vertex 不支持)
  - 模型层面: isModelSupportedForCacheEditing() 检查
  - 只处理主线程, 避免 sub-agent 污染全局状态
  - 本地消息不修改 (只在 API 层添加 cache_reference 和 cache_edits)
```

#### Pi 的替代方案

Pi 没有 MicroCompact, 工具结果一直保留到 Full Compact 触发。这意味着:
- 长对话中工具结果快速占满 context window
- 没有 "渐进释放" 机制, 只有 "全量压缩" 的跳变
- 没有 prompt cache 友好的工具结果清理

### 6. Session Memory Compact (Claude Code 独有)

> 源码: `src/services/compact/sessionMemoryCompact.ts`

#### 工作原理

```
触发: autoCompactIfNeeded() → 先尝试 Session Memory, 失败后再 Full Compact

条件检查:
  1. Session Memory 文件存在且非空
  2. 修剪后的 token 数 < 自动压缩阈值
  3. 至少保留 minTextBlockMessages(5) 条有文本的消息

执行:
  1. 读取 session memory 内容 (从 CLAUDE.local.md 或 MEMORY.md)
  2. truncateSessionMemoryForCompact(): 截断到 maxTokens(40K) 以内
  3. 找到上一次已总结的消息 ID (getLastSummarizedMessageId)
  4. 从该消息往后, 保留 minTokens(10K) ~ maxTokens(40K) 的消息
  5. 构建: boundaryMarker + session memory 作为 summary + 保留的消息
  6. 执行 SessionStart hooks
  7. 不调用 LLM — 速度快, 成本为零

配置 (默认):
  minTokens:            10,000
  minTextBlockMessages:      5
  maxTokens:            40,000
```

#### 与 Full Compact 的关系

```
autoCompactIfNeeded():
  ├── trySessionMemoryCompaction()  ← 先试这个 (快, 免费)
  │   └── 成功? → 返回 (不执行 Full Compact)
  │
  └── compactConversation()         ← SM 失败后 fallback
      └── forked agent 执行完整 LLM 总结
```

Pi 没有这个中间层。每次都是完整 LLM 总结, 有延迟和成本。

### 7. 补水机制 (Post-compact Rehydration)

#### Claude Code (`compact.ts` L532-584)

```
压缩完成后立即执行, 将关键上下文重新注入:

1. 文件内容 (fileAttachments):
   - 从 preCompactReadFileState 获取最近读取的文件
   - 用 FileReadTool 重新读取最多 5 个文件
   - 每个文件最多 5,000 tokens
   - 总预算 50,000 tokens
   - 使用 generateFileAttachment() 创建附件

2. Skills 内容:
   - 从 invoked skills 列表获取已使用的 skills
   - 每个 skill 最多 5,000 tokens
   - Skills 总预算 25,000 tokens

3. Plan 状态:
   - 从 getPlan() 读取当前活跃的计划文件
   - 注入 plan 附件

4. Plan Mode:
   - 如果当前在 plan mode, 重新注入 plan mode 指令

5. Deferred tools delta:
   - 重新公告已发现的延迟加载工具
   - diff 对空列表 → 完整公告

6. Agent listing delta:
   - 重新公告已知的子 agent

7. MCP instructions delta:
   - 重新公告 MCP 服务器指令

8. SessionStart hooks:
   - 执行 session start 钩子 (允许扩展注入自定义上下文)

9. Session metadata:
   - 重新追加会话标题等元数据到 JSONL 尾部 16KB 窗口

10. Discovered tool names:
    - 保留已发现的 deferred tool 名称到 boundary marker
```

#### Pi: 无补水

Pi 在 compact 后只有:
1. CompactionSummary (LLM 生成的摘要)
2. 保留的最近消息
3. 文件操作列表 (附在摘要末尾, 但不重新读取文件内容)

模型在 compact 后必须重新读取所有需要的文件。这增加了 compact 后的 "恢复时间"。

### 8. Hook 系统集成

| 维度 | Claude Code | Pi |
|------|------------|-----|
| **Pre-compact hook** | `executePreCompactHooks()` — 允许提供自定义指令和用户可见消息 | `session_before_compact` 事件 — 允许取消 (`cancel()`) 或自定义压缩 |
| **Post-compact hook** | `executePostCompactHooks()` — 允许提供用户可见消息 | `session_compact` 事件 — 通知压缩完成 |
| **SessionStart hook** | compact 后执行, 允许注入上下文 | 无 (compact 不触发 session_start) |
| **扩展生成的压缩** | 无 | `fromHook` 标记区分 core vs extension 生成的压缩/分支摘要 |

**Pi 的扩展点更灵活**: 扩展可以通过 `session_before_compact` 完全替代内置压缩逻辑, 或通过 `fromHook` 标记提供独立的压缩/分支摘要。Claude Code 的 hook 只能追加/修改指令, 不能替代整个压缩流程。

### 9. 迭代压缩

#### Claude Code

```
第二次 compact 时:
  1. 之前的 compact summary 作为上下文传给 forked agent
  2. 没有显式的 "update prompt" — 整个对话 (含之前的 summary) 被重新总结
  3. compact boundary marker 包含 compactMetadata:
     - preCompactTokenCount
     - trigger ('auto' / 'manual')
     - preservedSegment (用于 partial compact 的消息保留链)
     - preCompactDiscoveredTools
```

#### Pi

```
第二次 compact 时:
  1. 找到上一次 compaction 条目, 提取 previousSummary
  2. 使用 UPDATE_SUMMARIZATION_PROMPT (而非 SUMMARIZATION_PROMPT)
  3. 更新规则:
     - 保留已有信息
     - 添加新进展
     - In Progress → Done
     - 更新 Next Steps
     - 保留精确引用 (路径、函数名、错误信息)
  4. 文件操作从 previous compaction 的 details 继承
```

**Pi 的显式更新 prompt 是个优势**: 明确告诉 LLM 如何合并新旧摘要, 而不是依赖模型自行推断。Claude Code 因为使用 forked agent 且无更新 prompt, 可能在迭代压缩时丢失旧摘要的细节。

### 10. 分支/树结构的压缩

#### Claude Code

Claude Code 的消息是**扁平数组** (由 JSONL 加载后线性化), 没有原生的树形结构。分支通过 compact boundary 的 `preservedSegment` 和 `parentUuid` 链实现。Partial compact (`up_to`/`from`) 是手动选择消息范围的压缩方式。

#### Pi

Pi 有原生的**树形 session** (`SessionManager`), 支持:
- `branch()`: 移动 leafId
- `branchWithSummary()`: 分支 + 生成分支摘要
- `createBranchedSession()`: 从分支创建独立 session
- `collectEntriesForBranchSummary()`: 收集分支差异
- `generateBranchSummary()`: LLM 总结分支上下文 (独立于 compaction)

**Pi 的分支摘要系统与 compaction 是正交的**: compaction 压缩时间维度 (旧消息), branch summary 压缩空间维度 (其他分支的上下文)。两者的文件操作追踪独立但格式统一。

### 11. 错误恢复

| 维度 | Claude Code | Pi |
|------|------------|-----|
| **PTL (prompt too long)** | 最多 3 次重试, 每次删最旧 API-round 组, fallback 删 20% | 无 PTL 恢复 |
| **流式失败** | `MAX_COMPACT_STREAMING_RETRIES = 2` | 无重试 |
| **LLM 返回空** | 记录 `tengu_compact_failed`, 抛出错误 | `stopReason === "error"` 时抛出 |
| **用户中止** | `APIUserAbortError` 检查, 不计入熔断器 | signal?.aborted 检查 |
| **熔断器** | 3 次连续失败后停止自动压缩 | 无 |
| **forked agent 失败** | 回退到流式路径 | N/A (不用 forked agent) |
| **Context overflow 恢复** | `_overflowRecoveryAttempted` 防止死循环 | `_overflowRecoveryAttempted` 防止死循环 |

### 12. 清理与状态重置

#### Claude Code (`postCompactCleanup.ts`)

Compact 完成后执行全面的状态清理:

```
runPostCompactCleanup(querySource):
  1. resetMicrocompactState()         ← MC 状态清零
  2. resetContextCollapse()           ← 上下文折叠状态清零 (主线程)
  3. getUserContext.cache.clear()     ← memoized 上下文缓存清零 (主线程)
  4. resetGetMemoryFilesCache()       ← CLAUDE.md 文件缓存清零 (主线程)
  5. clearSystemPromptSections()      ← 系统提示分节缓存
  6. clearClassifierApprovals()       ← 权限分类器审批缓存
  7. clearSpeculativeChecks()         ← bash 推测检查缓存
  8. clearBetaTracingState()          ← 遥测追踪状态
  9. sweepFileContentCache()          ← commit attribution 文件缓存
  10. clearSessionMessagesCache()     ← session 消息缓存

注意:
  - 不重置 sentSkillNames (skill 内容需跨多次 compact 保留)
  - 主线程/子线程区分: querySource 判断, 防止 sub-agent compact 破坏主线程状态
```

#### Pi

Pi 的 compact 后没有显式的缓存清理步骤。compact 通过修改 session 文件中的 firstKeptEntryId 来标记哪些消息已被压缩, `buildSessionContext()` 在下次构建上下文时自然跳过被压缩的消息。

### 13. 遥测与可观测性

| 维度 | Claude Code | Pi |
|------|------------|-----|
| **事件** | `tengu_compact`, `tengu_compact_failed`, `tengu_compact_ptl_retry`, `tengu_cached_microcompact` | 无遥测 |
| **指标** | preCompactTokenCount, postCompactTokenCount, truePostCompactTokenCount, compactionInputTokens, compactionOutputTokens, cache 命中率, isRecompactionInChain | 无指标 |
| **Cache break 检测** | `notifyCompaction()` → 重置 cache read baseline, 防止误报 | 无 |
| **上下文分析** | `analyzeContext(messages)` → 详细 token 分布统计 | 无 |
| **重压缩追踪** | `RecompactionInfo`: isRecompactionInChain, turnsSincePreviousCompact, previousCompactTurnId | 无 |

## 总结: 关键差异

```
                    Claude Code                      Pi
                    ───────────                      ──
复杂度              11 files, ~4000 LOC              4 files（含 branch summary 辅助模块）
层次                4 层 (MC → Snip → AC → CC)       1 层 (Full Compact)
MicroCompact        ✔ (time-based + cached MC)       ✘
Session Memory      ✔ (无 LLM, 即时)                 ✘
补水                ✔ (5 文件 + skills + plan + MCP)  ✘
PTL 恢复            ✔ (3 次重试 + 截断)              ✘
熔断器              ✔ (3 次连续失败停止)              ✘
迭代更新 prompt     ✘ (依赖模型理解)                  ✔ (显式 UPDATE_SUMMARIZATION_PROMPT)
分支摘要            ✘ (扁平消息 + partial compact)    ✔ (原生树形 + branch summary)
扩展可替代          ✘ (hook 只能追加)                 ✔ (session_before_compact 可取消/替代)
Prompt cache 感知   ✔ (核心设计目标)                  ✘
遥测                ✔ (详细事件和指标)                ✘
Provider 锁定       ✔ (cache_edits 限 Anthropic)      ✘ (provider 中立)
```

## 对 Pi 的改进建议 (按 Pi 哲学)

基于 Pi "minimal core + extensions" 的设计哲学:

### 适合纳入核心

1. **熔断器** (低难度, 高价值): 在 `_checkCompaction()` / 自动压缩路径中添加连续压缩失败计数, 3 次后停止自动触发。防止无限循环。
2. **PTL 恢复** (中难度, 高价值): `generateSummary()` 中如果 LLM 报 prompt_too_long, 截断最旧消息后重试。
3. **token 估算填充** (低难度, 中价值): `estimateTokens()` 结果乘 4/3, 减少因低估导致的意外 overflow。

### 适合作为扩展实现

4. **MicroCompact 扩展** (中难度, 高价值): 通过 `session_before_compact` 或新的 `turn_end` 事件, 扩展清理旧工具结果。不需要 cache_edits (那是 Anthropic 专属), 简单替换内容即可。
5. **补水扩展** (中难度, 高价值): 在 `session_compact` 事件中, 扩展重新读取 CompactionDetails.modifiedFiles 的内容, 注入为 custom_message。
6. **Session Memory 扩展** (中难度, 中价值): 通过 `session_before_compact` 实现无 LLM 的快速压缩路径, 使用预存的会话摘要。

### 不适合纳入 (Claude Code 专属)

- **cache_edits**: 绑定 Anthropic API beta, 违反 Pi 的 provider 中立原则。
- **Context Collapse**: 实验性 feature-gated, 复杂度高, 与 autocompact 互斥。
- **forked agent 压缩**: Pi 无 forked agent 机制, completeSimple 已足够。
- **详细遥测**: Pi 倾向简洁, 可通过扩展按需添加。
