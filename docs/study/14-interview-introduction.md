# 面试介绍文档：如何讲清楚 `pi-mono`

这份文档只做一件事：帮你在面试里把 `pi-mono` **讲得清楚、讲得稳定、讲得不过头**。

如果你要最后冲刺，建议顺序是：

1. 先读 `15-interview-cheat-sheet.md`，把全局地图压进脑子
2. 再读这份文档，练 30 秒 / 90 秒 / 5 分钟讲述
3. 最后刷 `16-interview-question-bank.md`，专门防追问

## 一句话版本

`pi-mono` 是一个面向 LLM/agent 场景的 monorepo，它把 **provider 通信**、**通用 agent loop**、以及 **coding assistant 的工具 / 会话 / 扩展 / 运行模式** 明确拆成三层。

## 30 秒版本

如果让我用 30 秒介绍这个项目，我会说：

> `pi-mono` 的核心价值，不是“把模型调通”，而是把 coding agent 系统拆成了三层：`pi-ai` 负责 provider 适配和流式事件，`agent-core` 负责通用的 agent loop 与工具生命周期，`coding-agent` 再往上补工具、扩展、会话、compaction 和 TUI / print / rpc 模式。  
> 这样做的好处是边界非常清楚，底层可以复用，而产品层复杂度不会污染通用 runtime。

## 90 秒版本

更完整一点，我会这样讲：

> `pi-mono` 不是单个 CLI 脚本，而是一个分层的 agent 系统。  
> 第一层 `pi-ai` 统一不同 provider 的调用接口、模型定义和流式事件；第二层 `agent-core` 负责消息送模、接收 assistant 输出、处理 tool call、执行工具并把结果注回上下文；第三层 `coding-agent` 才把这个通用 runtime 产品化，补上 `edit`、`read`、`write`、`bash`、`grep`、`find`、`ls` 这些工具，以及扩展系统、会话树、compaction、TUI / print / json / rpc 等运行模式。  
> 我觉得它最值得讲的点，是作者把“模型通信”“循环控制”“产品能力”拆得很干净，所以同一个仓库里既能复用底层抽象，也能演进真正可用的 coding assistant。

## 5 分钟版本

### 1. 三层架构

#### `packages/ai`

这是最底层的 provider 通信层。它负责：

- 统一不同 provider 的调用接口
- 抽象流式事件
- 维护模型定义、provider 注册与配置解析
- 处理 provider 级别差异

它知道 prompt、model、usage、stream，但不知道 agent loop，也不知道 edit/read/bash 这些领域工具。

#### `packages/agent`

这是通用 agent runtime。它负责：

- 维护 `runAgentLoop()` / `runLoop()` 这样的核心循环
- 处理 `beforeToolCall` / `afterToolCall`
- 执行工具调用并管理并发策略
- 处理 steering / follow-up 这类运行时消息注入
- 把 `AgentMessage` 转成 LLM 真正认识的消息格式

它最重要的价值是：把“一个 agent 怎么跑”从具体产品里抽出来。

#### `packages/coding-agent`

这是产品化层。它把通用 runtime 落地成可用的 coding assistant：

- 7 个内置工具：`edit`、`bash`、`read`、`write`、`grep`、`find`、`ls`
- 扩展系统：工具、命令、flags、事件、UI
- `AgentSession` / `SessionManager` 的会话持久化
- compaction、resume、fork、branch
- TUI、print、json、rpc 这些运行模式

这一层的重点不是“再发一次模型请求”，而是把 session、工具、扩展和交互体验组织成一个完整产品。

### 2. 一次请求怎么跑

你可以这样讲：

1. 用户从 `AgentSession.prompt()` 发起输入
2. 进入 `Agent.prompt()`，再进入 `runAgentLoop()`
3. 在 `streamAssistantResponse()` 里先做 `transformContext(...)` 和 `convertToLlm(...)`
4. 然后调用 `pi-ai` 的 `streamSimple(...)`
5. 模型返回 assistant message；如果里面带 tool call，就进入工具执行阶段
6. `prepareToolCall()` 负责找工具、准备参数、做 schema 校验、跑 `beforeToolCall`
7. `executePreparedToolCall()` 真正调用工具
8. tool result 被重新注回上下文，再进入下一轮 loop
9. 同时 `coding-agent` 侧负责持久化消息和 session entry，并在需要时做 compaction

这段话的关键不是背函数名，而是讲清楚：**模型调用、工具调度、会话管理不是糊成一团，而是逐层协作。**

### 3. 这个项目的设计取舍

#### 取舍 1：核心尽量小

`pi-mono` 的风格明显偏向 minimal core。很多复杂能力没有直接塞进 `agent-core`，而是放在 `coding-agent` 或扩展层。

这意味着：

- 好处：边界清晰、复用性强、底层更稳定
- 代价：很多高级能力不会像闭源产品那样“默认全内建”

#### 取舍 2：工具执行更偏简单可靠，而不是最激进

当前 Pi 的工具执行模型是：

- 先拿到完整 assistant message
- 再统一进入工具执行阶段
- 全局 `toolExecution` 控制默认路径；如果当前这批调用中命中了某个 `executionMode: "sequential"` 的工具，整批会回退到串行路径

所以它：

- 没有 streaming tool execution
- 也没有 Claude Code 那种 `[并行块] -> [串行块] -> [并行块]` 的分区调度

这个点要老实讲。它体现的是作者优先选择**更容易推理和维护的执行模型**，而不是极限调度。

#### 取舍 3：compaction 放在 session/runtime 层

Pi 的 compaction 不是硬塞进 `runLoop()` 内部，而是由 `AgentSession._checkCompaction()` 在更高层控制。

这样做的结果是：

- 它和 session 持久化、恢复、overflow retry 更容易协同
- 但整体策略比 Claude Code 明显简单

所以更准确的讲法是：Pi 有 compaction，也有 compact-and-retry，但不是那种多层 PTL / 微压缩体系。

#### 取舍 4：扩展系统是进程内 TypeScript 扩展

Pi 的扩展系统强调：

- 类型安全
- 进程内调用
- 事件驱动
- 可以注册工具、命令、flags、UI 组件和 session hooks

这让它对 TypeScript 用户很友好，但也说明它更像“工程内扩展平台”，而不是先把一切都做成外部 HTTP 协议。

## 面试里最值得强调的亮点

如果面试官问“这个项目你最欣赏什么”，优先讲这 4 个：

1. **三层边界很清楚**：provider 通信、通用 runtime、coding 产品能力分开
2. **边界比功能堆砌更重要**：很多能力不是没有，而是被放在更合适的层
3. **类型系统驱动扩展**：工具、事件、消息、扩展 API 都有明确类型边界
4. **session / compaction / branch 是产品级能力**：说明它不是 demo agent，而是面向长期使用的交互系统

## 面试里要主动承认的限制

这部分不要回避。回避只会显得你没真看过代码。

你应该主动承认：

1. **Pi 没有流式工具执行**，要等 assistant message 完整结束后才开始执行工具
2. **Pi 已有一个较粗粒度的 tool-level `executionMode` 逃生口**，但还没有真正的分区批处理
3. **Pi 的 compaction 有效，但明显比 Claude Code 简化**
4. **很多高级能力更多依赖扩展层**，不是默认全内建

这不是减分，反而说明你理解了它的真实工程取舍。

## 千万不要说错的点

下面这些说法现在是错的：

- 不要说“Pi 完全没有 tool-level `executionMode`”，也不要把当前实现夸成 Claude Code 式分区批处理
- 不要说“`convertToLlm()` 只在 `streamAssistantResponse()` 里用一次”；compaction / summarization 相关路径也会复用
- 不要说模型显式引用格式是 `provider:model`；当前 canonical 形式是 `provider/model[:thinking]`
- 不要说贡献流程是 `lgtmi` 再 `lgtm`；当前仓库文档明确的是 first-time / new contributors 的 `lgtm` issue gate
- 不要把扩展层 `tool_call` 的参数改写，和 agent 层 `beforeToolCall` 的 hook 契约混成一回事
- 不要说 `tool_execution_end` 自带原始 `args`

## 如何使用后续材料

- 如果你只剩 10 分钟：读 `15-interview-cheat-sheet.md`
- 如果你要练“怎么讲”：继续用这份文档反复口述
- 如果你要防面试官深挖：读 `16-interview-question-bank.md`
- 如果你想验证自己不是死记硬背：回头做 `11-hands-on-exercises.md`

## 结尾模板

如果面试官问你“最后怎么总结这个项目”，可以用这段：

> 我会把 `pi-mono` 看成一个把 agent 系统工程化得很干净的项目。它最强的不是某一个花哨功能，而是把 provider 通信、通用 agent runtime、以及 coding assistant 的产品能力拆成了清楚的层级。  
> 这样做的结果是：它在某些高级调度和优化上没有那么激进，但结构非常适合扩展、维护和长期演化。对我来说，这比单纯“功能很多”更有工程价值。
