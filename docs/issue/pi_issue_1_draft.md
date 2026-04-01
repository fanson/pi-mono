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

`agent-loop.ts` line 194 only handles `"error"` and `"aborted"`:
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

When `stopReason` is `"length"`, the code falls through to line 201 where it extracts tool calls from the truncated message. A tool call that was being generated when the truncation happened will have incomplete JSON arguments — the `toolcall_end` event was never emitted for it, so it may not even appear in `message.content`. But if the provider's stream parser partially constructs it, the arguments could be malformed.

**Expected behavior:**

At minimum: when `stopReason === "length"`, filter out any tool calls with unparseable arguments before executing. Ideally: inject a system/user message telling the model its output was truncated, so it can continue.

**Suggested fix:**

```typescript
if (message.stopReason === "length") {
    // Filter to only tool calls with valid, parseable arguments
    const validContent = message.content.filter(c => {
        if (c.type !== "toolCall") return true;
        try {
            // Verify arguments are complete JSON
            JSON.stringify(c.arguments);
            return true;
        } catch {
            return false;
        }
    });
    message = { ...message, content: validContent };
    // Optionally: log a warning about truncated output
}
```

**Note:** I haven't been able to reliably trigger this in practice — it depends on the model generating a response large enough to hit the token limit. If the default `maxTokens` is already high enough that this rarely occurs, this might be low priority. But since `"length"` is a defined `StopReason` that the loop doesn't handle, it seems worth addressing defensively.

Happy to submit a PR if this makes sense.
