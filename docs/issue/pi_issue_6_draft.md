# Issue Draft: read tool decodes binary files as UTF-8

---

## Title

`read tool: binary files like zip, sqlite, and wasm are decoded as UTF-8 text`

## Body

The `read` tool currently treats any non-image file as text and decodes it as UTF-8. That works for plain text files, but it produces garbage output for binary files such as `.zip`, `.sqlite`, `.wasm`, and similar formats.

**Steps to reproduce:**

1. Create a project containing a binary file such as `database.sqlite` or `archive.zip`
2. Ask the agent to read that file
3. The tool returns unreadable UTF-8 output instead of identifying it as binary

**Current behavior:**

`packages/coding-agent/src/core/tools/read.ts` only has a special path for supported images:

```typescript
if (mimeType) {
    // Read image as binary.
```

If the file is not recognized as an image, the tool falls through to:

```typescript
const buffer = await ops.readFile(absolutePath);
const textContent = buffer.toString("utf-8");
```

`packages/coding-agent/src/utils/mime.ts` uses `file-type` to sniff the file, but it only returns a MIME type for four image formats:

```typescript
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
```

So a binary file that is recognized by `file-type` as a non-image format, for example `application/zip`, still falls through to the UTF-8 text path, and unrecognized binary files can do the same.

**Why this is a problem:**

Unsupported binary files should not be presented as text. The current behavior produces unreadable output and can mislead the model into thinking the file is textual.

**Expected behavior:**

When the file is binary, the tool should return a clear message such as:

- `Binary file: database.sqlite (24576 bytes). Cannot display as text.`

or another explicit binary-file notice.

**Suggested fix:**

Use the existing file-type sniffing to distinguish binary files from text files before the UTF-8 decode path.

A minimal fix could be:

- keep the current image handling
- detect known binary files and return a binary-file message instead of decoding them as UTF-8
- optionally add a simple heuristic for unknown binary files, such as checking for null bytes in the first chunk

A small helper in `mime.ts` or `read.ts` would keep the logic contained and avoid duplicating file-type checks.
