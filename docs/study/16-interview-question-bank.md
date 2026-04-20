# 面试问答库：`pi-mono`

这份文档不是“背答案模板”，而是帮你应对两类场景：

1. 面试官让你解释项目结构和设计取舍
2. 面试官开始试探你有没有真的看过代码

建议用法：

- 先自己口头回答
- 再对照这里的“标准答法”
- 最后看“面试官在试探什么”

## A. 架构定位题

### Q1. 为什么要拆成三层？直接在一个包里写完不行吗？

**标准答法：**

可以写在一个包里，但那样 provider 适配、通用 agent loop、coding assistant 产品能力会强耦合。  
`pi-mono` 把这三类复杂度拆开之后，`pi-ai` 可以独立复用，`agent-core` 可以服务非 coding 场景，而 `coding-agent` 可以专心做工具、会话、扩展和交互。

**面试官在试探什么：**

你有没有理解作者是在拆“复杂度边界”，而不是只是在拆目录。

### Q2. `agent-core` 和 `coding-agent` 的边界怎么理解？

**标准答法：**

`agent-core` 负责“agent 怎么循环”，`coding-agent` 负责“agent 用什么工具工作、怎么持久化、怎么和用户交互”。  
前者是通用执行引擎，后者是领域化产品层。

**面试官在试探什么：**

你能不能说清楚 runtime 和 product layer 的分工，而不是把所有东西都归成“agent”。

### Q3. `pi-ai` 这一层的价值是什么？为什么不让 `agent-core` 直接对接 provider？

**标准答法：**

`pi-ai` 把 provider 调用、流式事件、模型定义和配置解析统一起来，屏蔽 provider 差异。  
如果让 `agent-core` 直接对接 provider，agent loop 本身就会被 Anthropic / OpenAI / Gemini 这些具体协议细节污染。

**面试官在试探什么：**

你有没有理解 provider 抽象层存在的真正原因，是隔离模型通信复杂度。

## B. Runtime 与工具机制题

### Q4. Pi 的工具执行模型有什么特点？

**标准答法：**

Pi 是先拿到完整 assistant message，再统一进入工具执行阶段。  
默认路径由全局 `toolExecution` 控制；如果当前这批 tool call 里命中了某个 `executionMode: "sequential"` 的工具，整批会回退到串行执行。  
它没有 streaming tool execution，也没有 Claude Code 那种按工具安全性切块的分区调度。

**面试官在试探什么：**

你是不是只会泛泛地说“支持并发”，还是知道当前实现其实是一个粗粒度模型。

### Q5. Pi 现在支持 per-tool 并发模式吗？

**标准答法：**

支持一个**很粗粒度**的版本：工具类型上已经有 `executionMode` 字段。  
如果全局是 `parallel`，但这批 tool call 里命中了某个 `executionMode: "sequential"` 的工具，当前整批会回退到 `executeToolCallsSequential()`。  
但它还不支持 `[并行块] -> [串行块] -> [并行块]` 这种分区批处理，也没有更细的并发安全语义。

**面试官在试探什么：**

你有没有真的读过 `agent-loop.ts` 那层 `hasSequentialToolCall` 判断。

### Q6. `beforeToolCall` 和扩展层 `tool_call` 是一回事吗？

**标准答法：**

不是。  
agent-core 的 `beforeToolCall` 是 agent hook，接收结构化 context，能返回 `{ block, reason }`，也能通过改写传入的 `args` 影响后续执行。  
coding-agent 扩展层的 `tool_call` 是另一套扩展事件机制：它改的是 `event.input`，并通过扩展 runner 的返回值表达 block / reason。两层都可能改参，但不是同一层契约。

**面试官在试探什么：**

你会不会把公开 runtime hook 和产品层扩展桥接实现混成一团。

### Q7. 同一文件的多个 edit 为什么不会再互相覆盖？

**标准答法：**

因为 `edit` / `write` 的 read-modify-write 关键区被 `withFileMutationQueue()` 包起来了。  
同一路径的内部 tool mutation 会按 FIFO 串行化，所以后一个 edit 会基于前一个 edit 已写回的最新内容继续执行。  
但它解决的是**内部并发竞态**，不是外部进程改文件的问题；外部修改仍然缺少 mtime/hash 级冲突检测。

**面试官在试探什么：**

你能不能区分“内部串行化”和“真正的 optimistic locking”。

### Q8. Pi 的工具系统是“直接塞一个 `AgentTool` 对象”吗？

**标准答法：**

从 `agent-core` 的运行时视角看，最终用的确实是 `AgentTool`。  
但在 `coding-agent` 这一层，主流建模方式已经是 definition-first：先写 `ToolDefinition`，再通过 `wrapToolDefinition(...)` 暴露成 `AgentTool`。  
这样更方便挂 `prepareArguments`、UI 渲染和扩展层元数据。

**面试官在试探什么：**

你有没有分清运行时接口和产品层建模方式。

## C. Session / Compaction / Protocol 题

### Q9. Pi 什么时候会做 compaction？只在 agent turn 结束后吗？

**标准答法：**

不只。`AgentSession._checkCompaction()` 会在 `agent_end` 之后检查，也会在发送新的用户消息前检查。  
这样可以覆盖 threshold、aborted、overflow 等路径。  
如果发生 context overflow，Pi 会做 compact-and-retry，但不是 Claude Code 那种多层 PTL 恢复体系。

**面试官在试探什么：**

你是不是只会复述“Pi 有 compaction”，却不知道它的触发点在 session/runtime 层。

### Q10. `convertToLlm()` 只在 `streamAssistantResponse()` 里用一次吗？

**标准答法：**

主调用边界确实在 `streamAssistantResponse()`，因为每次发给模型前都要转换。  
但不是“全项目只在那里用一次”。compaction / summarization 相关路径也会复用 `convertToLlm()`。

**面试官在试探什么：**

你有没有把“主要入口”误讲成“唯一入口”。

### Q11. JSON mode 和 RPC mode 的 stdout 契约有什么区别？

**标准答法：**

JSON mode 面向机器消费事件流；如果有 session header，会先输出 `sessionManager.getHeader()`，之后逐行输出 `AgentSessionEvent`。  
RPC mode 则把命令响应、运行时事件和 `extension_ui_request` 都放在同一条 JSONL stdout 通道里。  
为了保持 stdout 可机读，`output-guard.ts` 会在非 interactive 模式下接管 stdout，把普通 `console.log` 重定向到 stderr。

**面试官在试探什么：**

你有没有真的理解 `print/json/rpc` 不是“同一套输出换个壳”。

### Q12. `tool_execution_end` 事件里能直接拿到原始 `args` 吗？

**标准答法：**

不能。`tool_execution_end` 里有 `toolCallId`、`toolName`、`result`、`isError`，但没有 `args`。  
如果你要按文件或参数关联，应该在 `tool_execution_start` 里记录 `toolCallId -> args`，再和 `tool_execution_end` 对上。

**面试官在试探什么：**

你有没有真看过事件类型，而不是凭直觉猜 payload。

## D. 贡献与演进题

### Q13. `--model` 的显式 provider 形式是什么？

**标准答法：**

canonical 形式是 `provider/model[:thinking]`，例如 `anthropic/claude-sonnet-4:high`。  
不要讲成 `provider:model`。

**面试官在试探什么：**

你到底是看过 `model-resolver.ts`，还是只是在用经验猜。

### Q14. Pi 的贡献 gate 是什么？是 `lgtmi` 还是 `lgtm`？

**标准答法：**

当前仓库文档写得很明确：对 first-time / new contributors，先开 issue，拿到 maintainer `lgtm`，再继续提 PR。  
如果你讲成“先 `lgtmi` 再 `lgtm`”，那是在讲当前仓库并没有明确写出的另一套流程。

**面试官在试探什么：**

你有没有把历史口径、别的仓库经验和当前仓库规则混在一起。

### Q15. 如果继续演进这个项目，你会优先看哪里？

**标准答法：**

我会优先看 3 个方向：

1. 工具调度粒度：是否把当前 coarse `executionMode` 提升成真正的分区批处理
2. 工具执行性能：是否值得引入 streaming tool execution
3. 文档与扩展体验：让已有强能力更容易被正确使用

**面试官在试探什么：**

你能不能基于现有代码边界提出下一步，而不是空谈“加更多功能”。

## 最后抽查

如果你在面试前只做一次自测，至少确认自己能不看文档答出下面 6 个问题：

1. 三层边界分别是什么
2. 一次请求从 `AgentSession.prompt()` 到 tool result 回流怎么走
3. 当前 `executionMode` 到底支持了什么、没支持什么
4. compaction 什么时候触发
5. JSON / RPC 的 stdout 契约差异
6. 哪些说法现在绝对不能讲错

答不顺，就别自欺欺人说“我已经熟了”。
