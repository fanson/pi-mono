# 第三层: coding-agent — 编码工具层

## 职责

`@mariozechner/pi-coding-agent` 是 "pi" CLI 所在的层。它在 agent-core 基础上
提供文件编辑工具、bash 执行、扩展系统、会话管理、上下文压缩和交互式 TUI。
这是领域特定层。

## 关键源文件

| 文件 | 作用 |
|------|------|
| `src/main.ts` | CLI 入口：参数解析、迁移、模式选择 |
| `src/cli/args.ts` | CLI 参数定义和解析 |
| `src/modes/interactive/` | 交互式 TUI 模式（4000+ LOC） |
| `src/modes/rpc/` | RPC 模式：JSON stdin/stdout 协议 |
| `src/modes/print-mode.ts` | 单次执行模式：`pi -p "prompt"` |
| `src/core/sdk.ts` | `createAgentSession()` — 编程式入口 |
| `src/core/agent-session.ts` | 会话编排器：钩子、事件、持久化 |
| `src/core/agent-session-runtime.ts` | **AgentSessionRuntimeHost** — 管理 session 切换 (/new, /resume, /fork) |
| `src/core/messages.ts` | 自定义消息类型 + `convertToLlm()` |
| `src/core/system-prompt.ts` | 系统提示词构建 |
| `src/core/tools/` | 7 个工具：edit, bash, read, write, grep, find, ls |
| `src/core/tools/file-mutation-queue.ts` | `withFileMutationQueue` — 按文件路径串行化文件写操作 |
| `src/core/tools/render-utils.ts` | 共享 UI 渲染辅助（路径缩短、文本输出、图片占位） |
| `src/core/tools/tool-definition-wrapper.ts` | `wrapToolDefinition` — ToolDefinition → AgentTool 转换 |
| `src/core/extensions/` | 扩展加载、类型、运行器 |
| `src/core/compaction/` | 上下文窗口管理 |
| `src/core/session-manager.ts` | 会话持久化 |
| `src/core/settings-manager.ts` | 全局/项目配置管理 |
| `src/core/resource-loader.ts` | 统一加载扩展、skills、prompts、themes |
| `src/core/auth-storage.ts` | API key 和 OAuth 存储 |
| `src/core/model-registry.ts` | Provider 注册和自定义模型 |
| `src/core/skills.ts` | Skill 发现、验证、加载（含 SourceInfo） |
| `src/core/package-manager.ts` | 包安装/卸载/更新（含 PathMetadata） |
| `src/core/source-info.ts` | **SourceInfo** — 资源来源追踪（用户/项目/包/临时） |
| `src/core/output-guard.ts` | **stdout 接管** — RPC/print 模式下重定向 stdout → stderr |

## CLI 入口 (src/main.ts)

`main()` 是 pi 命令的入口函数。

> **源码**: `packages/coding-agent/src/main.ts` — main() L663

启动流程：

```
pi "fix the bug"
    │
    ▼
main(args)
  1. 离线模式检查（--offline → 设置 PI_OFFLINE）
  2. 早期命令处理:
     └── pi install/remove/update/list → 包管理命令，执行后退出
     └── pi config → 配置选择器，执行后退出
  3. 运行迁移（auth、sessions 格式升级）
  4. 第一次参数解析: parseArgs(args) → 获取 --extension 路径
  5. 加载资源: DefaultResourceLoader
     └── 扩展、skills、prompts、themes
     └── 注册扩展提供的 Provider
  6. 第二次参数解析: parseArgs(args, extensionFlags) → 含扩展标志
  7. 短路退出: --version / --help / --list-models / --export
  8. 读取 stdin（非 RPC 模式；如有管道输入则强制 print 模式）
  9. 创建 SessionManager（新建/继续/fork/恢复）
  10. buildSessionOptions() → 构建 CreateAgentSessionOptions
  11. createAgentSession(options) → 返回 AgentSession
  12. 选择运行模式:
      ├── mode === "rpc"    → runRpcMode(session)
      ├── print 模式        → runPrintMode(session, ...)
      └── 默认              → InteractiveMode → mode.run()
```

### CLI 参数 (src/cli/args.ts)

> **源码**: `packages/coding-agent/src/cli/args.ts` — parseArgs L56

| 参数组 | 示例 | 用途 |
|---|---|---|
| 模型 | `--provider anthropic --model sonnet` | 选择 LLM |
| 会话 | `--continue`, `--resume`, `--fork`, `--session ID` | 会话生命周期 |
| 工具 | `--tools edit,bash`, `--no-tools` | 控制可用工具 |
| 扩展 | `--extension path.ts`, `--no-extensions` | 扩展加载 |
| 输出 | `-p` (print), `--mode text\|json\|rpc` | 运行模式 |
| 思考 | `--thinking high` | Thinking level |
| 文件 | `@file.ts` | 附加文件到初始消息 |

**两次解析模式**: 第一次解析获取 `--extension` 路径，加载扩展后注册扩展标志，
第二次解析才能识别扩展定义的自定义 CLI 标志。

## 三种运行模式

### Interactive 模式（默认）

> **源码**: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — InteractiveMode L147

`InteractiveMode` 基于 `@mariozechner/pi-tui` 提供完整的终端 UI：

```
┌────────────────────────────────────┐
│  聊天区域（滚动历史）               │
│  ├── 用户消息                      │
│  ├── AI 回复（流式 Markdown 渲染） │
│  └── 工具执行状态                  │
├────────────────────────────────────┤
│  编辑器（多行输入）                 │
├────────────────────────────────────┤
│  状态栏（模型、token、快捷键）      │
└────────────────────────────────────┘
```

主循环：

```
while (true) {
  userInput = await getUserInput()   // 阻塞等待用户输入
  await session.prompt(userInput)    // 发送给 agent
  // agent 事件通过订阅自动更新 UI
}
```

支持：slash 命令（`/settings`、`/model`、`/fork`）、自动补全、快捷键、
session 切换、主题、扩展 UI 组件。

### Print 模式（单次执行）

> **源码**: `packages/coding-agent/src/modes/print-mode.ts` — runPrintMode L31

`pi -p "fix the bug"` 或管道输入时使用。

```
runPrintMode(session, options):
  1. 发送 initialMessage → session.prompt()
  2. 发送 options.messages（如果有多条）
  3. text 模式: 打印最后一条 assistant 消息的文本内容
     json 模式: 每个 AgentEvent 作为 JSON 行输出
  4. 退出
```

不启动 TUI，不进入交互循环。适用于脚本和自动化。

### RPC 模式

> **源码**: `packages/coding-agent/src/modes/rpc/rpc-mode.ts` — runRpcMode L46

`pi --mode rpc` 启动无头模式，通过 JSON Lines 在 stdin/stdout 上通信。

```
客户端 ──JSON 命令──→ stdin  ──→ pi 处理
客户端 ←──JSON 事件──  stdout ←── pi 响应
```

| 命令类别 | 示例 |
|---|---|
| 对话 | `prompt`, `steer`, `follow_up`, `abort` |
| 模型 | `set_model`, `cycle_model`, `get_available_models` |
| 会话 | `new_session`, `fork`, `switch_session`, `export_html` |
| 压缩 | `compact`, `set_auto_compaction` |
| 状态 | `get_state`, `get_messages` |

用于将 pi 嵌入其他应用程序（如 IDE 插件、Web UI）。
`RpcClient` 类提供 TypeScript SDK 封装 RPC 协议。

## AgentSession: 中心编排器

AgentSession 把所有组件连接在一起：

```
                    AgentSession
                    ┌──────────────────────┐
                    │                      │
   用户输入 ──────→│  prompt()            │
                    │    │                  │
                    │    ▼                  │
                    │  Agent.prompt()       │───→ agent-core 循环
                    │    │                  │
                    │    ▼                  │
                    │  _handleAgentEvent()  │←─── AgentEvent 事件流
                    │    │                  │
                    │    ├── 持久化到       │───→ SessionManager
                    │    │   会话存储       │
                    │    ├── 运行扩展       │───→ ExtensionRunner
                    │    │   钩子           │
                    │    ├── 自动压缩       │───→ Compaction
                    │    │   （上下文过大时）│
                    │    └── 出错时重试     │
                    │                      │
                    └──────────────────────┘
```

### 构建流程

> **源码**: `packages/coding-agent/src/core/sdk.ts` — createAgentSession L174

```
createAgentSession(options)                  ← sdk.ts
  1. 创建基础设施: SessionManager, SettingsManager, ModelRegistry, AuthStorage
  2. 创建 Agent:
     - convertToLlm: 含 blockImages 过滤（settings.getBlockImages() 时剥离图片内容）
     - transformContext: 委托给 extension "context" 钩子
     - getApiKey: 委托给 modelRegistry.getApiKeyAndHeaders
     - onPayload: 触发 extension "before_provider_request" 钩子
  3. 恢复会话（或初始化新会话）
  4. 创建 AgentSession（Agent 作为参数传入，不是由 AgentSession 创建）
     → _buildRuntime()
       → createAllTools(cwd)    // read, bash, edit, write, grep, find, ls
       → 加载已预载的扩展      // ResourceLoader 在 createAgentSession 中已加载
       → 创建 ExtensionRunner
       → 绑定钩子（beforeToolCall → emitToolCall, afterToolCall → emitToolResult）
       → 构建系统提示词
```

**注意**: Agent 实例由 `createAgentSession()` (在 `sdk.ts` 中) 创建并传给 AgentSession，
AgentSession 本身不负责 Agent 的构建。

### 钩子桥接

> **源码**: `packages/coding-agent/src/core/agent-session.ts` — AgentSession L232, steer L1138, _buildRuntime L318

AgentSession 把 agent-core 的钩子桥接到扩展系统：

```typescript
// AgentSession 构造时通过 AgentOptions 传入:
beforeToolCall: async ({ toolCall, args }) => {
  // 等待所有待处理的 agent 事件被处理完
  await this._agentEventQueue
  // 让扩展检查/阻止工具调用
  return await runner.emitToolCall({
    type: "tool_call",
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    input: args
  })
}
```

注意：v0.66+ 中 `beforeToolCall` 和 `afterToolCall` 不再通过 setter 方法设置
（旧 API: `agent.setBeforeToolCall()`），而是通过 `AgentOptions` 构造参数传入，
或直接赋值 `agent.beforeToolCall = ...`。

`_agentEventQueue` 确保 `SessionManager` 已经持久化了 assistant 消息，
然后再让扩展的 `tool_call` 处理器看到上下文。防止扩展看到不一致的状态。

## 自定义消息类型 (src/core/messages.ts)

### 声明合并

```typescript
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage
    custom: CustomMessage
    branchSummary: BranchSummaryMessage
    compactionSummary: CompactionSummaryMessage
  }
}
```

### convertToLlm 映射

> **源码**: `packages/coding-agent/src/core/messages.ts` — convertToLlm L148

| 自定义类型 | → LLM 消息 |
|---|---|
| `bashExecution` | `user` 消息（bashExecutionToText）；如果 `excludeFromContext`（`!!` 前缀）则跳过 |
| `custom` | `user` 消息（string 或 content 数组） |
| `branchSummary` | `user` 消息（包裹在 `<summary>...</summary>` 中） |
| `compactionSummary` | `user` 消息（包裹在 `<summary>...</summary>` 中） |
| `user/assistant/toolResult` | 直接传递不变 |
| 未知类型 | 过滤掉（返回 undefined） |

## 工具系统

### 默认工具集

> **源码**: `packages/coding-agent/src/core/tools/index.ts` — createCodingToolDefinitions L140, createCodingTools L170, createAllTools L183

```typescript
createCodingTools(cwd) 返回:
  - read(path, offset?, limit?)           — 读取文件内容（含图片）
  - bash(command, timeout?)               — 执行 shell 命令
  - edit(path, edits[{oldText, newText}]) — 精确文本替换（支持多处编辑）
  - write(path, content)                  — 创建/覆写文件

createAllTools(cwd) 额外包含:
  - grep(pattern, path?, limit?, context?)  — 搜索文件内容
  - find(pattern, path?)                     — 按 glob 查找文件
  - ls(path?)                                — 列出目录内容

工具架构现在采用 **Definition-first** 模式：
  - `create*ToolDefinition(cwd)` → 返回 `ToolDefinition`（含 prompt 元数据 + execute + 可选 render）
  - `create*Tool(cwd)` → 通过 `wrapToolDefinition()` 包装为 `AgentTool`
  - `ToolDefinition.execute` 签名: `(toolCallId, params, signal, onUpdate, ctx: ExtensionContext)`
```

### 可插拔操作模式

每个工具接受一个 operations 接口，用于测试和远程执行：

```
┌─────────────┐      ┌──────────────────┐      ┌───────────────┐
│  edit 工具   │ ───→ │  EditOperations  │ ───→ │  本地 fs      │
│              │      │  readFile()      │      │  （默认）      │
│  （逻辑）    │      │  writeFile()     │      └───────────────┘
│              │      │  access()        │
│              │      └──────────────────┘      ┌───────────────┐
│              │               或           ───→ │  SSH 远程     │
│              │                                │  （扩展提供）  │
└─────────────┘                                └───────────────┘
```

```typescript
// 默认: 本地文件系统
const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  access: (path) => fsAccess(path, R_OK | W_OK),
}

// 通过 options 覆盖:
createEditTool(cwd, { operations: remoteEditOps })
```

BashOperations、WriteOperations、ReadOperations、GrepOperations、FindOperations、LsOperations
都遵循相同的模式。

### 文件变更队列 (withFileMutationQueue)

> **源码**: `packages/coding-agent/src/core/tools/file-mutation-queue.ts`

`edit` 和 `write` 工具的文件写入操作通过 `withFileMutationQueue` 串行化，
解决了并行工具执行时的 TOCTOU 竞态条件。

```
withFileMutationQueue(absolutePath, fn):
  1. realpathSync.native(absolutePath) 归一化路径（失败则 resolve 回退）
  2. 获取或创建该规范路径的 Promise 链
  3. 链式等待前一个操作完成
  4. 执行 fn()
  5. 完成后释放（即使出错也释放）

特性:
  - 同一文件（规范路径）→ 串行化（FIFO 顺序）
  - 不同文件 → 完全并行
  - Promise 链模式（无 mutex/semaphore）
```

## 资源来源追踪 (src/core/source-info.ts)

所有可加载资源（扩展、工具、命令、skills、prompts、themes）现在携带 `SourceInfo`：

```typescript
type SourceScope = "user" | "project" | "temporary"
type SourceOrigin = "package" | "top-level"

interface SourceInfo {
  path: string          // 资源文件路径
  source: string        // 包源标识（如 "npm:@scope/pkg"）
  scope: SourceScope    // 作用域
  origin: SourceOrigin  // 来源类型
  baseDir?: string      // 资源所在的基础目录（可选）
}
```

`createSourceInfo(path, metadata)` 从路径和 `PackageManager` 的 `PathMetadata` 构建。
`createSyntheticSourceInfo(path, { source, scope?, origin?, baseDir? })` 用于测试和 SDK
（默认 scope = `"temporary"`, origin = `"top-level"`）。

这使得 UI 和日志能够显示每个资源的来源（包/顶层），
帮助用户理解哪些扩展和配置来自哪里。

## Stdout 保护 (src/core/output-guard.ts)

RPC 模式和 print 模式需要 stdout 用于结构化输出（JSON Lines）。
`output-guard.ts` 提供 `takeOverStdout()` 将 `process.stdout.write` 重定向到 stderr，
防止扩展或依赖库意外写入 stdout 污染输出。

```typescript
takeOverStdout()     // 替换 process.stdout.write → stderr
restoreStdout()      // 恢复原始行为
isStdoutTakenOver()  // 检查当前状态
writeRawStdout(data) // 绕过保护直接写入 stdout
flushRawStdout()     // 刷新 stdout 缓冲
```

## 模型解析 (src/core/model-resolver.ts)

> **源码**: `packages/coding-agent/src/core/model-resolver.ts` — resolveCliModel L328, defaultModelPerProvider L14

`model-resolver.ts` 负责确定 agent 使用哪个 LLM 模型。

### 默认模型

```typescript
const defaultModelPerProvider: Record<string, string> = {
  anthropic: "claude-sonnet-4-...",
  openai: "o3-...",
  google: "gemini-2.5-...",
  // ...
}
```

### 解析流程

```
用户输入: "anthropic:claude-sonnet-4" 或 "sonnet" 或 无指定
       │
       ▼
resolveCliModel(input)
  1. parseModelPattern(input)        // 解析 "provider:model" 或 "alias"
  2. findExactModelReferenceMatch()  // 精确匹配 provider + model ID
  3. resolveModelScope()             // 在所有 provider 中搜索
       │
       ▼
findInitialModel()
  → 从 defaultModelPerProvider 中选择可用的 provider 的默认模型
```

### 与 Thinking Level 的交互

模型指定时可以附带 thinking level：`"anthropic:claude-sonnet-4:high"`。
`parseModelPattern()` 将其解析为 `{ provider, modelId, thinkingLevel }`。

## 系统提示词构建

> **源码**: `packages/coding-agent/src/core/system-prompt.ts` — buildSystemPrompt L28

系统提示词按以下顺序组装：

```
BuildSystemPromptOptions:
  customPrompt       — 自定义提示词（替换默认）
  selectedTools      — 当前活跃工具列表
  toolSnippets       — 工具代码片段（有此参数时才在提示词中列出工具）
  promptGuidelines   — 额外指南文本
  appendSystemPrompt — 追加到系统提示词末尾
  cwd, contextFiles, skills

组装顺序:
1. 工具部分（仅当 toolSnippets 提供时）
   "Available tools:"
   - 各工具的描述和代码片段

2. 指南（根据可用工具条件生成）
   - 有 bash 但没有 grep/find/ls: "用 bash 进行文件操作"
   - 有 grep/find/ls: "优先使用这些而非 bash 进行探索"
   - 有 read + edit: "编辑前先读取文件"
   - 有 edit: "精确编辑"
   - 有 write: "只用于新文件或完整重写"
   - 始终: "简洁，显示文件路径"

3. Pi 文档
   - readme、docs、examples 路径
   - 何时应该读取它们

4. 项目上下文（如果配置了 contextFiles）
   - 指定上下文文件的内容

5. Skills（如果有 read 工具和 skills）
   - 格式化的 skill 描述

6. 元数据
   - 当前日期
   - 工作目录 (cwd)
```

## 扩展系统

> **源码**: `packages/coding-agent/src/core/extensions/` — types.ts (ExtensionAPI L988), runner.ts (ExtensionRunner L202), loader.ts（详见 [06-extension-system-deep-dive.md](06-extension-system-deep-dive.md)）

### 加载路径

- `~/.pi/agent/extensions/*.ts` 或 `~/.pi/agent/extensions/*/index.ts`（全局）
- `.pi/extensions/*.ts` 或 `.pi/extensions/*/index.ts`（项目级）
- settings 中配置的额外路径

用 `jiti` 加载（不需要构建步骤）。

### 扩展 API

```typescript
export default function (pi: ExtensionAPI) {
  // 注册工具
  pi.registerTool({ name: "my-tool", ... })

  // 注册命令
  pi.registerCommand("mycommand", async (ctx) => { ... })

  // 拦截事件
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      return { block: true, reason: "Blocked" }
    }
  })

  pi.on("tool_result", async (event, ctx) => {
    return { content: [...] }  // 修改工具输出
  })

  pi.on("context", async (messages, ctx) => {
    return messages  // 修改发给 LLM 的上下文
  })
}
```

### 钩子生命周期

```
扩展钩子在一个 turn 中的触发顺序:

  agent_start
    turn_start
      [context 钩子]                    ← LLM 调用前
      [before_provider_request 钩子]    ← HTTP 请求前
      message_start (assistant)
      message_update* (流式 token)
      message_end (assistant)
      tool_execution_start
        [tool_call 钩子]                ← 可以阻止
        tool.execute()
        [tool_result 钩子]              ← 可以修改
      tool_execution_end
      message_start (toolResult)
      message_end (toolResult)
    turn_end
  agent_end
```

## 上下文压缩

> **源码**: `packages/coding-agent/src/core/compaction/compaction.ts` — compact L715, findCutPoint L386, generateSummary L530（详见 [07-compaction-and-sessions.md](07-compaction-and-sessions.md)）

当对话超出模型的上下文窗口时：

```
1. 检测: contextTokens > contextWindow - reserveTokens（默认 16K）

2. 切割: 从最新消息往回走，保留约 20K token 的近期消息
   在合法位置切割（不在 toolResult 中间切）

3. 摘要: 把要丢弃的消息发给 LLM 生成结构化摘要
   包含: Goal, Constraints, Progress, Decisions, Next Steps

4. 替换: 在 SessionManager 中，用一条 CompactionSummaryMessage 替换旧条目

5. 重载: Agent 在下一个 turn 看到压缩后的历史
```

如果之前已经有压缩摘要，新摘要会在旧摘要基础上增量更新（迭代压缩）。

## 会话管理

> **源码**: `packages/coding-agent/src/core/session-manager.ts` — SessionManager L664, appendMessage L829, getBranch L1029, branch L1120（详见 [07-compaction-and-sessions.md](07-compaction-and-sessions.md)）

会话以条目树（不是线性数组）存储：

```
SessionManager
  getBranch(leafId): SessionEntry[]   // 当前分支的线性视图
  getTree(): SessionTreeNode[]        // 含分支的完整树

SessionEntry = {
  id: string
  parentId: string | null     // null 表示根条目
  type: "message" | "compaction" | "label" | "thinking_level_change"
       | "model_change" | "branch_summary" | "custom" | "custom_message"
       | "session_info"
  message: AgentMessage       // 对于 message 类型的条目
}
```

分支允许探索对话的替代路径而不丢失原始路径。树结构支持：
- `branch(branchFromId)` — 从指定位置创建新分支（移动 leafId）
- `resetLeaf()` — 重置 leafId 为 null（用于重新编辑首条用户消息）
- Labels 标记重要位置

## Settings 管理 (src/core/settings-manager.ts)

> **源码**: `packages/coding-agent/src/core/settings-manager.ts` — Settings L63, deepMergeSettings L101, SettingsManager L226

配置系统使用全局 + 项目两级覆盖：

```
优先级: 项目级 > 全局级

全局: ~/.pi/agent/settings.json      ← 用户级默认值
项目: {cwd}/.pi/settings.json        ← 项目级覆盖
```

### Settings 接口

```typescript
interface Settings {
  defaultProvider?: string      // 默认 LLM 提供商
  defaultModel?: string         // 默认模型
  transport?: "sse" | "websocket" | "auto"
  packages?: PackageSource[]    // 安装的包
  extensions?: string[]         // 扩展路径
  skills?: string[]             // skill 路径
  prompts?: string[]            // prompt 模板路径
  themes?: string[]             // 主题路径
  enabledModels?: ScopedModel[] // 模型范围限制
  sessionDir?: string           // 自定义会话存储目录
  compaction?: CompactionSettings  // 压缩参数
  retry?: RetrySettings         // 自动重试
  terminal?: TerminalSettings   // 终端行为
  images?: { blockImages?: boolean }  // 图片处理（blockImages 阻止图片发给 LLM）
  thinkingBudgets?: ThinkingBudgets   // 每个 thinking level 的 token 预算
  markdown?: MarkdownSettings   // Markdown 渲染设置
  // ...
}
```

### 合并行为

嵌套对象递归合并（项目级覆盖对应键），数组和原始值整体替换。
`undefined` 值不覆盖已有值。

### 迁移

自动迁移旧配置格式：
- `queueMode` → `steeringMode`
- `websockets` → `transport`

### 环境变量回退

部分设置有环境变量回退：
- `PI_CLEAR_ON_SHRINK` — 终端缩小时清屏
- `PI_HARDWARE_CURSOR` — 硬件光标模式

### drainErrors()

收集并返回 Settings 初始化/解析时遇到的非致命错误，
允许调用方在 UI 就绪后统一报告。

### 文件锁

读写使用 `proper-lockfile` 加锁，防止多个 pi 实例并发修改。
`flush()` 用于将内存中的 async 写入队列持久化。

## Resource Loading (src/core/resource-loader.ts)

> **源码**: `packages/coding-agent/src/core/resource-loader.ts` — DefaultResourceLoader L150

统一管理所有可加载资源的生命周期：

```
DefaultResourceLoader.reload()
  1. packageManager.resolve()     ← 从 settings 解析包路径
  2. resolveExtensionSources()    ← 解析 CLI 指定的扩展（标记为 temporary）
  3. 合并路径: 包 + CLI + settings 中的额外路径
  4. loadExtensions()             ← 加载扩展（jiti），附加 sourceInfo
  5. updateSkillsFromPaths()      ← 加载 skills，附加 sourceInfo
  6. updatePromptsFromPaths()     ← 加载 prompt 模板，附加 sourceInfo
  7. updateThemesFromPaths()      ← 加载主题，附加 sourceInfo
  8. getAgentsFiles()             ← 发现 AGENTS.md / CLAUDE.md（agent 目录 + 祖先目录遍历）
  9. 解析系统提示词覆盖
  10. 冲突检测: 重复工具名 / 重复标志
```

### 资源类型

| 资源 | 文件类型 | 来源 | 附加信息 |
|---|---|---|---|
| 扩展 | `.ts`, `.js` | 本地、npm、git | sourceInfo |
| Skills | `.md` (含 frontmatter) | 本地、包 | sourceInfo |
| Prompt 模板 | `.md` | 本地、包 | sourceInfo |
| 主题 | `.json` | 本地、包 | sourceInfo |
| 上下文文件 | `AGENTS.md`, `CLAUDE.md` | agent 目录 + 祖先遍历 | — |

### 资源发现事件

加载完成后，`resources_discover` 事件允许扩展动态修改资源列表
（通过 `extendResources()`，新路径也会附加 sourceInfo 和来源元数据）。

### Prompt 模板

`PromptTemplate` 现在携带 `sourceInfo`，支持参数替换：
`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}` — 类似 shell 的位置参数语法。

## Auth Storage (src/core/auth-storage.ts)

> **源码**: `packages/coding-agent/src/core/auth-storage.ts` — AuthStorage L184, FileAuthStorageBackend L45

API 密钥和 OAuth 凭证的安全存储。

### 存储位置

```
~/.pi/agent/auth.json
  权限: 目录 0o700, 文件 0o600
```

### 凭证类型

```typescript
type AuthCredential =
  | { type: "api_key"; key: string }        // API 密钥
  | { type: "oauth"; ... OAuthCredentials } // OAuth token + refresh

type AuthStorageData = Record<string, AuthCredential>
// 键 = provider ID (如 "anthropic", "openai")
```

### 运行时 API Key

```typescript
authStorage.setRuntimeApiKey(provider, key)    // CLI --api-key 设置
authStorage.removeRuntimeApiKey(provider)
authStorage.setFallbackResolver(resolver)       // 自定义 Provider 的回退解析
```

API key 优先级：**runtime > file > env > fallback**

### OAuth Token 刷新

`refreshOAuthTokenWithLock` 使用 `withLockAsync` 确保多个并发请求
不会同时刷新 token。

### 并发安全

使用 `proper-lockfile` 文件锁。读写通过 `withLock(fn)` 序列化：
获取锁 → 读取 JSON → 调用 fn(current) → 写入 → 释放锁。

提供 `FileAuthStorageBackend`（生产）和 `InMemoryAuthStorageBackend`（测试）。
`hasAuth(provider)` 检查包括 runtime、file、env 和 fallback 四个来源。
`drainErrors()` 收集并返回初始化时遇到的非致命错误。

## Model Registry (src/core/model-registry.ts)

> **源码**: `packages/coding-agent/src/core/model-registry.ts` — ModelRegistry L255

管理内置模型和用户自定义模型/Provider。

### 核心功能

- **`refresh()`**: 重置所有 API/OAuth 注册，重新加载配置
- **`registerProvider(name, config)`** / **`unregisterProvider(name)`**: 运行时注册/注销 Provider
- **`getApiKeyAndHeaders(provider, model)`**: 统一获取认证信息
- **`clearApiKeyCache()`**: 清除缓存的 API key

`ProviderConfigInput` 支持自定义 `streamSimple` 函数和 OAuth 配置，
OAuth Provider 可通过 `modifyModels` 回调修改模型列表。

### 自定义模型配置

```
~/.pi/agent/models.json

{
  "providers": {
    "my-provider": {
      "baseUrl": "https://my-api.com/v1",
      "apiKey": "!echo $MY_KEY",        // !command 语法动态获取
      "api": "openai-responses",         // 使用哪个 API 协议
      "models": [
        {
          "id": "my-model",
          "name": "My Custom Model",
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ],
      "modelOverrides": {
        "existing-model-id": { "reasoning": true }
      }
    }
  }
}
```

### Provider 注册

扩展可以通过 `registerApiProvider()` 注册新的 LLM Provider，
注册后该 Provider 的模型立即可用。

### API Key 解析

```
优先级: CLI 参数 > models.json 中的配置 > auth.json > 环境变量
```

`models.json` 中的 `apiKey` 支持 `!command` 语法：
`"apiKey": "!op read 'My API Key'"` 会执行命令并使用其输出。

## Skills 系统 (src/core/skills.ts)

> **源码**: `packages/coding-agent/src/core/skills.ts` — loadSkillsFromDir L172, loadSkills L404

Skills 是给模型提供专业知识的 Markdown 文件。每个 Skill 现在携带 `sourceInfo`。

### 发现规则

```
skill 搜索路径:
  ~/.pi/agent/skills/     ← 全局（scope: "user"）
  .pi/skills/             ← 项目级（scope: "project"）
  包中的 skills/          ← 通过 package manager（origin: "package"）

发现逻辑:
  目录含 SKILL.md → 整个目录是一个 skill（不再递归）
  目录不含 SKILL.md → 扫描直接子 .md 文件 + 递归子目录
  遵循 .gitignore / .ignore / .fdignore
```

### Skill 结构

```markdown
---
name: my-skill
description: 做某件事的专业知识
disable-model-invocation: false
---

# 技能内容

详细的指导...
```

### 调用方式

| 方式 | 说明 |
|---|---|
| **模型自动调用** | `disableModelInvocation: false` 时，skill 描述出现在系统提示词中，模型按需读取 |
| **用户手动调用** | `/skill:my-skill` 命令（需开启 `enableSkillCommands`） |
| **隐藏 skill** | `disableModelInvocation: true` → 仅通过 `/skill:name` 访问 |

### 验证规则

- 名称必须等于父目录名
- 名称格式: `[a-z0-9-]+`，最长 64 字符
- 描述必填，最长 1024 字符

## Package Manager (src/core/package-manager.ts)

> **源码**: `packages/coding-agent/src/core/package-manager.ts` — DefaultPackageManager L681

管理扩展、skills、prompts、themes 的安装和更新。

### PathMetadata

包管理器为每个解析的路径提供 `PathMetadata`，用于构建 `SourceInfo`:

```typescript
interface PathMetadata {
  source: string        // 包源标识（如 "npm:@scope/pkg"）
  scope: SourceScope    // "user" | "project" | "temporary"
  origin: "package" | "top-level"  // 来源类型
  baseDir?: string      // 包安装目录（可选）
}
```

### 离线模式

`PI_OFFLINE=1` 跳过所有网络操作（`isOfflineModeEnabled()`）。

### 命令

```bash
pi install npm:@scope/pkg     # 从 npm 安装
pi install git:user/repo      # 从 git 安装
pi install ./local/path       # 本地路径

pi remove npm:@scope/pkg
pi update                     # 更新所有包
pi update npm:@scope/pkg      # 更新指定包
pi list                       # 列出已安装的包
```

### 安装范围

| 范围 | 存储位置 | 标志 |
|---|---|---|
| 用户级（默认） | `~/.pi/agent/settings.json` 的 `packages` | 无 |
| 项目级 | `{cwd}/.pi/settings.json` 的 `packages` | `--local` |

### 包结构

一个包可以同时提供多种资源：

```
my-package/
├── extensions/    → 扩展
├── skills/        → skills
├── prompts/       → prompt 模板
└── themes/        → 主题
```

也可以通过 `PackageSource` 精确控制启用哪些资源：

```json
{
  "packages": [
    {
      "source": "npm:@scope/pkg",
      "extensions": true,
      "skills": true,
      "prompts": false,
      "themes": false
    }
  ]
}
```
