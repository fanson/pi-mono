# Pi Mono Issue 复现指南

每个 Issue 都包含：环境准备、复现步骤、预期结果、实际结果、以及抓取证据的方法。

---

## 前置准备

```bash
cd /Users/haiyangzhou/work/pi-mono
npm install
npm run build

# 验证 Pi 可以从源码运行
./pi-test.sh --help
```

---

## Issue 1: `stopReason: "length"` 截断的工具调用未被正确处理

### 问题本质
当模型输出因 `max_output_tokens` 限制被截断时，可能产生不完整的工具调用参数（JSON 被截断）。agent-loop 没有特殊处理 `stopReason: "length"`，导致截断的工具调用被尝试执行，产生难以理解的错误。

### 复现方法 A：通过 SDK 脚本（最可控）

创建测试脚本 `test-length-issue.ts`：

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

async function main() {
  const { session } = await createAgentSession({
    // 使用你有 API key 的模型
  });

  // 关键：订阅事件以捕获证据
  session.agent.subscribe(async (event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      console.error(`\n[EVENT] Assistant message ended:`);
      console.error(`  stopReason: ${event.message.stopReason}`);
      console.error(`  content items: ${event.message.content.length}`);
      for (const item of event.message.content) {
        if (item.type === "toolCall") {
          console.error(`  toolCall: ${item.name}`);
          console.error(`  args preview: ${JSON.stringify(item.arguments).substring(0, 200)}`);
        }
      }
    }
    if (event.type === "tool_execution_end") {
      console.error(`[EVENT] Tool ${event.toolName} result isError: ${event.isError}`);
      if (event.isError) {
        console.error(`  error: ${JSON.stringify(event.result).substring(0, 300)}`);
      }
    }
  });

  // 触发多工具调用的 prompt
  await session.prompt(
    "Read all these files and tell me their first line: package.json, tsconfig.json, README.md, CONTRIBUTING.md, AGENTS.md, biome.json, pi-test.sh, test.sh, LICENSE"
  );

  await session.agent.waitForIdle();
}

main().catch(console.error);
```

**问题是如何降低 maxTokens。** 由于 Pi 的 Agent 不直接暴露 `maxTokens` 到 CLI/settings，最可控的方法是修改模型注册的 `maxTokens`：

在 `~/.pi/agent/models.json` 中添加一个低限制的模型配置：
```json
{
  "providers": {
    "anthropic-low-tokens": {
      "apiKey": "YOUR_ANTHROPIC_API_KEY",
      "api": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com/v1",
      "models": [
        {
          "id": "claude-sonnet-low-tokens",
          "name": "Claude Sonnet Low Tokens",
          "contextWindow": 200000,
          "maxTokens": 150
        }
      ]
    }
  }
}
```

注意：这里使用的是**自定义 provider 名** `anthropic-low-tokens`。当前 `ModelRegistry` 会要求这类自定义 provider 在定义 `models` 时显式提供 `baseUrl` 和 `apiKey`，否则配置校验不会通过。

然后用这个模型运行：
```bash
./pi-test.sh --model claude-sonnet-low-tokens
```

### 复现方法 B：直接使用 CLI（更自然）

```bash
# 用低 maxTokens 的模型配置
# 然后发送需要多个工具调用的请求
./pi-test.sh --print "Read these 10 files and summarize each: package.json, tsconfig.json, README.md, CONTRIBUTING.md, AGENTS.md, biome.json, pi-test.sh, test.sh, LICENSE, packages/agent/package.json"
```

### 预期的正确行为
当 `stopReason === "length"` 时，agent 应该：
1. 检测到截断
2. 丢弃不完整或未通过参数验证的工具调用
3. 仅执行完整的工具调用
4. 告知模型其输出被截断，需要继续

### 实际行为（Bug）
1. 截断的工具调用可能有不完整的参数
2. `validateToolArguments` 可能因 schema 不匹配而失败
3. 产生的错误消息对模型来说很困惑（不知道是自己输出被截断导致的）
4. 无续写机制

### 抓取证据

```bash
# 方法1：使用 JSON 模式捕获完整事件流
./pi-test.sh --mode json --model claude-sonnet-low-tokens \
  --print "Read all files in the current directory" \
  2>stderr.log | tee events.jsonl

# 在 events.jsonl 中搜索:
# - "stopReason":"length"
# - "isError":true 的工具结果
# - 工具参数中的截断 JSON

# 方法2：使用 RPC 模式
./pi-test.sh --mode rpc --model claude-sonnet-low-tokens 2>rpc_stderr.log
```

### 截图/日志要点
- 截取 `stopReason: "length"` 的事件输出
- 截取工具验证失败的错误消息
- 对比正常（`stopReason: "stop"` 或 `"toolUse"`）和截断情况的输出差异

---

## Issue 2: 并行工具执行时，单个工具失败不取消兄弟工具

### 问题本质
Pi 默认使用并行工具执行（`toolExecution: "parallel"`）。当模型同时请求多个 bash 命令，其中一个快速失败时，其他命令仍然运行到底，浪费时间和资源。

### 复现步骤

```bash
# Pi 默认就是 parallel 模式，无需特殊配置

# 方法1：交互模式
./pi-test.sh

# 在交互界面中输入以下 prompt（设计为触发并行 bash 调用）：
```

**Prompt（复制粘贴到 Pi 交互界面）：**
```
I need you to run these commands simultaneously:
1. Run `cat /nonexistent/path/file.txt` (this will fail immediately)
2. Run `sleep 5 && echo "done sleeping"` (this takes 5 seconds)
3. Run `sleep 8 && echo "done long sleep"` (this takes 8 seconds)

Execute all three right now.
```

### 如何观察问题

**方法1：使用 JSON 模式计时**
```bash
./pi-test.sh --mode json --print 'Run these three bash commands: 1) cat /nonexistent/path/file.txt  2) sleep 5 && echo "slept 5"  3) sleep 8 && echo "slept 8"' 2>stderr.log | tee events.jsonl
```

然后分析事件时间戳：
```bash
# 查找工具执行事件
grep -E "tool_execution_(start|end)" events.jsonl | head -20
```

**预期看到的时间线：**
```
t=0s: tool_execution_start bash(cat /nonexistent/...)
t=0s: tool_execution_start bash(sleep 5 ...)
t=0s: tool_execution_start bash(sleep 8 ...)
t=0s: tool_execution_end   bash(cat ...) — 失败 ❌
t=5s: tool_execution_end   bash(sleep 5 ...) — 仍在运行 ⚠️
t=8s: tool_execution_end   bash(sleep 8 ...) — 仍在运行 ⚠️
```

**正确行为应该是：**
```
t=0s: tool_execution_start bash(cat /nonexistent/...)
t=0s: tool_execution_start bash(sleep 5 ...)
t=0s: tool_execution_start bash(sleep 8 ...)
t=0s: tool_execution_end   bash(cat ...) — 失败 ❌
t=0s: tool_execution_end   bash(sleep 5 ...) — 被取消 ✓
t=0s: tool_execution_end   bash(sleep 8 ...) — 被取消 ✓
```

**方法2：观察终端输出计时**

在交互模式中，注意观察：
- 第一个 bash 命令几乎立即返回错误
- 但整个工具执行周期仍然需要等 5-8 秒才完成
- 这 5-8 秒的等待是不必要的

### 更实际的场景

```
请帮我做以下操作：
1. 编译项目: `cd /tmp/nonexistent-project && npm run build`
2. 运行测试: `cd /tmp/nonexistent-project && npm test`
3. 检查 lint: `cd /tmp/nonexistent-project && npm run lint`
```

这个场景更贴近真实使用——编译失败了，测试和lint还在跑，完全没必要。

### 抓取证据

```bash
# 使用 time 命令计时
time ./pi-test.sh --mode json --print 'Run these bash commands in parallel: 1) exit 1  2) sleep 10 && echo done' 2>stderr.log | tee events.jsonl

# 如果 bug 存在：real time ≈ 10s（等待 sleep 完成）
# 如果修复后：real time 应显著小于 10s（会有调度/取消开销，不会真到 0s）
```

### 截图/日志要点
- `time` 命令的输出，显示等了不必要的时间
- JSON 事件流中的时间戳差异
- 对比 "一个工具失败后其他仍在运行" 的事件序列

---

## Issue 3: 并行工具执行没有并发上限

### 问题本质
当模型一次性请求大量工具调用时，Pi 会同时启动所有工具执行，没有并发限制。

### 复现步骤

**方法1：直接请求读取大量文件**

```bash
./pi-test.sh
```

**Prompt：**
```
Read ALL of these files at once (use separate read tool calls for each, don't use bash):
1. packages/agent/src/agent-loop.ts
2. packages/agent/src/agent.ts
3. packages/agent/src/types.ts
4. packages/ai/src/types.ts
5. packages/ai/src/stream.ts
6. packages/coding-agent/src/core/agent-session.ts
7. packages/coding-agent/src/core/tools/read.ts
8. packages/coding-agent/src/core/tools/write.ts
9. packages/coding-agent/src/core/tools/edit.ts
10. packages/coding-agent/src/core/tools/bash.ts
11. packages/coding-agent/src/core/tools/grep.ts
12. packages/coding-agent/src/core/tools/find.ts
13. packages/coding-agent/src/core/tools/ls.ts
14. packages/coding-agent/src/core/settings-manager.ts
15. packages/coding-agent/src/core/system-prompt.ts
16. packages/coding-agent/src/core/sdk.ts
17. packages/coding-agent/src/core/model-registry.ts
18. packages/coding-agent/src/core/resource-loader.ts
19. packages/coding-agent/src/core/extensions/types.ts
20. packages/coding-agent/src/core/extensions/runner.ts
```

**方法2：使用 SDK 脚本验证并发**

创建 `test-concurrency.ts`：
```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

let activeCount = 0;
let maxActive = 0;

async function main() {
  const { session } = await createAgentSession({});

  session.agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start") {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      console.error(`[CONCURRENCY] Active: ${activeCount}, Max: ${maxActive} — started ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      activeCount--;
      console.error(`[CONCURRENCY] Active: ${activeCount}, Max: ${maxActive} — ended ${event.toolName}`);
    }
  });

  await session.prompt(
    "Read all 20 .ts files in packages/agent/src/ directory using individual read tool calls for each file"
  );

  await session.agent.waitForIdle();
  console.error(`\n[RESULT] Maximum concurrent tool executions: ${maxActive}`);
}

main().catch(console.error);
```

### 预期的问题表现

```
[CONCURRENCY] Active: 1, Max: 1 — started read
[CONCURRENCY] Active: 2, Max: 2 — started read
[CONCURRENCY] Active: 3, Max: 3 — started read
...
[CONCURRENCY] Active: 20, Max: 20 — started read  ← 20个同时执行！
...
[RESULT] Maximum concurrent tool executions: 20
```

### 为什么这是问题

对于文件读取可能还好，但考虑 bash 场景：
```
帮我在20个子目录中分别运行 npm install
```

20 个并发 `npm install` 会：
- 每个进程占用 200-500MB 内存
- 磁盘 I/O 严重竞争
- 可能导致 OOM 或系统卡死

### 抓取证据

```bash
# 使用 JSON 模式
./pi-test.sh --mode json --print "Read these 15 files: [list files]" 2>stderr.log | tee events.jsonl

# 分析并发
cat events.jsonl | python3 -c "
import sys, json
active = 0
max_active = 0
for line in sys.stdin:
    try:
        ev = json.loads(line)
        if ev.get('type') == 'tool_execution_start':
            active += 1
            max_active = max(max_active, active)
        elif ev.get('type') == 'tool_execution_end':
            active -= 1
    except: pass
print(f'Max concurrent: {max_active}')
"
```

### 截图/日志要点
- 最大并发数（显示无上限）
- 大量并发 bash 时的内存/CPU 使用
- 对比有并发限制时的资源使用

---

## Issue 4: 工具并发安全声明仍不存在（只有全局开关）

### 当前实现

`executeToolCalls()` 仍只看全局 `toolExecution`：

```typescript
const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
if (config.toolExecution === "sequential") {
    return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
}
return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
```

也就是说：
- Pi 当前仍然只有“整批串行”或“整批并行”
- 没有 Claude Code 那种每工具 `isConcurrencySafe` / 分区批处理
- `file-mutation-queue` 只能缓解同文件写入冲突，不等于 per-tool 并发安全声明

### 结论

原先“Pi 只有全局 sequential / parallel 开关”的判断仍然成立。
但这更像 feature request / 调度策略讨论，不是明确 bug，所以优先级不高。

---

## Issue 5: 模型输出过程中不开始执行工具（流式工具执行）

### 问题本质
Pi 等待 `streamAssistantResponse` 完全返回 `AssistantMessage` 后，才开始调用 `executeToolCalls`。模型如果一次输出 5 个工具调用，用户必须等所有 5 个定义完全流式完成后才开始第一个工具的执行。

### 复现步骤

```bash
./pi-test.sh
```

**Prompt（触发大量工具调用）：**
```
Read these 5 files one by one using separate read tool calls:
1. packages/agent/src/agent-loop.ts
2. packages/agent/src/agent.ts
3. packages/agent/src/types.ts
4. packages/ai/src/types.ts
5. packages/ai/src/stream.ts
```

### 如何观察问题

**方法1：JSON 模式 + 时间戳分析**

```bash
./pi-test.sh --mode json --print "Read these 5 files: packages/agent/src/agent-loop.ts, packages/agent/src/agent.ts, packages/agent/src/types.ts, packages/ai/src/types.ts, packages/ai/src/stream.ts" 2>stderr.log | tee events.jsonl
```

然后按**事件顺序**分析（JSON 模式输出没有统一的 top-level `timestamp`；`toolcall_*` 出现在 `message_update.assistantMessageEvent.type` 里）：

```bash
# 提取关键事件的出现顺序
cat events.jsonl | python3 -c "
import sys, json
line_no = 0
for line in sys.stdin:
    line_no += 1
    try:
        ev = json.loads(line)
        t = ev.get('type', '')
        if t == 'message_update':
            ame = ev.get('assistantMessageEvent', {})
            phase = ame.get('type', '')
            if phase in ('toolcall_start', 'toolcall_end'):
                print(f'#{line_no} {phase}')
        elif t in ('message_end', 'tool_execution_start', 'tool_execution_end'):
            print(f'#{line_no} {t}')
    except: pass
"
```

**预期看到的事件顺序：**
```
Phase 1 — 模型流式输出（所有工具定义）:
  #12 toolcall_start
  #18 toolcall_end      ← 工具1定义完成，但不开始执行
  #23 toolcall_start
  #29 toolcall_end      ← 工具2定义完成，仍不执行
  ...
  #61 message_end       ← 模型输出完成

Phase 2 — 工具执行（全部才开始）:
  #62 tool_execution_start       ← 直到这里才开始执行
  #63 tool_execution_start
  #64 tool_execution_start
  #65 tool_execution_start
  #66 tool_execution_start
  ...
```

**理想的流式执行顺序：**
```
  #12 toolcall_start
  #18 toolcall_end
  #19 tool_execution_start       ← 定义完就开始执行
  #23 toolcall_start
  #29 toolcall_end
  #30 tool_execution_start       ← 与后续 toolcall 流重叠
  ...
```

**方法2：SDK 脚本（精确计时）**

创建 `test-streaming-exec.ts`：
```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

async function main() {
  const { session } = await createAgentSession({});

  let firstToolCallEnd = 0;
  let firstToolExecStart = 0;
  let messageEndTime = 0;

  session.agent.subscribe(async (event) => {
    const now = Date.now();

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "toolcall_end" && !firstToolCallEnd) {
        firstToolCallEnd = now;
        console.error(`[${now}] First tool call definition complete`);
      }
    }
    if (event.type === "message_end") {
      messageEndTime = now;
      console.error(`[${now}] Message streaming complete`);
    }
    if (event.type === "tool_execution_start" && !firstToolExecStart) {
      firstToolExecStart = now;
      console.error(`[${now}] First tool execution started`);
    }
  });

  await session.prompt(
    "Read these 5 files using separate read calls: packages/agent/src/agent-loop.ts, packages/agent/src/agent.ts, packages/agent/src/types.ts, packages/ai/src/types.ts, packages/ai/src/stream.ts"
  );

  await session.agent.waitForIdle();

  const gap = firstToolExecStart - firstToolCallEnd;
  console.error(`\n=== Streaming Execution Gap ===`);
  console.error(`First tool definition complete: ${firstToolCallEnd}`);
  console.error(`Message streaming complete:     ${messageEndTime}`);
  console.error(`First tool execution started:   ${firstToolExecStart}`);
  console.error(`Gap (wasted time):              ${gap}ms`);
  console.error(`Could have saved:               ${messageEndTime - firstToolCallEnd}ms of overlap`);
}

main().catch(console.error);
```

### 预期输出（问题证据）

```
=== Streaming Execution Gap ===
First tool definition complete: 1711900000300   ← 0.3s 后第一个工具定义完
Message streaming complete:     1711900002500   ← 2.5s 后模型才输出完
First tool execution started:   1711900002510   ← 在模型输出完之后才执行
Gap (wasted time):              2210ms          ← 浪费了 2.2 秒！
Could have saved:               2200ms of overlap
```

### 代码根因

```typescript
// packages/agent/src/agent-loop.ts, line 191
const message = await streamAssistantResponse(...);  // ← 完全等待流式完成

// 然后才到这里
const toolCallBlocks = message.content.filter(...);  // ← 从完整消息提取工具调用
const toolResults = await executeToolCalls(...);      // ← 才开始执行
```

`streamAssistantResponse` 内部虽然处理了 `toolcall_end` 事件（line 293），但仅用于更新 `partialMessage`，并没有触发工具执行。

### 截图/日志要点
- Gap 时间（第一个工具定义完成 vs 第一个工具开始执行的差值）
- 多工具场景下的总浪费时间
- 对比概念图：串行 vs 流式重叠

### Issue 定位建议
这个是一个 **Discussion** 类型的 issue，因为：
- 改动较大，涉及 `streamAssistantResponse` 和 `executeToolCalls` 的交互
- 可能影响 event ordering 的语义
- 需要 maintainer 对架构方向做出判断

---

## Issue 复现注意事项

### 模型行为不确定性

LLM 可能不会按你期望的方式调用工具。为了让复现更可靠：

1. **使用 `--append-system-prompt`** 强制行为：
```bash
./pi-test.sh --append-system-prompt "IMPORTANT: Always use individual tool calls for each operation. Never combine multiple operations into a single tool call. When asked to run multiple commands, use parallel bash tool calls."
```

2. **使用 SDK 脚本** 直接注入特定的工具调用（最可控），绕过模型不确定性。

3. **多次运行** 取最能展示问题的一次截图。

### JSON 模式输出解析

Pi 的 `--mode json` 模式输出每行一个事件，可以用 `jq` 解析：
```bash
# 只看工具执行事件
cat events.jsonl | jq 'select(.type | startswith("tool_execution"))'

# 看 stopReason
cat events.jsonl | jq 'select(.type == "message_end" and .message.role == "assistant") | .message.stopReason'

# 看错误
cat events.jsonl | jq 'select(.isError == true)'
```

### 用 time 命令量化

```bash
# Issue 2 最有效的证据
time ./pi-test.sh --print "Run: exit 1, and also: sleep 10" 2>/dev/null
# 如果显示 real ≈ 10s，证明失败的命令没有取消兄弟
```

---

## Issue 提交模板

### 标题格式
`[agent-loop] <简洁描述>`

### 正文结构
```markdown
## Problem

<一句话描述问题>

## Reproduction

<步骤 + 命令>

## Expected behavior

<应该发生什么>

## Actual behavior

<实际发生了什么，附日志/截图>

## Analysis

<代码位置 + 根因分析>

## Suggested fix

<简要的修复方向，不需要完整代码>
```

---

## Issue 6: Read 工具不检测二进制文件，直接以 UTF-8 读取

### 问题本质
Pi 的 `read` 工具只区分"支持的图片格式"（jpg/png/gif/webp）和"其他"。所有非图片文件一律 `buffer.toString("utf-8")` 读取。当模型请求读取 .zip/.tar.gz/.wasm/.sqlite/.bin 等二进制文件时，产生 UTF-8 乱码，浪费上下文窗口 token，且对模型完全没用。

### 代码根因

```typescript
// packages/coding-agent/src/core/tools/read.ts, line 153
const mimeType = ops.detectImageMimeType
  ? await ops.detectImageMimeType(absolutePath)
  : undefined;

if (mimeType) {
  // 图片处理路径
} else {
  // 所有非图片文件走这里
  const buffer = await ops.readFile(absolutePath);
  const textContent = buffer.toString("utf-8");  // ← 二进制文件也走这！
}
```

```typescript
// packages/coding-agent/src/utils/mime.ts
// detectSupportedImageMimeTypeFromFile 只识别 image/jpeg, image/png, image/gif, image/webp
// 对于 .zip (application/zip), .wasm (application/wasm) 等，返回 null
// 返回 null → read.ts 走文本路径 → 乱码
```

### 复现步骤

**方法1：交互模式（最直观）**

```bash
cd /Users/haiyangzhou/work/pi-mono

# 准备一个二进制文件
cp package-lock.json /tmp/test-text.json  # 对照组：文本文件
dd if=/dev/urandom of=/tmp/test-binary.bin bs=1024 count=5  # 5KB 随机二进制

# 启动 Pi
./pi-test.sh
```

**Prompt：**
```
Read the file /tmp/test-binary.bin
```

### 预期看到的问题

Pi 会返回类似这样的内容（截取）：
```
Ø%Ùûñ¿¡Æ³.»¬Ê÷Ý1$#Ö~ÿ}ð...
[Truncated: showing 47 of 47 lines (50.0KB limit)]
```

这段乱码：
- 占用大量上下文 token（~12,500 tokens 按 chars/4 估算）
- 对模型完全没有意义
- 模型无法从中提取任何有用信息

### 正确行为（Claude Code 的做法）

```
Error: Cannot read binary file /tmp/test-binary.bin.
This appears to be a binary file (extension: .bin).
Use bash to inspect binary files: xxd, hexdump, or file commands.
```

### 更真实的场景

```bash
# 场景1：模型尝试理解项目结构时读到编译产物
# Prompt: "Read the file dist/index.js.map"
# Source maps 可能包含大量 base64 编码的二进制数据

# 场景2：数据库文件
sqlite3 /tmp/test.db "CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1);"
# Prompt: "Read the file /tmp/test.db"

# 场景3：压缩文件
gzip -k /tmp/test-text.json
# Prompt: "Read the file /tmp/test-text.json.gz"
```

### 抓取证据

```bash
# 方法1：JSON 模式观察工具输出
./pi-test.sh --mode json --print "Read the file /tmp/test-binary.bin" 2>stderr.log | tee events.jsonl

# 搜索工具结果中的乱码
cat events.jsonl | jq 'select(.type == "tool_execution_end") | .result' | head -5

# 方法2：截图交互界面
# 在 Pi TUI 中看到乱码输出就截图
```

### 截图/日志要点
- 截取 Pi 返回二进制乱码的界面截图
- 对比 Claude Code 拒绝读取二进制文件的截图（如有）
- 强调：这些乱码消耗的 token 完全是浪费

### 建议修复

```typescript
// 在 read.ts 的文本路径之前添加二进制检测
const BINARY_EXTENSIONS = new Set([
  '.bin', '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.wasm', '.pyc', '.pyo', '.class',
  '.db', '.sqlite', '.sqlite3',
  '.pdf',  // PDF 需要专门的解析器
  '.ico', '.bmp', '.tiff', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.ttf', '.otf', '.woff', '.woff2',
]);

const ext = path.extname(absolutePath).toLowerCase();
if (BINARY_EXTENSIONS.has(ext)) {
  return {
    content: [{ type: "text", text: `Cannot read binary file (${ext}). Use bash commands like xxd, hexdump, or file to inspect binary files.` }],
    details: undefined,
  };
}
```

---

## Issue 7: 无聚合工具结果预算（多个大工具结果可吹爆上下文）

### 问题本质
Pi 每个工具独立截断（50KB/2000行），但没有一个 turn 内所有工具结果的总预算。当模型并行请求多个大文件读取时，聚合结果可能远超合理范围。

### 复现步骤

**方法：请求读取多个大文件**

```bash
cd /Users/haiyangzhou/work/pi-mono

# 准备多个大文件
for i in $(seq 1 10); do
  python3 -c "print('x' * 80 + '\n') * 2000" > /tmp/bigfile_$i.txt
done

./pi-test.sh
```

**Prompt：**
```
Read all of these files at once:
/tmp/bigfile_1.txt
/tmp/bigfile_2.txt
/tmp/bigfile_3.txt
/tmp/bigfile_4.txt
/tmp/bigfile_5.txt
/tmp/bigfile_6.txt
/tmp/bigfile_7.txt
/tmp/bigfile_8.txt
/tmp/bigfile_9.txt
/tmp/bigfile_10.txt
```

### 预期的问题

每个文件被截断到 50KB（2000行 × ~80字符/行 = ~160KB，但 50KB byte limit 先触发），10个文件总计 **~500KB** 工具结果注入上下文。

按 chars/4 估算 ≈ **125,000 tokens** 仅工具结果。

### 如何量化

**方法1：SDK 脚本**

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

async function main() {
  const { session } = await createAgentSession({});

  let totalResultSize = 0;
  let resultCount = 0;

  session.agent.subscribe(async (event) => {
    if (event.type === "tool_execution_end") {
      const resultStr = JSON.stringify(event.result);
      totalResultSize += resultStr.length;
      resultCount++;
      console.error(`[RESULT #${resultCount}] size=${resultStr.length} chars, total=${totalResultSize} chars (~${Math.round(totalResultSize/4)} tokens)`);
    }
  });

  await session.prompt("Read these files: " +
    Array.from({length: 10}, (_, i) => `/tmp/bigfile_${i+1}.txt`).join(", "));

  await session.agent.waitForIdle();

  console.error(`\n=== Aggregate Tool Results ===`);
  console.error(`Total results: ${resultCount}`);
  console.error(`Total size: ${totalResultSize} chars`);
  console.error(`Estimated tokens: ~${Math.round(totalResultSize/4)}`);
  console.error(`No aggregate budget was applied.`);
}

main().catch(console.error);
```

**方法2：JSON 模式**

```bash
./pi-test.sh --mode json --print "Read files: /tmp/bigfile_1.txt through /tmp/bigfile_10.txt" 2>stderr.log | tee events.jsonl

# 计算聚合大小
cat events.jsonl | python3 -c "
import sys, json
total = 0
count = 0
for line in sys.stdin:
    try:
        ev = json.loads(line)
        if ev.get('type') == 'tool_execution_end':
            size = len(json.dumps(ev.get('result', '')))
            total += size
            count += 1
            print(f'Result #{count}: {size} chars')
    except: pass
print(f'Total: {total} chars (~{total//4} tokens)')
print(f'No aggregate budget applied!')
"
```

### 对比：Claude Code 的做法

Claude Code 有 `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`（默认 200K chars）。超过预算的工具结果会被持久化到磁盘，替换为短摘要：
```
[Tool result too large, saved to disk. Summary: File /tmp/bigfile_5.txt, 2000 lines, contains repeated 'x' characters]
```

### 截图/日志要点
- 聚合工具结果总大小（证明无上限）
- 对比有预算时应该只保留最重要的结果

---

## Issue 8: Read 工具缺少重复读取去重

### 问题本质
模型在多轮对话中经常反复读取同一文件（例如编辑前后都读一次，或者在不同上下文中重新参考同一文件）。Pi 每次都返回完整内容，即使文件没有变化。这浪费上下文 token。

### 复现步骤

```bash
cd /Users/haiyangzhou/work/pi-mono
./pi-test.sh
```

**多轮对话模拟：**

```
轮次1: Read the file packages/agent/src/types.ts
```

等 Pi 返回内容后继续：

```
轮次2: Now read packages/agent/src/types.ts again
```

### 预期的问题

两次读取返回**完全相同的内容**（文件没有变化），浪费了一次完整的文件内容的 token。

### 如何量化

**SDK 脚本：**

```typescript
import { createAgentSession } from "@mariozechner/pi-coding-agent";

async function main() {
  const { session } = await createAgentSession({});

  const readArgs = new Map<string, string>();
  const readResults: { call: number; file: string; size: number }[] = [];

  session.agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start" && event.toolName === "read") {
      readArgs.set(event.toolCallId, event.args?.path || "unknown");
    }
    if (event.type === "tool_execution_end" && event.toolName === "read") {
      const size = JSON.stringify(event.result).length;
      const file = readArgs.get(event.toolCallId) || "unknown";
      readResults.push({
        call: readResults.length + 1,
        file,
        size,
      });
      console.error(`[READ #${readResults.length}] ${file} → ${size} chars`);
    }
  });

  // 第一次读
  await session.prompt("Read the file packages/agent/src/types.ts");
  await session.agent.waitForIdle();

  // 第二次读同一文件（文件没变）
  await session.prompt("Read packages/agent/src/types.ts again and confirm nothing changed");
  await session.agent.waitForIdle();

  console.error(`\n=== Duplicate Read Analysis ===`);
  for (const r of readResults) {
    console.error(`Call #${r.call}: ${r.file} → ${r.size} chars`);
  }

  if (readResults.length >= 2) {
    const wasted = readResults.slice(1).reduce((sum, r) => sum + r.size, 0);
    console.error(`Wasted on duplicate reads: ${wasted} chars (~${Math.round(wasted/4)} tokens)`);
    console.error(`Could have returned: "file_unchanged since last read"`);
  }
}

main().catch(console.error);
```

### 对比：Claude Code 的做法

Claude Code 的 `FileReadTool` 检测同文件 + 同范围 + 同 mtime 的重复读取：
```typescript
// 如果文件没变化
return { type: "text", text: "[file_unchanged: packages/agent/src/types.ts]" };
```

这将 ~8000 chars 的重复内容压缩到 ~50 chars，节省 ~2000 tokens。

### 截图/日志要点
- 两次读取返回完全相同的内容
- 计算浪费的 token 数
- 在长对话中模型多次读取同一文件的真实场景

### 注意
这个 Issue 更偏向性能优化而非 bug。建议作为 Enhancement 提交。但在长对话中影响显著——模型读取同一个 300 行的文件 5 次 = 浪费 ~10,000 tokens。

---

## 所有 Issue 汇总

| # | 标题 | 类型 | Bug? | 接受度 | 复现难度 |
|---|------|------|------|--------|---------|
| 1 | `stopReason: "length"` 未处理 | 鲁棒性 | ✅ | ★★★☆☆ | 中 |
| 6 | Read 不检测二进制文件 | Bug | ✅ | ★★★★★ | 低 |
| 2 | 兄弟工具失败不取消 | 鲁棒性 | ⚠️ | ★★★★☆ | 低 |
| 3 | 并行无并发上限 | 安全 | ⚠️ | ★★★★☆ | 低 |
| 7 | 无聚合工具结果预算 | 设计 | ⚠️ | ★★★☆☆ | 低 |
| 8 | Read 无去重 | 性能 | ❌ | ★★★☆☆ | 低 |
| 4 | 工具并发安全声明 | 设计 | ❌ | ★★☆☆☆ | 低 |
| 5 | 流式工具执行 | 性能 | ❌ | ★★☆☆☆ | 中 |

---

## Issue 9: Bash 工具将所有非零退出码视为错误（grep/diff/test 误报）

### 问题本质
Pi 的 `bash` 工具对所有 `exitCode !== 0` 都 `reject(new Error(...))`，这导致：
- `grep pattern file` 未找到匹配 → exit 1 → Pi 报告为"error"
- `diff file1 file2` 文件不同 → exit 1 → Pi 报告为"error"
- `test -f somefile` 文件不存在 → exit 1 → Pi 报告为"error"

这些命令的 exit 1 是**正常语义**，不是错误。

### 代码根因

```typescript
// packages/coding-agent/src/core/tools/bash.ts, lines 379-384
if (exitCode !== 0 && exitCode !== null) {
    outputText += `\n\nCommand exited with code ${exitCode}`;
    reject(new Error(outputText));  // ← 所有非零都当 error
} else {
    resolve({ content: [{ type: "text", text: outputText }], details });
}
```

没有任何命令语义映射。对比 Claude Code 的 `commandSemantics.ts`：

```typescript
// Claude Code: src/tools/BashTool/commandSemantics.ts
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  ['grep', (exitCode) => ({
    isError: exitCode >= 2,  // 0=found, 1=not found, 2+=real error
    message: exitCode === 1 ? 'No matches found' : undefined,
  })],
  ['diff', (exitCode) => ({
    isError: exitCode >= 2,  // 0=same, 1=different, 2+=error
  })],
  ['test', () => ({ isError: false })],  // always semantic
]);
```

### 复现步骤

```bash
cd /Users/haiyangzhou/work/pi-mono
./pi-test.sh
```

**Prompt 1（grep 无匹配）：**
```
Run this command: grep "xyznonexistent" package.json
```

**预期看到的问题：**
Pi 返回 error 消息，包含 `Command exited with code 1`，模型可能认为命令执行失败并开始"修复"或重试。

**Prompt 2（diff 比较不同文件）：**
```
Run: diff package.json tsconfig.json
```

**预期看到的问题：**
同样返回 error，但 diff exit 1 只表示"文件不同"——这正是用户期望的结果。

**Prompt 3（test 检查不存在的文件）：**
```
Run: test -f /tmp/nonexistent_file_12345 && echo "exists" || echo "not exists"
```

这个用 `||` 规避了问题，但如果直接用 `test -f /tmp/nonexistent`，会误报为 error。

### 抓取证据

```bash
# JSON 模式观察
./pi-test.sh --mode json --print 'Run: grep "xyznonexistent" package.json' 2>stderr.log | tee events.jsonl

# 检查工具结果是 error 而非正常返回
cat events.jsonl | jq 'select(.type == "tool_execution_end") | {toolName, isError}'

# 如需查看 bash 返回的退出码文本，可继续抽取 text block：
cat events.jsonl | jq -r '
  select(.type == "tool_execution_end") |
  .result.content[]? |
  select(.type == "text") |
  .text
'
```

### 影响
- 模型看到 "error" 后可能做出错误决策（重试、换命令、放弃）
- 对 `grep -r` 搜索代码时影响最大——搜不到东西是正常的，不应报错
- 在实际使用中非常频繁（每个 coding agent session 都可能执行大量 grep）

### 建议修复

添加命令语义映射，至少覆盖 `grep`、`rg`、`diff`、`test`、`cmp`：

```typescript
const COMMAND_SEMANTICS: Record<string, (exitCode: number) => boolean> = {
  grep: (code) => code >= 2,   // 1 = no match (not error)
  rg: (code) => code >= 2,
  diff: (code) => code >= 2,   // 1 = files differ (not error)
  test: () => false,            // all exit codes are semantic
  cmp: (code) => code >= 2,
};

function getLeadCommand(command: string): string {
  return command.trim().split(/[\s|&;]/)[0].replace(/^.*\//, '');
}

// 替换 reject 逻辑：
const leadCmd = getLeadCommand(command);
const isRealError = COMMAND_SEMANTICS[leadCmd]?.(exitCode) ?? (exitCode !== 0);
if (isRealError) {
  reject(new Error(outputText));
} else {
  resolve({ content: [{ type: "text", text: outputText }], details });
}
```

---

## Issue 10: Bash 工具无默认超时（命令可无限挂起）

### 问题本质
Pi 的 bash 工具 `timeout` 参数是可选的，且**无默认值**。如果模型执行了一个会挂起的命令（如 `cat` 不带参数、`read` 等待输入、连接不通的 `curl`），整个 session 会**永久卡死**。

### 代码根因

```typescript
// packages/coding-agent/src/core/tools/bash.ts, lines 33-35
const bashSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({
        description: "Timeout in seconds (optional, no default timeout)"
    })),
});

// lines 93-99
if (timeout !== undefined && timeout > 0) {
    timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
    }, timeout * 1000);
}
// ← 如果 timeout 未提供，不设置任何超时
```

对比 Claude Code：

```typescript
// Claude Code: src/utils/Shell.ts
const DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 分钟
const commandTimeout = timeout || DEFAULT_TIMEOUT;
```

### 复现步骤

```bash
cd /Users/haiyangzhou/work/pi-mono
./pi-test.sh
```

**Prompt（会导致挂起的命令）：**
```
Run this command: cat
```

或：
```
Run: python3 -c "import time; time.sleep(99999)"
```

### 预期看到的问题
- Pi session 卡住，无法进行任何操作
- 必须手动 Ctrl+C 终止整个进程
- 如果模型决定不传 `timeout` 参数（这是默认行为），没有任何保护

### 抓取证据

```bash
# 在另一个终端观察 Pi 进程
ps aux | grep pi

# 等待 30 秒后观察进程仍然存活
# 截图显示 Pi 完全卡住无响应
```

### 影响
- **可靠性严重问题**：一个挂起的命令导致整个 session 不可用
- 模型不可能总是正确判断什么命令需要 timeout
- 在实际使用中，`curl` 连接超时、交互式命令等都可能触发

### 建议修复

```typescript
const DEFAULT_BASH_TIMEOUT = 30 * 60; // 30 分钟（秒）

// 在 execute 中：
const effectiveTimeout = timeout ?? DEFAULT_BASH_TIMEOUT;
if (effectiveTimeout > 0) {
    timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
    }, effectiveTimeout * 1000);
}
```

---

## Issue 11: Edit 工具无冲突检测（读-编辑间文件变更导致静默覆盖）

### 问题本质
Pi 的 `edit` 工具在执行时读取文件 → 应用编辑 → 写入文件，但**不检查文件自上次 read 以来是否被修改**。如果 linter（eslint --fix）、formatter（prettier）、或另一个工具在 read 和 edit 之间修改了文件，编辑会**静默覆盖**那些变更。

### 代码根因

```typescript
// packages/coding-agent/src/core/tools/edit.ts, execute path around lines 357-382
// 同文件工具调用会先进入 withFileMutationQueue，但队列内部仍是直接读取 → 编辑 → 写入，没有任何外部修改检测
await withFileMutationQueue(absolutePath, async () => {
const buffer = await ops.readFile(absolutePath);
const rawContent = buffer.toString("utf-8");
// ...
const { baseContent, newContent } = applyEditsToNormalizedContent(
    normalizedContent, edits, path,
);
// ...
await ops.writeFile(absolutePath, finalContent);
// ← 没有检查文件在 read 和 edit 之间是否被其他进程修改
});
```

对比 Claude Code 的 `FileEditTool.ts`：

```typescript
// Claude Code 跟踪每次 read 的时间戳和内容
const readTimestamp = toolUseContext.readFileState.get(fullFilePath);
if (!readTimestamp) {
  return { result: false, message: 'File has not been read yet.' };
}
const lastWriteTime = getFileModificationTime(fullFilePath);
if (lastWriteTime > readTimestamp.timestamp) {
  // 文件被修改了！
  return { result: false, message: 'File modified since read, read it again.' };
}
```

### 复现步骤

**方法1：模拟 linter 自动修复**

```bash
cd /Users/haiyangzhou/work/pi-mono

# 创建一个 JS 文件
cat > /tmp/test-edit-conflict.js << 'EOF'
const x = 1;
const  y  =  2;
function foo(){
return x+y
}
EOF

./pi-test.sh
```

**Prompt：**
```
Read the file /tmp/test-edit-conflict.js, then add a comment "// hello" at the top
```

在 Pi 读取文件后但写入前，在另一个终端运行：
```bash
# 模拟 prettier/linter 自动格式化
npx prettier --write /tmp/test-edit-conflict.js
```

Pi 的 edit 会覆盖 prettier 的格式化结果。

**方法2：更真实的场景**

```
1. 让 Pi read 一个 TypeScript 文件
2. Pi 执行 edit 修改该文件
3. 假设项目配置了 onSave 的 eslint --fix
4. eslint 修改了文件（添加分号、修复缩进等）
5. Pi 下一次 edit 同一文件时，基于旧内容，覆盖了 eslint 的修复
```

### 抓取证据

```bash
# 1. 创建测试文件
echo "line1\nline2\nline3" > /tmp/conflict-test.txt

# 2. 在 Pi 中读取文件
# Prompt: "Read /tmp/conflict-test.txt"

# 3. 在另一个终端修改文件
echo "MODIFIED BY EXTERNAL TOOL" >> /tmp/conflict-test.txt

# 4. 在 Pi 中编辑文件
# Prompt: "Replace 'line2' with 'edited-line2' in /tmp/conflict-test.txt"

# 5. 检查结果
cat /tmp/conflict-test.txt
# 预期看到 "MODIFIED BY EXTERNAL TOOL" 被覆盖丢失
```

### 影响
- **数据丢失**：外部修改（linter、formatter、其他工具）被静默覆盖
- 在有 format-on-save 配置的项目中尤其危险
- 用户不会意识到修改被覆盖了

### 建议修复

```typescript
// 在 agent-session 或 tool context 中维护 readFileState
interface ReadState {
  timestamp: number;
  content: string;
}
const readFileState = new Map<string, ReadState>();

// edit 执行前检查
const lastRead = readFileState.get(absolutePath);
if (lastRead) {
  const currentMtime = statSync(absolutePath).mtimeMs;
  if (currentMtime > lastRead.timestamp) {
    // 文件被修改了
    throw new Error(
      `File ${path} has been modified since it was last read. ` +
      `Read it again before editing.`
    );
  }
}
```

---

## Issue 12: Edit 工具不处理 UTF-16 编码（非 UTF-8 文件被损坏）

### 问题本质
Pi 的 edit 和 read 工具硬编码 `buffer.toString("utf-8")` 和 `writeFile(path, content, "utf-8")`。UTF-16 LE/BE 编码的文件（某些 Windows 生成的配置文件、PowerShell 脚本等）会被**损坏**。

### 代码根因

```typescript
// packages/coding-agent/src/core/tools/edit.ts, lines 79-81
const defaultEditOperations: EditOperations = {
    readFile: (path) => fsReadFile(path),
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    //                                                        ^^^^^^^^ 硬编码 UTF-8
};

// edit execute, around line 359
const rawContent = buffer.toString("utf-8");  // UTF-16 文件变乱码
```

对比 Claude Code：

```typescript
// Claude Code 检测 BOM 选择编码
const encoding: BufferEncoding =
  fileBuffer.length >= 2 &&
  fileBuffer[0] === 0xff &&
  fileBuffer[1] === 0xfe
    ? 'utf16le'
    : 'utf8';
fileContent = fileBuffer.toString(encoding);
```

### 复现步骤

```bash
# 创建一个 UTF-16 LE 文件（有 BOM）
python3 -c "
with open('/tmp/utf16-test.txt', 'wb') as f:
    f.write(b'\xff\xfe')  # UTF-16 LE BOM
    f.write('Hello World\nLine 2\nLine 3\n'.encode('utf-16-le'))
"

# 验证文件
file /tmp/utf16-test.txt
# 应显示: UTF-16 Unicode text, with BOM

cd /Users/haiyangzhou/work/pi-mono
./pi-test.sh
```

**Prompt：**
```
Read the file /tmp/utf16-test.txt, then replace "Line 2" with "Modified Line 2"
```

### 预期看到的问题
1. `read` 返回乱码（UTF-16 被当 UTF-8 解码）
2. 如果模型仍尝试 `edit`，写入的 UTF-8 内容**损坏**了文件编码
3. 原来能正常打开的文件变得无法使用

### 抓取证据

```bash
# 对比编辑前后的文件
hexdump -C /tmp/utf16-test.txt | head  # 编辑前
# 让 Pi 编辑
hexdump -C /tmp/utf16-test.txt | head  # 编辑后 → BOM 和编码信息丢失
file /tmp/utf16-test.txt  # 编辑后不再是 UTF-16
```

### 影响
- UTF-16 文件被静默损坏
- 在跨平台项目中（Windows 生成的文件）会遇到
- 虽然纯 UTF-8 项目不受影响，但这是一个**真正的 bug**

---

## 更新后的完整 Issue 汇总

| # | 标题 | 类型 | Bug? | 接受度 | 复现难度 |
|---|------|------|------|--------|---------|
| 9 | Bash 非零退出码全部视为 error | Bug | ✅ | ★★★★★ | 极低 |
| 1 | `stopReason: "length"` 未处理 | 鲁棒性 | ✅ | ★★★☆☆ | 中 |
| 6 | Read 不检测二进制文件 | Bug | ✅ | ★★★★★ | 低 |
| 10 | Bash 无默认超时 | 可靠性 | ✅ | ★★★★☆ | 极低 |
| 11 | Edit 无冲突检测 | 数据安全 | ⚠️ | ★★★★☆ | 低 |
| 12 | Edit 不处理 UTF-16 | Bug | ✅ | ★★★★☆ | 低 |
| 2 | 兄弟工具失败不取消 | 鲁棒性 | ⚠️ | ★★★★☆ | 低 |
| 3 | 并行无并发上限 | 安全 | ⚠️ | ★★★★☆ | 低 |
| 7 | 无聚合工具结果预算 | 设计 | ⚠️ | ★★★☆☆ | 低 |
| 8 | Read 无去重 | 性能 | ❌ | ★★★☆☆ | 低 |
| 4 | 工具并发安全声明 | 设计 | ❌ | ★★☆☆☆ | 低 |
| 5 | 流式工具执行 | 性能 | ❌ | ★★☆☆☆ | 中 |

### 注意事项
- Pi 的 CONTRIBUTING.md 要求首次贡献者先开 Issue
- 不要直接提 PR
- 先等 `lgtm`，再提 PR
- 不要编辑 CHANGELOG.md
