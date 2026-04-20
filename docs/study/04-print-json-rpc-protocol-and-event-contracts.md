# print/json/rpc 模式与事件契约

> 源码对照:
> - `packages/coding-agent/src/main.ts`
> - `packages/coding-agent/src/modes/print-mode.ts`
> - `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
> - `packages/coding-agent/src/modes/rpc/rpc-types.ts`
> - `packages/coding-agent/src/modes/rpc/jsonl.ts`
> - `packages/coding-agent/src/core/output-guard.ts`
> - `packages/coding-agent/src/core/agent-session.ts`
> - `packages/agent/src/types.ts`
> - `packages/ai/src/types.ts`
> - 官方文档: `packages/coding-agent/docs/json.md`、`packages/coding-agent/docs/rpc.md`

这一章的重点不是“怎么用 CLI”，而是：

1. Pi 如何在 **interactive / print / json / rpc** 之间切换
2. stdout 上到底会出现什么
3. `AgentEvent`、`AgentSessionEvent`、`assistantMessageEvent` 三层事件怎么对应
4. 哪些字段**看起来像有，其实没有**

如果你要做 IDE 集成、脚本消费、协议面试题，或者只是想证明自己不是只会用 TUI，这一章必须补。

## 1. 四种 app mode 的真实分流

Pi 在 `main.ts` 里先解析 CLI 参数，然后根据 `resolveAppMode()` 决定运行模式：

```typescript
if (parsed.mode === "rpc") return "rpc";
if (parsed.mode === "json") return "json";
if (parsed.print || !stdinIsTTY) return "print";
return "interactive";
```

### 结论

| app mode | 触发条件 | 典型场景 |
|---|---|---|
| `interactive` | 默认，且 stdin 是 TTY | 正常终端交互 |
| `print` | `-p/--print` 或 stdin 非 TTY | 单次执行、shell 脚本 |
| `json` | `--mode json` | 事件流消费、自定义 UI |
| `rpc` | `--mode rpc` | 长生命周期宿主进程 / IDE 集成 |

### 一个容易讲错的点

CLI help 里会显示：

```bash
--mode <mode>  Output mode: text (default), json, or rpc
```

但从 `resolveAppMode()` 的实现看，真正的 app mode 并没有单独的 `"text"` 分支。  
**非交互文本输出**在实现里更接近“进入 print 路径后，`PrintModeOptions.mode === "text"`”。

所以更准确的说法是：

- **`json` / `rpc`** 是明确的 app mode
- **文本输出**是 print 路径里的输出子模式

这不是用户层面的致命问题，但在源码级解释里要讲准。

## 2. stdout 为什么能保持机器可读

一旦进入非 interactive 模式，Pi 会尽早调用 `takeOverStdout()`。

它做的事很直接：

- 保存原始 `process.stdout.write`
- 把之后普通的 `process.stdout.write(...)` 重定向到 **stderr**
- 真正要写 machine-readable stdout 的地方，必须走 `writeRawStdout(...)`

### 这意味着什么

1. **JSON / RPC stdout 不会被普通 `console.log` 污染**
2. 调试输出通常会落到 stderr
3. 你如果在协议客户端里只读 stdout，就能把它当成受控通道

这个设计很重要，因为它解释了为什么 Pi 可以在同一个进程里同时：

- 保持 JSONL / 协议输出干净
- 又允许内部日志继续存在

## 3. Print 模式到底输出什么

Print 模式对应 `runPrintMode(...)`。

它做的不是“启动一个迷你 TUI”，而是：

1. 创建 / 绑定 session
2. 发送 `initialMessage`
3. 依次发送额外的 `messages`
4. 按输出子模式写 stdout
5. 退出

### `text` 子模式

`text` 模式不会流式吐 token。  
它会在所有 prompt 完成后，拿当前 session state 的**最后一条 assistant message**，然后：

- 如果 `stopReason === "error"` 或 `"aborted"`：写 stderr，并返回非零 exit code
- 否则：只把 assistant message 中的 **text blocks** 写到 stdout

### `json` 子模式

`json` 模式和 `text` 最大的区别是：它不会只打印最终答案，而是把 session 订阅到的事件逐行写到 stdout。

顺序是：

1. 如果有 session header，先输出一行 header
2. 然后每个 `AgentSessionEvent` 一行 JSON

### JSON 模式的第一行不是普通事件

JSON print 模式的第一行可能长这样：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

这来自 `sessionManager.getHeader()`，**不是** `AgentSessionEvent` union 的一部分。  
后面才是 `agent_start`、`message_update`、`tool_execution_end` 这些事件。

如果有人把“session header”和“事件流”混成一个类型系统，那说明他没有真正读过实现。

## 4. RPC 模式不是“JSON print 的别名”

RPC 模式和 JSON print 都走 JSONL，但它们不是一回事。

### JSON print

- 你给一个 prompt
- Pi 跑完
- stdout 持续吐 session 事件
- 进程结束

它更像：**一次性任务的事件流输出**

### RPC

- Pi 作为长生命周期子进程常驻
- stdin 接收命令
- stdout 同时输出：
  - `response`
  - `AgentSessionEvent`
  - `extension_ui_request`

它更像：**一个 headless agent server**

## 5. RPC 的协议分三层，不要混

### 第一层：命令（stdin）

客户端发到 stdin 的，是 `RpcCommand` JSONL。

典型命令包括：

- `prompt`
- `steer`
- `follow_up`
- `abort`
- `get_state`
- `set_model`
- `compact`
- `get_messages`
- `bash`

所有命令都可以带可选 `id`，用于 request/response 关联。

### 第二层：响应（stdout）

大多数命令会返回：

```json
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{...}}
```

失败时：

```json
{"id":"req-1","type":"response","command":"set_model","success":false,"error":"..."}
```

### 第三层：事件（stdout）

除了 `response`，stdout 还会继续流出 session 事件：

- `agent_start`
- `message_update`
- `tool_execution_start`
- `tool_execution_end`
- `queue_update`
- `compaction_end`
- `auto_retry_start`
- ...

### 关键点

**RPC 的 stdout 不是只有一种消息。**  
它是一个混合通道：

1. `response`
2. `AgentSessionEvent`
3. `extension_ui_request`
4. `extension_error`

如果客户端只按“所有 stdout 行都是事件”去解析，会直接做错。

## 6. `prompt` 的成功响应不等于任务完成

这是 RPC 最容易误解的一点。

`prompt` 命令的处理是：

- 调用 `session.prompt(...)`
- **不等待整个 agent run 完成**
- 立即返回 `success`
- 后续 streaming / tool execution / agent_end 通过事件异步输出

所以：

```json
{"type":"response","command":"prompt","success":true}
```

只表示：

> “这个 prompt 命令被成功接收并启动了”

不表示：

> “assistant 已经回答完了”

真正的完成，需要你自己看事件流，比如 `agent_end`、`message_end`、或者根据你的 UI/宿主逻辑做收敛。

## 7. `AssistantMessageEvent`、`AgentEvent`、`AgentSessionEvent` 三层到底是什么

这是这一章最重要的部分。

### 第一层：`AssistantMessageEvent`

定义在 `packages/ai/src/types.ts`。  
它描述的是**单次 assistant 流式生成内部的 token / block / toolcall 协议**。

包括：

- `start`
- `text_start` / `text_delta` / `text_end`
- `thinking_start` / `thinking_delta` / `thinking_end`
- `toolcall_start` / `toolcall_delta` / `toolcall_end`
- `done`
- `error`

这层是 **provider/stream 协议层**。

### 第二层：`AgentEvent`

定义在 `packages/agent/src/types.ts`。  
它描述的是 **agent loop 自己的生命周期**：

- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

这层是 **agent runtime 层**。

### 第三层：`AgentSessionEvent`

定义在 `packages/coding-agent/src/core/agent-session.ts`。  
它等于：

- `AgentEvent`
- 再加 session 自己的事件：
  - `queue_update`
  - `compaction_start`
  - `compaction_end`
  - `auto_retry_start`
  - `auto_retry_end`

这层是 **产品 / session 层**。

## 8. `message_update` 为什么最容易让人讲乱

`message_update` 是顶层 `AgentEvent`。  
但它内部又带着一个字段：

```typescript
assistantMessageEvent
```

也就是说：

- 顶层 `type === "message_update"`
- 真正的流式 delta 类型在 `assistantMessageEvent.type`

例如：

```json
{
  "type": "message_update",
  "message": {...},
  "assistantMessageEvent": {
    "type": "toolcall_end",
    ...
  }
}
```

### 结论

下面这句话是错的：

> “JSON 模式里会直接出现顶层 `toolcall_start` / `toolcall_end` 事件。”

更准确的是：

> 顶层仍然是 `message_update`；`toolcall_*` 是 `assistantMessageEvent.type`

## 9. `toolcall_*` 和 `tool_execution_*` 不是同一件事

这两个名字很像，但层次完全不同。

### `toolcall_*`

这是 assistant 在**生成 tool call 本身**时的流式事件。

例如：

- tool call block 开始生成
- arguments JSON 逐步增长
- tool call 完整闭合

它属于：

- `AssistantMessageEvent`
- 出现在 `message_update.assistantMessageEvent.type`

### `tool_execution_*`

这是工具已经开始跑之后的运行事件。

例如：

- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`

它属于：

- 顶层 `AgentEvent`
- 会直接出现在 JSON / RPC 事件流里

### 面试时最稳的一句话

> `toolcall_*` 说明“模型正在定义一个工具调用”，`tool_execution_*` 说明“runtime 已经开始执行那个工具”。

## 10. 哪些字段真的有，哪些只是你以为有

### `tool_execution_start`

有：

- `toolCallId`
- `toolName`
- `args`

### `tool_execution_update`

有：

- `toolCallId`
- `toolName`
- `args`
- `partialResult`

### `tool_execution_end`

有：

- `toolCallId`
- `toolName`
- `result`
- `isError`

**没有 `args`。**

所以如果你想按参数追踪一个工具调用，不能在 `tool_execution_end` 里直接拿 `args`，而应该：

1. 在 `tool_execution_start` 里记住 `toolCallId -> args`
2. 再在 `tool_execution_end` 里按 `toolCallId` 对回来

这是当前文档里最容易让人写错消费代码的点之一。

## 11. 时间戳不要乱假设

Pi 的消息里经常有 `timestamp`，但**事件不是统一顶层都带 timestamp**。

所以：

- 不能默认每一条 JSON 事件都有顶层 `timestamp`
- 如果你要做时序分析，最稳的是：
  - 自己在消费端记录 wall-clock
  - 或者基于事件顺序 / `toolCallId` / message content 关联

这也是为什么很多“拿 JSONL 做简单时间分析”的脚本很容易写歪。

## 12. RPC 为什么强调 strict JSONL

`jsonl.ts` 明确写了：

- 记录分隔符只认 `\n`
- 可接受输入里的 `\r\n`（会去掉结尾 `\r`）
- 不要用会把 `U+2028` / `U+2029` 也当换行的通用 line reader

### 为什么这重要

因为这些 Unicode 分隔符在 JSON 字符串里是合法内容。  
如果客户端随手用一个“不是真正 JSONL 语义”的行读取器，就可能把一条合法 JSON 错切成两条。

这就是 `rpc.md` 里专门点名不建议直接用 Node `readline` 的原因。

## 13. Extension UI 在 RPC 里是一个子协议

RPC 不是只有 prompt / response / events。

扩展如果调用：

- `ctx.ui.select()`
- `ctx.ui.confirm()`
- `ctx.ui.input()`
- `ctx.ui.editor()`

RPC 模式会在 stdout 发：

```json
{"type":"extension_ui_request", ...}
```

客户端再通过 stdin 回：

```json
{"type":"extension_ui_response", "id":"...", ...}
```

### 这意味着

1. RPC 宿主不只是“读事件”，还可能要承担 UI 代理职责
2. `ctx.hasUI` 在 RPC 下仍然可以是 `true`
3. 但很多真正依赖 TUI 的能力会降级或变成 no-op

所以 RPC 更像：

> “协议化的 headless 宿主接口”

而不是：

> “把 interactive TUI 原封不动搬到别的地方”

## 14. JSON 模式 vs RPC 模式：该怎么选

### 选 JSON print

如果你要的是：

- 一次性任务
- 简单脚本集成
- 记录事件流
- 不需要主动发多个命令

就用：

```bash
pi --mode json "..."
```

### 选 RPC

如果你要的是：

- 长生命周期 agent 进程
- 宿主主动驱动 session
- 多轮 `prompt` / `steer` / `follow_up`
- 读写状态、切 session、fork、compact、bash
- 处理扩展 UI 子协议

就用：

```bash
pi --mode rpc
```

### 选 `AgentSession`

如果你本来就是 Node/TypeScript 宿主，甚至不一定要 subprocess。  
官方 `rpc.md` 也明确建议：

> 如果你是 Node.js/TypeScript 应用，优先考虑直接用 `AgentSession`

也就是说，RPC 更像“给外部宿主 / 跨进程集成”的协议层。

## 15. 最容易被面试官追问的 6 个坑

1. `toolcall_*` 在哪里？  
   不在顶层 event type，在 `message_update.assistantMessageEvent.type`

2. `tool_execution_end` 有没有 `args`？  
   没有

3. JSON 模式第一行是不是事件？  
   可能不是，是 session header

4. `prompt` 的 RPC success 是不是表示任务完成？  
   不是，只表示请求已成功接收/启动

5. RPC stdout 里是不是只有事件？  
   不是，还有 `response`、`extension_ui_request`、`extension_error`

6. stdout 为什么能保持协议干净？  
   因为非 interactive 模式会启用 `output-guard`

## 16. 这一章和其他章节怎么配合

- `03-coding-agent-layer.md`  
  负责讲“有哪些模式、分别干什么”

- **本章**
  负责讲“这些模式的 stdout/stderr、JSONL、事件层次、字段契约到底是什么”

- `05-call-graph-and-dependencies.md`
  负责把 mode / session / loop / tool execution 放回整体调用图里

- `14-interview-introduction.md`
  负责把这些事实压缩成面试时能讲出口的话术

## 17. 一句话总结

如果你要用一句话讲清这章：

> Pi 的 `print/json/rpc` 不是三个“输出格式开关”，而是三种不同的宿主契约：`print` 面向一次性执行，`json` 面向事件流消费，`rpc` 面向长生命周期协议驱动；理解它们的关键，不是命令名，而是 stdout 上到底流过哪几层对象。
