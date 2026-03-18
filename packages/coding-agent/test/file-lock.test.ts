/**
 * Tests for withFileLock and parallel edit/write tool serialization.
 * Verifies the fix for https://github.com/badlogic/pi-mono/issues/2327
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.js";
import { withFileLock } from "../src/core/tools/file-lock.js";
import { createWriteTool } from "../src/core/tools/write.js";

// Simulates pre-fix edit: read-modify-write with no lock.
// Delay between read and write widens the race window deterministically.
async function editWithoutLock(filePath: string, oldText: string, newText: string, delayMs = 20): Promise<void> {
	const content = await readFile(filePath, "utf-8");
	if (!content.includes(oldText)) {
		throw new Error(`Text not found: ${oldText}`);
	}
	const updated = content.replace(oldText, newText);
	await new Promise((r) => setTimeout(r, delayMs));
	await writeFile(filePath, updated, "utf-8");
}

describe("withFileLock", () => {
	it("should serialize operations on the same file path", async () => {
		const order: number[] = [];
		const path = "/tmp/test-lock-serialize";

		const op1 = withFileLock(path, async () => {
			order.push(1);
			await new Promise((r) => setTimeout(r, 50));
			order.push(2);
			return "a";
		});

		const op2 = withFileLock(path, async () => {
			order.push(3);
			return "b";
		});

		const [r1, r2] = await Promise.all([op1, op2]);

		expect(r1).toBe("a");
		expect(r2).toBe("b");
		expect(order).toEqual([1, 2, 3]);
	});

	it("should allow parallel operations on different file paths", async () => {
		const order: string[] = [];

		const op1 = withFileLock("/tmp/file-a", async () => {
			order.push("a-start");
			await new Promise((r) => setTimeout(r, 50));
			order.push("a-end");
		});

		const op2 = withFileLock("/tmp/file-b", async () => {
			order.push("b-start");
			await new Promise((r) => setTimeout(r, 50));
			order.push("b-end");
		});

		await Promise.all([op1, op2]);

		expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("a-end"));
		expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("b-end"));
		// Both should start before either ends (true parallelism)
		expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
	});

	it("should resolve equivalent paths to the same lock", async () => {
		const order: number[] = [];

		const op1 = withFileLock("/tmp/./foo/../bar", async () => {
			order.push(1);
			await new Promise((r) => setTimeout(r, 30));
			order.push(2);
		});

		const op2 = withFileLock("/tmp/bar", async () => {
			order.push(3);
		});

		await Promise.all([op1, op2]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("should release lock even when operation throws", async () => {
		const path = "/tmp/test-lock-error";

		await expect(
			withFileLock(path, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// Lock should be released; next operation runs immediately
		const result = await withFileLock(path, async () => "recovered");
		expect(result).toBe("recovered");
	});

	it("should maintain FIFO order for multiple queued operations", async () => {
		const order: number[] = [];
		const path = "/tmp/test-lock-fifo";

		const ops = Array.from({ length: 5 }, (_, i) =>
			withFileLock(path, async () => {
				order.push(i);
				await new Promise((r) => setTimeout(r, 10));
			}),
		);

		await Promise.all(ops);
		expect(order).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("race condition reproduction (issue #2327)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `file-lock-race-proof-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should lose edits without file lock (reproduces the bug)", async () => {
		const testFile = join(testDir, "no-lock.txt");
		writeFileSync(testFile, "line_alpha\nline_beta\nline_gamma\n");

		await Promise.all([
			editWithoutLock(testFile, "line_alpha", "REPLACED_ALPHA"),
			editWithoutLock(testFile, "line_beta", "REPLACED_BETA"),
		]);

		const result = readFileSync(testFile, "utf-8");
		const hasAlpha = result.includes("REPLACED_ALPHA");
		const hasBeta = result.includes("REPLACED_BETA");

		expect(hasAlpha && hasBeta).toBe(false);
	});

	it("should preserve all edits with file lock (verifies the fix)", async () => {
		const testFile = join(testDir, "with-lock.txt");
		writeFileSync(testFile, "line_alpha\nline_beta\nline_gamma\n");

		const tool = createEditTool(testDir);

		await Promise.all([
			tool.execute("call-1", { path: testFile, oldText: "line_alpha", newText: "REPLACED_ALPHA" }),
			tool.execute("call-2", { path: testFile, oldText: "line_beta", newText: "REPLACED_BETA" }),
		]);

		const result = readFileSync(testFile, "utf-8");
		expect(result).toContain("REPLACED_ALPHA");
		expect(result).toContain("REPLACED_BETA");
		expect(result).toContain("line_gamma");
	});
});

describe("parallel edit tool calls on the same file (issue #2327)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `file-lock-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should apply both edits when two parallel edits target different lines", async () => {
		const testFile = join(testDir, "parallel-edit.txt");
		writeFileSync(testFile, "line_alpha\nline_beta\nline_gamma\n");

		const tool = createEditTool(testDir);

		const [r1, r2] = await Promise.all([
			tool.execute("call-1", {
				path: testFile,
				oldText: "line_alpha",
				newText: "REPLACED_ALPHA",
			}),
			tool.execute("call-2", {
				path: testFile,
				oldText: "line_beta",
				newText: "REPLACED_BETA",
			}),
		]);

		expect(r1.content[0]).toEqual({ type: "text", text: expect.stringContaining("Successfully replaced") });
		expect(r2.content[0]).toEqual({ type: "text", text: expect.stringContaining("Successfully replaced") });

		const finalContent = readFileSync(testFile, "utf-8");
		expect(finalContent).toContain("REPLACED_ALPHA");
		expect(finalContent).toContain("REPLACED_BETA");
		expect(finalContent).toContain("line_gamma");
	});

	it("should apply three parallel edits correctly", async () => {
		const testFile = join(testDir, "triple-edit.txt");
		writeFileSync(testFile, "aaa_unique_marker\nbbb_unique_marker\nccc_unique_marker\n");

		const tool = createEditTool(testDir);

		const results = await Promise.all([
			tool.execute("call-1", { path: testFile, oldText: "aaa_unique_marker", newText: "AAA" }),
			tool.execute("call-2", { path: testFile, oldText: "bbb_unique_marker", newText: "BBB" }),
			tool.execute("call-3", { path: testFile, oldText: "ccc_unique_marker", newText: "CCC" }),
		]);

		for (const r of results) {
			expect(r.content[0]).toEqual({ type: "text", text: expect.stringContaining("Successfully replaced") });
		}

		const finalContent = readFileSync(testFile, "utf-8");
		expect(finalContent).toBe("AAA\nBBB\nCCC\n");
	});

	it("should not block edits on different files", async () => {
		const fileA = join(testDir, "a.txt");
		const fileB = join(testDir, "b.txt");
		writeFileSync(fileA, "content_a\n");
		writeFileSync(fileB, "content_b\n");

		const tool = createEditTool(testDir);

		const [r1, r2] = await Promise.all([
			tool.execute("call-1", { path: fileA, oldText: "content_a", newText: "EDITED_A" }),
			tool.execute("call-2", { path: fileB, oldText: "content_b", newText: "EDITED_B" }),
		]);

		expect(r1.content[0]).toEqual({ type: "text", text: expect.stringContaining("Successfully replaced") });
		expect(r2.content[0]).toEqual({ type: "text", text: expect.stringContaining("Successfully replaced") });
		expect(readFileSync(fileA, "utf-8")).toBe("EDITED_A\n");
		expect(readFileSync(fileB, "utf-8")).toBe("EDITED_B\n");
	});
});

describe("parallel write tool calls on the same file", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `file-lock-write-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should serialize writes so last queued write wins", async () => {
		const testFile = join(testDir, "parallel-write.txt");

		const tool = createWriteTool(testDir);

		await Promise.all([
			tool.execute("call-1", { path: testFile, content: "first" }),
			tool.execute("call-2", { path: testFile, content: "second" }),
		]);

		const finalContent = readFileSync(testFile, "utf-8");
		// Both writes complete without error; second (FIFO) overwrites first
		expect(finalContent).toBe("second");
	});
});

describe("parallel edit + write on the same file", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `file-lock-mixed-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should serialize mixed edit and write operations", async () => {
		const testFile = join(testDir, "mixed-ops.txt");
		writeFileSync(testFile, "original_content\n");

		const editTool = createEditTool(testDir);
		const writeTool = createWriteTool(testDir);

		// edit runs first (FIFO), then write overwrites
		const [editResult, writeResult] = await Promise.all([
			editTool.execute("call-1", {
				path: testFile,
				oldText: "original_content",
				newText: "edited_content",
			}),
			writeTool.execute("call-2", {
				path: testFile,
				content: "completely_new_content\n",
			}),
		]);

		expect(editResult.content[0]).toEqual({ type: "text", text: expect.stringContaining("Successfully replaced") });
		expect(writeResult.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("Successfully wrote"),
		});

		const finalContent = readFileSync(testFile, "utf-8");
		// Write runs second, so it overwrites the edit
		expect(finalContent).toBe("completely_new_content\n");
	});
});
