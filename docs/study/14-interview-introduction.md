# 面试介绍文档：如何介绍 `pi-mono`

这份文档不是源码手册，而是给你在面试里**稳定、正确、可复述**地介绍 `pi-mono` 用的。
目标不是把所有细节都背下来，而是让你在 30 秒、90 秒、5 分钟三种时长里都能讲清楚。

## 一句话版本

`pi-mono` 是一个面向 LLM/agent 场景的 monorepo，它把 **LLM provider 抽象**、**通用 agent 循环**、以及 **面向 coding assistant 的工具 / 会话 / 扩展 / TUI** 明确拆成三层。

## 30 秒版本

如果让我用 30 秒介绍这个项目，我会说：

> `pi-mono` 的核心价值是把一个 coding agent 系统拆成了三层：`pi-ai` 负责和不同模型提供商打交道，`agent-core` 负责通用的 agent loop 和工具生命周期，`coding-agent` 再往上加文件工具、bash、扩展系统、会话持久化、上下文压缩和交互式 TUI。  
> 这种分层让底层能力可以复用，而 coding assistant 相关的复杂度不会污染通用 agent 核心。

## 90 秒版本

更完整一点，我会这样讲：

> `pi-mono` 是一个把 coding agent 做成“分层系统”而不是“单个 CLI 脚本”的项目。  
> 第一层 `pi-ai` 提供统一的 LLM API 抽象，负责 provider 适配、流式事件、模型定义和配置解析。  
> 第二层 `agent-core` 提供真正的 agent loop：把消息发给模型、接收 assistant 输出、处理 tool call、执行工具、再把 tool result 注入下一轮。它本身不知道文件系统，也不知道 edit/bash/read 这些具体工具的业务含义。  
> 第三层 `coding-agent` 才把这个通用 loop 落地成 coding assistant：提供 `edit`、`read`、`write`、`bash`、`grep`、`find`、`ls` 这些工具，加入扩展系统、session tree、resume/fork、compaction、TUI / print / rpc 模式。  
> 我觉得这个项目最值得讲的点，不是“它能调模型”，而是它把**模型通信、循环控制、产品化能力**拆得很干净，所以你可以单独复用某一层，而不是被整套 CLI 绑死。

## 5 分钟版本

### 1. 三层架构

#### `packages/ai`

这是最底层。它的职责是：

- 统一不同 provider 的调用接口
- 抽象流式事件
- 维护模型信息、provider 注册和配置
- 处理 provider 级别的差异

你可以把它理解成：**“面向模型的通信层”**。  
它知道 prompt、stream、usage、provider、model，但它不知道 agent loop，也不知道 edit/read/bash。

#### `packages/agent`

这是通用 agent runtime。它的职责是：

- 维护 `runAgentLoop()` 这样的核心循环（内部由 `runLoop()` 驱动）
- 处理 `beforeToolCall` / `afterToolCall`
- 调用工具并发或串行执行
- 处理 steering / follow-up 这类运行时消息注入
- 把 `AgentMessage` 转成 LLM 真正认识的消息格式

这一层最重要的价值是：**把“一个 agent 怎么跑起来”从具体产品里抽出来。**

#### `packages/coding-agent`

这是产品化层。它把通用 runtime 变成真正可用的 coding assistant：

- 7 个内置工具：`edit`、`bash`、`read`、`write`、`grep`、`find`、`ls`
- 扩展系统（工具、命令、快捷键、flags、事件）
- `AgentSession` / `SessionManager` 的会话持久化
- compaction、branch、resume、fork
- 交互式 TUI、print mode、rpc mode

如果要一句话概括第三层：  
**“它把通用 agent loop 变成了一个真正能做代码工作的交互式应用。”**

### 2. 一次完整请求怎么跑

你可以这样讲：

1. 用户从 `AgentSession.prompt()` 发起输入
2. 进入 `agent-core` 的 `Agent.prompt()` / `runAgentLoop()`
3. 在 `streamAssistantResponse()` 里先做 `transformContext(...)` 和 `convertToLlm(...)`
4. 交给 `pi-ai` 的 `streamSimple(...)` 调模型
5. 模型返回 assistant message；如果里面有 tool call，就进入工具执行
6. `prepareToolCall()` 负责找工具、准备参数、校验参数、跑 `beforeToolCall`
7. `executePreparedToolCall()` 真正调用工具
8. 工具结果回到上下文，再进入下一轮 loop
9. 同时 `coding-agent` 这边把消息和条目持久化到 session tree，需要时做 compaction

这段话的重点是：  
**模型调用、工具调度、会话管理不是糊在一起的，而是逐层协作。**

### 3. 这个项目有哪些设计取舍

这是面试里很加分的部分，因为你不是只会复述结构，而是能讲出作者的偏好。

#### 取舍 1：核心尽量小

`pi` 的哲学明显偏向 minimal core。  
很多复杂能力没有直接塞进 `agent-core`，而是留在 `coding-agent` 或扩展层。

这意味着：

- 好处：边界清晰、复用性强、底层更稳定
- 代价：有些高级能力不会像 Claude Code 那样“一上来全内置”

#### 取舍 2：工具执行更偏简单可靠，而不是最激进

当前 Pi 的工具执行是：

- 先拿到完整 assistant message
- 再统一进入工具执行阶段
- 工具并发/串行由全局 `toolExecution` 控制

这意味着它**没有** Claude Code 那种边流式输出边执行工具的机制，也**没有** per-tool 并发安全声明。

这个点很好讲，因为它体现了产品选择：

- Pi 选的是更简单、更容易推理的执行模型
- 代价是峰值性能和调度细粒度不如更激进的系统

#### 取舍 3：compaction 放在 session/runtime 层，而不是硬塞进 agent loop

Pi 的 compaction 不是直接揉进 `runLoop()` 内部，而是由 `AgentSession._checkCompaction()` 在更高层控制。

这让它：

- 更贴近 session 管理
- 能和持久化、恢复、overflow retry 配合
- 但策略层次明显比 Claude Code 更简单

所以你可以说：  
**Pi 有 compaction，也有 overflow 后的 compact-and-retry，但它不是 Claude Code 那种多层 PTL/微压缩体系。**

#### 取舍 4：扩展系统是进程内 TypeScript 扩展，不是“万物 HTTP hook”

Pi 的扩展系统强调：

- 类型安全
- 进程内调用
- 事件驱动
- 可以注册工具、命令、flags、UI 组件、session hooks

这让它对 TypeScript 用户非常友好，但不像一些系统那样默认把一切做成外部协议。

## 面试里最值得强调的亮点

如果面试官问“这个项目你最欣赏什么”，优先讲这 4 个：

1. **分层非常清楚**：provider 通信、agent loop、coding 产品能力三层分开。
2. **边界比功能更重要**：很多能力不是没有，而是放在正确的层实现。
3. **类型系统驱动扩展**：工具、事件、消息、扩展 API 都有明确类型边界。
4. **session / compaction / branch 不是补丁，而是产品级能力**：说明它不是 demo agent，而是长期使用的交互系统。

## 面试里要主动承认的限制

这是非常关键的一段。不要把项目吹成全能系统。

你应该主动说：

1. **Pi 没有流式工具执行**，要等 assistant message 完整结束后才开始执行工具。
2. **Pi 当前没有 per-tool 并发安全声明**，工具调度仍由全局 `toolExecution` 控制。
3. **Pi 的 compaction 有效，但比 Claude Code 简化很多**，没有对方那种多层 PTL/微压缩体系。
4. **很多高级能力更依赖扩展层**，不是像一些闭源产品那样一切默认内建。

这不是减分，反而说明你真的理解项目，而不是背宣传词。

## 高频面试问题与回答

### Q1. 为什么要拆成三层？直接在一个包里写完不行吗？

**答法：**

可以写在一个包里，但那样 provider 适配、agent loop、coding assistant 产品能力会强耦合。  
`pi-mono` 把这三类复杂度拆开之后，`pi-ai` 可以单独复用，`agent-core` 可以服务非 coding 场景，`coding-agent` 也能专注在工具、会话和交互体验上。

### Q2. `agent-core` 和 `coding-agent` 的边界怎么理解？

**答法：**

`agent-core` 负责“agent 怎么循环”，`coding-agent` 负责“agent 拿什么工具干活、怎么持久化、怎么和用户交互”。  
前者是通用执行引擎，后者是领域化产品层。

### Q3. Pi 的工具执行模型有什么特点？

**答法：**

它是先拿到完整 assistant message，再批量执行 tool call。  
优点是实现简单、边界清楚、容易推理；缺点是没有 streaming tool execution，也没有更细粒度的 per-tool 并发调度。

### Q4. Pi 的 compaction 和 Claude Code 比起来怎么样？

**答法：**

Pi 有 compaction，也有 context overflow 时的 compact-and-retry，但整体是更简单的单主路径设计。  
Claude Code 在压缩策略、缓存感知、PTL 恢复上更复杂；Pi 则更强调 session/runtime 层的一致性和简单性。

### Q5. 扩展系统最重要的价值是什么？

**答法：**

它把很多“本来会污染核心”的能力外移了。  
你可以通过扩展注册工具、命令、flags、事件处理和 UI，而不用改 agent-core 本身，这很符合 minimal core 的设计哲学。

### Q6. 如果你要继续演进这个项目，你会先看哪里？

**答法：**

我会优先看三个方向：

1. 工具调度粒度：是否要支持 per-tool 并发安全声明
2. 工具执行性能：是否值得引入 streaming tool execution
3. 文档和扩展体验：让现有强能力更容易被用户正确使用

## 试探你是不是真的懂的追问

这一组问题不是让你背术语，而是面试官最可能拿来验证你有没有真的读过源码。

### 1. Pi 现在支持 per-tool 并发模式吗？

**标准回答：**

不支持。当前工具调度仍由全局 `toolExecution` 决定，只能整批串行或整批并行。  
如果有人说 “Pi 已经支持 per-tool `executionMode`”，那是错的。

**面试官在试探什么：**

你有没有真的看过 `agent-loop.ts` 的执行分支，而不是只会讲概念。

### 2. `beforeToolCall` 和扩展层 `tool_call` 是一回事吗？

**标准回答：**

不是一回事。  
agent-core 层的 `beforeToolCall` 是 agent hook，接收结构化 context，既能返回 `{ block, reason }`，也能通过原地改传进来的 `args` 对象影响后续执行。  
coding-agent 扩展层的 `tool_call` 是另一套扩展事件机制：它通过修改 `event.input` 和返回 `{ block, reason }` 工作。两层都可能改参，但契约和接入点不是一回事。

**面试官在试探什么：**

你有没有把“公开契约”和“产品层桥接实现”混在一起。

### 3. 同一文件的多个 edit 为什么不会再互相覆盖？

**标准回答：**

因为 `edit` / `write` 的真正 read-modify-write 关键区会被 `withFileMutationQueue()` 包起来。  
同一路径的内部 tool mutation 会按 FIFO 串行化。  
但它解决的是**内部并发竞态**，不是外部进程改文件的问题；外部修改仍然缺少 mtime/hash 级冲突检测。

**面试官在试探什么：**

你能不能区分“内部队列串行化”和“真正的 optimistic locking”。

### 4. Pi 什么时候会做 compaction？只在 agent turn 结束后吗？

**标准回答：**

不只。`AgentSession._checkCompaction()` 会在 `agent_end` 之后检查，也会在发送新的用户消息前检查。  
这样可以覆盖 threshold、aborted、overflow 等路径。  
如果是 context overflow，Pi 会做 compact-and-retry，但不是 Claude Code 那种多层 PTL 恢复体系。

**面试官在试探什么：**

你是不是只背了“Pi 有 compaction”，但不知道它在 session/runtime 层怎么触发。

### 5. `convertToLlm()` 只在 `streamAssistantResponse()` 里用一次吗？

**标准回答：**

主调用边界确实在 `streamAssistantResponse()`，因为每次发给模型前都要转换。  
但不是“全项目只在那里用一次”。compaction / summarization 这些路径也会复用 `convertToLlm()`。

**面试官在试探什么：**

你有没有把“最主要的边界”误讲成“唯一的边界”。

### 6. `--model` 的显式 provider 形式是什么？

**标准回答：**

canonical 形式是 `provider/model[:thinking]`，比如 `anthropic/claude-sonnet-4:high`。  
`parseModelPattern()` 返回的是 `{ model, thinkingLevel, warning }`，不是手写拆出来的 `{ provider, modelId, ... }`。

**面试官在试探什么：**

你到底是读过 `model-resolver.ts`，还是只凭经验猜了个 `provider:model`。

### 7. 如果你新增一个自定义消息类型，却忘了给 `convertToLlm()` 补 case，会发生什么？

**标准回答：**

在这套严格类型写法里，先出现的通常是 exhaustiveness type error。  
如果你硬绕过类型系统，运行时才会落进 `default`，然后消息被过滤掉，LLM 看不到它。

**面试官在试探什么：**

你有没有理解这套代码是靠 TypeScript 做边界约束，而不是纯靠运行时容错。

### 8. `tool_execution_end` 事件里能直接拿到原始 `args` 吗？

**标准回答：**

不能。`tool_execution_end` 里有 `toolCallId`、`toolName`、`result`、`isError`，但没有 `args`。  
如果你要按文件或参数关联，应该在 `tool_execution_start` 里记录 `toolCallId -> args`，再和 `tool_execution_end` 对上。

**面试官在试探什么：**

你有没有真看过事件类型定义，而不是凭直觉猜事件 payload。

### 9. Pi 的贡献 gate 是什么？是 `lgtmi` 还是 `lgtm`？

**标准回答：**

当前仓库文档写得很明确：**对 first-time / new contributors**，先开 issue，拿到 maintainer `lgtm`，再继续提 PR。  
如果你说成 “先 `lgtmi` 再 `lgtm`”，那是在讲一个并不在当前仓库文档里的流程。

**面试官在试探什么：**

你有没有把历史口径、外部经验、当前仓库规则混在一起。

### 10. Pi 的工具系统是“直接塞一个 `AgentTool` 对象”吗？

**标准回答：**

从 agent-core 看最终运行时确实是 `AgentTool`。  
但在 coding-agent 这一层，主流模式已经是 definition-first：先写 `ToolDefinition`，再通过 `wrapToolDefinition(...)` 暴露成 `AgentTool`。  
这样才方便挂上 `prepareArguments`、UI 渲染和扩展层元数据。

**面试官在试探什么：**

你有没有理解运行时接口和产品层建模方式是两层东西。

## 千万不要说错的点

下面这些说法现在是错的，面试时不要讲：

- 不要说“Pi 已支持 per-tool `executionMode`”
- 不要说“`convertToLlm()` 只在 `streamAssistantResponse()` 里用一次，别的地方不会复用”
- 不要说模型显式引用格式是 `provider:model`；当前 canonical 形式是 `provider/model`
- 不要说贡献流程是 `lgtmi` 再 `lgtm`；当前仓库文档只明确写了对 first-time / new contributors 的 `lgtm` issue gate
- 不要把扩展层 `tool_call` 的参数原地修改，和 agent 层 `beforeToolCall` 的 block hook 混成一件事

## 结尾模板

如果面试官问你“你最后会怎么总结这个项目”，可以用这段：

> 我会把 `pi-mono` 看成一个把 agent 系统工程化得很干净的项目。它最强的不是某一个花哨功能，而是把 provider 通信、通用 agent runtime、以及 coding assistant 的产品能力拆成了清楚的层级。  
> 这样做的结果是：它在某些高级调度和优化上没有那么激进，但结构非常适合扩展、维护和长期演化。对我来说，这比单纯“功能很多”更有工程价值。
