# Claude Code vs Pi Mono: 深度对比分析报告

## 一、项目概述

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **全称** | Claude Code (Anthropic Terminal CLI) | Pi Coding Agent |
| **定位** | Anthropic 官方终端编码代理 | 开源终端编码代理框架 |
| **语言** | TypeScript (Bun runtime) | TypeScript (Node.js runtime) |
| **许可** | 源码镜像（非官方发布） | MIT |
| **架构** | 单体应用 | npm monorepo (7个包) |
| **UI框架** | React + Ink (终端UI) | 自研 pi-tui (差分渲染) |
| **LLM支持** | Anthropic 单一提供商 | 多提供商 (OpenAI, Anthropic, Google, Bedrock, Mistral 等) |
| **构建工具** | Bun bundler + feature flags | tsgo (TypeScript native preview) + Vitest |
| **包管理** | Bun | npm workspaces |

---

## 二、架构层次对比

### Claude Code: 单体架构

```
┌─────────────────────────────────────────────┐
│  CLI Entry (main.tsx)                        │
│  ├─ Commander.js 参数解析                    │
│  ├─ OAuth/Keychain 认证                      │
│  ├─ GrowthBook 特性开关                      │
│  └─ React + Ink REPL 启动                    │
├─────────────────────────────────────────────┤
│  QueryEngine → query() loop                  │
│  ├─ 系统/用户上下文注入                       │
│  ├─ 流式模型调用 (Anthropic API)              │
│  ├─ StreamingToolExecutor (边流边执行)         │
│  ├─ 自动压缩 (autocompact)                    │
│  └─ Token 预算管理                            │
├─────────────────────────────────────────────┤
│  Tools Layer                                 │
│  ├─ 内置工具 (File/Bash/Search/...)          │
│  ├─ MCP 工具                                 │
│  └─ 插件/技能系统                             │
├─────────────────────────────────────────────┤
│  Services                                    │
│  ├─ API (claude.ts)                          │
│  ├─ Compact (压缩)                           │
│  ├─ Session (JSONL transcript)               │
│  ├─ Bridge (IDE集成)                          │
│  ├─ Coordinator (多代理)                      │
│  └─ Analytics/Telemetry                      │
└─────────────────────────────────────────────┘
```

### Pi Mono: 分层 Monorepo 架构

```
┌─────────────────────────────────────────────┐
│  pi-coding-agent (CLI Layer)                 │
│  ├─ main.ts 参数解析                         │
│  ├─ AgentSession (会话管理)                   │
│  ├─ ExtensionRunner (扩展系统)                │
│  ├─ Interactive / Print / RPC 模式            │
│  └─ Settings / Themes / Skills               │
├─────────────────────────────────────────────┤
│  pi-agent-core (Agent Runtime)               │
│  ├─ Agent 类 (状态 + 事件)                    │
│  ├─ agentLoop / agentLoopContinue            │
│  ├─ 工具调度 (顺序/并行)                      │
│  └─ 消息队列 (steering / follow-up)           │
├─────────────────────────────────────────────┤
│  pi-ai (LLM Abstraction)                     │
│  ├─ stream / streamSimple / complete         │
│  ├─ Provider 注册表                           │
│  ├─ 多提供商实现                              │
│  └─ EventStream 异步队列                      │
├─────────────────────────────────────────────┤
│  pi-tui (Terminal UI)                        │
│  └─ 差分渲染引擎                              │
├─────────────────────────────────────────────┤
│  其他包: pi-mom, pi-web-ui, pi-pods          │
└─────────────────────────────────────────────┘
```

**关键差异：** Claude Code 是深度耦合的单体应用，所有组件共享同一进程上下文；Pi Mono 采用清晰的三层分离（AI → Agent → Coding Agent），每层可独立使用和测试。

---

## 三、核心循环（Agent Loop）深度对比

### 3.1 Claude Code 的 `queryLoop`

**入口：** `query()` → `queryLoop()` — 一个 `while(true)` 驱动的迭代循环。

**每轮前处理（模型调用前）：**
1. `getMessagesAfterCompactBoundary(messages)` — 仅取压缩边界后的消息
2. `applyToolResultBudget` — 限制工具结果总大小
3. `HISTORY_SNIP` — 可选的历史裁剪
4. `microcompact` — 微型压缩/缓存编辑路径
5. `CONTEXT_COLLAPSE` — 上下文折叠（替换整个消息视图）
6. `autocompact` — 主动压缩（基于 token 计数阈值）

**模型调用：**
- 带有回退机制的内循环：`FallbackTriggeredError` 触发模型切换
- 流式处理同时启动 `StreamingToolExecutor`
- 特殊错误"扣留"机制（prompt-too-long 等不立即抛出）

**工具执行后续：**
- 收集 `StreamingToolExecutor` 的剩余结果 **或** 同步执行 `runTools()`
- 工具摘要生成、附件消息、记忆预取
- 状态累积：`messages = [...messagesForQuery, ...assistantMessages, ...toolResults]`

**终止条件：**
- 无工具调用时：检查错误恢复、停止钩子、Token 预算、最终返回 `completed`
- 有工具调用时：执行工具后进入下一轮

### 3.2 Pi Mono 的 `agentLoop`

**入口：** `agentLoop()` → `runLoop()` — 双层 `while(true)` 嵌套。

**外层循环：** 检查 `getFollowUpMessages()` 是否有后续消息需要处理
**内层循环：** `hasMoreToolCalls || pendingMessages.length > 0`

**每轮流程：**
1. `getSteeringMessages()` — 获取注入消息（steering queue）
2. `streamAssistantResponse()`:
   - `transformContext(messages)` — 可选上下文变换
   - `convertToLlm(messages)` — 转换为 LLM 格式
   - 构建 `Context`，调用 `streamFn ?? streamSimple`
   - 流式状态机：`start` → 创建占位 → 增量更新 → `done`/`error` 终结
3. 工具执行：`executeToolCalls()` 生成 `ToolResultMessage[]`
4. `turn_end` 事件 + 循环继续判断

**关键差异对比：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **循环结构** | 单层 while + 复杂状态机 | 双层 while（外层follow-up，内层tool-call） |
| **压缩触发** | 内置于循环前处理（5种策略） | 外置于 AgentSession（`_checkCompaction`） |
| **流式工具执行** | 有（StreamingToolExecutor 边流边执行） | 无（等待完整 assistant message 后执行） |
| **消息注入** | 系统级（system prompt + user context） | 运行时注入（steering + follow-up 队列） |
| **错误恢复** | 内置多策略（PTL恢复、模型回退、max_output升级） | 外置于 AgentSession（auto-retry + backoff） |
| **回退模型** | 循环内 FallbackTriggeredError → 切换模型 | 无内置回退 |
| **Token 预算** | 一等公民（taskBudget 跨压缩持续跟踪） | 无内置 token 预算管理 |

---

## 四、工具执行机制对比

### 4.1 Claude Code 的工具执行

**两种路径：**

**A. 非流式路径 — `runTools()`（toolOrchestration.ts）**

分区算法 `partitionToolCalls`:
- 连续的 `isConcurrencySafe` 工具合并为一个并发批次
- 非安全工具独占一个批次
- 结果：`[safe, safe, unsafe, safe, safe]` → `[[safe, safe], [unsafe], [safe, safe]]`

并发执行 `runToolsConcurrently`:
- 使用 `all()` 生成器工具函数，限制最大并发数（默认10）
- `Promise.race` 按完成顺序 yield（非工具顺序）
- 上下文修改器（contextModifier）在整个批次完成后按工具顺序应用

**B. 流式路径 — `StreamingToolExecutor`**

核心设计：**工具在模型流式输出的同时就开始执行**。

调度器 `canExecuteTool`:
```
无执行中工具 → 可以启动
新工具并发安全 AND 所有执行中工具并发安全 → 可以启动
否则 → 排队等待
```

执行器 `executeTool`:
- 子 AbortController 继承自 sibling controller
- Bash 工具错误触发 `siblingAbortController.abort('sibling_error')` — 兄弟工具取消
- 非并发安全工具的上下文修改器立即应用

结果产出 `getCompletedResults`:
- **严格顺序**：按队列顺序 yield，遇到正在执行的串行工具就 break
- 效果：并行安全工具的结果可能乱序完成但按序产出

### 4.2 Pi Mono 的工具执行

**单一路径 — `executeToolCalls()`（agent-loop.ts）**

配置驱动：`config.toolExecution === "sequential"` 决定模式

**顺序模式：** 严格 `for` 循环，一个接一个

**并行模式：**
1. 预处理阶段（顺序）：所有工具调用依次经过 `prepareToolCall` + `validateToolArguments` + `beforeToolCall`
2. 执行阶段（并行）：`Promise` map 并行执行所有已准备的工具
3. 终结阶段（顺序）：按原始顺序执行 `afterToolCall` + 事件发射

**关键差异：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **流式执行** | 支持（模型输出同时执行工具） | 不支持（等待完整消息后执行） |
| **并发控制** | 基于工具安全性标记 (`isConcurrencySafe`) | 全局配置开关 (`sequential` vs 并行) |
| **最大并发** | 可配置（默认10） | 无上限（所有工具并行） |
| **兄弟取消** | Bash错误取消兄弟工具 | 无兄弟取消机制 |
| **结果顺序** | 严格按队列顺序产出 | 并行执行但按序终结 |
| **上下文修改** | 区分并发/串行两种策略 | 无上下文修改器概念 |
| **分批策略** | 自动分批（连续安全→合并） | 不分批（全部一起或全部串行） |

---

## 五、权限系统对比

### Claude Code: 多层权限管道

```
Tool 调用 → hasPermissionsToUseTool() → allow/deny/ask
                                          │
              ┌───────────────────────────┴──────────┐
              │ allow: 规则匹配（always allow 列表） │
              │ deny: 规则匹配（always deny 列表）   │
              │ ask: 需要交互确认                     │
              └──────────────┬───────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │ Interactive → UI Prompt      │
              │ Coordinator → 协调器决策      │
              │ Swarm Worker → 工作节点决策   │
              │ Bridge → IDE 通道回调         │
              └──────────────┬──────────────┘
                             │
              Bash 分类器竞速（可选）
              文件系统权限检查（readPermission）
              ToolPermissionContext（mode, rules, bypass）
```

**权限规则来源：**
- 用户设置（`PermissionsSchema`）
- 项目设置
- 企业 MDM 管理策略
- 运行时 defaultMode（plan/auto 等）

### Pi Mono: 极简主义哲学

**无内置权限 UI。** 设计哲学明确：用容器或扩展来处理安全。

```
Tool 调用 → beforeToolCall Hook → { block: true, reason } | undefined
                                    │
                                    └── ExtensionRunner.emitToolCall()
                                         └── 扩展决定是否阻止
```

**核心机制：** `beforeToolCall` 返回 `{ block: true, reason }` → 转为错误工具结果 → 模型看到错误后调整行为。

**关键差异：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **设计哲学** | 内置安全第一 | 容器/扩展负责安全 |
| **权限层级** | 用户/项目/企业三级 | 无内置层级 |
| **交互确认** | 内置 UI 提示 | 无（扩展可实现） |
| **Bash 分类** | AI 分类器判断命令安全性 | 无 |
| **文件权限** | 读写分别检查 | 无 |
| **模式切换** | plan/auto/ask 模式 | 无 |
| **MDM 支持** | 企业管理策略 | 无 |
| **bypass** | 可配置 bypass 规则 | 无 |

---

## 六、上下文管理与压缩对比

### Claude Code: 五层压缩策略

1. **History Snip** — 裁剪历史，释放 token，记录释放量
2. **Microcompact** — 利用 `cache_deleted_input_tokens` 差值的微型压缩
3. **Context Collapse** — `applyCollapsesIfNeeded` 替换整个消息视图
4. **Autocompact** — 主动压缩（基于 token 计数阈值），使用分叉代理生成摘要
5. **Reactive Compact** — 被动压缩（PTL 错误触发时的应急压缩）

**压缩实现 (`compactConversation`)：**
- `tokenCountWithEstimation` 计算预压缩 token 数
- `streamCompactSummary` 使用分叉代理（`runForkedAgent`）或直接流式调用
- PTL（Prompt Too Long）重试：`truncateHeadForPTLRetry` 按 API 轮次分组丢弃头部
- 压缩后重建文件状态快照、清除缓存、重新声明延迟工具
- 前后压缩钩子（`preCompact` / `postCompact`）

**Task Budget 跨压缩追踪：**
```
taskBudgetRemaining -= finalContextTokensFromLastResponse(messagesForQuery)
// 压缩后 remaining 继续从上次消耗处计算
```

### Pi Mono: 外置式压缩

压缩不在 `agentLoop` 内部，而是在 `AgentSession._checkCompaction` 中：
- 检查时机：`agent_end` 事件时
- 使用 `transformContext` 可选钩子（在每次 LLM 调用前）
- 会话级别的压缩条目记录在 `SessionManager` 中

**关键差异：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **压缩策略数** | 5种（snip, micro, collapse, auto, reactive） | 1种（会话级检查） |
| **触发位置** | 循环内置 | 循环外（AgentSession 事件处理） |
| **分叉代理** | 用独立代理生成摘要 | 无 |
| **PTL 恢复** | 内置多次重试 + 头部截断 | 无 |
| **缓存感知** | 利用 prompt cache 差值做微型压缩 | 无 |
| **Token 预算** | 跨压缩持续追踪 | 无 |
| **钩子** | 前后压缩钩子 | 无 |

---

## 七、LLM API 交互对比

### Claude Code

**单一提供商，深度集成：**
- `queryModelWithStreaming` / `queryModelWithoutStreaming`
- Beta headers 管理（thinking, prompt cache, task budgets）
- `accumulateUsage` / 成本跟踪
- `getAPIProvider` 提供商检测
- 配额/速率限制处理（`claudeAiLimits`）
- `withRetry` 重试逻辑
- `withStreamingVCR` 测试录制/回放
- `releaseStreamResources` 流资源清理

**Beta 特性：**
- Thinking (extended thinking)
- Prompt caching
- Task budgets
- Structured outputs
- Deferred tool search
- Advisor mode

### Pi Mono

**多提供商抽象层：**
```typescript
// pi-ai 统一接口
stream(model, context, options)     // 完整事件流
streamSimple(model, context, opts)  // 简化流
complete(model, context, options)   // 非流式
```

**Provider 注册表模式：**
- `getApiProvider(model.api).stream(...)` — 按模型名路由到具体提供商
- 每个提供商独立实现（OpenAI, Anthropic, Google, Bedrock, Mistral 等）
- `register-builtins.js` 副作用注册

**EventStream 通用异步队列：**
- `AssistantMessageEventStream` — 流事件标准化
- `result()` 方法获取最终消息
- 统一错误处理（`done` / `error` 事件）

**关键差异：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **提供商** | 仅 Anthropic | 多提供商 (5+) |
| **API 深度** | 深度集成 Beta 特性 | 标准 API 调用 |
| **缓存** | Prompt caching 一等支持 | 无 |
| **成本追踪** | 内置 usage 累积 | 无内置 |
| **测试** | VCR 录制/回放 | 无（但有 Vitest） |
| **抽象层** | 无（直接调用 SDK） | 三层抽象（stream → provider → SDK） |
| **OAuth** | 内置 Anthropic OAuth | `pi-ai/oauth` 模块 |

---

## 八、会话管理对比

### Claude Code

- **存储格式：** JSONL transcript
- **位置：** 会话目录（IDE bridge 或本地）
- **功能：**
  - `isTranscriptMessage` 类型过滤
  - 写入时刷新
  - 恢复/加载
  - 大小限制（50MB 重写保护）
  - 墓碑消息（tombstone）
  - `sessionIngress` 集成
  - `MACRO.VERSION` 版本标记

### Pi Mono

- **存储格式：** JSONL
- **位置：** `~/.pi/agent/sessions/`（按工作目录组织）
- **功能：**
  - 树状结构（`id` / `parentId`）支持分支
  - `SessionManager` 实现加载/保存
  - CLI 参数：`--continue`, `--resume`, `--session`, `--fork`, `--no-session`, `--session-dir`
  - 压缩条目记录

**关键差异：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **分支** | 无明确分支 | 树状分支（parentId） |
| **恢复模式** | resume | continue/resume/fork |
| **版本追踪** | 编译时 MACRO | 无 |
| **IDE 集成** | Bridge 协议 | 无（纯 CLI） |

---

## 九、扩展/插件系统对比

### Claude Code

**三层扩展：**
1. **Bundled Skills** (`src/skills/bundled/`) — 内置技能
2. **Plugins** (`src/plugins/`, `src/utils/plugins/`) — 用户可切换的插件
3. **MCP** — Model Context Protocol 服务器工具

**当前状态：** `initBuiltinPlugins()` 目前是空壳（"No built-in plugins registered yet"），但基础设施完整。

**其他扩展点：**
- Hooks（preCompact, postCompact, sessionStart 等）
- Commands（斜杠命令）
- Bridge protocol（IDE 集成）
- Coordinator mode（多代理协调）

### Pi Mono

**TypeScript 扩展系统：**
```
加载路径:
  ~/.pi/agent/extensions/     (全局)
  .pi/extensions/             (项目)
  Pi packages (npm/git)       (包)
```

**扩展能力：**
- 工具定义（tools）
- 命令（commands）
- 按键绑定（keybindings）
- UI 组件
- 事件处理（tool_call, tool_result, input 等）
- 自定义压缩
- MCP 集成

**ExtensionRunner 机制：**
- `emitToolCall` — 工具调用前拦截
- `emitToolResult` — 工具结果后处理
- `_installAgentToolHooks()` 将 `beforeToolCall` / `afterToolCall` 转发到扩展

**关键差异：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **扩展模型** | Skills + Plugins + MCP | TypeScript Extensions + Packages |
| **加载方式** | 内置 + 缓存管理 | 文件系统约定 + npm |
| **工具拦截** | 权限系统处理 | beforeToolCall/afterToolCall 钩子 |
| **成熟度** | 框架完整但空壳 | 完整实现 + 示例 |
| **MCP** | 深度集成 | 扩展可提供 |

---

## 十、文件操作对比

### Claude Code — `FileReadTool`

- Zod schema 验证输入
- 路径扩展 + 安全检查（阻止设备路径）
- PDF/图片/Notebook 特殊处理
- 行范围读取
- `checkReadPermissionForTool` 权限检查
- 分析追踪

### Pi Mono — 内置工具集

**read.ts:**
- `resolveReadPath` 路径解析
- 图片：MIME 检测 → 可选 resize → 图像块
- 文本：完整缓冲 → 行切分 → offset/limit → `truncateHead`
- 引导消息（告知模型下一步 offset 或使用 bash）

**write.ts:**
- `withFileMutationQueue(absolutePath, ...)` — 按文件路径串行化写入
- `mkdir` + `writeFile`

**edit.ts:**
- `prepareEditArguments` 参数规范化
- `stripBom` → `detectLineEnding` → `normalizeToLF` → `applyEditsToNormalizedContent` → `restoreLineEndings`
- 成功消息含 diff 输出

**bash.ts:**
- `spawn(shell, [...args, command], { detached: true })`
- stdout/stderr 合并
- 滚动分块缓冲（`truncateTail`）用于流式进度
- 超过大小限制切换到临时文件
- 进程树 kill（timeout/abort）

**关键差异：**

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **写入串行化** | 未见明确队列 | `fileMutationQueue` 按路径串行 |
| **编辑算法** | 未深入分析 | BOM/行尾感知 + 规范化编辑 |
| **Bash 流式** | 工具结果整体返回 | 滚动缓冲分块更新 + 临时文件降级 |
| **图片处理** | 内置 | 内置（含 resize） |
| **PDF** | 内置 | 未见 |
| **权限检查** | 读/写分别检查 | 无 |

---

## 十一、错误处理对比

### Claude Code

**多层错误策略：**
1. **API 错误分类：** `categorizeRetryableAPIError` — 区分可重试/不可重试
2. **PTL 恢复：** 413 → contextCollapse → reactiveCompact → truncateHead
3. **模型回退：** `FallbackTriggeredError` → 切换到 fallbackModel
4. **Max Output 升级：** 动态增大 `maxOutputTokensOverride`
5. **工具错误：** 未知工具 → `tool_use_error` 合成消息
6. **速率限制：** `claudeAiLimits` 配额管理
7. **Withholding 机制：** 某些错误暂不 yield，在流结束后统一处理

### Pi Mono

**事件驱动错误处理：**
1. **LLM 流错误：** `stopReason === 'error'` / `'aborted'` → 发射事件后返回
2. **工具错误：** `execute` 抛出 → `isError: true` 工具结果
3. **验证错误：** schema 验证失败 → 立即错误结果
4. **自动重试：** `AgentSession._handleRetryableError` — 丢弃最后助手消息，指数退避后 `agent.continue()`
5. **Agent 层：** `runWithLifecycle` catch → 合成错误助手消息

---

## 十二、构建与测试对比

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **构建** | Bun bundler + `feature()` 死代码消除 | tsgo + npm workspace |
| **特性开关** | `bun:bundle` `feature('FLAG')` 编译时 | 无 |
| **Lint** | 未见配置（快照不完整） | Biome (tabs, width 120) |
| **测试框架** | Bun test（测试文件未包含） | Vitest |
| **测试覆盖** | 不明（快照无测试） | 全面（agent session, tools, extensions, modes） |
| **CI** | 不明 | `test.sh` 备份 auth、清除 API keys |

---

## 十三、独特机制对比

### Claude Code 独有

1. **StreamingToolExecutor** — 边流式输出边执行工具，极大减少延迟
2. **五层压缩策略** — 从微型到完整压缩的渐进式策略
3. **Prompt Cache 感知** — 利用 Anthropic cache delta 做微型压缩
4. **Task Budget** — 跨压缩的 token 预算持续追踪
5. **Bash 分类器** — AI 辅助判断命令安全性
6. **GrowthBook 特性开关** — 运行时特性标志
7. **Bridge Protocol** — IDE 双向通信协议
8. **Coordinator Mode** — 多代理协调（特性门控）
9. **MDM 企业管理** — 企业设备管理策略集成
10. **VCR 测试录制** — 流式 API 响应录制/回放

### Pi Mono 独有

1. **多提供商抽象** — 统一的 LLM 接口层，支持 5+ 提供商
2. **TypeScript 扩展系统** — 真正的代码级扩展，非配置驱动
3. **会话分支** — 树状结构支持 fork/分支
4. **Steering/Follow-up 队列** — 运行时消息注入机制
5. **FileMutationQueue** — 按文件路径串行化写入操作
6. **pi-tui 差分渲染** — 自研终端 UI 引擎
7. **pi-web-ui** — Web 组件支持
8. **Pi Packages** — npm/git 包分发扩展
9. **输出隔离（output-guard）** — stdout → stderr 重定向保护 TUI
10. **RPC 模式** — 机器通信接口

---

## 十四、设计哲学对比

| 维度 | Claude Code | Pi Mono |
|------|-------------|---------|
| **安全观** | 防御性（内置多层权限） | 信任性（容器/扩展负责） |
| **复杂度** | 高（单体、深耦合、多策略） | 适中（分层、解耦、组合） |
| **可扩展性** | 插件/MCP/技能（框架完整但内容少） | 扩展系统（完整实现 + 示例） |
| **LLM 绑定** | 深度绑定 Anthropic | 提供商无关 |
| **企业特性** | 完整（MDM, OAuth, 远程设置） | 无 |
| **开发者体验** | 专用工具（feature flags, VCR） | 标准工具链（Vitest, Biome, npm） |
| **性能优化** | 激进（流式工具、微压缩、缓存感知） | 保守（简单清晰优先） |
| **代码组织** | 功能聚合（单一 src/） | 关注点分离（独立包） |

---

## 十五、总结

**Claude Code** 是一个**高度工程化的商业产品**，其核心优势在于：
- 流式工具执行带来的延迟优化
- 多层压缩策略带来的长对话能力
- 深度集成 Anthropic API Beta 特性（prompt cache, task budget, thinking）
- 企业级权限和管理功能

但它也是一个**深度耦合的单体系统**，难以独立使用各个部分，且仅支持 Anthropic 作为 LLM 提供商。

**Pi Mono** 是一个**架构清晰的开源框架**，其核心优势在于：
- 三层分离的干净架构（可独立使用 pi-ai 或 pi-agent-core）
- 多 LLM 提供商支持
- 完整的 TypeScript 扩展系统
- 会话分支和 fork 能力
- 标准工具链和完整测试

但它在**性能优化和企业功能**方面不如 Claude Code：无流式工具执行、单一压缩策略、无内置权限系统、无 prompt cache 优化。

两者代表了 Coding Agent 设计的两种路线：**深度垂直集成** vs **水平通用框架**。
