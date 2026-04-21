# Issue Draft: bash exit codes like grep(1) and diff(1) are incorrectly marked as errors

---

## Title

`bash tool: exit code 1 from commands like grep and diff is treated as a tool error`

## Body

When a bash command exits with a non-zero code, the tool currently rejects with an error, which is then surfaced to the model as `isError: true`.

This is incorrect for some commands whose non-zero exit codes are part of normal semantics.

**Steps to reproduce:**

1. Start a pi session in any project
2. Ask the agent to search for something that does not exist, for example: `search for "xyznonexistent" in the codebase`
3. The agent runs `grep -r "xyznonexistent" .`
4. `grep` exits with code `1`, which means “no matches found”
5. The bash tool rejects the result and the model receives it as an error

**Current behavior:**

`packages/coding-agent/src/core/tools/bash.ts` treats every non-zero exit code as a failure:

```typescript
if (exitCode !== 0 && exitCode !== null) {
    outputText += `\n\nCommand exited with code ${exitCode}`;
    reject(new Error(outputText));
}
```

`packages/agent/src/agent-loop.ts` then converts that rejection into a tool error:

```typescript
catch (error) {
    return {
        result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
        isError: true,
    };
}
```

As a result, the model sees normal command results as execution failures.

This is not just presentation: provider adapters also propagate the tool error flag to the upstream API (for example Anthropic's `is_error` field on tool results), which can change how the model responds on the next turn.

**Why this is a problem:**

Some common commands use exit code `1` to indicate a valid, expected outcome:

| Command | Exit 1 means | Should be treated as error? |
|---------|--------------|-----------------------------|
| `grep`  | no match found | No |
| `diff`  | files differ | No |
| `test -f` / `[` | condition is false | No |

For these commands, the model should receive the output normally instead of being told the tool failed.

**Expected behavior:**

Commands whose exit code `1` represents a normal outcome should be returned as successful tool results, not tool errors.

**Suggested fix:**

Handle command-specific exit semantics in the bash tool.

A minimal first pass could recognize a small set of commands such as:

- `grep`
- `diff`
- `test`
- `[` 

For these commands, exit code `1` should resolve as a normal result, while other non-zero exit codes should still reject.

Command detection may also need to account for wrappers such as `env`, `sudo`, or absolute executable paths.

A more robust follow-up would be to make acceptable exit codes configurable per command instead of hardcoding them in the tool.
