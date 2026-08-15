import assert from "node:assert/strict";
import test from "node:test";

import type { OutfitCombination, PurchaseDecisionReport } from "./types.ts";
import {
  getEligibleTryOnOutfits,
  needsTryOnGeneration,
  settleTryOnJobs,
  withStableOutfitIds,
} from "./outfit-try-on.ts";

function createOutfit(index: number): OutfitCombination {
  return {
    title: `搭配 ${index}`,
    scenario: "通勤",
    items: ["待买上衣", `衣橱单品 ${index}`],
    closetItemIds: [`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`],
    summary: "自然搭配",
    visualIntent: "outfit",
  };
}

test("stable outfit ids remain deterministic and unique by source order", () => {
  const outfits = [createOutfit(1), createOutfit(2)];
  const first = withStableOutfitIds(outfits);
  const second = withStableOutfitIds(outfits);

  assert.deepEqual(
    first.map((outfit) => outfit.outfitId),
    second.map((outfit) => outfit.outfitId),
  );
  assert.notEqual(first[0].outfitId, first[1].outfitId);
});

test("eligibility excludes fallbacks and limits model outfits to three", () => {
  const report = {
    usedModel: true,
    outfitCombinations: [createOutfit(1), createOutfit(2), createOutfit(3), createOutfit(4)],
  } as Pick<PurchaseDecisionReport, "usedModel" | "outfitCombinations">;

  assert.equal(getEligibleTryOnOutfits(report, true).length, 3);
  assert.equal(getEligibleTryOnOutfits({ ...report, usedModel: false }, true).length, 0);
  assert.equal(getEligibleTryOnOutfits(report, false).length, 0);
  assert.equal(
    getEligibleTryOnOutfits(
      { ...report, outfitCombinations: [{ ...createOutfit(1), closetItemIds: [] }] },
      true,
    ).length,
    0,
  );
});

test("try-on jobs start together and settle in source order", async () => {
  const started: number[] = [];
  const releases: Array<() => void> = [];
  const jobs = [0, 1, 2].map(
    (index) => () =>
      new Promise<number>((resolve) => {
        started.push(index);
        releases[index] = () => resolve(index);
      }),
  );

  const settled = settleTryOnJobs(jobs);
  assert.deepEqual(started, [0, 1, 2]);
  releases[2]();
  releases[0]();
  releases[1]();

  assert.deepEqual(await settled, [
    { status: "fulfilled", value: 0 },
    { status: "fulfilled", value: 1 },
    { status: "fulfilled", value: 2 },
  ]);
});

test("one failed try-on does not reject or reorder the batch", async () => {
  const settled = await settleTryOnJobs([
    async () => "first",
    async () => {
      throw new Error("provider failed");
    },
    async () => "third",
  ]);

  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[2].status, "fulfilled");
});

test("persisted ready images are reused while failed rows are regenerated", () => {
  assert.equal(needsTryOnGeneration({ status: "ready", imagePath: "user/try-ons/a.png" }), false);
  assert.equal(needsTryOnGeneration({ status: "ready", imagePath: null }), true);
  assert.equal(needsTryOnGeneration({ status: "failed", imagePath: null }), true);
});

test("try-on job batches reject more than three jobs", () => {
  assert.throws(
    () => settleTryOnJobs([0, 1, 2, 3].map((value) => async () => value)),
    /cannot exceed 3 jobs/,
  );
});
