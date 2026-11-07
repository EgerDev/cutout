/** Run `fn` over `items` with at most `limit` jobs in flight. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  if (!items.length || limit < 1) return;
  let i = 0;
  const n = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const index = i++;
        if (index >= items.length) return;
        await fn(items[index]!);
      }
    }),
  );
}
