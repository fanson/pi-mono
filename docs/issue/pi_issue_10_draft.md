# Issue Draft: bash tool has no default timeout

---

## Title

`bash tool: commands without an explicit timeout can hang the session indefinitely`

## Body

The bash tool accepts an optional `timeout`, but it does not enforce any default timeout. If the model omits the field, a hanging command can block the session indefinitely.

**Steps to reproduce:**

1. Start a pi session
2. Ask the agent to run a command that waits for input or never exits, for example `cat`, `python -c 'while True: pass'`, or `ssh host`
3. If no timeout is provided, the session can hang indefinitely

**Current behavior:**

`packages/coding-agent/src/core/tools/bash.ts` defines `timeout` as optional with no default:

```typescript
const bashSchema = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});
```

The timeout handling only activates when a value is passed:

```typescript
if (timeout !== undefined && timeout > 0) {
    timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) killProcessTree(child.pid);
    }, timeout * 1000);
}
```

So a missing timeout means no timer at all.

**Why this is a problem:**

The model often does not provide an explicit timeout. If it runs an interactive or blocking command by mistake, the user is left with a frozen session and no automatic recovery.

**Expected behavior:**

The system should provide a safe fallback for commands that omit `timeout`, while still allowing long-running commands when explicitly requested.

**Suggested fix:**

One option would be to introduce a default timeout in the bash tool, for example:

```typescript
const DEFAULT_TIMEOUT_SECONDS = 1800;
const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_SECONDS;
```

Another option would be to make that fallback configurable at the session or application level.

Either approach would preserve explicit timeouts while reducing the risk of indefinite hangs when the field is omitted.
