# 设计模式与贡献指南

## 核心设计模式

### 1. 推送式事件流 (EventStream)

**位置**: pi-ai 的 `EventStream<T, R>`，全项目使用

**模式**: 生产者推送事件；消费者异步迭代。stream 有"完成"概念 —
一个终止事件结束它并 resolve 最终结果 Promise。

**为什么不用拉取式？** LLM 响应异步到达（SSE/WebSocket）。推送允许生产者独立于消费者速度工作。
queue 在消费者较慢时缓冲事件。

**为什么不用回调？** 异步迭代（`for await`）给消费者提供背压和自然的错误处理，
且与 async/await 天然组合。

### 2. 边界转换 (convertToLlm)

**位置**: `AgentLoopConfig.convertToLlm`

**模式**: 内部表示（AgentMessage）与外部表示（Message）不同。转换只在边界发生，不是到处转换。

**为什么？** 每层都添加 LLM 不理解的消息类型。与其到处搞联合类型，不如在一个地方
（convertToLlm）决定映射方式。循环保持通用。

### 3. 声明合并扩展 (CustomAgentMessages)

**位置**: agent-core 的 `CustomAgentMessages` 接口

**模式**: TypeScript 的声明合并允许下游包扩展接口而不修改源代码。基础类型自动包含所有扩展。

**为什么不用泛型？** 泛型需要把类型参数传递到每个处理 AgentMessage 的函数。
声明合并全局生效，零代码改动。

### 4. 可插拔操作 (Pluggable Operations)

**位置**: coding-agent 的 `EditOperations`、`BashOperations`、`WriteOperations`

**模式**: 工具接受一个 operations 接口。默认实现用本地文件系统。
可以被替换为远程（SSH）、mock（测试）或自定义实现。

**支持场景**:
- 不碰文件系统的单元测试
- 通过 SSH 远程编辑
- 自定义存储后端
- 工具逻辑与 I/O 分离

### 5. 懒加载 Provider

**位置**: pi-ai 的 `register-builtins.ts`

**模式**: Provider 模块只在首次使用时动态导入。同步的包装器立即返回 stream；
实际的 provider 在内部异步加载。

**为什么？** 20+ 个 provider，全部启动时加载太慢太浪费。
某些 provider（Bedrock）依赖 Node-only 模块会破坏浏览器构建。

### 6. 文件变更队列（`withFileMutationQueue`）

**位置**: coding-agent 的 `file-mutation-queue.ts`

**模式**: 一个 `Map<normalizedPath, Promise>` 的链式结构。每个新操作链接到前一个的 Promise。
不需要 mutex 或 semaphore。路径通过 `realpathSync.native` 归一化（失败则 `resolve` 回退）。

**当前状态**: edit 和 write 工具都通过 `withFileMutationQueue` 保护。

**为什么用 Promise 链而非 Mutex**:
- 更简单（无 lock/unlock 状态管理）
- 天然 FIFO（链保持顺序）
- 错误安全（finally 总是释放）
- 无外部依赖

### 7. 钩子适配器（桥接模式）

**位置**: AgentSession 桥接 `beforeToolCall` → `emitToolCall`

**模式**: agent-core 定义低级钩子。coding-agent 的 AgentSession 把这些适配为扩展事件系统。
扩展看到高级事件；agent 循环看到钩子返回值。

**为什么？** 解耦。agent-core 不知道扩展的存在。扩展不知道钩子返回类型。
AgentSession 翻译两者之间。

## 代码库中的常见模式

### 错误处理：流中永远不 throw

```typescript
// 错误做法: 抛出异常破坏流契约
streamFn: () => {
  throw new Error("API key missing")
}

// 正确做法: 把错误编码在 stream 事件中
streamFn: () => {
  const stream = new AssistantMessageEventStream()
  stream.push({ type: "error", reason: "error", error: errorMessage })
  stream.end()
  return stream
}
```

这个模式出现在：
- `StreamFunction` 契约（pi-ai types.ts）
- 所有 provider 实现
- `AgentLoopConfig.convertToLlm`（"must not throw or reject"）
- `AgentLoopConfig.transformContext`（"must not throw or reject"）

### TypeBox 用于工具 Schema

```typescript
import { Type } from "@sinclair/typebox"

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file" }),
  oldText: Type.String({ description: "Exact text to find" }),
  newText: Type.String({ description: "Text to replace with" }),
})
```

TypeBox 在运行时生成 JSON Schema，用于：
- LLM 工具定义（发送给 API）
- 参数验证（`validateToolArguments`）
- TypeScript 类型推断（`Static<typeof editSchema>`）

### AbortSignal 传播

每个异步操作接受 `signal?: AbortSignal`：

```
Agent.prompt() → AbortController.signal
  → runAgentLoop(signal)
    → streamAssistantResponse(signal)
      → streamSimple(options.signal)
        → provider SDK（转发 signal）
    → executeToolCalls(signal)
      → tool.execute(signal)
        → ops.exec(signal)  // bash
```

中止在每一层生效。工具在操作之间检查 `signal.aborted`（读、处理、写之间）
避免浪费工作。

## 贡献清单

### 写代码前

1. 读 `CONTRIBUTING.md` 和 `AGENTS.md`
2. 开 issue 描述改动
3. 等 maintainer 回复 `lgtm`
4. 确定改动影响哪一层

### 层级放置指南

| 改动 | 正确的层 |
|------|----------|
| 新 LLM provider | pi-ai |
| Provider 特定选项 | pi-ai |
| 模型定价更新 | pi-ai (scripts/generate-models.ts) |
| 循环控制流（steering、follow-up） | agent-core |
| 工具执行顺序 | agent-core |
| 新钩子类型 | agent-core |
| 新编码工具 | coding-agent |
| 工具行为修复 | coding-agent |
| 扩展 API | coding-agent |
| 系统提示词 | coding-agent |
| 会话持久化 | coding-agent |
| 上下文压缩 | coding-agent |
| UI 组件 | coding-agent 或 web-ui |

### 代码风格

- 不用 `any`（除非绝对必要）
- 不用 inline import（`await import(...)`）
- 不硬编码按键绑定
- 工具参数用 TypeBox
- 流函数中永远不 throw
- 始终传播 AbortSignal

### 测试

```bash
# 提交前必须通过的检查
npm run check

# 运行特定测试
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts

# 运行所有测试（PR 前运行，不在开发过程中运行）
./test.sh
```

### 常见错误

1. **编辑 CHANGELOG.md** — 由 maintainer 处理
2. **放错层** — 文件锁放在 agent-core 而非 coding-agent
3. **破坏流契约** — throw 而不是把错误编码在事件中
4. **缺少中止检查** — 长操作不检查 signal.aborted
5. **使用 `git add -A`** — 会暂存其他 agent 的改动
6. **Inline import** — `await import("./foo.js")` 被禁止
