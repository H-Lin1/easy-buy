import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  collectClosetStorageCleanupPaths,
  restoreClosetItemAtIndex,
} from "./deletion-workflow.ts";

test("collects snapshot and authoritative image paths without duplicates", () => {
  assert.deepEqual(
    collectClosetStorageCleanupPaths(
      {
        imagePath: "user/original.jpg",
        processedImagePath: "user/processed.webp",
      },
      {
        imagePath: "user/original.jpg",
        displayImagePath: "user/display/latest.png",
      },
    ),
    ["user/original.jpg", "user/processed.webp", "user/display/latest.png"],
  );
});

test("restores an optimistically removed item at its original position", () => {
  const restored = restoreClosetItemAtIndex(
    [{ id: "first" }, { id: "third" }],
    { id: "second" },
    1,
  );

  assert.deepEqual(restored.map((item) => item.id), ["first", "second", "third"]);
  assert.strictEqual(restoreClosetItemAtIndex(restored, { id: "second" }, 1), restored);
});

test("pending deletion stays available during analysis and display work", () => {
  const pageSource = readFileSync(new URL("../../app/app/page.tsx", import.meta.url), "utf8");
  const confirmationCardSource = pageSource.slice(
    pageSource.indexOf("function ClosetConfirmationCard"),
    pageSource.indexOf("function LabeledInput"),
  );

  assert.match(
    confirmationCardSource,
    /disabled=\{isDeleting\}[\s\S]*onClick=\{\(\) => void onDeleteItem\(item\)\}/,
  );
  assert.doesNotMatch(confirmationCardSource, /itemDestructiveBusy/);
});

test("deletion aborts item requests, gates late writes and cleans authoritative paths", () => {
  const pageSource = readFileSync(new URL("../../app/app/page.tsx", import.meta.url), "utf8");
  const deleteSource = pageSource.slice(
    pageSource.indexOf("async function deleteClosetItem"),
    pageSource.indexOf("async function confirmClosetItemOnServer"),
  );

  assert.equal((pageSource.match(/signal: requestController\.signal/g) ?? []).length, 2);
  assert.match(
    pageSource,
    /isCurrentClosetSession\(sessionEpoch\) && !deletedClosetItemIdsRef\.current\.has\(itemId\)/,
  );
  assert.match(deleteSource, /deletedClosetItemIdsRef\.current\.add\(item\.id\)/);
  assert.match(deleteSource, /analysisQueueRef\.current = analysisQueueRef\.current\.filter/);
  assert.match(deleteSource, /abortClosetItemRequests\(item\.id\)/);
  assert.match(
    deleteSource,
    /\.delete\(\)[\s\S]*\.select\("image_path,processed_image_path,display_image_path"\)/,
  );
  assert.match(deleteSource, /collectClosetStorageCleanupPaths\([\s\S]*deletedItem/);
  assert.match(deleteSource, /deletedClosetItemIdsRef\.current\.delete\(item\.id\)/);
  assert.match(deleteSource, /restoreClosetItemAtIndex\(items, item, originalIndex\)/);
});

test("display generation removes uploaded files when database ownership is lost", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/ai/generate-closet-display-image/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /callConfiguredImageEdit\(imageDataUrl, timing, request\.signal\)/);
  assert.match(
    routeSource,
    /if \(!data\) \{[\s\S]*removeUncommittedDisplayImage\([\s\S]*"storage_cleanup_unowned"/,
  );
  assert.match(
    routeSource,
    /if \(uploadedDisplayImagePath && !displayImageCommitted\) \{[\s\S]*"storage_cleanup_failed"/,
  );
  assert.match(
    routeSource,
    /supabase\.storage\.from\("closet-images"\)\.remove\(\[displayImagePath\]\)/,
  );
});
