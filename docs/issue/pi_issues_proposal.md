# Pi Mono 改进提案 — 最终评估

基于对 Claude Code 与 Pi Mono 的深度对比分析，以及对 Pi 现有机制、设计哲学、代码路径的**逐一验证**后的最终结论。

## Pi 的设计哲学

> "pi's core is minimal. If your feature doesn't belong in the core, it should be an extension."
> — CONTRIBUTING.md

Pi 故意选择了 minimal core + extensibility 路线。很多 Claude Code 有而 Pi 没有的特性，不是"缺陷"，而是**设计选择**。以下评估严格区分：
- **真正的 bug**：代码行为违反了其自身的预期语义
- **安全/可靠性缺陷**：可能导致数据丢失或系统挂起
- **设计增强**：Claude Code 做得更好，但 Pi 的做法不算"错"

---

## ✅ 推荐提交的 Issue（有明确证据，高价值）

### 🥇 Issue 9: Bash 非零退出码误标 `isError`

**推荐度：★★★★★（最优先提交）**

**问题定位：** `packages/coding-agent/src/core/tools/bash.ts` 第 379-381 行

**验证过的代码路径：**
```
bash.ts reject(new Error(...))
  → agent-loop.ts executePreparedToolCall catch
    → { result, isError: true }
      → convertMessages → Anthropic API is_error: true
```

**核心问题：** 所有非零退出码一律视为错误，但很多命令的非零退出码是正常语义：

| 命令 | 退出码 | 含义 | 是否错误？ |
|------|--------|------|-----------|
| `grep pattern file` | 1 | 未找到匹配 | ❌ 正常结果 |
| `diff file1 file2` | 1 | 文件不同 | ❌ 正常结果 |
| `test -f file` | 1 | 文件不存在 | ❌ 正常结果 |
| `which cmd` | 1 | 命令不存在 | ❌ 正常结果 |

```typescript
// bash.ts 第 379-381 行
if (exitCode !== 0 && exitCode !== null) {
    outputText += `\n\nCommand exited with code ${exitCode}`;
    reject(new Error(outputText));  // ← 所有非零都当 error
}
```

**实际影响：**
- `isError: true` 标志通过 API 传递给 LLM，模型认为工具执行失败
- 模型会尝试"修复"命令或向用户道歉，而不是正常处理输出
- `grep` 是 coding session 中**最高频使用的命令之一**，每次无结果都触发此问题

**建议修复方案：**
```typescript
const NORMAL_EXIT_CODES: Record<string, Set<number>> = {
    grep: new Set([1]),    // 1 = no match
    diff: new Set([1]),    // 1 = files differ
    test: new Set([1]),    // 1 = condition false
    which: new Set([1]),   // 1 = not found
};

function isNormalExitCode(command: string, exitCode: number): boolean {
    const cmd = command.trim().split(/\s+/)[0];
    const basename = cmd.split("/").pop() ?? cmd;
    return NORMAL_EXIT_CODES[basename]?.has(exitCode) ?? false;
}

// 在 bash.ts 中替换 reject 逻辑
if (exitCode !== 0 && exitCode !== null) {
    outputText += `\n\nCommand exited with code ${exitCode}`;
    if (isNormalExitCode(command, exitCode)) {
        resolve({ content: [{ type: "text", text: outputText }], details });
    } else {
        reject(new Error(outputText));
    }
}
```

**为什么 maintainer 会接受：**
- 这是客观的语义错误，不是设计争论
- 修复极小（~20 行），不增加核心复杂度
- 不改变 API surface，不违反 minimal core 原则
- 每个 coding session 都受影响

**Issue 标题建议：** `bash tool: non-zero exit codes like grep(1) and diff(1) should not be marked as errors`

**复现步骤：**
1. 安装并配置 Pi
2. 在任意项目目录启动 `pi` session
3. 发送 prompt："搜索这个项目中包含 'xyznonexistent123' 的文件"
4. 模型执行 `grep -r "xyznonexistent123" .`，退出码 1（无匹配）
5. **预期行为：** 模型回复"没有找到包含该字符串的文件"
6. **实际行为：** 模型收到 `isError: true`，可能回复"命令执行出错"或尝试修改搜索命令

---

### 🥈 Issue 6: Read 工具不检测二进制文件

**推荐度：★★★★☆**

**问题定位：** `packages/coding-agent/src/core/tools/read.ts` 第 187-188 行

**验证过的证据：**
- Pi 团队**已经在 bash 工具中修复了同类问题**（`sanitizeBinaryOutput`，changelog 记录："Fix crash when bash command outputs binary data"）
- 但 `read` 工具仍有此缺口

```typescript
// read.ts 只检测支持的图片格式，其他二进制一律 UTF-8
const mimeType = ops.detectImageMimeType
  ? await ops.detectImageMimeType(absolutePath) : undefined;
if (mimeType) { /* 图片路径 - 有处理 */ }
else {
    const buffer = await ops.readFile(absolutePath);
    const textContent = buffer.toString("utf-8");  // .zip/.db/.wasm → 乱码
}
```

**`detectSupportedImageMimeTypeFromFile`（mime.ts）** 只返回支持的图片 MIME 类型，其他二进制文件（.zip, .sqlite, .wasm, .pdf, .docx）通过 else 分支被强制解码为 UTF-8 文本。

**实际影响：**
- 模型探索项目结构时可能尝试 read `.sqlite`、`.wasm`、`.zip` 等
- UTF-8 解码产生大量乱码，消耗 token 但无意义
- 乱码可能干扰模型后续推理

**建议修复方案：**
```typescript
function isBinaryFile(buffer: Buffer, path: string): boolean {
    const ext = path.split(".").pop()?.toLowerCase();
    const BINARY_EXTENSIONS = new Set([
        "zip", "gz", "tar", "bz2", "7z", "rar",
        "sqlite", "db", "wasm", "pyc", "class",
        "pdf", "doc", "docx", "xls", "xlsx",
        "exe", "dll", "so", "dylib", "o",
    ]);
    if (ext && BINARY_EXTENSIONS.has(ext)) return true;

    // null byte check for first 8KB
    const sample = buffer.subarray(0, 8192);
    return sample.includes(0);
}

// 在 read.ts 的 else 分支中
const buffer = await ops.readFile(absolutePath);
if (isBinaryFile(buffer, absolutePath)) {
    return { content: [{ type: "text", text: `Binary file: ${path} (${buffer.length} bytes). Cannot display as text.` }] };
}
const textContent = buffer.toString("utf-8");
```

**为什么 maintainer 会接受：**
- 团队已在 bash 工具中处理了同类问题，这是遗漏的修复
- 修复简单且 defensive
- 不改变正常文本文件的行为

**Issue 标题建议：** `read tool: detect binary files instead of decoding as UTF-8`

**复现步骤：**
1. 创建一个包含 `.sqlite` 文件的项目
2. 启动 `pi` session
3. 发送 prompt："读取 database.sqlite 文件的内容"
4. **预期行为：** 提示这是二进制文件，无法显示
5. **实际行为：** 返回大量 UTF-8 乱码

---

### 🥉 Issue 10: Bash 工具无默认超时

**推荐度：★★★★☆（但可能有设计分歧）**

**问题定位：** `packages/coding-agent/src/core/tools/bash.ts` 第 33-35 行

**验证过的代码路径：**
1. `bash.ts`：`timeout` 参数可选，无默认值
2. `tool-definition-wrapper.ts`：无超时包装
3. `agent-loop.ts` → `executePreparedToolCall`：无超时，只有 abort signal
4. `agent.ts` → `runWithLifecycle`：signal 仅用于手动 abort，无定时器

**结论：** 如果模型不传 `timeout` 参数（默认行为），一个挂起的命令会导致 session **永久卡住**。用户只能手动 Ctrl+C。

```typescript
// bash.ts
const bashSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds (optional, no default timeout)"
    })),
});
```

**实际影响：**
- 模型运行 `npm install`（网络问题）→ 无响应 → 用户不知道发生了什么
- 模型运行 `python script.py`（无限循环）→ session 永久挂起
- 模型运行 `ssh host`（等待输入）→ 永久等待

**建议修复方案：**
```typescript
const DEFAULT_TIMEOUT_SECONDS = 1800; // 30 minutes

// 在 bash.ts 的 spawn 逻辑中
const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_SECONDS;
const timer = setTimeout(() => {
    process.kill();
    reject(new Error(`Command timed out after ${effectiveTimeout} seconds`));
}, effectiveTimeout * 1000);
```

**为什么 maintainer 可能接受：**
- 可靠性问题，不是功能增强
- 修复极小
- 默认超时可以通过参数覆盖，向后兼容

**为什么 maintainer 可能犹豫：**
- Pi 的设计哲学可能认为模型应该自己学会传 timeout
- 他们可能偏好 "No default timeout" 作为显式设计选择

**Issue 标题建议：** `bash tool: add a default timeout to prevent sessions from hanging indefinitely`

**复现步骤：**
1. 启动 `pi` session
2. 发送 prompt："运行 `sleep 99999`"（或 `cat` 不带文件参数）
3. **预期行为：** 一段时间后超时并返回错误
4. **实际行为：** session 永久卡住，只能手动中断

---

## ⚠️ 有一定价值但需谨慎评估（建议先自行验证后再决定）

### Issue 1: `stopReason: "length"` 未处理

**推荐度：★★★☆☆**

**问题定位：** `packages/agent/src/agent-loop.ts` 第 194-198 行、`packages/ai/src/types.ts` 的 `StopReason`

**验证过的代码路径：**
```
agent-loop.ts 主循环（第 191-206 行）:
  → message = await streamAssistantResponse(...)
  → if (message.stopReason === "error" || message.stopReason === "aborted")
    → 返回（处理了 error 和 aborted）
  → // stopReason === "length" 时，直接进入工具执行分支
  → toolCalls = message.content.filter(...)
  → executeToolCalls(...)  // ← 可能执行被截断的工具调用
```

**核心问题：** 当模型输出被 `max_output_tokens` 截断时（`stopReason: "length"`），工具调用的 JSON 参数可能不完整。Pi 的 agent-loop 只检查 `"error"` 和 `"aborted"`，不处理 `"length"`。

```typescript
// agent-loop.ts 第 194-198 行
if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
}
// ← stopReason === "length" 在这里没有被拦截

// types.ts 中的 StopReason 包含 "length"
// stopReason: "stop" | "length" | "toolUse" | "error" | "aborted"
```

**Claude Code 的做法：**
```typescript
// query.ts - 多层恢复策略
// 1. 如果 stopReason === max_tokens 且未 escalate 过
//    → 提升 maxOutputTokens 到 ESCALATED_MAX_TOKENS，重试
// 2. 如果已 escalate 过且 maxOutputTokensRecoveryCount < MAX_LIMIT
//    → 发送 recovery 消息："Output token limit hit. Resume directly..."
//    → maxOutputTokensRecoveryCount++
// 3. 过滤掉截断的工具调用（不完整的 JSON 参数）
```

**实际影响：**
- 如果模型尝试生成很长的代码（如 write 一个 500 行的文件），输出可能被截断
- 很多情况下，截断后的 tool call 会在 provider 解析或 `validateToolArguments` 阶段失败，然后以错误结果回到模型
- 但 `stopReason === "length"` 仍然意味着“这一轮 assistant 输出不完整”，如果其中混有部分已形成的 tool call，而循环继续把它当成普通完成态处理，就存在误执行或错误恢复不足的风险
- 需要验证 Pi 默认的 `maxTokens` 是多少——如果已经设得足够大（如 16K+），此问题很少触发

**建议修复方案（如果要提交）：**
```typescript
// agent-loop.ts - 把 "length" 视为显式状态，而不是普通完成
if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
}

if (message.stopReason === "length") {
    // 更可靠的方向：
    // 1. 只执行已经完整结束、且通过 schema/validateToolArguments 的 tool call
    // 2. 对未完成输出补一条 steering/user message，让模型继续
    // 3. 如果 provider 能暴露“toolcall_end 未完成”之类的真实信号，优先基于那个过滤
}
```

**重新评估的考量：**
- 需要先验证 Pi 默认的 `maxTokens` 是多少——如果已经设得足够大（如 16K+），此问题很少触发
- Claude Code 的 `max_tokens` escalation 是为极端情况设计的
- **建议：** 在自己的 Pi session 中测试大代码生成场景，观察 `stopReason` 是否实际为 `"length"`，再决定是否提

**Issue 标题建议：** `agent-loop: handle stopReason "length" to prevent executing truncated tool calls`

**复现步骤：**
1. 配置 Pi 使用较小的 `maxTokens`（如 4096）
2. 启动 `pi` session
3. 发送 prompt："创建一个包含 20 个 React 组件的大文件，每个组件都有详细的 JSX 和 props 定义"
4. 观察模型是否因 `max_output_tokens` 限制而截断输出
5. **预期行为：** 检测到截断，过滤不完整的工具调用，请求模型继续
6. **实际行为：** 截断的输出直接进入工具执行阶段，可能导致参数解析错误或执行不完整的代码
7. **验证方法：** 在 `agent-loop.ts` 的 stopReason 检查后添加日志 `console.log("stopReason:", message.stopReason)`

---

### Issue 11: Edit 工具无文件冲突检测

**推荐度：★★★☆☆**

**问题定位：** `packages/coding-agent/src/core/tools/edit.ts` execute path（约第 357-382 行）

**验证过的代码路径：**
```
edit.ts execute（约第 357-382 行）:
  → rawContent = await ops.readFile(absolutePath)   // 读取当前文件内容
  → stripBom(rawContent)
  → applyEditsToNormalizedContent(normalizedContent, edits, path)
    → findOldText(content, oldText)                 // 在当前内容中搜索 oldText
    → 如果找到 → 替换为 newText
    → 如果未找到 → 返回错误
  → ops.writeFile(absolutePath, finalContent)        // 写回文件
  // ← 无 mtime 或 content hash 检查
```

**核心问题：** Pi 的 edit 工具在执行时重新读取文件并匹配 `oldText`，提供了**部分保护**。但如果外部修改只改了文件的**其他区域**（被编辑区域以外的部分），`oldText` 仍然匹配，外部修改会被静默覆盖。

```typescript
// edit.ts execute path（简化）
await withFileMutationQueue(absolutePath, async () => {
    const rawContent = await ops.readFile(absolutePath);
    const { bom, text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);

    // oldText 匹配提供部分保护：如果外部修改打中了被编辑区域，这里会失败
    const { baseContent, newContent } = applyEditsToNormalizedContent(
        normalizedContent, edits, path
    );

    // 但如果外部修改发生在别的区域，oldText 仍可能匹配成功
    // → 工具会把“基于旧上下文推导出来的修改”写进 T1 版本文件
    // → 没有 mtime / hash / compare-and-swap 检查来阻止这种跨区域冲突
    // ...构造 finalContent...
    await ops.writeFile(absolutePath, finalContent);
});
```

**Claude Code 的做法：**
Claude Code 使用 optimistic locking：在首次读取文件时记录 mtime 和 content hash，在 edit 执行前检查这些值是否变化。如果检测到外部修改，返回错误要求模型重新读取文件。

**实际影响：**
- 用户在 IDE 中编辑文件的同时，Pi 也在编辑同一文件 → 可能导致用户的修改被覆盖
- 但 Pi 有 `file-mutation-queue` 序列化**内部**工具的并发访问（防止两个 edit 工具同时写同一文件）
- 风险主要存在于**外部**修改场景（IDE、git 操作、其他进程）
- `oldText` 匹配提供了部分保护，覆盖了"被编辑区域被外部修改"的场景

**建议修复方案（如果要提交）：**
```typescript
import { stat } from "fs/promises";

// 在 edit 工具中维护文件状态缓存
const fileStateCache = new Map<string, { mtime: number; size: number }>();

// 在 read 工具读取文件时记录状态
function recordFileState(absolutePath: string, stats: { mtimeMs: number; size: number }): void {
    fileStateCache.set(absolutePath, { mtime: stats.mtimeMs, size: stats.size });
}

// 在 edit 工具执行前检查
async function checkForExternalModification(absolutePath: string): Promise<boolean> {
    const cached = fileStateCache.get(absolutePath);
    if (!cached) return false; // 没有缓存，无法检测
    
    const current = await stat(absolutePath);
    return current.mtimeMs !== cached.mtime || current.size !== cached.size;
}

// 在 edit.ts execute 中
if (await checkForExternalModification(absolutePath)) {
    throw new Error(
        `File ${path} has been modified externally since last read. ` +
        `Please re-read the file before editing.`
    );
}
```

**为什么 maintainer 可能不接受：**
- 部分保护（`oldText` 匹配）已经存在，覆盖了最危险的场景
- 完整的 mtime/content 检查需要跨工具状态共享（read → edit），增加耦合
- 可能被认为是 extension 的职责（用户可以在 extension 中实现 `beforeToolCall` hook）
- Pi 有 `file-mutation-queue` 已经处理了内部并发

**Issue 标题建议：** `edit tool: detect external file modifications to prevent silent overwrites`

**复现步骤：**
1. 创建一个 100 行的文件 `target.ts`
2. 启动 `pi` session
3. 发送 prompt："读取 target.ts"（Pi 模型获取文件内容）
4. 在 Pi 处理下一个 prompt 之前，**在 IDE 中修改 target.ts 的第 50 行**
5. 发送 prompt："将 target.ts 第 10 行的 `const` 改为 `let`"
6. **预期行为：** Pi 检测到文件已被外部修改，要求重新读取
7. **实际行为：** Pi 执行 edit，第 10 行的 `oldText` 匹配成功（因为第 10 行没被外部修改），edit 成功。但模型的 edit 是基于旧版文件的上下文生成的，可能与第 50 行的新修改产生语义冲突
8. **注意：** 这个场景的实际风险取决于外部修改和 Pi 编辑之间的语义依赖关系。如果修改是完全独立的，实际上不会有问题

---

## ❌ 不建议提交的 Issue（设计选择或过度优化）

### Issue 2: 并行工具执行时，单个工具失败不会取消兄弟工具

**推荐度：★★☆☆☆（设计选择）**

**问题定位：** `packages/agent/src/agent-loop.ts` 第 390-438 行 `executeToolCallsParallel`

**验证过的代码路径：**
```
agent-loop.ts executeToolCallsParallel
  → runnableCalls.map(executePreparedToolCall)  // 所有工具同时启动
    → for (const running of runningCalls)       // 逐个 await，无中止机制
      → await running.execution                 // 即使兄弟已失败，仍等待完成
```

**核心问题：** 在并行模式下，如果一个工具发生严重错误，其他并行运行的工具不会被取消，仍然会运行到完成。

```typescript
// agent-loop.ts 第 417-435 行
const runningCalls = runnableCalls.map((prepared) => ({
    prepared,
    execution: executePreparedToolCall(prepared, signal, emit),
}));

for (const running of runningCalls) {
    const executed = await running.execution;  // ← 无兄弟中止检查
    results.push(
        await finalizeExecutedToolCall(
            currentContext, assistantMessage,
            running.prepared, executed,
            config, signal, emit,
        ),
    );
}
```

**Claude Code 的做法：**
```typescript
// StreamingToolExecutor.ts 第 46-48 行
// Child of toolUseContext.abortController. Fires when a Bash tool errors
// so sibling subprocesses die immediately instead of running to completion.
private siblingAbortController: AbortController
```
Claude Code 为每批并行工具创建一个 `siblingAbortController`，当 bash 工具返回错误时触发 `abort('sibling_error')`，立即终止所有兄弟子进程。

**实际影响：**
- 模型并行发出 `rm -rf build/` 和 `ls build/src/`，第一个删除目录后，第二个仍会尝试 ls（得到文件不存在错误，但浪费时间）
- 模型并行发出一个失败的 `npm test` 和其他操作，失败后其他操作仍继续
- 但实际场景中，模型发出的并行工具通常是**独立的读取操作**，相互依赖的破坏性操作极少见

**建议修复方案（如果要提交）：**
```typescript
async function executeToolCallsParallel(...): Promise<ToolResultMessage[]> {
    const siblingAbort = new AbortController();
    const combinedSignal = signal 
        ? AbortSignal.any([signal, siblingAbort.signal]) 
        : siblingAbort.signal;

    const runningCalls = runnableCalls.map((prepared) => ({
        prepared,
        execution: executePreparedToolCall(prepared, combinedSignal, emit),
    }));

    for (const running of runningCalls) {
        const executed = await running.execution;
        if (executed.isError && prepared.toolCall.name === "bash") {
            siblingAbort.abort("sibling_error");
        }
        results.push(await finalizeExecutedToolCall(...));
    }
    return results;
}
```

**不建议提交的原因：**
- Pi 的并行设计是有意的简化，`executePreparedToolCall` 已经 catch 错误并返回 `isError: true`，不会导致崩溃
- 添加 abort 机制增加核心复杂度，违反 minimal core 原则
- 实际场景中模型发出的并行工具通常是独立操作，相互依赖的情况极少
- 收益/复杂度比太低

**Issue 标题建议（如果决定提交）：** `parallel tool execution: abort sibling tools when bash command fails`

**复现步骤：**
1. 启动 `pi` session，确保 `toolExecution` 设为 `"parallel"`（默认）
2. 发送 prompt："删除 build 目录，然后列出 build/src 目录的内容"
3. 观察模型是否并行发出 `rm -rf build/` 和 `ls build/src/`
4. **预期行为：** 第一个命令删除目录后，第二个命令立即被取消
5. **实际行为：** 两个命令都运行到完成，第二个返回 "No such file or directory" 错误
6. **注意：** 此场景不容易稳定复现，因为模型通常不会并行发出有依赖关系的命令

---

### Issue 3: 并行工具执行缺少并发上限

**推荐度：★★☆☆☆（过度防御）**

**问题定位：** `packages/agent/src/agent-loop.ts` 第 417-419 行

**验证过的代码路径：**
```
agent-loop.ts executeToolCallsParallel
  → runnableCalls.map(executePreparedToolCall)  // 全部同时启动，无上限
    → 每个 executePreparedToolCall 可能 spawn 子进程或打开文件
```

**核心问题：** 当模型一次性返回大量工具调用时，所有工具同时启动，没有并发上限控制。

```typescript
// agent-loop.ts 第 417-419 行
const runningCalls = runnableCalls.map((prepared) => ({
    prepared,
    execution: executePreparedToolCall(prepared, signal, emit),
    // ← 所有 prepared 调用同时启动，无 concurrency limiter
}));
```

**Claude Code 的做法：**
```typescript
// toolOrchestration.ts 第 8-12 行
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
  )
}
```
Claude Code 默认最多 10 个工具并发执行，通过环境变量可配置。使用信号量（semaphore）在 `runToolsConcurrently` 中限制并发。

**实际影响：**
- 如果模型一次返回 30 个 `read` 调用（如 "读取这个目录下所有 TypeScript 文件"），30 个文件同时打开并读入内存
- 理论上可能导致文件描述符耗尽（系统限制通常 1024）
- 内存峰值：30 × 50KB（截断限制）= 1.5MB，在现代系统上不算严重
- 如果是 30 个 `bash` 调用，会同时 spawn 30 个子进程

**建议修复方案（如果要提交）：**
```typescript
import pLimit from "p-limit";

const MAX_CONCURRENT_TOOLS = 10;

async function executeToolCallsParallel(...): Promise<ToolResultMessage[]> {
    const limit = pLimit(MAX_CONCURRENT_TOOLS);
    
    const runningCalls = runnableCalls.map((prepared) => ({
        prepared,
        execution: limit(() => executePreparedToolCall(prepared, signal, emit)),
    }));
    // ... rest unchanged
}
```

**不建议提交的原因：**
- 实际场景中模型很少一次发 20+ 工具调用，更常见的是 3-5 个
- Node.js 的异步 I/O（`readFile`、`writeFile`）天然有内核级调度，不会真的"同时"读 30 个文件
- Pi 的截断机制（50KB/2000行）已经限制了每个工具的内存占用
- 如果真出问题，用户可以切换到 `sequential` 模式
- 引入 `p-limit` 依赖或手写信号量增加了不必要的复杂度

**Issue 标题建议（如果决定提交）：** `parallel tool execution: add concurrency limit to prevent resource exhaustion`

**复现步骤：**
1. 创建一个包含 50+ TypeScript 文件的项目
2. 启动 `pi` session
3. 发送 prompt："读取这个项目中的所有 .ts 文件"
4. 观察模型是否一次性发出大量 `read` 工具调用
5. **预期行为：** 最多同时执行 N 个读取操作
6. **实际行为：** 所有文件同时读取
7. **注意：** 由于 Node.js 的异步 I/O 特性，实际不太可能观察到明显的性能问题。可以通过 `ulimit -n 32` 人为降低文件描述符限制来观察差异

---

### Issue 4: 每个工具可声明并发安全性（替代全局开关）

**推荐度：★★☆☆☆（Feature request）**

**问题定位：** `packages/agent/src/agent-loop.ts` 的 `executeToolCalls()` 仍只根据全局 `toolExecution` 分支

**验证过的代码路径：**
```typescript
const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
if (config.toolExecution === "sequential") {
    return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
}
return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
```

**核心问题：** 当前并行/串行仍是全局配置，无法按工具类型区分。用户被迫在“全部串行（慢）”和“全部并行（有风险）”之间选择。

Claude Code 的做法是给工具增加 `isConcurrencySafe` 之类的声明，然后把一批工具切成 `[并行块] → [串行块] → [并行块]`。Pi 目前没有这层调度。

**为什么仍然不建议优先提交：**
- 这不是 bug，而是调度能力增强
- Pi 已有 `file-mutation-queue` 缓解同文件写冲突
- 真要做正确，往往意味着要改 `AgentTool` 接口和批处理算法，复杂度不小

**更准确的结论：**
- “Pi 现在只有全局 sequential / parallel 开关” 这个判断仍然成立
- 但它更像 future feature discussion，不是高优先级 issue

---

### Issue 5: 流式工具执行（在模型输出过程中开始执行工具）

**推荐度：★☆☆☆☆（大型架构变更）**

**问题定位：** `packages/agent/src/agent-loop.ts` 第 191-206 行

**验证过的代码路径：**
```
agent-loop.ts 主循环:
  → streamAssistantResponse(...)    // 第 191 行：等待完整消息
  → message = await ...             // 阻塞直到所有内容流完
  → toolCalls = message.content.filter(...)  // 第 201 行：提取工具调用
  → executeToolCalls(...)           // 第 206 行：**此时才开始执行**
```

**核心问题：** Pi 等待完整的 `AssistantMessage`（包括所有工具调用的参数）全部流完后，才开始执行工具。

```typescript
// agent-loop.ts 第 191-206 行
const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
// ← 整个 stream 消费完毕后才返回

newMessages.push(message);
if (message.stopReason === "error" || message.stopReason === "aborted") { return; }

const toolCalls = message.content.filter((c) => c.type === "toolCall");
hasMoreToolCalls = toolCalls.length > 0;

if (hasMoreToolCalls) {
    toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));
    // ← 所有工具在 stream 结束后才开始执行
}
```

**Claude Code 的做法：**
```typescript
// StreamingToolExecutor.ts 第 40-62 行
export class StreamingToolExecutor {
    private tools: TrackedTool[] = []
    
    // 在 stream 过程中，每当一个工具的参数完整时立即调用
    addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void {
        // 立即检查是否可以开始执行
        this.tryStartExecution();
    }
    
    // 并发安全的工具在参数完整后立即启动
    // 非安全工具排队等待前面的完成
    private tryStartExecution(): void { ... }
}
```
Claude Code 的 `StreamingToolExecutor` 在 stream 过程中监听 `toolcall_end` 事件，每当一个工具调用的参数完整时立即开始执行（如果该工具是 `isConcurrencySafe`）。

**实际影响：**
- 如果模型输出包含 3 个工具调用，每个调用的参数需要 2 秒输出，Pi 需要 6 秒等待 + 执行时间
- Claude Code 在第 2 秒就开始执行第一个工具，总时间更短
- 对于复杂的 turn（5+ 工具调用），差异可达数秒
- 但对于简单的 turn（1-2 个工具调用），差异极小

**建议修复方案（如果要提交）：**
```typescript
// 需要重构 streamAssistantResponse 和 executeToolCalls 的交互模式
class StreamingToolExecutor {
    private pendingTools: { toolCall: AgentToolCall; promise: Promise<ToolResult> }[] = [];
    
    onToolCallComplete(toolCall: AgentToolCall): void {
        if (this.isConcurrencySafe(toolCall)) {
            // 立即启动执行
            this.pendingTools.push({
                toolCall,
                promise: this.execute(toolCall),
            });
        } else {
            this.pendingTools.push({ toolCall, promise: null }); // 排队
        }
    }
    
    async awaitAll(): Promise<ToolResult[]> {
        // 等待所有已启动的工具 + 执行排队的串行工具
    }
}
```

**不建议提交的原因：**
- 这是**大型架构变更**，不是简单修复
- 需要引入 `StreamingToolExecutor` 类（Claude Code 中约 500 行）
- 需要改变 `streamAssistantResponse` 的消费模式，从"返回完整消息"变为"事件驱动"
- 需要同时实现 Issue 4（`isConcurrencySafe`）才有意义
- 纯性能优化，不影响正确性
- Pi 强调 minimal core，这与核心简洁性直接冲突
- 不适合作为首次或早期贡献

**Issue 标题建议（如果决定提交）：** `performance: start tool execution during streaming instead of waiting for complete response`

**复现步骤：**
1. 启动 `pi` session
2. 发送 prompt："读取 file1.ts、file2.ts、file3.ts、file4.ts、file5.ts 这 5 个文件"
3. 观察模型输出过程：所有 5 个工具调用的参数逐个流出
4. **预期行为：** 第一个 read 工具的参数完整后，立即开始读取文件，同时继续接收后续工具参数
5. **实际行为：** 所有 5 个工具调用的参数全部流完后，才开始读取第一个文件
6. **测量方法：** 添加 `console.time/timeEnd` 到 `executeToolCalls` 调用前后，比较 stream 结束到工具开始执行的时间差

---

### Issue 7: 聚合工具结果预算

**推荐度：★★☆☆☆（过度优化）**

**问题定位：** `packages/coding-agent/src/core/tools/truncate.ts` 第 11-12 行

**验证过的代码路径：**
```
truncate.ts:
  → DEFAULT_MAX_LINES = 2000     // 单工具限制
  → DEFAULT_MAX_BYTES = 50KB     // 单工具限制
  → truncateHead / truncateTail  // 按单工具独立截断

agent-loop.ts executeToolCalls:
  → 每个工具独立执行，独立截断
  → 所有结果注入上下文，无聚合预算
```

**核心问题：** Pi 对单个工具结果有截断限制（2000 行 / 50KB），但没有**聚合预算**。如果模型在一个 turn 中调用多个工具，每个工具的结果独立截断后全部注入上下文。

```typescript
// truncate.ts 第 11-12 行
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

// truncateHead 函数 - 按单工具独立截断
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    // ... 只考虑当前工具的输出，不考虑同 turn 其他工具
}
```

**Claude Code 的做法：**
Claude Code 有 per-turn aggregate budget（`TOOL_RESULT_BUDGET_TOKENS`），收集一个 turn 中所有工具的结果后，从最长的结果开始截断，直到总 token 数在预算内。这确保了无论调用多少个工具，总注入上下文的 token 数量可控。

**实际影响：**
- 模型在一个 turn 中调用 10 个 `read`，每个返回 50KB → 总计 500KB 注入上下文
- 500KB ≈ 125K tokens，可能占满上下文窗口的大部分
- 但 Pi 的 compaction 机制会在上下文过大时触发，间接缓解
- 实际场景中 10 个工具每个都返回 50KB 的情况不常见

**建议修复方案（如果要提交）：**
```typescript
const AGGREGATE_BUDGET_BYTES = 200 * 1024; // 200KB per turn

function applyAggregateBudget(results: ToolResult[]): ToolResult[] {
    let totalBytes = results.reduce((sum, r) => sum + getResultBytes(r), 0);
    
    if (totalBytes <= AGGREGATE_BUDGET_BYTES) return results;
    
    // 按结果大小降序排列
    const sorted = [...results].sort((a, b) => getResultBytes(b) - getResultBytes(a));
    
    for (const result of sorted) {
        if (totalBytes <= AGGREGATE_BUDGET_BYTES) break;
        const currentBytes = getResultBytes(result);
        const targetBytes = Math.max(currentBytes / 2, 1024); // 至少保留 1KB
        result.content = truncateToBytes(result.content, targetBytes);
        totalBytes -= (currentBytes - targetBytes);
    }
    
    return results;
}
```

**不建议提交的原因：**
- Pi 的单工具截断（50KB/2000行）已提供基本保护
- 聚合预算是额外优化层，增加了调度复杂度
- Pi 的 compaction 机制在上下文过大时会触发，间接缓解了此问题
- 实际场景中同一 turn 多个大结果的情况不常见
- 收益/复杂度比不高

**Issue 标题建议（如果决定提交）：** `context management: add per-turn aggregate budget for tool results`

**复现步骤：**
1. 创建一个项目，包含 10 个较大的文件（每个 100+ 行）
2. 启动 `pi` session
3. 发送 prompt："读取 file1.ts 到 file10.ts 这 10 个文件的完整内容"
4. 观察模型一次性发出 10 个 `read` 工具调用
5. **预期行为：** 总结果受聚合预算控制，最大的几个结果被进一步截断
6. **实际行为：** 每个文件独立截断到 50KB/2000行，全部注入上下文
7. **验证方法：** 检查 turn 完成后上下文中 tool_result 消息的总大小

---

### Issue 8: Read 去重（重复读取同文件返回 stub）

**推荐度：★★☆☆☆（过度优化）**

**问题定位：** `packages/coding-agent/src/core/tools/read.ts` 第 186-188 行

**验证过的代码路径：**
```
read.ts:
  → 每次 read 调用都执行 ops.readFile(absolutePath)
  → buffer.toString("utf-8")
  → truncateHead(selectedContent)
  → 返回完整内容（即使之前已读过且文件未变）
```

**核心问题：** 在同一 session 中多次读取同一文件（内容未变），每次都返回完整内容，浪费 token。

```typescript
// read.ts 第 186-188 行（else 分支）
const buffer = await ops.readFile(absolutePath);
const textContent = buffer.toString("utf-8");
// ← 无论是否已读过此文件，都返回完整内容
```

**Claude Code 的做法：**
```typescript
// FileReadTool.ts - file_unchanged 类型定义
z.object({
    type: z.literal('file_unchanged'),
    file: z.object({
        filePath: z.string().describe('The path to the file'),
    }),
})

// FileReadTool.ts - 去重逻辑
// 如果文件自上次读取后未修改（基于 hash 比较），返回 stub
logEvent('tengu_file_read_dedup', { ext: analyticsExt })
return {
    data: {
        type: 'file_unchanged' as const,
        file: { filePath: file_path },
    },
}

// 转换为 API 消息时
case 'file_unchanged':
    return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: FILE_UNCHANGED_STUB,  // 简短的 stub 文本，而非完整内容
    }
```
Claude Code 跟踪每个文件的读取状态（基于内容 hash），如果文件自上次读取后未修改，返回 `FILE_UNCHANGED_STUB` 而非完整内容，节省大量 token。

**实际影响：**
- 模型经常在 edit 前后读取同一文件（先读取理解结构，edit 后再读取验证）
- 一个 1000 行的文件被读取 3 次 = 3 × ~4000 tokens = 12000 tokens 浪费
- 在长 session 中，模型可能对同一文件读取 5-10 次
- 但 Pi 的 compaction 机制会在上下文过大时压缩旧的重复内容

**建议修复方案（如果要提交）：**
```typescript
// 在 read.ts 中添加文件读取缓存
import { createHash } from "crypto";

const fileReadCache = new Map<string, { hash: string; mtime: number }>();

function hashContent(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

// 在 read 执行逻辑中
const buffer = await ops.readFile(absolutePath);
const hash = hashContent(buffer);
const stat = await ops.stat(absolutePath);
const cached = fileReadCache.get(absolutePath);

if (cached && cached.hash === hash && cached.mtime === stat.mtimeMs) {
    return {
        content: [{ type: "text", text: `[File unchanged since last read: ${path}]` }],
    };
}

fileReadCache.set(absolutePath, { hash, mtime: stat.mtimeMs });
const textContent = buffer.toString("utf-8");
// ... 继续正常处理
```

**不建议提交的原因：**
- 纯性能优化，不影响正确性
- 增加了文件状态跟踪的复杂性（需要管理 cache 生命周期、文件 watch 等）
- compaction 机制间接缓解了重复内容问题
- 需要考虑 cache 失效场景（外部修改、git checkout 等）
- 收益主要在长 session 中体现，短 session 影响不大

**Issue 标题建议（如果决定提交）：** `read tool: return stub for unchanged files to reduce token waste`

**复现步骤：**
1. 创建一个包含 500+ 行的大文件 `large_file.ts`
2. 启动 `pi` session
3. 发送 prompt："读取 large_file.ts 的内容"
4. 再次发送："再读一次 large_file.ts"（文件未修改）
5. **预期行为：** 第二次读取返回 "文件未变化" 的简短提示
6. **实际行为：** 第二次返回完整的 500+ 行内容
7. **验证方法：** 对比两次读取的 tool_result 消息大小

---

### Issue 12: UTF-16 编码支持

**推荐度：★☆☆☆☆（极端边缘）**

**问题定位：** `packages/coding-agent/src/core/tools/edit.ts` 第 74 行、`edit-diff.ts` `stripBom` 函数

**验证过的代码路径：**
```
edit.ts:
  → defaultEditOperations.writeFile = fsWriteFile(path, content, "utf-8")
  → 硬编码 UTF-8，不检测原始编码

edit.ts execute（第 226-246 行）:
  → rawContent = await ops.readFile(absolutePath)  // 读取为 Buffer
  → stripBom(rawContent)                           // 剥离 UTF-8 BOM（仅 \uFEFF）
  → applyEditsToNormalizedContent(...)
  → ops.writeFile(absolutePath, finalContent)       // 写回时用 UTF-8

edit-diff.ts stripBom:
  → 只处理 UTF-8 BOM（\uFEFF），不处理 UTF-16 LE/BE BOM
```

**核心问题：** edit 和 write 工具硬编码 UTF-8 编码。对于 UTF-16 LE/BE 编码的文件，`readFile` 读取后无法正确解码，`writeFile` 用 UTF-8 写回导致编码静默转换。

```typescript
// edit.ts 第 72-76 行
const defaultEditOperations: EditOperations = {
    readFile: (path) => fsReadFile(path),
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    //                                                        ^^^^^^^^ 硬编码
    access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

// edit-diff.ts 第 136-139 行 - stripBom 只处理 UTF-8 BOM
export function stripBom(content: string): { bom: string; text: string } {
    return content.startsWith("\uFEFF")
        ? { bom: "\uFEFF", text: content.slice(1) }
        : { bom: "", text: content };
    // ← 只检测 UTF-8 BOM (EF BB BF decoded to \uFEFF)
    // ← 不检测 UTF-16 LE BOM (FF FE) 或 UTF-16 BE BOM (FE FF)
}
```

**Claude Code 的做法：**
Claude Code 在读取文件时检测 BOM（UTF-8、UTF-16 LE、UTF-16 BE），记录原始编码，写回时使用对应编码。支持的 BOM 检测：
- `EF BB BF` → UTF-8 with BOM
- `FF FE` → UTF-16 LE
- `FE FF` → UTF-16 BE

**实际影响：**
- UTF-16 编码文件极为罕见：现代项目几乎全是 UTF-8
- 可能影响的场景：某些 Windows 生成的文件（如 `.sln`、`.csproj`）、某些 PowerShell 脚本
- Pi 的 `readFile` 使用 `Buffer` 无编码参数读取，然后 `toString("utf-8")`，UTF-16 文件会产生乱码
- 但 Pi 的 `stripBom` 会保留 BOM 并在写回时加回（`bom + restoreLineEndings(...)`），所以 UTF-8 BOM 文件是安全的

**建议修复方案（如果要提交）：**
```typescript
type Encoding = "utf-8" | "utf-16le" | "utf-16be";

function detectEncoding(buffer: Buffer): { encoding: Encoding; bomLength: number } {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return { encoding: "utf-8", bomLength: 3 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return { encoding: "utf-16le", bomLength: 2 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        return { encoding: "utf-16be", bomLength: 2 };
    }
    return { encoding: "utf-8", bomLength: 0 };
}

// 在 edit.ts 中
const buffer = await ops.readFile(absolutePath);
const { encoding, bomLength } = detectEncoding(buffer);
const rawContent = buffer.slice(bomLength).toString(encoding);
// ... 编辑处理 ...
const bom = Buffer.from(bomLength > 0 ? [buffer[0], buffer[1], ...(bomLength === 3 ? [buffer[2]] : [])] : []);
const encodedContent = Buffer.concat([bom, Buffer.from(finalContent, encoding)]);
await ops.writeFile(absolutePath, encodedContent);
```

**不建议提交的原因：**
- 现代项目几乎全是 UTF-8，UTF-16 文件极为罕见
- 影响范围极小，几乎不会在实际 coding session 中遇到
- Pi 可能有意只支持 UTF-8（minimal core 原则）
- 增加编码检测逻辑增加了代码路径复杂度
- 即使遇到 UTF-16 文件，模型通常不会尝试编辑它们（多为二进制-like 格式）

**Issue 标题建议（如果决定提交）：** `edit tool: preserve original file encoding (UTF-16 LE/BE) instead of forcing UTF-8`

**复现步骤：**
1. 创建一个 UTF-16 LE 编码的文件：
   ```bash
   echo -e '\xff\xfe' > utf16_file.txt
   iconv -f UTF-8 -t UTF-16LE <<< "Hello World" >> utf16_file.txt
   ```
2. 启动 `pi` session
3. 发送 prompt："读取 utf16_file.txt 并将 Hello 改为 Hi"
4. **预期行为：** 文件被正确读取、编辑并以 UTF-16 LE 写回
5. **实际行为：** 文件读取时可能产生乱码，写回时编码被转换为 UTF-8
6. **注意：** 此场景在 macOS/Linux 上难以自然触发，因为几乎没有工具生成 UTF-16 文件

---

## 最终优先级排序

| 优先级 | Issue | 类型 | 接受可能性 | 实现难度 | 复现频率 |
|--------|-------|------|-----------|---------|---------|
| 🥇 第一 | **Issue 9: Bash 退出码语义** | Bug | ★★★★★ | 极低 | 每次 session |
| 🥈 第二 | **Issue 6: Read 二进制检测** | Bug/遗漏 | ★★★★☆ | 低 | 偶尔 |
| 🥉 第三 | **Issue 10: Bash 默认超时** | 可靠性 | ★★★☆☆ | 极低 | 偶尔 |
| 💡 待验证 | **Issue 1: stopReason length** | 边界 | ★★★☆☆ | 低 | 需验证 |
| 💡 待验证 | **Issue 11: Edit 冲突检测** | 增强 | ★★☆☆☆ | 中 | 低频 |

---

## 提 Issue 策略

1. **先提 Issue 9**：这是最安全的首次贡献。客观 bug，修复小，无争议。
2. **不要一次提多个 issue**：作为新贡献者，一次提 5 个 issue 显得在"审计"项目。一个一个来。
3. **被接受后再提 Issue 6**：建立了信誉后跟进。
4. **Issue 10 视社区反应而定**：如果前两个被良好接收，再提。
5. **绝对不要提到 Claude Code**：只描述 Pi 自身的问题和修复方案。
