/** Bounds for calls that can hang on a dead network share. */

/** Rejects when `promise` has not settled after `ms`. The underlying call is abandoned, not cancelled. */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Run `task` over `items` with at most `limit` in flight, keeping the order of the results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
