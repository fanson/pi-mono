# Issue Draft: stopReason "length" is not handled explicitly

---

## Title

`agent-loop: stopReason "length" is not handled explicitly and may be treated as a complete turn`

## Body

When the model hits the output token limit, the assistant response can end with `stopReason: "length"`. The agent loop currently handles `"error"` and `"aborted"`, but not `"length"`.

That means a truncated assistant turn is processed like a normal completion.

**Steps to reproduce:**

1. Start a pi session with a task that requires a large assistant response, for example one that produces many tool calls
2. If configurable in the environment, use a low output-token limit; otherwise ask for a response large enough to exceed the configured limit
3. The assistant response ends with `stopReason: "length"`
4. The agent loop continues as if the turn completed normally

**Current behavior:**

`packages/agent/src/agent-loop.ts` only special-cases `"error"` and `"aborted"`:

```typescript
if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
}
```

But `StopReason` in `packages/ai/src/types.ts` also includes `"length"`:

```typescript
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

So `"length"` is a defined outcome, but it is not handled explicitly in the loop.

**Why this matters:**

`"length"` means the assistant response was truncated. Treating it the same as a normal completed turn can lead to confusing behavior, especially when the response was cut off before the model could finish its intended output.

The main risk is not invalid JSON by itself — tool call arguments are parsed into objects and validated later — but that an incomplete assistant turn can still flow into normal tool execution.

This is especially relevant because some providers parse partial tool-call JSON incrementally and preserve the partially parsed arguments object in the assistant message even when the turn ends due to `"length"`.

**Expected behavior:**

When `stopReason === "length"`, the agent should treat the turn as incomplete and recover explicitly, for example by:

- stopping before tool execution,
- prompting the model to continue,
- or otherwise surfacing that the last assistant turn was truncated.

**Suggested fix:**

Handle `stopReason === "length"` explicitly in `packages/agent/src/agent-loop.ts`.

A minimal fix could be to stop before tool execution when `stopReason === "length"` and surface that the assistant turn was truncated.

A better follow-up would be to emit a continuation message or another explicit signal so the model can continue from the truncated response.

**Note:** I have not been able to trigger this reliably in every environment. It depends on the model producing a response large enough to hit the token limit. Even so, since `"length"` is a defined `StopReason` and the loop does not handle it explicitly, it seems worth addressing defensively.
