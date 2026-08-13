export type ConcurrentQueueHooks<T> = Readonly<{
  onQueued?: (item: T) => void;
  onStarted?: (item: T) => void;
  onSettled?: (item: T) => void;
}>;

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  hooks: ConcurrentQueueHooks<T> = {},
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  const queue = [...items];
  const errors: unknown[] = [];
  queue.forEach((item) => hooks.onQueued?.(item));

  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift() as T;

      hooks.onStarted?.(item);
      try {
        await worker(item);
      } catch (error) {
        errors.push(error);
      } finally {
        hooks.onSettled?.(item);
      }
    }
  });

  await Promise.all(runners);

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} concurrent queue workers failed.`);
  }
}
