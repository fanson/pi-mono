# 第二层: agent-core — Agent 运行时

## 职责

`@mariozechner/pi-agent-core` 提供 agent 循环：一个在 LLM 调用和工具执行之间
交替运行的状态机。它扩展了 pi-ai 的 `Message` 为 `AgentMessage`，`Tool` 为 `AgentTool`，
增加了执行能力。

## 关键源文件

| 文件 | 作用 |
|------|------|
| `src/types.ts` | AgentMessage、AgentTool、AgentEvent、AgentLoopConfig、BeforeToolCallContext/AfterToolCallContext |
| `src/agent-loop.ts` | 主循环：runLoop、工具执行（含 prepareArguments）、流式传输 |
| `src/agent.ts` | Agent 类：状态管理、队列、公共 API、signal 暴露 |
| `src/proxy.ts` | 代理流：通过服务器代理 LLM 请求（用于 web-ui 等场景） |

## 这一层在 pi-ai 基础上增加了什么？

| pi-ai | agent-core |
|-------|------------|
| `Message`（user/assistant/toolResult） | `AgentMessage` = Message + 自定义类型 |
| `Tool`（name、description、parameters） | `AgentTool` = Tool + execute() + label + prepareArguments?() |
| `Context`（systemPrompt、messages、tools） | `AgentContext`（同上但用 AgentMessage/AgentTool） |
| `streamSimple()` 返回 stream | Agent 循环消费 stream 并继续执行 |

## 循环入口函数 (src/agent-loop.ts)

```
agentLoop(prompts, context, config, signal?, streamFn?)
  → 添加新的 prompt 消息到上下文，开始循环
  → 返回 EventStream<AgentEvent, AgentMessage[]>

agentLoopContinue(context, config, signal?, streamFn?)
  → 从当前上下文继续（不添加新消息），用于重试
  → 入口要求上下文非空，且最后一条消息不能是 `role === "assistant"`
  → 典型可继续状态是 `user` / `toolResult`，或能经 `convertToLlm()` 映射为 LLM `user` 的自定义消息
  → 返回 EventStream<AgentEvent, AgentMessage[]>
```

两者都使用相同的内部 `runLoop()` 函数。

## 双循环 (src/agent-loop.ts)

> **源码对照**: `packages/agent/src/agent-loop.ts` — `runLoop`、`streamAssistantResponse`、`prepareToolCallArguments`、`prepareToolCall`

这是项目中最核心的代码。按执行顺序说明：

### 1. 初始 steering 检查

进入循环之前，先检查是否有等待中的 steering 消息：

```
pendingMessages = getSteeringMessages()  ← runLoop() 的第一步，两层循环之外
```

这确保用户在等待期间排入的 steering 消息不会被遗漏。

### 2. 外层循环：处理 follow-up 消息

```
while (true) {
  运行内层循环...
  
  // agent 本来要停止了
  followUpMessages = getFollowUpMessages()
  if (followUpMessages.length > 0) {
    pendingMessages = followUpMessages
    continue  // 重启内层循环
  }
  break  // 结束
}
```

follow-up 消息在 **agent 本来要停止时** 被注入。
场景：用户在 agent 快完成时打字，作为 follow-up 而非 steering 消息投递。

### 3. 内层循环：处理 turns

```
while (hasMoreToolCalls || pendingMessages.length > 0) {
  1. 注入 pendingMessages（steering 或 follow-up）
  2. streamAssistantResponse() → AssistantMessage
  3. 如果 error/aborted → 发射 agent_end，返回
  4. 如果 toolUse → executeToolCalls()
  5. 发射 turn_end
  6. pendingMessages = getSteeringMessages()  ← 每个 turn 结束后再次检查
}
```

一个 "turn" = 一次 assistant 回复 + 它的工具调用 + 工具结果。

### 完整结构一览

```
runLoop():
  pendingMessages = getSteeringMessages()     ← 步骤 1: 初始检查
  while (true) {                               ← 步骤 2: 外层循环
    while (hasMore || pending) {               ← 步骤 3: 内层循环
      注入 pending → LLM → 工具执行 → turn_end
      pendingMessages = getSteeringMessages()
    }
    followUp = getFollowUpMessages()
    if (followUp) { pending = followUp; continue }
    break
  }
  emit(agent_end)
```

### Steering vs Follow-up

| | Steering | Follow-up |
|---|---|---|
| **检查时机** | 每个 turn 之后（步骤 6） | 内层循环退出后 |
| **用途** | 中途重定向 agent | agent 停止后继续 |
| **例子** | agent 在编辑时你说"先处理 header" | agent 说"完成了"后你说"再修复测试" |
| **队列方法** | `agent.steer(message)` | `agent.followUp(message)` |

### 用户如何触发（TUI 视角）

在 coding-agent 的 TUI 交互模式中，用户**不需要知道** steering/follow-up 的概念。
系统根据按键和时机自动决定：

| Agent 状态 | 用户操作 | 行为 |
|---|---|---|
| **空闲** | Enter | 正常开始新 turn（`session.prompt(text)`） |
| **执行中** | **Enter** | **steering** — 当前工具执行完后注入 |
| **执行中** | **Alt+Enter** | **follow-up** — agent 完全停止后再投递 |
| **压缩中** | Enter | 缓存为 steering，压缩完成后发送 |
| **压缩中** | Alt+Enter | 缓存为 follow-up，压缩完成后发送 |

**实际场景**：agent 正在并行编辑 5 个文件

- 按 **Enter** 输入"停下，先处理 header" → 当前文件编辑完成后 agent 立即看到
- 按 **Alt+Enter** 输入"完成后再跑测试" → 5 个文件全部编辑完、agent 本来要停止时才看到

### 消息流转链路

```
用户按 Enter（agent 执行中）
  → interactive-mode.ts: session.prompt(text, { streamingBehavior: "steer" })
    → agent-session.ts: _queueSteer(expandedText)
      → agent.steer({ role: "user", content, timestamp })
        → agent.ts: steeringQueue.enqueue(msg)
          → agent-loop.ts: getSteeringMessages() 返回队列内容
            → 注入到下一次 LLM 调用前
```

### streamAssistantResponse()

这是 `AgentMessage[]` 变成 `Message[]` 的地方:

```
1. transformContext(messages, signal)  — 可选，操作 AgentMessage[]
   例如：上下文窗口裁剪、注入外部上下文
   
2. convertToLlm(messages)  — 必需，AgentMessage[] → Message[]
   例如：过滤 UI-only 消息、映射自定义角色
   
3. streamSimple(model, context, options)  — 调用 LLM
   返回: AssistantMessageEventStream
   
4. 遍历 stream 事件:
   - start: 把 partial 消息推入 context，发射 message_start
   - text_* / thinking_* / toolcall_*: 更新 context 中的 partial，发射 message_update
   - done/error: 最终化消息，发射 message_end
```

在 streaming 期间，`partial` 消息被直接推入 `context.messages`。
这意味着系统其他部分可以在 streaming 过程中看到进行中的消息。

## 工具执行 (src/agent-loop.ts)

### 三个阶段（prepareToolCall 内含参数预处理）

```
阶段 1: PREPARE（准备） — 由 prepareToolCall() 函数完成
  - 按名称查找工具（找不到 → 错误结果）
  - 运行 prepareToolCallArguments()（如果工具定义了 prepareArguments）
    → 在 schema 验证之前运行（v0.64.0 新增）
    → 返回新的 args 替换原始参数
    → 用途：向后兼容旧的参数格式（如 edit 工具的单参数→多参数迁移）
  - 用 `validateToolArguments()`（AJV 校验 `parameters` schema）验证参数
  - 调用 beforeToolCall 钩子
    → { block: true } 阻止执行
    → undefined 允许执行

阶段 2: EXECUTE（执行）
  - 调用 tool.execute(toolCallId, args, signal, onUpdate)
  - onUpdate 回调用于流式部分结果
  - 异常 → 错误工具结果

阶段 3: FINALIZE（完成）
  - 调用 afterToolCall 钩子
    → 提供的 `content` / `details` / `isError` 会完整替换对应字段；省略的字段保留原值
  - 发射 tool_execution_end
  - 发射 message_start/end（ToolResultMessage）
```

### 并行执行模式（parallel 分支）

只有当 `AgentLoopConfig.toolExecution !== "sequential"` 时，才会进入下面这条并行分支。
否则循环会走 `executeToolCallsSequential()`，按 prepare → execute → finalize
逐个执行工具调用。

```typescript
// 步骤 1: 顺序准备所有工具调用（保证钩子顺序）
for (const toolCall of toolCalls) {
  const preparation = await prepareToolCall(...)
  if (preparation.kind === "immediate") {
    results.push(...)  // 被阻止或出错
  } else {
    runnableCalls.push(preparation)
  }
}

// 步骤 2: 并发执行所有可运行的工具
const runningCalls = runnableCalls.map(prepared => ({
  prepared,
  execution: executePreparedToolCall(prepared, signal, emit)
  // ↑ .map() 启动所有执行，execution 是一个 Promise
}))

// 步骤 3: 按源顺序逐个 finalize（等待每个完成）
for (const running of runningCalls) {
  const executed = await running.execution
  results.push(await finalizeExecutedToolCall(...))
}
```

关键细节：
- **Prepare** 是串行的：钩子看到一致的状态
- **Execute** 是并发的：`.map()` 同时启动所有，每个 `.execution` 是一个 Promise
- **Finalize** 是串行的：结果按 LLM 指定的顺序发射
- **file-mutation-queue 的意义**：execute 阶段并发，所以两个 edit 同时操作同一文件会竞争（通过 `withFileMutationQueue` 串行化，详见 [06-tool-system-deep-dive.md](06-tool-system-deep-dive.md)）

## Agent 类 (src/agent.ts)

> **源码对照**: `packages/agent/src/agent.ts` — `Agent`、`prompt()`、`steer()`

`Agent` 类用状态管理包装了循环。

### 状态

```typescript
interface AgentState {
  systemPrompt: string
  model: Model<any>
  thinkingLevel: ThinkingLevel  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  set tools(tools: AgentTool<any>[])  // 赋值时拷贝顶层数组
  get tools(): AgentTool<any>[]
  set messages(messages: AgentMessage[])  // 赋值时拷贝顶层数组
  get messages(): AgentMessage[]
  readonly isStreaming: boolean           // 包含等待 agent_end listener settle
  readonly streamingMessage?: AgentMessage  // 当前流式传输中的消息
  readonly pendingToolCalls: ReadonlySet<string>  // 正在执行的工具 ID
  readonly errorMessage?: string
}
```

状态管理通过直接属性赋值：
```typescript
agent.state.systemPrompt = "New prompt"
agent.state.model = getModel("openai", "gpt-4o")
agent.state.thinkingLevel = "medium"
agent.state.tools = [myTool]           // 拷贝数组后存储
agent.state.messages = newMessages     // 拷贝数组后存储
agent.state.messages.push(message)     // 直接修改当前数组
agent.reset()                          // 清空所有状态
```

注意：`tools` 和 `messages` 的 setter 会**拷贝顶层数组**再存储。但通过 getter 返回的数组是可变引用——直接 `push()` 会修改当前状态。

### 消息队列

两个队列，可配置消费模式：

```
steeringQueue: AgentMessage[]
  - "one-at-a-time" 模式（默认）: 每个 turn 只消费第一条
  - "all" 模式: 一次消费所有

followUpQueue: AgentMessage[]
  - 相同的两种模式
```

### 公共 API

```typescript
// 开始新的对话 turn
agent.prompt("fix the bug")
agent.prompt(agentMessage)
agent.prompt([msg1, msg2])

// 在 agent 运行时排队消息
agent.steer(message)    // 当前 turn 工具执行完后投递
agent.followUp(message) // agent 要停止时投递

// 从当前上下文继续
agent.continue()

// 控制
agent.abort()           // 中止当前操作
agent.waitForIdle()     // 等待不再 streaming 的 Promise
agent.reset()           // 清空所有状态

// 信号 — v0.63.2 新增
agent.signal            // 当前 turn 的 AbortSignal（用于嵌套异步操作）
```

## Steering 时序保证

Steering 消息在**当前 assistant 消息的完整工具批次**全部完成后才被消费（v0.58.4 修复）。
即使 steering 消息在工具执行中途到达，也会等到本批次所有工具 finalize 完成后
才注入到下一次 LLM 调用。

## AgentMessage 扩展（声明合并）

> **源码对照**: `packages/agent/src/types.ts` — `AgentMessage`、`AgentTool`、`AgentLoopConfig`、`AgentEvent`

代码库中最优雅的模式：

```typescript
// agent-core 中定义（默认为空）:
export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]
// 此时: AgentMessage = Message（因为 CustomAgentMessages 没有 key）

// coding-agent 中通过声明合并扩展:
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage
    custom: CustomMessage
    branchSummary: BranchSummaryMessage
    compactionSummary: CompactionSummaryMessage
  }
}
// 现在: AgentMessage = Message | BashExecutionMessage | CustomMessage | ...
```

这意味着：
- **agent-core 循环** 处理所有消息类型，无需知道具体类型
- **convertToLlm** 在每个应用中决定自定义消息如何映射为 LLM 格式
- **类型安全** 完全保留：TypeScript 知道所有可能的消息类型

为什么不用泛型？泛型需要把类型参数传递到每个处理 AgentMessage 的函数。
声明合并全局生效，不需要改现有代码。

## AgentEvent 类型

```typescript
type AgentEvent =
  // 生命周期边界
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  
  // Turn 边界（一个 turn = 一次 assistant 回复 + 工具调用）
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  
  // 消息生命周期（user、assistant、toolResult）
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: ... }
  | { type: "message_end"; message: AgentMessage }
  
  // 工具执行生命周期
  | { type: "tool_execution_start"; toolCallId; toolName; args }
  | { type: "tool_execution_update"; toolCallId; toolName; args; partialResult }
  | { type: "tool_execution_end"; toolCallId; toolName; result; isError }
```

事件通过 `emit: AgentEventSink = (event) => Promise<void> | void` 发射。
Agent 类在私有 `processEvents()` 中处理它们更新状态，然后转发给订阅者。

`Agent.subscribe()` 的 listener 按注册顺序被 await。`agent_end` 表示不会再发射
更多循环事件，但 `agent.waitForIdle()` 和 `agent.prompt()` 只在所有被 await 的
`agent_end` listener 完成后才 settle。
