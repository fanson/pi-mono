# Issue Draft: bash exit codes like grep(1) and diff(1) are incorrectly marked as errors

---

## Title

`bash tool: grep exit 1 (no match) and diff exit 1 (files differ) are treated as tool errors`

## Body

When a bash command exits with a non-zero code, the tool always `reject`s with an Error, which surfaces as `isError: true` in the tool result sent back to the model. This is wrong for commands where non-zero exit codes carry normal semantics.

**Steps to reproduce:**

1. Start a pi session in any project
2. Ask the agent to search for something that doesn't exist (e.g. "search for 'xyznonexistent' in the codebase")
3. The agent runs `grep -r "xyznonexistent" .` which exits with code 1 (no match found)
4. The model receives the result with `isError: true` and treats it as a failure

**What happens:**

`packages/coding-agent/src/core/tools/bash.ts` lines 379-381:
```typescript
if (exitCode !== 0 && exitCode !== null) {
    outputText += `\n\nCommand exited with code ${exitCode}`;
    reject(new Error(outputText));
}
```

This `reject` flows to `packages/agent/src/agent-loop.ts` `executePreparedToolCall` catch block (lines 555-559):
```typescript
} catch (error) {
    return {
        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
        isError: true,
    };
}
```

The `isError: true` flag is then passed through to the LLM API (e.g. Anthropic's `is_error` on `tool_result`), which signals to the model that the tool execution failed.

**The problem:**

Several common commands use non-zero exit codes as normal return values:

| Command | Exit 1 means | Error? |
|---------|-------------|--------|
| `grep` | no match found | No |
| `diff` | files differ | No |
| `test -f` / `[ -f ]` | condition is false | No |
| `which` | command not found | No |

When `grep` finds no matches, exit 1 is the expected result. But `isError: true` causes the model to apologize, retry with different flags, or explain that "the command failed" — instead of simply reporting "no matches found."

**Expected behavior:**

For commands like `grep` and `diff`, exit code 1 should be resolved (not rejected), so the model sees the output as a normal tool result.

**Suggested fix:**

A small lookup table for well-known command semantics:

```typescript
const NORMAL_EXIT_CODES: Record<string, Set<number>> = {
    grep: new Set([1]),
    egrep: new Set([1]),
    fgrep: new Set([1]),
    diff: new Set([1]),
    test: new Set([1]),
    which: new Set([1]),
};

function isNormalExitCode(command: string, exitCode: number): boolean {
    const firstWord = command.trim().split(/\s+/)[0];
    const basename = firstWord?.split("/").pop() ?? "";
    return NORMAL_EXIT_CODES[basename]?.has(exitCode) ?? false;
}
```

Then in the exit code check:
```typescript
if (exitCode !== 0 && exitCode !== null) {
    outputText += `\n\nCommand exited with code ${exitCode}`;
    if (isNormalExitCode(command, exitCode)) {
        resolve({ content: [{ type: "text", text: outputText }], details });
    } else {
        reject(new Error(outputText));
    }
}
```

Happy to submit a PR if this direction makes sense. The table can start small (grep, diff, test) and be extended over time.
