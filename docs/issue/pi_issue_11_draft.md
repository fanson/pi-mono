# Issue Draft: edit tool can silently overwrite external file changes

---

## Title

`edit tool: external file modifications can be overwritten between read and write`

## Body

The edit tool reads a file, applies replacements, and writes it back. It does not verify that the file stayed unchanged between the read and the write. If another process modifies the file in that window, those changes can be silently lost.

**Steps to reproduce:**

1. Use a project with a formatter, watcher, or other process that can modify files automatically
2. Ask the agent to edit a file
3. The edit tool reads the file and computes the replacement
4. Another process changes the file before the write happens
5. The edit tool writes the final content and overwrites the external change

**Current behavior:**

`packages/coding-agent/src/core/tools/edit.ts` reads the file and writes it back inside `withFileMutationQueue(...)`, but there is no external-change check in between:

```typescript
const buffer = await ops.readFile(absolutePath);
const rawContent = buffer.toString("utf-8");
...
const finalContent = bom + restoreLineEndings(newContent, originalEnding);
await ops.writeFile(absolutePath, finalContent);
```

`withFileMutationQueue()` only serializes tool calls within pi. It does not prevent external processes from modifying the same file.

The `oldText` matching in `applyEditsToNormalizedContent()` protects against some conflicts, but only when the external change affects the edited block. If the other process changes a different part of the file, the edit can still succeed and overwrite the external modification.

**Why this is a problem:**

Users can lose formatter output or other concurrent edits without any warning.

**Expected behavior:**

The tool should make a best-effort attempt to detect external modification between read and write, and then either:

- fail with a clear error so the model can re-read and retry, or
- re-read and re-apply the edit against the latest content

**Suggested fix:**

Add a best-effort change check before writing, for example using a content hash or file metadata captured at read time.

A minimal approach would be to store `mtime` or a hash after the read and compare it before the write. If the file changed, throw an error telling the model to re-read the file and retry the edit.

That would not eliminate every race, but it would catch common cases and reduce the risk of silent overwrites.
