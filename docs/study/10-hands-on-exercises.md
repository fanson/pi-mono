# 实战练习：验证你的理解

通过这些练习，你可以验证自己是否真正理解了项目架构。
每个练习都对应一个真实的贡献场景。

## 练习 1: 追踪一次完整的 edit 调用

**目标**: 从用户输入追踪到文件被修改的完整路径。

**步骤**:
1. 打开 `packages/agent/src/agent-loop.ts`，找到 `executeToolCallsParallel()` 函数
2. 跟踪这个调用链:
   - LLM 返回了 `{ type: "toolCall", name: "edit", arguments: { path, oldText, newText } }`
   - `prepareToolCall()` 做了什么？（找到工具、验证参数、运行 beforeToolCall 钩子）
   - `executePreparedToolCall()` 调用的是哪个函数？
3. 跳到 `packages/coding-agent/src/core/tools/edit.ts`，从 `execute` 方法开始读
4. 注意：当前 `edit.ts` 的 `execute` 方法直接调用 `ops.readFile` → 替换 → `ops.writeFile`，
   没有并发保护。这就是 #2327 竞态条件 bug 的根源。

**验证问题**:
- Q: 如果 LLM 同时返回 3 个 edit 调用（同一文件），当前（main）会发生什么？
- A: 准备阶段按顺序（A→B→C），执行阶段并发启动——三个 edit 同时读取文件，
  各自基于相同的原始内容做替换，后写入的覆盖先写入的，导致编辑丢失。
  这就是 TOCTOU（Time-of-Check-to-Time-of-Use）竞态条件。

- Q: PR #2327 的 `withFileLock` 如何解决这个问题？
- A: 在 execute 阶段，同一文件的操作通过 Promise 链串行化（FIFO），
  不同文件仍然完全并行。

**动手**: 阅读 `packages/coding-agent/src/core/tools/edit.ts` 的 `execute` 方法，
找到 read-modify-write 的三步操作，理解为什么并发执行会丢失编辑。

---

## 练习 2: 理解 convertToLlm 边界

**目标**: 理解为什么 `AgentMessage` 不能直接发给 LLM。

**步骤**:
1. 打开 `packages/coding-agent/src/core/messages.ts`
2. 找到 `convertToLlm()` 函数
3. 看 `bashExecution` 类型是怎么被转换的
4. 再看 `compactionSummary` 类型是怎么被包裹在 `<summary>` 标签中的

**验证问题**:
- Q: 如果你新增一个自定义消息类型 `"codeReview"`，需要改哪些文件？
- A: 三步:
  1. 在 `messages.ts` 中定义 `CodeReviewMessage` 接口
  2. 在 `declare module` 块中添加到 `CustomAgentMessages`
  3. 在 `convertToLlm()` 的 switch 中添加 case，决定如何映射为 `user` 消息

- Q: 如果你忘了在 `convertToLlm()` 添加 case 会怎样？
- A: 该消息会被 `default` 分支过滤掉（返回 undefined），LLM 永远看不到它。

---

## 练习 3: 追踪 steering 消息

**目标**: 理解 steering 和 follow-up 的区别。

**步骤**:
1. 打开 `packages/agent/src/agent-loop.ts`
2. 找到 `runLoop()` 函数（约第 155 行）
3. 跟踪:
   - `getSteeringMessages()` 在哪里被调用？（内层循环末尾，每个 turn 之后）
   - `getFollowUpMessages()` 在哪里被调用？（外层循环末尾，agent 本来要停止时）
4. 打开 `packages/agent/src/agent.ts`，看 `dequeueSteeringMessages()` 的 `one-at-a-time` 模式

**验证问题**:
- Q: 用户在 agent 执行工具时按了 Enter 输入了一条消息，这条消息什么时候被处理？
- A: agent 完成当前 turn 的所有工具调用后，在 `turn_end` 之后调用 `getSteeringMessages()`
  获取到这条消息，注入到下一个 turn 的开始。工具调用不会被中断。

---

## 练习 4: EventStream 内部机制

**目标**: 理解推送式异步迭代的工作原理。

**步骤**:
1. 打开 `packages/ai/src/utils/event-stream.ts`
2. 完整阅读 `EventStream` 类（约 65 行）
3. 模拟这个场景:
   ```
   const stream = new EventStream(e => e === "end", e => e)
   
   // 生产者 (async):
   stream.push("a")     // queue: ["a"], waiting: []
   stream.push("b")     // queue: ["a", "b"], waiting: []
   
   // 消费者 (async):
   for await (const e of stream) {
     // 第一次: yield "a", queue: ["b"]
     // 第二次: yield "b", queue: []
     // 第三次: 没有数据，添加 resolver 到 waiting[]，阻塞
   }
   
   // 生产者继续:
   stream.push("c")     // waiting 有 resolver → 解除阻塞，yield "c"
   stream.push("end")   // done = true, finalResultPromise 解析
   // 消费者第四次: yield "end"
   // 下一次迭代: done = true → return（退出循环）
   ```

**验证问题**:
- Q: 如果 push 在消费者开始迭代之前发生，事件会丢失吗？
- A: 不会，它们被缓存在 `queue` 数组中。

- Q: `stream.result()` 什么时候 resolve？
- A: 当 `isComplete(event)` 返回 true 的事件被 push 时。对于
  `AssistantMessageEventStream`，是 `done` 或 `error` 事件。

---

## 练习 5: 写一个新工具（模拟 PR 贡献）

**目标**: 验证你是否能在正确的层添加新功能。

**场景**: 假设你要给 coding-agent 添加一个 `count` 工具，统计文件行数。

**需要修改的文件**:
1. `packages/coding-agent/src/core/tools/count.ts`（新建）
   ```typescript
   import type { AgentTool } from "@mariozechner/pi-agent-core"
   import { type Static, Type } from "@sinclair/typebox"
   import { readFile } from "fs/promises"
   import { resolveToCwd } from "./path-utils.js"
   
   const countSchema = Type.Object({
     path: Type.String({ description: "Path to the file" }),
   })
   
   export interface CountOperations {
     readFile: (absolutePath: string) => Promise<Buffer>
   }
   
   const defaultCountOperations: CountOperations = {
     readFile: (path) => readFile(path),
   }
   
   export function createCountTool(cwd: string, options?: {
     operations?: CountOperations
   }): AgentTool<typeof countSchema> {
     const ops = options?.operations ?? defaultCountOperations
     return {
       name: "count",
       label: "count",
       description: "Count the number of lines in a file",
       parameters: countSchema,
       execute: async (_toolCallId, { path }) => {
         const absolutePath = resolveToCwd(path, cwd)
         const content = await ops.readFile(absolutePath)
         const lines = content.toString("utf-8").split("\n").length
         return {
           content: [{ type: "text", text: `${path}: ${lines} lines` }],
           details: { lines },
         }
       },
     }
   }
   ```

2. `packages/coding-agent/src/core/tools/index.ts`
   - 导出 `createCountTool`
   - 在 `createAllTools()` 中添加

**验证问题**:
- Q: 为什么 `CountOperations` 是必要的？
- A: 可插拔操作模式。默认用本地 fs，但可以被替换为 SSH 远程操作或测试 mock。

- Q: 为什么不需要改 `packages/agent/` 的任何文件？
- A: 因为工具是领域特定的，属于 coding-agent 层。agent-core 通过 `AgentTool`
  接口使用工具，不需要知道具体工具的实现。

- Q: 如果用户通过扩展 block 了 `count` 工具会怎样？
- A: `prepareToolCall()` 中的 `beforeToolCall` 钩子返回 `{ block: true }`，
  agent-core 会生成一个错误的 `ToolResultMessage`，LLM 会看到工具被阻止。

---

## 练习 6: 理解 AgentSession 如何编排一切

**目标**: 理解 coding-agent 层如何把所有组件连接起来。

**步骤**:
1. 打开 `packages/coding-agent/src/core/agent-session.ts`
2. 找到构造函数，理解它做了什么:
   - 订阅 agent 事件
   - 设置 `setBeforeToolCall` / `setAfterToolCall`
   - 调用 `_buildRuntime()`
3. 找到 `_buildRuntime()`:
   - `createAllTools()` 创建所有工具
   - 加载扩展
   - 创建 `ExtensionRunner`
   - 构建系统提示词

**关键理解**: `AgentSession` 是"粘合层"。它不自己实现逻辑，而是把:
- agent-core 的循环
- coding-agent 的工具
- 扩展系统
- 会话持久化
- 上下文压缩

连接在一起。

**验证问题**:
- Q: `_agentEventQueue` 的作用是什么？
- A: 确保 `SessionManager` 已经持久化了 assistant 消息，
  然后再让扩展的 `tool_call` 处理器看到上下文。防止扩展看到不一致的状态。

---

## 综合验证：你是否准备好贡献 PR？

回答以下问题。如果能全部答对，说明你已经理解了项目架构：

1. **分层**: pi-ai、agent-core、coding-agent 各自的职责边界是什么？
2. **消息流**: `AgentMessage` 在什么时刻、通过什么函数被转换为 `Message`？
3. **工具执行**: 并行模式下，两个 edit 调用的三个阶段（prepare、execute、finalize）分别是串行还是并发？
4. **事件流**: `EventStream.push()` 在没有消费者时做什么？有消费者等待时做什么？
5. **扩展钩子**: `beforeToolCall` 返回 `{ block: true }` 后，循环做了什么？
6. **并发问题**: 当前 main 分支的 edit 工具在并行模式下有什么竞态条件？PR #2327 如何修复？
7. **steering vs follow-up**: 用户在工具执行期间发送的消息，什么时候被注入到上下文？
8. **Provider 契约**: 为什么 provider 不能 throw，必须把错误编码在 stream 事件中？
9. **声明合并**: 如果想添加一个新的自定义消息类型，需要修改 agent-core 的代码吗？
10. **convertToLlm**: 如果一个自定义消息类型没有在 `convertToLlm()` 中处理，会发生什么？

### 参考答案

1. pi-ai: LLM API 通信，不知道 agent/工具；agent-core: 循环控制+工具生命周期，不知道文件系统；coding-agent: 领域工具+扩展+会话
2. 在 `streamAssistantResponse()` 内部，通过 `config.convertToLlm(messages)` 转换，发生在每次 LLM 调用前
3. prepare: 串行；execute: 并发；finalize: 串行（按源顺序）
4. 没有消费者: 加入 `queue` 缓存；有消费者等待: 从 `waiting` 数组取出 resolver 直接 unblock
5. 生成一个错误内容的 `ToolResultMessage`，跳过 `executePreparedToolCall`，直接走 `emitToolCallOutcome`
6. edit 的 execute 做 read→modify→write 三步操作，并行模式下多个 edit 同时读取同一文件的旧内容，各自替换后写入，后写的覆盖先写的（TOCTOU）。PR #2327 用 `withFileLock`（Promise 链）串行化同一文件的操作
7. 在当前 turn 的所有工具调用完成后，`turn_end` 之后，通过 `getSteeringMessages()` 获取并注入到下一个 turn 开始
8. 因为 `streamSimple()` 的调用者期望同步收到一个 stream 对象。如果 provider throw，调用者无法获得 stream。错误必须通过 stream 事件传播，这样消费者才能统一处理
9. 不需要。通过 TypeScript 声明合并 (`declare module`)，在 coding-agent 或任何其他包中扩展 `CustomAgentMessages` 接口即可
10. 被 `default` 分支过滤（返回 undefined），消息被丢弃，LLM 永远看不到它。不会报错，只是静默丢失

---

## Phase 2 练习：工具系统

### 练习 7: edit 的模糊匹配

**目标**: 理解为什么 edit 有时能匹配到 LLM 提供的"不精确"文本。

**步骤**:
1. 打开 `packages/coding-agent/src/core/tools/edit-diff.ts`
2. 找到 `normalizeForFuzzyMatch()` 函数
3. 列出所有规范化操作（弯引号、Unicode 破折号、特殊空格等）

**验证问题**:
- Q: LLM 发送的 oldText 包含弯引号 `"hello"`，文件中是直引号 `"hello"`。edit 能匹配吗？
- A: 能。模糊匹配会把弯引号规范化为直引号。但副作用是：替换后文件中的其他弯引号也会被规范化。

- Q: 为什么唯一性检查在模糊规范化内容上进行？
- A: 因为两个区域如果只是在尾部空白或 Unicode 变体上不同，对 LLM 来说是"同一段文本"，需要报告为多次匹配让 LLM 提供更多上下文。

### 练习 8: bash 的进程管理

**目标**: 理解 bash 工具如何安全地管理子进程。

**步骤**:
1. 打开 `packages/coding-agent/src/core/tools/bash.ts`
2. 找到 `spawn` 调用，注意 `detached: true`
3. 找到 `killProcessTree` 函数

**验证问题**:
- Q: 为什么用 `detached: true`？
- A: 让子进程成为进程组 leader。这样 `kill(-pid)` 能杀死子进程和它启动的所有孙进程（例如 `npm test` 启动的 jest）。

- Q: 如果用户按下 Ctrl+C（abort），正在运行的 `npm install` 会怎样？
- A: Agent 调用 `agent.abort()` → signal.aborted = true → onAbort 回调 → killProcessTree(pid) → 整个进程组被 SIGKILL → close 事件 → reject("aborted") → LLM 看到 "Command aborted" 错误。

### 练习 9: truncateHead vs truncateTail

**目标**: 理解为什么不同工具使用不同的截断策略。

**验证问题**:
- Q: read 用 truncateHead（保留头部），bash 用 truncateTail（保留尾部）。为什么？
- A: read 的用户从文件开头读起，需要看到开始的内容（可以用 offset 继续）。bash 的错误和最终结果通常在输出末尾，保留尾部更有价值。

- Q: grep 的每行截断（500 字符）为什么单独处理？
- A: 日志文件中可能有极长的 JSON 行。如果不截断单行，一个匹配就能占满整个输出预算。

### 练习 10: 可插拔操作的实际应用

**目标**: 理解为什么所有工具都需要 Operations 接口。

**场景**: 假设你要实现通过 SSH 远程编辑文件。

**需要做的**:
1. 创建 `RemoteEditOperations`:
   ```typescript
   const remoteEditOps: EditOperations = {
     readFile: async (path) => {
       const { stdout } = await ssh.exec(`cat ${path}`)
       return Buffer.from(stdout)
     },
     writeFile: async (path, content) => {
       await ssh.exec(`cat > ${path}`, { stdin: content })
     },
     access: async (path) => {
       await ssh.exec(`test -r ${path} -a -w ${path}`)
     },
   }
   ```
2. 传入工具创建函数:
   ```typescript
   createEditTool(remoteCwd, { operations: remoteEditOps })
   ```

**验证问题**:
- Q: 工具内部的匹配逻辑和 diff 生成是否需要改变？
- A: 不需要。所有逻辑（normalizeToLF、fuzzyFindText、generateDiffString）操作的是内存中的字符串，与 I/O 无关。只有 readFile/writeFile/access 被替换。

---

## Phase 3 练习：扩展系统

### 练习 11: 写一个拦截扩展

**目标**: 理解 `tool_call` 事件如何阻止工具执行。

**场景**: 写一个扩展，阻止所有 `write` 调用写入 `*.md` 文件。

```typescript
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "write" && event.input.path?.endsWith(".md")) {
      return { block: true, reason: "Markdown files are read-only" }
    }
  })
}
```

**验证问题**:
- Q: 如果有两个扩展都监听 `tool_call`，扩展 A 返回 `{ block: true }`，扩展 B 不返回。最终结果是什么？
- A: 工具被阻止。`emitToolCall` 在第一个返回 `{ block: true }` 的处理器处停止遍历。

- Q: 如果 `tool_call` 处理器抛出异常会怎样？
- A: 异常会传播到 agent session（不被 try/catch 捕获），阻止工具执行。这是唯一不被错误处理包裹的事件。

### 练习 12: 理解 context 事件链

**目标**: 理解多个扩展如何链式修改上下文。

**场景**: 两个扩展都监听 `context` 事件。

```
扩展 A: 过滤掉超过 100 行的工具结果
扩展 B: 在每条用户消息前添加时间戳

执行顺序:
1. context 事件触发，messages = [原始消息]
2. 扩展 A 收到 messages → 过滤 → 返回 { messages: [过滤后] }
3. 扩展 B 收到 A 的结果 → 添加时间戳 → 返回 { messages: [最终] }
4. 最终 messages 发给 LLM
```

**验证问题**:
- Q: 如果扩展 B 在扩展 A 之前加载会怎样？
- A: 执行顺序反转。B 先处理，A 后处理。加载顺序决定事件处理顺序。

### 练习 13: 扩展持久化状态

**目标**: 理解 `appendEntry` 如何在会话中保存扩展状态。

**步骤**:
1. 阅读 `examples/extensions/tools.ts` 的实现
2. 理解它如何在 `session_start`、`session_tree`、`session_fork` 时恢复状态

**验证问题**:
- Q: 为什么需要在 `session_tree` 和 `session_fork` 时也恢复状态？
- A: 因为 session 支持分支。切换到不同分支或 fork 后，需要从该分支的历史中恢复扩展配置，而不是使用上一个分支的配置。

- Q: `appendEntry` 创建的条目在 `convertToLlm` 时会怎样？
- A: 自定义条目不是 `AgentMessage`，它们只存储在 `SessionManager` 中，不参与 LLM 上下文。

### 练习 14: 扩展发现机制

**目标**: 理解扩展是如何被发现和加载的。

**验证问题**:
- Q: 一个扩展放在 `cwd/.pi/extensions/my-ext/index.ts`，能被加载吗？
- A: 能。发现规则：子目录中的 `index.ts` 或 `index.js` 会被自动发现。

- Q: 一个扩展放在 `cwd/.pi/extensions/my-ext/lib/main.ts`，能被加载吗？
- A: 不能直接加载。需要在 `my-ext/package.json` 中配置 `{ "pi": { "extensions": ["lib/main.ts"] } }`。

- Q: 扩展可以 import pi-mono 的内部包吗？
- A: 可以。通过 jiti 的别名机制，扩展可以 import `@mariozechner/pi-coding-agent`、`@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`、`@sinclair/typebox` 等。

---

## Phase 4 练习：压缩与会话

### 练习 15: 追踪压缩触发

**目标**: 理解压缩何时触发以及如何决定保留哪些消息。

**步骤**:
1. 打开 `packages/coding-agent/src/core/compaction/compaction.ts`
2. 找到 `shouldCompact()` 和 `findCutPoint()`
3. 模拟场景：128K 上下文窗口，当前对话 115K token

**验证问题**:
- Q: 128K 窗口、16K reserveTokens、20K keepRecentTokens。当前 115K token。触发压缩吗？
- A: 是。115K > 128K - 16K = 112K。

- Q: 压缩后保留多少 token 的近期消息？
- A: 约 20K token（keepRecentTokens）。从最新消息往回走，累积到 20K 时切割。

- Q: 为什么不能在 toolResult 处切割？
- A: 因为 toolResult 属于前一个 assistant 消息的工具调用。如果切在工具调用和结果之间，LLM 会看到一个没有结果的工具调用，或者一个没有对应调用的结果。

### 练习 16: 理解会话树

**目标**: 理解 parentId 如何构成树形结构。

**模拟场景**:
```
条目 A (parentId: null)  — user: "fix bug"
  └── 条目 B (parentId: A)  — assistant: "I'll edit..."
       ├── 条目 C (parentId: B)  — toolResult: "done"
       │    └── 条目 D (parentId: C)  — user: "good"  ← 分支 1
       └── 条目 E (parentId: B)  — toolResult: "error" ← 分支 2
            └── 条目 F (parentId: E)  — user: "try again"
```

**验证问题**:
- Q: `getBranch("D")` 返回什么？
- A: [A, B, C, D]（从 root 到 leafId 的路径）

- Q: `getBranch("F")` 返回什么？
- A: [A, B, E, F]（另一条路径，不包含 C 和 D）

- Q: `getEntries()` 返回什么？
- A: [A, B, C, D, E, F]（所有条目，按追加顺序）

- Q: 切换分支时（从 D 到 F），LLM 看到的上下文是什么？
- A: buildSessionContext 使用 `getBranch("F")` 的路径 [A, B, E, F] 构建上下文。LLM 看不到 C 和 D。

### 练习 17: 压缩后的上下文构建

**目标**: 理解 compaction 条目如何影响发给 LLM 的消息。

**场景**:
```
条目 1-50: 原始对话
条目 51: compaction { summary: "...", firstKeptEntryId: "条目30" }
条目 52-60: 新对话
```

**验证问题**:
- Q: `buildSessionContext` 输出什么？
- A:
  1. CompactionSummaryMessage（摘要内容）
  2. 条目 30-50 的消息（firstKeptEntryId 到 compaction 之间保留的）
  3. 条目 52-60 的消息（compaction 之后的新对话）
  4. 条目 1-29 的消息被丢弃（已被摘要替代）

- Q: 旧条目 1-29 从 JSONL 文件中删除了吗？
- A: 没有。JSONL 是 append-only 的。条目保留在文件中，只是在构建上下文时不再包含。这保证了会话文件的完整性（可以用于审计或回溯）。

---

## Phase 5 练习：CLI 入口、运行模式与基础设施

### 练习 18: 追踪 main() 启动流程

**目标**: 理解从 `pi "fix the bug"` 到 agent 开始工作的完整路径。

> **源码对照**: `packages/coding-agent/src/main.ts` — main() L623

**步骤**:
1. 打开 `packages/coding-agent/src/main.ts`，找到 `main()` 函数
2. 注意**两次参数解析**模式：
   - 第一次 `parseArgs(args)` 获取 `--extension` 路径
   - 加载资源后，第二次 `parseArgs(args, extensionFlags)` 识别扩展定义的 CLI 标志
3. 跟踪到 `buildSessionOptions()` → `createAgentSession()` → 模式选择

**验证问题**:
- Q: 为什么需要两次参数解析？
- A: 扩展可以注册自定义 CLI 标志（如 `--my-ext-debug`）。第一次解析获取扩展路径并加载扩展，扩展注册标志后，第二次解析才能识别这些标志。

- Q: `pi -p "fix bug"` 和 `echo "fix bug" | pi` 走同一个模式吗？
- A: 是。管道输入时强制进入 print 模式（检测到 stdin 非 TTY 时设置 print mode）。

### 练习 19: 理解三种运行模式的差异

**目标**: 理解 Interactive、Print、RPC 模式的选择逻辑和职责。

**步骤**:
1. 在 `main()` 末尾找到模式选择分支
2. 分别打开三个入口：
   - `src/modes/interactive/interactive-mode.ts` — InteractiveMode L144
   - `src/modes/print-mode.ts` — runPrintMode L30
   - `src/modes/rpc/rpc-mode.ts` — runRpcMode L45

**验证问题**:
- Q: 在 RPC 模式下，谁负责显示输出？
- A: pi 本身不显示任何内容。所有 AgentEvent 作为 JSON Lines 写到 stdout，客户端（如 IDE 插件）负责 UI 渲染。

- Q: Print 模式和 Interactive 模式在 session 持久化上有区别吗？
- A: 没有核心区别。两者都使用 `SessionManager` 持久化。但 print 模式通常是单次执行，不进入交互循环。

### 练习 20: 理解模型解析

**目标**: 理解 `pi --provider anthropic --model sonnet` 如何解析为具体模型。

> **源码对照**: `packages/coding-agent/src/core/model-resolver.ts` — resolveCliModel L328

**步骤**:
1. 打开 `src/core/model-resolver.ts`
2. 跟踪 `resolveCliModel()` 的搜索流程:
   - `parseModelPattern("sonnet")` → 无 provider 前缀
   - `findExactModelReferenceMatch()` → 精确匹配
   - `resolveModelScope()` → 模糊搜索所有 provider

**验证问题**:
- Q: `pi --model "anthropic:claude-sonnet-4:high"` 中的 `:high` 被谁消费？
- A: `parseModelPattern()` 解析为 `{ provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "high" }`。thinkingLevel 传递给 agent-core 的 streamOptions。

- Q: 如果没有指定任何模型，默认用什么？
- A: `findInitialModel()` 从 `defaultModelPerProvider` 中按顺序查找第一个有 API key 的 provider 的默认模型。

### 练习 21: 写一个 Skill（模拟贡献）

**目标**: 理解 skill 的发现、验证和调用机制。

> **源码对照**: `packages/coding-agent/src/core/skills.ts` — loadSkillsFromDir L147

**场景**: 创建一个 `code-review` skill。

**步骤**:
1. 创建目录结构：
   ```
   .pi/skills/code-review/
   └── SKILL.md
   ```

2. 编写 SKILL.md：
   ```markdown
   ---
   name: code-review
   description: Guides the agent through a structured code review process
   ---

   # Code Review Skill

   When reviewing code, follow this process:
   1. Read the changed files
   2. Check for common issues...
   ```

**验证问题**:
- Q: 如果目录名是 `code_review` 但 frontmatter 中 `name: code-review`，会怎样？
- A: 验证失败。名称必须等于父目录名。

- Q: `disable-model-invocation: true` 会有什么效果？
- A: skill 描述不出现在系统提示词中，模型无法自动发现和使用它。只能通过 `/skill:code-review` 命令手动调用。

- Q: Skill 被模型调用时，实际发生了什么？
- A: 模型看到 skill 描述后，使用 `read` 工具读取 SKILL.md 的完整内容。Skill 本身不是代码，是指导模型行为的知识文档。

### 练习 22: Settings 优先级

**目标**: 理解全局和项目级配置的合并行为。

> **源码对照**: `packages/coding-agent/src/core/settings-manager.ts` — deepMergeSettings L100

**场景**:
```json
// ~/.pi/agent/settings.json (全局)
{
  "defaultProvider": "anthropic",
  "compaction": { "keepRecentTokens": 20000, "reserveTokens": 16000 }
}

// {cwd}/.pi/settings.json (项目)
{
  "compaction": { "keepRecentTokens": 40000 }
}
```

**验证问题**:
- Q: 合并后 `compaction.reserveTokens` 的值是什么？
- A: 16000。`deepMergeSettings` 递归合并嵌套对象。项目级只覆盖了 `keepRecentTokens`，`reserveTokens` 保留全局值。

- Q: 如果项目级设置 `"defaultProvider": "openai"`，最终 provider 是什么？
- A: `"openai"`。项目级覆盖全局级。原始值 `"anthropic"` 被替换。

- Q: Settings 的读写为什么用 `proper-lockfile`？
- A: 因为多个 pi 实例可能同时运行在同一目录，需要跨进程的文件锁防止并发写入损坏 JSON。

### 练习 23: Prompt Cache 的 Provider 差异

**目标**: 理解不同 Provider 实现 prompt cache 的方式差异。

> **源码对照**: `packages/ai/src/providers/anthropic.ts` — getCacheControl L49

**验证问题**:
- Q: Anthropic 和 OpenAI 的缓存机制有什么根本区别？
- A: Anthropic 使用 `cache_control` 标记特定消息块作为缓存断点。OpenAI 使用 `prompt_cache_key`（session 级别）让相同前缀的消息自动缓存。Anthropic 更精细（块级），OpenAI 更粗放（session 级）。

- Q: `CacheRetention` 的 `"short"` 和 `"long"` 有什么区别？
- A: 取决于 Provider。Anthropic 中 short 使用 `ephemeral`（约 5 分钟），long 使用 `persistent`（付费持久化）。Bedrock 中 long 使用 `TTL: ONE_HOUR`。

- Q: 用户如何通过环境变量启用持久缓存？
- A: 设置 `PI_CACHE_RETENTION=long`。所有 Provider 的 `resolveCacheRetention()` 都会检查这个环境变量。
