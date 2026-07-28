#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertUniqueSceneSet,
  assertUnrelatedBaselineHashes,
  captureUnrelatedBaselineHashes,
  sha256Buffer,
  sha256File,
  verifyBaselineInventory,
} from "./lib.mjs";

assert.equal(
  sha256Buffer(Buffer.from("ui-harness-fixture")),
  "58e41dc5441d6eb5081b1362a73e421dd32e63f599c8baa24e81b1cce06ab6c5",
  "baseline hash guard must be deterministic",
);
assert.throws(
  () => assertUniqueSceneSet(["one", "one"], ["one"]),
  /Duplicate scenario id/,
);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dopedb-ui-guard-"));
try {
  const snapshots = path.join(temporary, "snapshots");
  fs.mkdirSync(snapshots);
  const first = path.join(snapshots, "first.png");
  const second = path.join(snapshots, "second.png");
  fs.writeFileSync(first, "first fixture image");
  fs.writeFileSync(second, "second fixture image");
  const manifest = {
    schemaVersion: 1,
    baselines: [
      {
        scene: "first",
        file: "snapshots/first.png",
        sha256: sha256File(first),
      },
      {
        scene: "second",
        file: "snapshots/second.png",
        sha256: sha256File(second),
      },
    ],
  };
  const inventory = verifyBaselineInventory({
    manifest,
    requireAll: true,
    root: temporary,
    snapshotRoot: snapshots,
    knownScenes: ["first", "second"],
  });
  const unrelated = captureUnrelatedBaselineHashes(inventory, "first");
  fs.writeFileSync(second, "unexpected blind update");
  assert.throws(
    () => assertUnrelatedBaselineHashes(unrelated),
    /unrelated snapshot changed/,
  );

  fs.writeFileSync(second, "second fixture image");
  fs.writeFileSync(path.join(snapshots, "unknown.png"), "not approved");
  assert.throws(
    () =>
      verifyBaselineInventory({
        manifest,
        root: temporary,
        snapshotRoot: snapshots,
        knownScenes: ["first", "second"],
      }),
    /Unapproved snapshot file/,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("ui harness guard self-tests ok");
