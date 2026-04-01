# Issue Draft: edit tool can silently overwrite external file changes

---

## Title

`edit tool: no detection of external file modifications between read and write`

## Body

The edit tool reads a file, applies string replacements, and writes the result — but doesn't check whether the file was modified externally between the read and write. If a linter, formatter, or another process modifies the file in that window, those changes are silently overwritten.

**Steps to reproduce:**

1. Set up a project with format-on-save (e.g. Prettier, ESLint fix, or Black for Python)
2. Start a pi session and ask the agent to edit a file
3. The agent reads the file, applies the edit, and writes it back
4. If the formatter runs between the read and write (triggered by the IDE watching for changes), the formatter's changes are lost

A more concrete scenario:
1. The agent calls `write` to create a file → this triggers the IDE's format-on-save
2. The agent then calls `edit` on the same file in the same turn
3. The `edit` tool reads the file (now formatted), but if the formatter is still running or runs again, there's a race window

**What happens:**

`edit.ts` line 222-246:
```typescript
const buffer = await ops.readFile(absolutePath);
const rawContent = buffer.toString("utf-8");
// ... normalize, apply edits ...
const finalContent = bom + restoreLineEndings(newContent, originalEnding);
await ops.writeFile(absolutePath, finalContent);
// ← No check that the file hasn't changed since the read
```

The `oldText` matching in `applyEditsToNormalizedContent` provides **partial** protection: if the external change modifies the same region being edited, `oldText` won't match and the edit fails (safe). But if the external change only modifies a **different** region of the file (e.g. the formatter fixes trailing whitespace at the end while the agent edits a function at the top), `oldText` still matches and the write succeeds — silently reverting the formatter's changes.

**Context:**

Pi already has `file-mutation-queue.ts` which serializes concurrent tool calls that target the same file. This handles internal concurrency well. But it doesn't cover external modifications (IDE formatters, git hooks, other processes).

**Expected behavior:**

Detect that the file changed between read and write, and either:
- Retry the edit against the new file contents, or
- Return an error telling the model the file was modified externally

**Suggested fix:**

Store the file's mtime (or a content hash) at read time, and compare before writing:

```typescript
const statBefore = await fsStat(absolutePath);
const buffer = await ops.readFile(absolutePath);
// ... apply edits ...
const statAfter = await fsStat(absolutePath);
if (statAfter.mtimeMs !== statBefore.mtimeMs) {
    throw new Error(
        `File ${path} was modified externally during edit. ` +
        `Re-read the file and retry the edit.`
    );
}
await ops.writeFile(absolutePath, finalContent);
```

**Note:** This is a race condition, so it won't catch 100% of cases (the file could be modified between the stat check and the write). But it catches the most common scenario (format-on-save) and is a significant improvement over the current behavior of zero detection. A more robust approach would use file locking, but that's significantly more complex.

Happy to submit a PR if this makes sense.
