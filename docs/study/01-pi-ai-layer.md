# 第一层: pi-ai — 统一 LLM API

## 职责

`@mariozechner/pi-ai` 提供跨 20+ LLM 提供商的统一流式 API。
它不知道 agent、工具执行或文件系统的存在。唯一的工作：把消息发给 LLM，返回结构化的事件流。

## 关键源文件

| 文件 | 作用 |
|------|------|
| `src/types.ts` | 所有类型定义：Message、Tool、Context、Model、Events |
| `src/stream.ts` | `streamSimple()`、`complete()` — 公共入口 |
| `src/utils/event-stream.ts` | `EventStream<T, R>` — 推送式异步迭代器 |
| `src/api-registry.ts` | Provider 注册表 |
| `src/providers/register-builtins.ts` | 所有内置 Provider 的懒注册 |
| `src/models.ts` | 模型注册表：`getModel()`、`getModels()` |
| `src/env-api-keys.ts` | `getEnvApiKey()` — 凭证检测 |

## 核心类型 (src/types.ts)

> **源码对照**: `packages/ai/src/types.ts` — Message L213, Usage L167-178, Model L314, CacheRetention L56, AssistantMessageEvent L237

### 消息类型

```typescript
// LLM 能理解的三种角色
type Message = UserMessage | AssistantMessage | ToolResultMessage

// 用户消息：纯文本或文本+图片
interface UserMessage {
  role: "user"
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

// 助手回复：文本、推理、工具调用
interface AssistantMessage {
  role: "assistant"
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: Api              // 哪个 API 生成的
  provider: Provider    // 哪个提供商
  model: string         // 模型 ID
  usage: Usage          // token 用量和费用
  stopReason: StopReason // "stop" | "length" | "toolUse" | "error" | "aborted"
  timestamp: number
}

// 工具结果：文本和图片
interface ToolResultMessage<TDetails = any> {
  role: "toolResult"
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  isError: boolean
  timestamp: number
}
```

### 内容块类型

```typescript
interface TextContent { type: "text"; text: string }
interface ThinkingContent { type: "thinking"; thinking: string }
interface ImageContent { type: "image"; data: string; mimeType: string }
interface ToolCall {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, any>
}
```

### 流式事件协议

每个事件中的 `partial` 字段包含**累积的**消息状态（不仅仅是增量），
所以消费者随时可以读 `partial.content` 获取当前完整内容。

```typescript
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  // 文本流
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  // 推理流
  | { type: "thinking_start"; ... }
  | { type: "thinking_delta"; ... }
  | { type: "thinking_end"; ... }
  // 工具调用流
  | { type: "toolcall_start"; ... }
  | { type: "toolcall_delta"; ... }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; ... }
  // 终止事件
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage }
```

### Model 和 Context

```typescript
interface Model<TApi extends Api> {
  id: string          // 如 "claude-sonnet-4-20250514"
  name: string        // 如 "Claude Sonnet 4"
  api: TApi           // 如 "anthropic-messages"
  provider: Provider  // 如 "anthropic"
  baseUrl: string     // API 端点
  reasoning: boolean  // 是否支持推理
  contextWindow: number
  maxTokens: number
  cost: { input, output, cacheRead, cacheWrite }  // $/百万 token
}

interface Context {
  systemPrompt?: string
  messages: Message[]
  tools?: Tool[]       // Tool 只有 schema，没有 execute
}
```

## EventStream (src/utils/event-stream.ts)

> **源码对照**: `packages/ai/src/utils/event-stream.ts` — EventStream 类 L4

pi-mono 所有流式操作的骨干。推送式异步迭代器，带最终结果 Promise。

### 内部状态

```
queue: T[]                               — 未消费的缓冲事件
waiting: ((IteratorResult<T>) => void)[]  — 阻塞的消费者 resolver
done: boolean                             — 是否收到终止事件
finalResultPromise: Promise<R>            — 完成时 resolve
```

### Push 流程

```
push(event) 被调用时:
  1. 如果 done → 忽略
  2. 如果 isComplete(event) → 标记 done，resolve finalResultPromise
  3. 如果有消费者在等待 → 解除阻塞（传递事件）
  4. 否则 → 加入 queue
```

### 消费者流程 (for await)

```
[Symbol.asyncIterator]:
  1. 如果 queue 非空 → yield queue.shift()
  2. 如果 done → return（结束迭代）
  3. 否则 → 创建 Promise → 把 resolver 加入 waiting[] → 阻塞等待
```

### 设计决策

事件**按顺序**传递。只应有一个消费者迭代 stream。多个消费者会互相"偷"事件。

## streamSimple() 流程 (src/stream.ts)

> **源码对照**: `packages/ai/src/stream.ts` — streamSimple L43

```typescript
export function streamSimple(model, context, options?) {
  const provider = getApiProvider(model.api)  // 从注册表查找
  return provider.streamSimple(model, context, options)
}
```

就这么简单 — 一行注册表分发。复杂性在于：
1. 注册表（懒加载）
2. Provider 实现（协议映射）

## Provider 实现模式

> **源码对照**: `packages/ai/src/providers/anthropic.ts` — streamAnthropic L199, streamSimpleAnthropic L477

每个 Provider 遵循相同模式（以 Anthropic 为例）：

```
streamAnthropic(model, context, options):
  1. 创建 AssistantMessageEventStream
  2. 启动异步 IIFE（不 await — 立即返回 stream）
  3. 异步内部:
     a. 解析凭证（options.apiKey、环境变量、OAuth）
     b. 构建 provider 特定参数（buildParams）
     c. 调用 provider SDK（client.messages.stream）
     d. 遍历 SDK 事件:
        - 映射到 AssistantMessageEvent
        - stream.push(mapped event)
     e. 成功: push({ type: "done", message }), stream.end()
     f. 错误: push({ type: "error", error }), stream.end()
  4. 返回 stream（在异步工作完成前）
```

### 事件映射表（Anthropic）

| Anthropic SDK 事件 | → AssistantMessageEvent |
|---|---|
| `content_block_start` (text) | `text_start` |
| `content_block_start` (thinking) | `thinking_start` |
| `content_block_start` (tool_use) | `toolcall_start` |
| `content_block_delta` (text_delta) | `text_delta` |
| `content_block_delta` (thinking_delta) | `thinking_delta` |
| `content_block_delta` (input_json_delta) | `toolcall_delta` |
| `content_block_stop` | `text_end` / `thinking_end` / `toolcall_end` |
| 循环正常结束 | `done` |
| 异常捕获 | `error` |

## Prompt Cache（提示缓存）

### 概述

Prompt Cache 是一种 LLM 提供商的优化机制：将 system prompt 和对话历史的前缀缓存在服务端，
后续请求如果前缀相同则直接命中缓存，**减少约 90% 的输入 token 费用**。

pi-ai 通过 `CacheRetention` 类型统一抽象不同提供商的缓存策略。

### 支持的提供商

| Provider | 缓存机制 | 代码位置 |
|---|---|---|
| **Anthropic** | `cache_control: { type: "ephemeral" }` | `providers/anthropic.ts` |
| **OpenAI Responses** | `prompt_cache_key` + `prompt_cache_retention` | `providers/openai-responses.ts` |
| **Amazon Bedrock** | `cachePoint: { type: CachePointType.DEFAULT }` | `providers/amazon-bedrock.ts` |
| Google | 被动读取 `cachedContentTokenCount`，不主动设置缓存 | `providers/google.ts` |
| Mistral / 其他 | 不支持 | — |

### CacheRetention 类型

```typescript
type CacheRetention = "none" | "short" | "long"
```

在 `StreamOptions` 中定义，所有 Provider 共享同一接口：

```typescript
interface StreamOptions {
  cacheRetention?: CacheRetention  // 默认 "short"
  sessionId?: string               // 用于 session 级缓存（OpenAI 使用）
  // ...
}
```

### 三级缓存策略

| 级别 | 含义 | Anthropic 行为 | OpenAI 行为 | Bedrock 行为 |
|---|---|---|---|---|
| `"none"` | 不缓存 | 不添加 `cache_control` | 不设置 `prompt_cache_key` | 不添加 `cachePoint` |
| `"short"` (默认) | 短期缓存 | `ephemeral` (约 5 分钟) | 设置 `prompt_cache_key` | `CachePointType.DEFAULT` |
| `"long"` | 长期缓存 | `ephemeral` + `ttl: "1h"` (仅官方 API) | `prompt_cache_retention: "24h"` (仅官方 API) | `CacheTTL.ONE_HOUR` |

### 缓存标记位置

三个支持缓存的 Provider 共享相同的标记策略：

```
请求结构:
  ┌─ system prompt ← 添加 cache 标记
  │
  ├─ message[0]    (user)
  ├─ message[1]    (assistant)
  ├─ ...
  └─ message[n]    (user) ← 最后一条 user 消息添加 cache 标记
```

这样设计的原因：system prompt 和对话历史的前缀在多轮对话中保持不变，
标记最后一条 user 消息是为了让整个对话前缀都能被缓存。

**Anthropic** 在 system prompt 块和最后一条 user 消息的最后一个 content block 上添加 `cache_control`：

```typescript
// system prompt
params.system = [{
  type: "text",
  text: systemPrompt,
  ...(cacheControl ? { cache_control: cacheControl } : {}),
}]

// 最后一条 user 消息
(lastBlock as any).cache_control = cacheControl
```

**OpenAI** 使用 `sessionId` 作为 `prompt_cache_key`，服务端自动识别前缀：

```typescript
const params = {
  prompt_cache_key: cacheRetention === "none" ? undefined : options?.sessionId,
  prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
}
```

**Bedrock** 在 system prompt 和最后一条 user 消息后追加 `cachePoint` 块：

```typescript
blocks.push({
  cachePoint: {
    type: CachePointType.DEFAULT,
    ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
  },
})
```

### 解析优先级

每个 Provider 内部都有相同的 `resolveCacheRetention()` 函数：

> **源码对照**: `packages/ai/src/providers/anthropic.ts` — resolveCacheRetention L39, getCacheControl L49, buildParams L607, convertMessages L697

```typescript
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  if (cacheRetention) return cacheRetention           // 1. 编程传入的值
  if (process.env.PI_CACHE_RETENTION === "long")      // 2. 环境变量
    return "long"
  return "short"                                       // 3. 默认值
}
```

优先级：**代码传参 > 环境变量 > 默认值 ("short")**

### 费用追踪

`Usage` 接口记录缓存命中/写入的 token 数及费用：

```typescript
interface Usage {
  input: number
  output: number
  cacheRead: number    // 缓存命中的 token 数
  cacheWrite: number   // 写入缓存的 token 数
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number  // 缓存读取费用（通常是 input 的 10%）
    cacheWrite: number // 缓存写入费用（通常是 input 的 125%）
    total: number
  }
}
```

`Model` 定义中也包含每百万 token 的缓存单价：

```typescript
interface Model {
  cost: {
    input: number       // $/百万 token
    output: number
    cacheRead: number   // 通常远低于 input
    cacheWrite: number  // 通常略高于 input
  }
}
```

### 用户使用方式

1. **零配置**：默认 `cacheRetention` 为 `"short"`，自动启用短期缓存
2. **环境变量**：`PI_CACHE_RETENTION=long` 启用长期缓存
3. **编程接口**：

```typescript
import { streamSimple } from "@mariozechner/pi-ai"

const stream = streamSimple(model, context, {
  cacheRetention: "long",
  sessionId: "my-session-123",  // OpenAI 用于 prompt_cache_key
})

for await (const event of stream) {
  if (event.type === "done") {
    console.log("缓存命中:", event.message.usage.cacheRead, "tokens")
    console.log("缓存写入:", event.message.usage.cacheWrite, "tokens")
    console.log("缓存节省:", event.message.usage.cost.cacheRead, "$")
  }
}
```

### "long" 的限制

`"long"` 级别的 `ttl` 扩展**仅在直连官方 API 时生效**：
- Anthropic: 仅 `api.anthropic.com`
- OpenAI: 仅 `api.openai.com`

通过第三方代理或兼容 API 时，`"long"` 会回退为 `"short"` 行为。
这是因为第三方可能不支持 `ttl` 或 `prompt_cache_retention` 参数。

## 模型注册表 (src/models.ts)

> **源码对照**: `packages/ai/src/models.ts` — getModel L20, getProviders L28, calculateCost L39

模型由 `scripts/generate-models.ts` 从 provider API 生成到 `models.generated.ts`。
模块加载时存入两级 Map：

```
Map<provider, Map<modelId, Model>>

例如:
  "anthropic" → {
    "claude-sonnet-4-20250514" → Model { ... }
    "claude-haiku-3.5-20241022" → Model { ... }
  }
```

### 公共 API

- `getModel(provider, id)` — 查找单个模型
- `getModels(provider)` — 获取某 provider 的所有模型
- `getProviders()` — 列出所有 provider 名称
- `calculateCost(model, usage)` — 计算费用
