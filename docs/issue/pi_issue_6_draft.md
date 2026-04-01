# Issue Draft: read tool decodes binary files as UTF-8

---

## Title

`read tool: binary files (zip, sqlite, wasm, etc.) are decoded as UTF-8 garbage`

## Body

The `read` tool checks whether a file is a supported image (jpeg/png/gif/webp) and handles those correctly. But non-image binary files fall through to the text path and get decoded as UTF-8, producing garbage output.

**Steps to reproduce:**

1. Create a project with a `.sqlite` or `.zip` file
2. Ask the agent to read it (e.g. "read database.sqlite" or the agent tries to understand the project structure and reads it)
3. The tool returns garbled UTF-8 text

**What happens:**

`read.ts` line 185-188:
```typescript
} else {
    // Read text content.
    const buffer = await ops.readFile(absolutePath);
    const textContent = buffer.toString("utf-8");
```

`detectSupportedImageMimeTypeFromFile` in `mime.ts` uses `file-type` to sniff the format, but explicitly filters to only 4 image types:
```typescript
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// ...
if (!IMAGE_MIME_TYPES.has(fileType.mime)) {
    return null;  // ← zip, sqlite, wasm all return null here
}
```

So a `.zip` file gets detected by `file-type` as `application/zip`, but that's discarded, and the buffer gets `.toString("utf-8")`.

**Expected behavior:**

Return something like `"Binary file: database.sqlite (24576 bytes). Cannot display as text."` instead of garbled output.

**Context:**

Binary data has been addressed for bash output — `sanitizeBinaryOutput` in `utils/shell.ts` strips control characters to prevent crashes (that fix was for bash commands that pipe binary). But the `read` tool has a similar gap: it can detect binary *before* reading but currently doesn't.

**Suggested fix:**

Since `file-type` is already a dependency (used in `mime.ts`), the simplest fix is to check the sniff result before the image filter — if `fileType` is non-null and not a supported image, it's a known binary format. Alternatively, a null-byte check on the first few KB works for unknown formats that `file-type` doesn't recognize.

This is a small change in `read.ts` (or `mime.ts` could expose a broader `isBinaryFile` helper). Happy to submit a PR if this makes sense.
