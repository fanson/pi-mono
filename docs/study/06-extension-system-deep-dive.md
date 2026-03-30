# Phase 3: 扩展系统深入分析

## 概述

扩展系统是 pi 的"不改核心代码就能定制行为"的机制。通过 Extension API，
开发者可以注册工具、拦截事件、修改上下文、添加命令——全部通过一个 TypeScript 文件。

## 扩展结构

每个扩展是一个默认导出工厂函数的文件：

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  // 注册工具
  pi.registerTool({ ... })
  
  // 注册命令
  pi.registerCommand("mycommand", { ... })
  
  // 监听事件
  pi.on("tool_call", async (event, ctx) => { ... })
}
```

## Extension API 完整接口

> **源码对照**: `packages/coding-agent/src/core/extensions/types.ts` — ExtensionAPI L950, ExtensionEvent L819

### 事件订阅

```typescript
pi.on(event: EventType, handler: (event, ctx?) => Promise<Result> | Result)
```

详见下方事件列表。

### 工具注册

```typescript
pi.registerTool({
  name: string,             // 工具名
  label: string,            // 显示标签
  description: string,      // LLM 看到的描述
  parameters: TSchema,      // TypeBox schema
  prepareArguments?: (rawArgs) => args,  // schema 验证前的参数预处理
  execute: (id, args, signal, onUpdate, ctx) => Promise<AgentToolResult>,
  renderCall?: (args) => TuiNode,      // TUI 渲染
  renderResult?: (result) => TuiNode,  // TUI 渲染
})
```

### 命令注册

```typescript
pi.registerCommand("name", {
  description?: string,
  getArgumentCompletions?: (prefix) => { value, label }[],
  handler: (args, ctx) => Promise<void>
})
```

### 快捷键和标志

```typescript
pi.registerShortcut(shortcut: KeyId, {
  description?: string,
  handler: (ctx) => Promise<void>
})

pi.registerFlag("name", {
  description?: string,
  type: "boolean" | "string",
  default?: any
})
pi.getFlag("name")  // 获取标志值
```

### 消息和会话操作

```typescript
// 发送消息
pi.sendMessage(message, { triggerTurn?, deliverAs? })
pi.sendUserMessage(content, { deliverAs? })
pi.appendEntry(customType, data?)  // 自定义条目

// 会话元数据
pi.setSessionName(name)
pi.getSessionName()
pi.setLabel(entryId, label?)
```

### 工具控制

```typescript
pi.getActiveTools()    // 当前活跃工具名列表
pi.getAllTools()        // 所有工具（含描述）
pi.setActiveTools(toolNames)  // 设置活跃工具集
```

### 模型和思考级别

```typescript
pi.setModel(model)           // 切换模型
pi.getThinkingLevel()        // 获取思考级别
pi.setThinkingLevel(level)   // 设置思考级别
```

### Provider 注册

```typescript
pi.registerProvider("name", config)   // 注册/覆盖模型提供商
pi.unregisterProvider("name")         // 移除提供商
```

**生命周期**: 在 `bindCore()` 之前调用时，注册会排入 `pendingProviderRegistrations` 队列。
`bindCore()` 冲刷队列并替换 `registerProvider` / `unregisterProvider` 为立即生效的实现。
这意味着扩展工厂函数中的 `registerProvider` 调用会被延迟到 runner 绑定时执行。

### 扩展间通信

```typescript
pi.events.emit("channel", data)       // 发布事件
pi.events.on("channel", (data) => {}) // 订阅事件
```

## 事件系统详解

### 事件分类

```
资源事件:
  resources_discover  — 发现技能、提示词、主题路径
  session_directory   — 自定义会话目录

会话事件:
  session_start       — 会话启动后
  session_shutdown    — 会话关闭前
  session_before_switch / session_switch
  session_before_fork / session_fork
  session_before_compact / session_compact
  session_before_tree / session_tree

Agent 事件:
  before_agent_start  — agent 启动前（可修改系统提示词）
  agent_start / agent_end
  turn_start / turn_end
  message_start / message_update / message_end
  tool_execution_start / tool_execution_update / tool_execution_end

输入事件:
  input               — 用户输入前（可拦截或变换）
                        InputEvent 含 source: "interactive" | "rpc" | "extension"
  user_bash           — !command 执行前

工具事件:
  tool_call           — 工具调用前（可阻止）
  tool_result         — 工具结果后（可修改）

模型事件:
  model_select        — 模型选择时

上下文事件:
  context             — LLM 调用前（可修改消息）
  before_provider_request — HTTP 请求前（可修改 payload）
```

### 影响行为的事件

| 事件 | 返回值 | 效果 |
|------|--------|------|
| `tool_call` | `{ block: true, reason }` | **阻止**工具执行，第一个阻止的生效 |
| `tool_result` | `{ content?, details?, isError? }` | **修改**工具结果，所有处理器的改动合并 |
| `context` | `{ messages? }` | **替换**发给 LLM 的消息，链式传递 |
| `before_provider_request` | payload | **替换** HTTP 请求体，链式传递 |
| `before_agent_start` | `{ message?, systemPrompt? }` | **累积**消息，**替换**系统提示词（最后一个生效） |
| `input` | `{ action: "handled" }` | **拦截**输入，停止后续处理 |
| `input` | `{ action: "transform", text }` | **变换**输入内容，链式传递 |
| `user_bash` | `{ operations?, result? }` | **覆盖** bash 执行方式 |
| `session_before_*` | `{ cancel: true }` | **取消**对应操作 |

### 事件链处理规则

```
tool_call:
  遍历所有处理器 → 第一个返回 { block: true } 的生效 → 停止遍历

tool_result:
  遍历所有处理器 → 每个可以修改 event 对象 → 最终结果是所有修改的合并

context:
  处理器 A 返回 { messages: [...] }
  → 处理器 B 收到 A 的 messages 作为输入
  → 处理器 C 收到 B 的 messages 作为输入
  → 最终结果发给 LLM

input:
  处理器 A 返回 { action: "transform", text: "modified" }
  → 处理器 B 收到 modified text
  → 处理器 C 返回 { action: "handled" }
  → 停止，不再调用后续处理器
```

## ExtensionRunner 内部实现

> **源码对照**: `packages/coding-agent/src/core/extensions/runner.ts` — ExtensionRunner L199, emitToolCall L655, emitToolResult L605

### 核心数据

```
extensions: Extension[]              // 已加载的扩展列表
runtime: ExtensionRuntime            // 共享运行时（action 绑定）
uiContext: ExtensionUIContext         // UI 操作（或 noOp）
errorListeners: Set<ErrorListener>   // 错误监听器
```

### 绑定顺序

```
1. loadExtensions()
   → 对每个扩展文件: jiti.import() → factory(api)
   → 注册处理器和工具到 Extension 对象
   → registerProvider 调用排入 runtime.pendingProviderRegistrations 队列

2. ExtensionRunner.bindCore(actions, contextActions, providerActions?)
   → 把 sendMessage/setModel/etc 绑定到 runtime
   → 绑定 getModel/isIdle/getSignal/abort/hasPendingMessages/shutdown 等上下文 action
   → 冲刷 pendingProviderRegistrations（通过 providerActions 或 modelRegistry.registerProvider）
   → 替换 runtime.registerProvider/unregisterProvider 为立即生效版本

3. ExtensionRunner.bindCommandContext(actions?)
   → 绑定 waitForIdle/newSession/fork 等
   → 如果不提供 actions，命令操作变为 no-op

4. ExtensionRunner.setUIContext(uiContext)
   → 绑定 UI 操作（select/confirm/notify/custom）
```

### 错误处理

```
大多数事件派发:
  try { handler(event, ctx) } catch (error) {
    emitError({ extensionPath, event, error, stack })
    // 继续处理其他扩展
  }

例外: emitToolCall 不捕获异常
  → 工具调用处理器抛出的异常会传播到 agent session
  → 阻止工具执行
```

### 上下文对象

每次事件派发时创建 `ExtensionContext`（通过 `runner.createContext()`）:

```typescript
interface ExtensionContext {
  ui: UIContext             // select, confirm, notify, custom
  hasUI: boolean            // 是否有 UI（RPC/print 模式下为 false）
  cwd: string               // 当前工作目录
  sessionManager: ReadonlySessionManager
  modelRegistry: ModelRegistry
  model: Model              // 当前模型
  signal: AbortSignal | undefined  // 当前 turn 的 abort 信号
  isIdle: () => boolean     // agent 是否空闲
  abort: () => void         // 中止当前操作
  hasPendingMessages: () => boolean
  shutdown: () => void      // 关闭会话
  getContextUsage: () => ContextUsage
  compact: () => void       // 触发压缩
  getSystemPrompt: () => string
}
```

**注意**: `signal` 在 `createContext()` 调用时快照，不是每次属性访问时重新获取。

命令处理器获得扩展的 `ExtensionCommandContext`:

```typescript
interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle: () => Promise<void>
  newSession: () => void
  fork: (entryId?) => void
  navigateTree: () => void
  switchSession: () => void
  reload: () => void
}
```

## 扩展加载

> **源码对照**: `packages/coding-agent/src/core/extensions/loader.ts` — loadExtensions L361, loadExtension L317, loadExtensionModule L287

### 发现路径

```
1. 项目级: cwd/.pi/extensions/
2. 全局级: ~/.pi/agent/extensions/
3. 配置级: settings/CLI 指定的路径
```

### 发现规则（单层遍历）

```
extensions/
├── hello.ts              → 直接加载
├── my-ext/
│   ├── package.json      → 读取 pi.extensions 字段
│   │   { "pi": { "extensions": ["index.ts"] } }
│   └── index.ts          → 通过 package.json 发现
├── another-ext/
│   └── index.ts          → 自动发现 index.ts/index.js
└── data.json             → 忽略（不是 .ts/.js）
```

### 加载机制

使用 `jiti`（即时 TypeScript 编译器）加载扩展：
- 不需要预构建步骤
- 扩展可以直接 import pi-mono 的包（通过别名或虚拟模块）
- Bun 二进制构建使用 `virtualModules`，Node 开发模式使用 `alias`

## 真实扩展示例

### hello.ts — 最小工具

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "hello",
    label: "hello",
    description: "Greets a person by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    execute: async (_id, { name }) => ({
      content: [{ type: "text", text: `Hello, ${name}!` }],
      details: undefined,
    }),
  })
}
```

### ssh.ts — 远程执行

```typescript
export default function (pi: ExtensionAPI) {
  // 注册 CLI 标志
  pi.registerFlag("ssh", {
    description: "SSH connection string (user@host:/path)",
    type: "string"
  })
  
  // 在 session_start 时解析标志（此时才可用）
  pi.on("session_start", async (event, ctx) => {
    const sshTarget = pi.getFlag("ssh")
    if (!sshTarget) return
    
    // 用远程操作替换内置工具
    const remoteEditOps = createRemoteEditOps(sshConnection)
    pi.registerTool(createEditTool(remoteCwd, { operations: remoteEditOps }))
    // ... read, write, bash 类似
  })
  
  // 拦截 !command（直接在远程执行）
  pi.on("user_bash", async (event, ctx) => {
    return { operations: createRemoteBashOps(sshConnection) }
  })
  
  // 修改系统提示词（告诉 LLM 在远程操作）
  pi.on("before_agent_start", async (event, ctx) => {
    return { systemPrompt: event.systemPrompt + "\nYou are editing files on a remote server." }
  })
}
```

### tools.ts — 工具选择器（含持久化）

```typescript
export default function (pi: ExtensionAPI) {
  // 注册 /tools 命令
  pi.registerCommand("tools", {
    description: "Enable/disable tools",
    handler: async (args, ctx) => {
      const allTools = pi.getAllTools()
      const activeTools = pi.getActiveTools()
      
      // 用 UI 让用户选择
      const selected = await ctx.ui.select("Select tools", allTools, activeTools)
      pi.setActiveTools(selected)
      
      // 持久化到会话
      pi.appendEntry("tools-config", { enabledTools: selected })
    }
  })
  
  // 会话恢复时读取配置
  const restoreFromBranch = async () => {
    const branch = ctx.sessionManager.getBranch()
    const configEntry = branch.findLast(e => e.customType === "tools-config")
    if (configEntry) {
      pi.setActiveTools(configEntry.data.enabledTools)
    }
  }
  
  pi.on("session_start", restoreFromBranch)
  pi.on("session_tree", restoreFromBranch)
  pi.on("session_fork", restoreFromBranch)
}
```

## 扩展生命周期

```
CLI 启动
  │
  ├── 解析参数
  │
  ├── callSessionDirectoryHook()
  │   └── session_directory 事件（自定义会话目录）
  │
  ├── 创建 SessionManager
  │
  ├── ResourceLoader.reload()
  │   └── discoverAndLoadExtensions()
  │       ├── 发现扩展文件（项目/全局/配置）
  │       ├── jiti.import() 加载每个扩展
  │       └── factory(api) 注册处理器和工具
  │
  ├── createAgentSession()
  │   └── _buildRuntime()
  │       ├── 创建 ExtensionRunner
  │       ├── bindCore(actions)
  │       ├── bindCommandContext(actions)
  │       └── setUIContext(uiContext)
  │
  ├── session_start 事件
  │
  ├── emitResourcesDiscover("startup")
  │   └── 合并技能/提示词/主题路径
  │
  └── 进入交互/RPC/打印模式
       │
       ├── 用户输入 → input 事件
       ├── !command → user_bash 事件
       ├── /command → 命令处理器
       ├── 普通输入 → agent 循环
       │   ├── before_agent_start 事件
       │   ├── context 事件
       │   ├── before_provider_request 事件
       │   ├── tool_call / tool_result 事件
       │   └── agent_end 事件
       │
       └── /reload
           ├── session_shutdown 事件
           ├── 重新加载扩展
           └── session_start 事件
```

## 扩展开发指南

### 常见模式

| 模式 | API | 场景 |
|------|-----|------|
| 注册工具 | `pi.registerTool()` | 添加新的 LLM 可调用工具 |
| 拦截工具 | `pi.on("tool_call")` | 阻止危险操作 |
| 修改结果 | `pi.on("tool_result")` | 后处理工具输出 |
| 修改上下文 | `pi.on("context")` | 注入/过滤发给 LLM 的消息 |
| 修改提示词 | `pi.on("before_agent_start")` | 动态修改系统提示词 |
| 拦截输入 | `pi.on("input")` | 预处理或接管用户输入 |
| 覆盖执行 | `pi.on("user_bash")` + 自定义 ops | 远程执行、沙箱等 |
| 持久化状态 | `pi.appendEntry()` | 会话内保存配置 |
| 扩展间通信 | `pi.events.emit/on` | 多扩展协作 |
| 延迟配置 | `pi.on("session_start")` + `pi.getFlag()` | 在标志可用后配置 |

### InputSource 和 Input 事件

`input` 事件现在携带 `source` 字段标识输入来源：

```typescript
type InputSource = "interactive" | "rpc" | "extension"

interface InputEvent {
  type: "input"
  text: string
  images?: ImageContent[]
  source: InputSource  // 标识输入从哪里来
}
```

`emitInput` 链式处理所有扩展：
- `transform` → 修改 text/images，传递给下一个处理器
- `handled` → 短路返回，不再调用后续处理器
- `continue` → 不修改，继续传递

### 注意事项

1. **工厂函数是同步初始化**：可以在 `on` 回调中做异步操作，但工厂本身应快速返回
2. **`tool_call` 异常会传播**：不像其他事件被 try/catch 包裹
3. **扩展间顺序**：加载顺序决定事件处理顺序（项目级 → 全局级 → 配置级）
4. **不要修改 agent-core**：所有定制通过扩展 API 实现
5. **signal 快照**：`ExtensionContext.signal` 在 `createContext()` 时快照，不会动态更新
6. **Provider 注册时序**：工厂函数中的 `registerProvider` 是延迟的，`bindCore` 后才生效
