# Pi-Mono 架构总览

## 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                coding-agent（第三层）                     │
│  CLI、工具、扩展、会话、系统提示词、UI                       │
│  依赖: agent-core, pi-ai, pi-tui                        │
├─────────────────────────────────────────────────────────┤
│                agent-core（第二层）                       │
│  Agent 循环、AgentMessage、工具生命周期、事件               │
│  依赖: pi-ai                                            │
├─────────────────────────────────────────────────────────┤
│                   pi-ai（第一层）                         │
│  统一 LLM API、流式传输、模型、Provider                    │
│  不依赖 monorepo 上层包（仅使用外部 npm 依赖）             │
└─────────────────────────────────────────────────────────┘
```

### 设计原则：每层有严格的职责边界

- **pi-ai** 不知道 agent、工具执行或文件系统的存在。它只认识 `Message`、`Context`、`Tool`（仅 schema）和 `Model`。
- **agent-core** 不知道 coding 工具、会话或 TUI 的存在。它只认识 `AgentMessage`、`AgentTool`（含 `execute`）和循环控制。
- **coding-agent** 是领域特定层：`edit`、`bash`、`read`、`write`、扩展、会话、系统提示词。

### 为什么这很重要？

贡献代码时，你必须把改动放在正确的层：
- 文件锁 → coding-agent（文件 I/O 是这一层的职责）
- steering 消息时机 → agent-core（循环控制流）
- Provider 重试逻辑 → pi-ai（LLM 通信）

**放错层 = PR 被拒。**

## 端到端数据流

```
用户输入 "fix the bug"
    │
    ▼
AgentSession.prompt("fix the bug")      ← coding-agent 层
    │
    ▼
Agent.prompt(userMessage)               ← agent-core 层
    │
    ▼
runAgentLoop(prompts, context, config, emit, signal)
    │
    ├── pendingMessages = getSteeringMessages()  ← 初始检查
    │
    ├── 外层循环（处理 follow-up 消息）─────────────────────┐
    │   │                                                    │
    │   ├── 内层循环（处理 turns + steering）──────────┐     │
    │   │   │                                          │     │
    │   │   │  1. 注入待处理的 steering 消息            │     │
    │   │   │  2. streamAssistantResponse()             │     │
    │   │   │     ├── transformContext(AgentMessage[], signal) │     │
    │   │   │     │   应用上下文变换（裁剪、注入）         │     │
    │   │   │     ├── convertToLlm(AgentMessage[])      │     │
    │   │   │     │   把自定义消息转为 LLM 格式           │     │
    │   │   │     ├── streamSimple(model, context)      │     │
    │   │   │     │   调用 LLM API  ← pi-ai 层         │     │
    │   │   │     └── 发射 message_start/update/end     │     │
    │   │   │                                          │     │
    │   │   │  3. 如果 LLM 返回 toolUse:               │     │
    │   │   │     executeToolCalls(并行或串行)           │     │
    │   │   │     ├── prepareToolCall（验证 + 钩子）     │     │
    │   │   │     ├── executePreparedToolCall（执行）    │     │
    │   │   │     └── finalizeExecutedToolCall（钩子）   │     │
    │   │   │                                          │     │
    │   │   │  4. 发射 turn_end                        │     │
    │   │   │  5. getSteeringMessages()                │     │
    │   │   │     有消息 → 继续内层循环                  │     │
    │   │   └──────────────────────────────────────────┘     │
    │   │                                                    │
    │   │  6. getFollowUpMessages()                          │
    │   │     有消息 → 继续外层循环                            │
    │   └────────────────────────────────────────────────────┘
    │
    ▼
发射 agent_end
```

## 消息类型层级

```
pi-ai 定义:
  Message = UserMessage | AssistantMessage | ToolResultMessage
  （三种 LLM 能理解的角色）

agent-core 扩展:
  AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]
  （通过 TypeScript 声明合并，允许任意自定义消息类型）

coding-agent 通过声明合并添加:
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage    // !command 执行记录
    custom: CustomMessage                   // 扩展注入的消息
    branchSummary: BranchSummaryMessage     // 分支摘要
    compactionSummary: CompactionSummaryMessage  // 压缩摘要
  }
```

**关键洞察**: `AgentMessage` 在整个 agent 循环中流转，包含各种自定义类型。
但 LLM 只认识 `user`、`assistant`、`toolResult` 三种角色。所以在调用 LLM 前，
必须通过 `convertToLlm()` 把自定义类型映射为 LLM 能理解的格式。**主调用边界**在
`streamAssistantResponse()` 内部（每次 assistant turn 前都会做一次），但 compaction /
summary 这些辅助路径也会复用同一套转换逻辑。

## 事件系统

系统有两层事件：

```
LLM 事件 (pi-ai 层):
  AssistantMessageEvent:
    start → text_start → text_delta* → text_end →
    thinking_start → thinking_delta* → thinking_end →
    toolcall_start → toolcall_delta* → toolcall_end →
    done | error

Agent 事件 (agent-core 层):
  AgentEvent:
    agent_start →
      turn_start →
        message_start → message_update* → message_end  （assistant 消息）
        tool_execution_start → tool_execution_update* → tool_execution_end
        message_start → message_end  （toolResult 消息）
      turn_end →
    agent_end

消费者 (coding-agent 层):
  AgentSession 订阅 AgentEvent 并：
    - 持久化消息到 SessionManager
    - 运行扩展钩子（tool_call、tool_result）
    - 触发自动上下文压缩
    - 更新 UI 状态
```

## 工具生命周期

```
                    ┌─────────────────┐
                    │  LLM 返回       │
                    │  toolCall 块    │
                    └────────┬────────┘
                             │
               ┌─────────────▼──────────────┐
               │    prepareToolCall()        │
               │  1. 按名称查找工具            │
               │  2. AJV 校验参数（基于 TypeBox schema） │
               │  3. beforeToolCall 钩子      │
               │     → 返回 block? → 错误结果  │
               └─────────────┬──────────────┘
                             │
          ┌──── 串行模式 ────┼──── 并行模式 ────┐
          │                  │                   │
          ▼                  ▼                   ▼
   逐个准备→执行→完成    准备所有(顺序)      并发执行
                          然后并发执行     结果按源顺序输出
          │                                      │
          ▼                                      ▼
   finalizeExecutedToolCall()
   1. afterToolCall 钩子（可修改 content/details/isError）
   2. 发射 tool_execution_end
   3. 发射 message_start/end（ToolResultMessage）
```

### 并行 vs 串行执行

默认是**并行**。区别：

```
串行:
  准备(A) → 执行(A) → 完成(A) → 准备(B) → 执行(B) → 完成(B)

并行:
  准备(A) → 准备(B)  （顺序准备，钩子顺序一致）
  执行(A) ┐
  执行(B) ┘           （并发执行）
  完成(A) → 完成(B)  （顺序完成，按 LLM 指定顺序）
```

**并发保护**: 并行执行意味着两个 edit 可能同时操作同一文件（TOCTOU 竞态条件）。
通过 `withFileMutationQueue()` 按规范文件路径串行化写操作来解决
（同一文件 FIFO 串行，不同文件完全并行）。

## Provider 系统 (pi-ai)

### 注册机制

所有 Provider 使用**懒加载包装器**，只在首次使用时才动态导入实际的 provider 模块：

```
用户调用: streamSimple(model, context, options)
    │
    ▼
stream.ts: resolveApiProvider(model.api)  // 内部走 getApiProvider，未注册则抛错
    │
    ▼
懒加载包装器:
  1. 立即返回 outer AssistantMessageEventStream（同步）
  2. 异步: import("./anthropic.js")
  3. 加载完成后: provider.streamSimple() → inner stream
  4. forwardStream(outer, inner)  // 转发事件
```

### 为什么要懒加载？

1. **Tree-shaking**: 未使用的 provider 不会被打包
2. **浏览器兼容**: Bedrock 依赖 Node-only SDK，浏览器构建不加载它
3. **启动速度**: 重量级 SDK（Anthropic、OpenAI）只在首次使用时加载

### Provider 契约

每个 provider 必须：
1. 返回 `AssistantMessageEventStream`（永远不 throw）
2. 先 push `start` 事件
3. 最终 push `done` 或 `error` 事件
4. 错误编码在 `AssistantMessage.stopReason` + `errorMessage` 中
5. 把 provider 特定事件映射到统一的 `AssistantMessageEvent` 协议

## 凭证解析链

```
Provider 代码调用:
  options?.apiKey ?? getEnvApiKey(model.provider)

getEnvApiKey 检查:
  1. Provider 特定逻辑:
     - anthropic: ANTHROPIC_OAUTH_TOKEN > ANTHROPIC_API_KEY
     - bedrock: AWS_PROFILE, AWS_ACCESS_KEY_ID, IAM 角色
     - vertex: ADC (application_default_credentials.json)
     - copilot: COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN
  2. 通用环境变量映射:
     - openai → OPENAI_API_KEY
     - google → GEMINI_API_KEY
     - groq → GROQ_API_KEY
     - ...
```
