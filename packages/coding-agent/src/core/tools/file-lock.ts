import { resolve } from "path";

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize async operations on the same file path.
 * Concurrent calls with the same absolute path are queued in FIFO order.
 * Operations on different files run fully in parallel.
 */
export async function withFileLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(absolutePath);
	const currentLock = fileLocks.get(key) ?? Promise.resolve();

	let releaseLock!: () => void;
	const nextLock = new Promise<void>((r) => {
		releaseLock = r;
	});
	const chained = currentLock.then(() => nextLock);
	fileLocks.set(key, chained);

	await currentLock;
	try {
		return await fn();
	} finally {
		releaseLock();
		if (fileLocks.get(key) === chained) {
			fileLocks.delete(key);
		}
	}
}
