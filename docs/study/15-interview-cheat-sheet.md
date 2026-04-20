# 面试速记版：`pi-mono`

这份文档是最后冲刺用的，不是细读源码用的。
目标只有一个：把最容易讲错、最值得讲、最常被追问的点压成一页脑图。

## 15 秒地图

`pi-mono` = `pi-ai` + `agent-core` + `coding-agent`

- `packages/ai`：provider 通信层
- `packages/agent`：通用 agent loop 与工具生命周期
- `packages/coding-agent`：工具、扩展、会话、compaction、TUI / print / json / rpc

一句话记忆：

> 它的价值不是“调模型”，而是把 coding agent 的三类复杂度拆开了。

## 30 秒最短答法

> `pi-mono` 把 coding agent 做成了三层系统：`pi-ai` 统一 provider 与流式事件，`agent-core` 负责通用循环和工具生命周期，`coding-agent` 再往上补工具、扩展、会话、compaction 和多种运行模式。  
> 这种拆法让底层可以复用，而产品层复杂度不会反向污染 agent 核心。

## 一次请求怎么跑

1. `AgentSession.prompt()`
2. `Agent.prompt()` / `runAgentLoop()`
3. `streamAssistantResponse()` 里做 `transformContext(...)` + `convertToLlm(...)`
4. `streamSimple(...)` 调模型
5. assistant message 完整返回
6. 如果有 tool call，进入 `prepareToolCall()`
7. `executePreparedToolCall()` 真正执行工具
8. tool result 注回上下文，进入下一轮
9. `AgentSession` / `SessionManager` 负责持久化与 compaction

你真正要讲清楚的是：

- 模型调用
- 工具执行
- 会话持久化

这三件事是分层协作的，不是搅在一起。

## 最值得讲的 4 个点

1. **三层边界干净**：provider 通信、通用 runtime、coding 产品能力分开
2. **minimal core 倾向明显**：很多复杂能力被放在 `coding-agent` 或扩展层
3. **类型系统驱动扩展**：工具、事件、消息、扩展 API 都有明确边界
4. **session / compaction / branch 是产品能力**：不是 demo agent，而是长期使用系统

## 要主动承认的限制

1. **没有 streaming tool execution**
2. **没有 Claude Code 那种分区工具调度**
3. **compaction 有，但比 Claude Code 简化**
4. **很多高级能力依赖扩展层，不是默认全内建**

这段不要逃。你不主动讲，面试官反而会怀疑你在吹。

## 最容易讲错的 8 个点

1. 不要说 Pi 完全没有 tool-level `executionMode`
2. 不要把当前 `executionMode` 夸成真正的分区批处理
3. 不要说 `convertToLlm()` 只在 `streamAssistantResponse()` 用一次
4. 不要说模型显式引用格式是 `provider:model`
5. 不要说 `tool_execution_end` 自带原始 `args`
6. 不要把扩展层 `tool_call` 和 agent 层 `beforeToolCall` 混成一回事
7. 不要说贡献 gate 是 `lgtmi` 再 `lgtm`
8. 不要把 JSON mode 和 RPC mode 的 stdout 契约讲成一回事

## 5 个高频追问的标准短答

### 1. 为什么要拆三层？

为了把 provider 差异、通用 agent loop、coding assistant 产品能力解耦。这样每层都能单独复用和演进。

### 2. Pi 的工具执行模型有什么特点？

先拿到完整 assistant message，再统一执行 tool call。默认并发策略由全局 `toolExecution` 控制；如果命中 `executionMode: "sequential"` 的工具，当前整批回退到串行。

### 3. Pi 的 compaction 在哪里控制？

不是直接塞进 `runLoop()`，而是由 `AgentSession._checkCompaction()` 在 session/runtime 层控制。

### 4. Pi 的扩展系统值钱在哪？

很多会污染核心的能力被外移成进程内 TypeScript 扩展，既有类型边界，又保留产品层灵活性。

### 5. 如果继续演进这个项目，你先看哪里？

- 更细粒度的工具调度
- streaming tool execution 的收益是否值得
- 文档与扩展体验

## print / json / rpc 一句话区别

- `print`：人类读输出
- `json`：机器读事件流；可先输出 session header，再逐行输出 `AgentSessionEvent`
- `rpc`：命令/响应/事件共用一条 JSONL stdout 通道，普通 `console.log` 会被重定向到 stderr

## 面试前 10 分钟复习顺序

1. 先背这份速记版
2. 再读 `14-interview-introduction.md` 练讲述
3. 最后抽查 `16-interview-question-bank.md`

## 结尾模板

> 我会把 `pi-mono` 看成一个把 agent 系统工程化得很干净的项目。它不靠把所有高级能力都塞进核心，而是把 provider 通信、通用 runtime 和 coding 产品能力拆成清楚层级。  
> 这让它在一些高级调度上没那么激进，但在边界、扩展性和长期演化上很有工程价值。
