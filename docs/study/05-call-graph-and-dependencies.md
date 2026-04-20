# 调用图和依赖关系

## 包依赖关系

下面这张图主要强调 **monorepo 内部依赖**；外部依赖只举关键例子，不做完整穷举。

```
pi-ai（无 monorepo 内部依赖）
  ├─ @sinclair/typebox（JSON schema）
  └─ 多个 provider SDK / 校验与网络依赖（Anthropic、OpenAI、Google、AJV、undici ...）

pi-agent-core
  └─ @mariozechner/pi-ai

pi-tui（无 monorepo 内部依赖）
  └─ 终端渲染库

pi-coding-agent
  ├─ @mariozechner/pi-agent-core
  ├─ @mariozechner/pi-ai
  └─ @mariozechner/pi-tui

pi-web-ui
  ├─ @mariozechner/pi-ai
  └─ @mariozechner/pi-tui

pi-mom（Slack 机器人）
  ├─ @mariozechner/pi-coding-agent
  ├─ @mariozechner/pi-agent-core
  └─ @mariozechner/pi-ai

pi-pods（GPU pod / vLLM 管理 CLI）
  └─ @mariozechner/pi-agent-core
```

## 完整调用图：用户输入到工具执行

```
AgentSession.prompt(text)                   ← coding-agent
│
├── this.agent.prompt(userMessage)          ← agent-core
│   │
│   ├── Agent.runPromptMessages(messages)
│   │   │
│   │   └── runAgentLoop(prompts, context, config, emit, signal)
│   │       │
│   │       ├── emit(agent_start)
│   │       ├── emit(turn_start)
│   │       │
│   │       ├── 对每个初始 prompt 发出
│   │       │   ├── emit(message_start)
│   │       │   └── emit(message_end)
│   │       │
│   │       └── runLoop(context, newMessages, config, signal, emit)
│   │           │
│   │           └── 外层循环:
│   │               └── 内层循环:
│   │                   │
│   │                   ├── 注入 pendingMessages
│   │                   │
│   │                   ├── streamAssistantResponse()
│   │                   │   │
│   │                   │   ├── config.transformContext(messages, signal)
│   │                   │   │   └── sdk.ts 中注入的 transformContext()
│   │                   │   │       └── ExtensionRunner.emitContext(messages)
│   │                   │   │
│   │                   │   ├── config.convertToLlm(messages)
│   │                   │   │   └── messages.ts: convertToLlm()
│   │                   │   │       ├── user → 直接传递
│   │                   │   │       ├── assistant → 直接传递
│   │                   │   │       ├── toolResult → 直接传递
│   │                   │   │       ├── bashExecution → user 消息
│   │                   │   │       ├── custom → user 消息
│   │                   │   │       ├── branchSummary → user + <summary>
│   │                   │   │       └── compactionSummary → user + <summary>
│   │                   │   │
│   │                   │   └── sdk.ts 注入的 streamFn()
│   │                   │       ├── modelRegistry.getApiKeyAndHeaders(model)
│   │                   │       └── streamSimple(model, llmContext, { apiKey, headers })   ← pi-ai
│   │                   │           │
│   │                   │           └── resolveApiProvider(model.api)
│   │                   │               └── 懒加载包装器
│   │                   │                   └── import("./anthropic.js")
│   │                   │                       └── Anthropic SDK
│   │                   │
│   │                   ├── executeToolCalls()
│   │                   │   │
│   │                   │   ├── executeToolCallsSequential()
│   │                   │   │   └── 全局 `toolExecution === "sequential"`
│   │                   │   │      或本批存在 `executionMode === "sequential"` 的工具时进入
│   │                   │   │
│   │                   │   └── executeToolCallsParallel()
│   │                   │       │
│   │                   │       ├── 顺序准备: prepareToolCall()
│   │                   │       │   ├── 查找工具
│   │                   │       │   ├── prepareToolCallArguments()
│   │                   │       │   ├── validateToolArguments()
│   │                   │       │   └── beforeToolCall 钩子
│   │                   │       │       └── → ExtensionRunner.emitToolCall()
│   │                   │       │
│   │                   │       ├── 并发执行: executePreparedToolCall()
│   │                   │       │   └── tool.execute(id, args, signal, onUpdate)
│   │                   │       │       ├── edit: 读 → 替换 → 写（通过 `withFileMutationQueue` 串行化同文件写入）
│   │                   │       │       ├── write: mkdir → 写（通过 `withFileMutationQueue` 串行化同文件写入）
│   │                   │       │       ├── bash: ops.exec(command)
│   │                   │       │       ├── read: ops.readFile(path)
│   │                   │       │       ├── grep: spawn(rg) + GrepOperations
│   │                   │       │       ├── find: FindOperations（fd 或自定义 glob）
│   │                   │       │       └── ls: ops.readdir()
│   │                   │       │
│   │                   │       └── 顺序完成: finalizeExecutedToolCall()
│   │                   │           └── afterToolCall 钩子
│   │                   │               └── → ExtensionRunner.emitToolResult()
│   │                   │
│   │                   ├── emit(turn_end)
│   │                   └── pendingMessages = getSteeringMessages()
│   │
│   └── Agent.processEvents(event)
│       ├── 更新 AgentState
│       └── 通知订阅者
│
└── AgentSession._handleAgentEvent(event)
    ├── _createRetryPromiseForAgentEnd()   // 同步创建 retry promise
    ├── _agentEventQueue.then(_processAgentEvent)
    └── _processAgentEvent(event)
        ├── ExtensionRunner.emit(event)    // 扩展先看见事件
        ├── _emit(event)                   // 再通知 UI / listeners
        ├── message_end → SessionManager.appendMessage()
        └── agent_end → 检查自动压缩 / 重试
```

## 关键抽象边界

### 边界 1: AgentMessage → Message (convertToLlm)

```
            Agent 循环内部                              LLM
    ┌──────────────────────────┐              ┌──────────────────┐
    │  AgentMessage[]          │              │  Message[]       │
    │  (user, assistant,       │  convertToLlm│  (user, assistant│
    │   toolResult,            │ ────────────→│   toolResult)    │
    │   bashExecution,         │              │                  │
    │   custom,                │              │  只有标准        │
    │   branchSummary,         │              │  LLM 角色       │
    │   compactionSummary)     │              │                  │
    └──────────────────────────┘              └──────────────────┘
```

### 边界 2: AgentTool → Tool (仅 schema)

```
    coding-agent                 agent-core                  pi-ai
    ┌────────────┐              ┌───────────┐              ┌──────┐
    │ AgentTool  │              │ AgentTool │              │ Tool │
    │ name       │              │ name      │              │ name │
    │ description│              │ description              │ desc │
    │ parameters │              │ parameters│              │ params│
    │ label      │              │ label     │              │      │
    │ execute()  │              │ execute() │              │      │
    │            │              │           │              │      │
    │ + EditOps  │              │           │              │      │
    │ + BashOps  │              │           │              │      │
    └────────────┘              └───────────┘              └──────┘
```

pi-ai 的 `Tool` 只有 schema（name、description、parameters），没有 execute。
agent-core 的 `AgentTool` 添加了 `execute()` 和 `label`。
coding-agent 在 `AgentTool` 基础上添加了具体的 I/O 操作。

### 边界 3: AgentEvent → 扩展事件

```
    agent-core                    coding-agent
    ┌──────────────┐             ┌─────────────────┐
    │ AgentEvent   │             │ 扩展事件         │
    │              │             │                  │
    │ agent_start  │ ──────────→│ agent_start      │
    │ turn_start   │ ──────────→│ turn_start       │
    │ message_*    │ ──────────→│ message_*        │
    │              │             │                  │
    │ （通过钩子） │             │ tool_call        │
    │ beforeToolCall────────────→│  （可以阻止）    │
    │ afterToolCall ────────────→│ tool_result      │
    │              │             │  （可以修改）    │
    │              │             │                  │
    │              │             │ context          │
    │              │             │  （变换消息）    │
    │              │             │ input            │
    │              │             │  （预处理输入）  │
    └──────────────┘             └─────────────────┘
```

## 文件依赖图（关键文件）

```
packages/ai/src/
├── types.ts              ← 定义 Message, Tool, Context, Model
├── stream.ts             ← 依赖 types, api-registry
├── utils/event-stream.ts ← 依赖 types.ts（导入 AssistantMessage, AssistantMessageEvent）
├── api-registry.ts       ← 依赖 types
├── models.ts             ← 依赖 types, models.generated
├── env-api-keys.ts       ← 无 monorepo 内部依赖
└── providers/
    ├── register-builtins.ts  ← 依赖 api-registry, types
    └── anthropic.ts          ← 依赖 types, event-stream, env-api-keys

packages/agent/src/
├── types.ts              ← 从 pi-ai 导入 Message, Tool 等
├── agent-loop.ts         ← 从 pi-ai 导入 streamSimple, EventStream
│                            导入 types.ts 的 AgentContext, AgentLoopConfig
└── agent.ts              ← 导入 agent-loop.ts 的 runAgentLoop
                             导入 types.ts 的 AgentState, AgentTool

packages/coding-agent/src/core/
├── messages.ts           ← 从 pi-agent-core 导入 AgentMessage，并通过 declare module 扩展 CustomAgentMessages
├── tools/
│   ├── edit.ts           ← 从 pi-agent-core 导入 AgentTool
│   │                        导入 path-utils.ts, edit-diff.ts
│   ├── write.ts          ← 从 pi-agent-core 导入 AgentTool
│   │                        导入 path-utils.ts
│   └── bash.ts           ← 从 pi-agent-core 导入 AgentTool
├── agent-session.ts      ← 导入 Agent（pi-agent-core）
│                            导入 tools, messages, extensions, session-manager
├── sdk.ts                ← 导入 agent-session, tools, models, settings
└── system-prompt.ts      ← 导入 tools, skills
```
