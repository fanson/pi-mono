# Issue Draft: bash tool has no default timeout

---

## Title

`bash tool: commands without explicit timeout can hang the session indefinitely`

## Body

The bash tool's `timeout` parameter is optional with no default. If the model doesn't pass a timeout (which is the default behavior), a hanging command will block the session forever with no way to recover other than manual Ctrl+C.

**Steps to reproduce:**

1. Start a pi session
2. Ask the agent to run a command that blocks on input or hangs (e.g. "run `cat` without arguments", or "run `python -c 'while True: pass'`")
3. The session hangs indefinitely — no timeout, no error, no recovery

**What happens:**

`packages/coding-agent/src/core/tools/bash.ts` lines 33-35 define timeout as optional with no default:
```typescript
const bashSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});
```

The timeout mechanism exists and works correctly when provided (lines 93-99):
```typescript
if (timeout !== undefined && timeout > 0) {
    timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
    }, timeout * 1000);
}
```

But when `timeout` is `undefined`, no timer is set. And there's no outer timeout anywhere in the call chain — `tool-definition-wrapper.ts`, `agent-loop.ts`, and `agent.ts` all pass through without adding one.

**The problem:**

In practice, the model almost never passes an explicit `timeout` value. Common hanging scenarios:
- `cat` (no args, waits for stdin)
- `ssh host` or `telnet host` (waits for input)
- `npm install` with network issues (hangs on DNS/registry)
- `python script.py` with an infinite loop
- Any interactive command the model accidentally runs

The user sees the session freeze with no feedback. The only recovery is killing the terminal.

**Expected behavior:**

A reasonable default timeout (e.g. 30 minutes) that kills the process and returns a timeout error, while still allowing the model to pass a custom `timeout` when needed.

**Suggested fix:**

```typescript
const DEFAULT_TIMEOUT_SECONDS = 1800; // 30 minutes

// In the execute function:
const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_SECONDS;
```

The rest of the existing timeout infrastructure (killProcessTree, timedOut flag, timeout error message) already works. The only change is providing a fallback value.

This doesn't change behavior for any call that already passes a timeout. Happy to submit a PR if this makes sense. The default value is debatable — 5 min, 10 min, whatever the team thinks is reasonable.
