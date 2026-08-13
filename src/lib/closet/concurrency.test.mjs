import assert from "node:assert/strict";
import test from "node:test";

import { runWithConcurrency } from "./concurrency.ts";

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

test("owns every queued item before starting a concurrency-limited batch", async () => {
  const items = ["item-1", "item-2", "item-3", "item-4"];
  const gates = new Map(items.map((item) => [item, createDeferred()]));
  const events = [];
  const ownedItems = new Set();
  let activeCount = 0;
  let maxActiveCount = 0;

  const work = runWithConcurrency(
    items,
    2,
    async (item) => {
      activeCount += 1;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      await gates.get(item).promise;
      activeCount -= 1;
    },
    {
      onQueued: (item) => {
        events.push(`queued:${item}`);
        ownedItems.add(item);
      },
      onStarted: (item) => events.push(`started:${item}`),
      onSettled: (item) => {
        events.push(`settled:${item}`);
        ownedItems.delete(item);
      },
    },
  );

  assert.deepEqual(events.slice(0, 4), items.map((item) => `queued:${item}`));
  assert.deepEqual(events.slice(4), ["started:item-1", "started:item-2"]);
  assert.deepEqual([...ownedItems], items);
  assert.equal(maxActiveCount, 2);

  gates.get("item-1").resolve();
  gates.get("item-2").resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ownedItems.has("item-3"), true);
  assert.equal(ownedItems.has("item-4"), true);

  gates.get("item-3").resolve();
  gates.get("item-4").resolve();
  await work;

  assert.equal(maxActiveCount, 2);
  assert.deepEqual([...ownedItems], []);
});

test("releases lifecycle ownership when a worker rejects", async () => {
  const ownedItems = new Set();

  await assert.rejects(
    runWithConcurrency(
      ["item-1"],
      1,
      async () => {
        throw new Error("worker failed");
      },
      {
        onQueued: (item) => ownedItems.add(item),
        onSettled: (item) => ownedItems.delete(item),
      },
    ),
    /worker failed/,
  );

  assert.deepEqual([...ownedItems], []);
});

test("drains the remaining queue before reporting multiple worker failures", async () => {
  const items = ["item-1", "item-2", "item-3", "item-4"];
  const ownedItems = new Set();
  const startedItems = new Set();
  const settledItems = new Set();

  await assert.rejects(
    runWithConcurrency(
      items,
      2,
      async (item) => {
        startedItems.add(item);
        if (item === "item-1" || item === "item-2") {
          throw new Error(`${item} failed`);
        }
      },
      {
        onQueued: (item) => ownedItems.add(item),
        onSettled: (item) => {
          settledItems.add(item);
          ownedItems.delete(item);
        },
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.every((reason) => reason instanceof Error),
  );

  assert.deepEqual([...startedItems].sort(), items);
  assert.deepEqual([...settledItems].sort(), items);
  assert.deepEqual([...ownedItems], []);
});

test("processes falsy generic values without leaking lifecycle ownership", async () => {
  const values = [0, false, ""];
  const processed = [];
  const ownedValues = new Set();

  await runWithConcurrency(
    values,
    2,
    async (value) => {
      processed.push(value);
    },
    {
      onQueued: (value) => ownedValues.add(value),
      onSettled: (value) => ownedValues.delete(value),
    },
  );

  assert.deepEqual(processed, values);
  assert.deepEqual([...ownedValues], []);
});
