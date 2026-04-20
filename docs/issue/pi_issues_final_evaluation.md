# Pi Issues 最终评估：哪些是真正有价值的？

基于对 Pi 完整架构、设计哲学、和代码路径的深度验证。

---

## Pi 的设计哲学（必须理解的背景）

> "pi's core is minimal. If your feature doesn't belong in the core, it should be an extension."

Pi 故意选择了 minimal core + extensibility 路线。很多 Claude Code 有而 Pi 没有的特性，不是"缺陷"，而是**设计选择**。提 issue 时必须区分：
- **真正的 bug**：代码行为违反了其自身的预期语义
- **真正的安全缺陷**：可能导致数据丢失或系统挂起
- **设计增强**：Claude Code 做得更好，但 Pi 的做法不算"错"

---

## ✅ 真正有价值的 Issue（建议提交）

### Issue 9: Bash 非零退出码误标 isError（★★★★★ 推荐度最高）

**为什么是真 bug：**

经代码路径验证：`packages/coding-agent/src/core/tools/bash.ts` 的 `reject(new Error(...))`（约 lines 379-381）→ `packages/agent/src/agent-loop.ts` 的 `executePreparedToolCall` catch（约 lines 555-559）→ 返回 `{ result, isError: true }`。

关键点：虽然**文本内容**（stdout/stderr + exit code）被保留，但 `isError: true` 标志通过 `convertMessages` 传递给 LLM API（如 Anthropic 的 `is_error: true`），**直接误导模型认为工具执行失败**。

```typescript
// packages/agent/src/agent-loop.ts lines 555-559
} catch (error) {
    return {
        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
        isError: true,  // ← 这个标志对 grep exit 1 是错误的
    };
}
```

**实际影响：**
- `grep pattern file` 没找到结果（exit 1）→ 模型看到 `isError: true` → 模型认为 grep 命令有问题 → 尝试"修复"命令或道歉
- `diff file1 file2` 文件不同（exit 1）→ 同样误导
- 这在每个 coding session 中**高频发生**（grep 是最常用的命令之一）

**为什么 Pi maintainer 会接受：**
- 这是客观的语义错误：grep exit 1 ≠ error
- 修复极小（添加命令语义映射表）
- 不违反 Pi 的 minimal core 哲学（这是修复 bug，不是添加 feature）

---

### Issue 6: Read 工具不检测二进制文件（★★★★☆）

**为什么是真 bug：**

Pi 团队已经在 bash 工具中处理了二进制输出问题（`sanitizeBinaryOutput`，changelog 中有"Fix crash when bash command outputs binary data"的记录），但 `read` 工具的二进制处理仍有缺口：

```typescript
// packages/coding-agent/src/core/tools/read.ts lines 153, 186-188: 只检测支持的图片格式，其他一律 UTF-8
const mimeType = ops.detectImageMimeType
  ? await ops.detectImageMimeType(absolutePath) : undefined;
if (mimeType) { /* 图片路径 */ }
else {
    const buffer = await ops.readFile(absolutePath);
    const textContent = buffer.toString("utf-8");  // .zip/.db/.wasm → 乱码
}
```

**为什么 Pi maintainer 会接受：**
- 团队已证明关注二进制数据问题（bash 已修复）
- read 工具是同类问题的遗漏
- 乱码消耗 token 且无意义，这不是设计选择

**注意：** 实际影响取决于模型多频繁地请求读取二进制文件。在正常 coding session 中不算高频，但偶尔会发生（模型试图理解项目结构时可能读取 .sqlite、.wasm 等）。

---

### Issue 10: Bash 工具无默认超时（★★★★☆）

**为什么是真的可靠性问题：**

经完整代码路径验证：
1. `packages/coding-agent/src/core/tools/bash.ts`（约 lines 33-36）：`timeout` 可选，无默认值
2. `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`：无超时包装
3. `packages/agent/src/agent-loop.ts` → `executePreparedToolCall`：无默认超时，只有 abort signal
4. `packages/agent/src/agent.ts` → `runWithLifecycle`：signal 仅用于手动 abort，无定时器

**结论：如果模型不传 timeout 参数（这是默认行为），一个挂起的命令会导致 session 永久卡住。**

**Pi 的设计考量：**
Pi 的哲学是"No background bash — use tmux"，暗示他们偏好用户显式控制。但缺少默认超时不是"显式控制"——而是"无保护"。用户甚至不知道发生了什么。

**为什么 maintainer 可能会接受：**
- 这是可靠性问题，不是功能增强
- 一个合理的默认超时（如 30 分钟）不违反 minimal 原则
- 修复极小

**为什么 maintainer 可能犹豫：**
- 他们可能认为这应该由模型自己学会传 timeout 参数
- 或者他们认为用户应该手动 Ctrl+C

---

## ⚠️ 有一定价值但需谨慎（可以提但期望别太高）

### Issue 1: stopReason "length" 未特殊处理（★★★☆☆）

**重新评估：**
需要验证模型实际是否频繁触发 output token limit。如果模型通常在 4K-8K output 范围内完成响应，这个 issue 很少触发。Claude Code 的 `max_tokens` escalation 是为了极端情况（模型输出非常长的代码块），而 Pi 的默认 maxTokens 如果已经设得足够大，可能不是问题。

**建议：** 先自己测试看 stopReason "length" 是否实际发生，再决定是否提 issue。

### Issue 11: Edit 无冲突检测（★★★☆☆）

**重新评估：**
Pi 的 edit 工具在 execute 时**重新读取文件**并匹配 `oldText`。这提供了**部分保护**：
- 如果外部修改改变了被编辑区域 → `oldText` 不匹配 → 编辑失败（安全）
- 如果外部修改只改了其他区域 → `oldText` 仍匹配 → 覆盖外部修改（数据丢失）

第二种情况是真实风险，但频率取决于项目是否有 format-on-save 等自动化。

**为什么 maintainer 可能犹豫：**
- Pi 有 `file-mutation-queue` 处理并发工具（team 已考虑过文件冲突）
- 实现完整的 readFileState 跟踪是相当大的改动，不算"minimal"
- 可能被认为是 extension 的职责

---

## ❌ 不建议提的 Issue（设计选择或过度优化）

### Issue 2（兄弟工具失败不取消）、Issue 3（并行无并发上限）

**为什么不提：** Pi 的并行工具执行是有意的简化设计。adding complexity 违反 minimal core 原则。

### Issue 4（工具并发安全声明）

**为什么不提：** 这条判断本身并没有过期。当前 Pi 依然只有全局 `toolExecution` 开关，没有 Claude Code 那种 per-tool 并发安全声明或分区批处理。但它更像 feature request / 调度策略讨论，不是明确 bug；Pi 也已经用 `file-mutation-queue` 缓解了同文件写冲突，所以不适合作为优先 issue。

### Issue 5（流式工具执行）

**为什么不提：** 这是性能优化，Pi 可能认为等 LLM 完全响应后再执行工具更简单可靠。

### Issue 7（聚合工具结果预算）

**为什么不提：** Pi 的个体工具截断（50KB/2000行）已经提供了基本保护。聚合预算是额外优化层。

### Issue 8（Read 去重）

**为什么不提：** 纯性能优化。Pi 团队可能认为这增加了不必要的复杂性。

### Issue 12（UTF-16 编码）

**重新评估后降级：** 虽然技术上是 bug，但现代项目几乎全是 UTF-8。Pi 可能有意只支持 UTF-8。影响范围太小，不值得首次贡献者拿来提 issue。

---

## 最终推荐：按优先级排序

| 优先级 | Issue | 理由 |
|--------|-------|------|
| 🥇 第一个提 | **Issue 9: Bash 退出码语义** | 客观 bug，高频触发，极小修复，无争议 |
| 🥈 第二个提 | **Issue 6: Read 二进制检测** | 明确的遗漏（team 已修了 bash 的同类问题），合理修复 |
| 🥉 第三个提 | **Issue 10: Bash 默认超时** | 可靠性问题，修复简单，但可能有设计分歧 |
| 💡 观察后提 | **Issue 1: stopReason length** | 先自己验证是否实际发生 |
| 💡 观察后提 | **Issue 11: Edit 冲突检测** | 有部分保护，需要更强的 evidence |

---

## 提 Issue 的策略

1. **Issue 9 作为首次贡献**：这是最安全的选择。这是一个明确的语义 bug，修复小且无争议。如果被接受并合并，你就建立了信誉。

2. **不要一次提太多 issue**：作为新贡献者，一次提 5 个 issue 会显得不专业。一个一个来。

3. **每个 issue 需要包含：**
   - 清晰的问题描述（不要提到 Claude Code）
   - 复现步骤
   - 实际输出 vs 预期输出
   - 建议的修复方案（简短）

4. **不要提到 Claude Code**：Pi maintainer 不需要知道你是通过比较 Claude Code 发现的。只描述 Pi 的问题本身。
