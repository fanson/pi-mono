# Issue Draft: stopReason "length" not handled

---

## Title

`agent-loop: stopReason "length" can cause execution of truncated tool calls`

## Body

When the model hits the `max_output_tokens` limit, the response is truncated mid-stream with `stopReason: "length"`. The agent-loop doesn't handle this case, which can lead to executing tool calls with invalid (truncated) JSON arguments.

**Steps to reproduce:**

1. Start a pi session with a task that requires the model to generate a large response with multiple tool calls
2. E.g. ask the agent to "create 10 files with detailed boilerplate content" — the model tries to output many `write` tool calls in one response
3. If the combined output exceeds `maxTokens`, the response is truncated mid-tool-call

**What happens:**

`packages/agent/src/agent-loop.ts` around line 194 only handles `"error"` and `"aborted"`:
```typescript
if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
}
```

`StopReason` in `packages/ai/src/types.ts` includes `"length"`:
```typescript
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

And the stream protocol explicitly sends `"length"` as a `"done"` event reason (not an error):
```typescript
| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
```

When `stopReason` is `"length"`, the code falls through to line 200-201 where it extracts tool calls from the truncated message. A tool call that was being generated when the truncation happened will have incomplete JSON arguments — the `toolcall_end` event was never emitted for it, so it may not even appear in `message.content`. But if the provider's stream parser partially constructs it, the arguments could be malformed.

**Expected behavior:**

At minimum: when `stopReason === "length"`, filter out any tool calls with unparseable arguments before executing. Ideally: inject a system/user message telling the model its output was truncated, so it can continue.

**Suggested fix:**

不要用 `JSON.stringify(c.arguments)` 当作“参数完整”的判断条件。对一个已经构造成内存对象的 `arguments` 来说，
`JSON.stringify()` 几乎不会因为“原始流被截断”而给出你真正想要的信号。

更可靠的方向是：

1. 把 `stopReason === "length"` 当成一类显式状态，而不是普通 `done`
2. 只执行那些**已经完整结束并且通过 schema/`validateToolArguments` 验证**的 tool call
3. 对被截断的 assistant 输出补一条 steering/user message，告诉模型“上一条输出被截断，需要继续”
4. 如果 provider 侧能暴露“toolcall_end 未完成”或部分 JSON 状态，优先基于那个真实信号过滤，而不是基于 `JSON.stringify`

**Note:** I haven't been able to reliably trigger this in practice — it depends on the model generating a response large enough to hit the token limit. If the default `maxTokens` is already high enough that this rarely occurs, this might be low priority. But since `"length"` is a defined `StopReason` that the loop doesn't handle, it seems worth addressing defensively.

Happy to submit a PR if this makes sense.
