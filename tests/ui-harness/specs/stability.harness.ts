import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { scenarioIds } from "../scenarios";
import type { UiHarnessSceneId } from "../scenarios/types";
import { openPreparedScene } from "../support/openScene";

const selected = (process.env.UI_HARNESS_STABILITY_SCENES ?? "")
  .split(",")
  .filter((scene): scene is UiHarnessSceneId =>
    scenarioIds.includes(scene as UiHarnessSceneId),
  );
const repeat = Number(process.env.UI_HARNESS_STABILITY_REPEAT ?? 0);

test.skip(
  selected.length === 0 || repeat < 2,
  "stability는 ui:harness:stability에서만 실행한다",
);

for (const scene of selected) {
  test(`${scene} — ${repeat}회 fresh-page pixel 결정성`, async ({ page }) => {
    const rawPixelHashes: string[] = [];
    const perceptualDiffPixels: number[] = [];
    let reference: PNG | undefined;
    const output = path.resolve(
      "output",
      "playwright",
      "stability",
      scene,
    );
    mkdirSync(output, { recursive: true });

    for (let iteration = 0; iteration < repeat; iteration += 1) {
      await openPreparedScene(page, scene);
      const image = await page.screenshot({
        animations: "disabled",
        caret: "hide",
      });
      // Chromium may encode identical pixels into byte-different PNG streams.
      // Determinism is therefore based on decoded RGBA pixels plus dimensions.
      const decoded = PNG.sync.read(image);
      const hash = createHash("sha256")
        .update(`${decoded.width}x${decoded.height}:`)
        .update(decoded.data)
        .digest("hex");
      rawPixelHashes.push(hash);

      const diffPixels = reference
        ? pixelmatch(
            reference.data,
            decoded.data,
            undefined,
            decoded.width,
            decoded.height,
            {
              // Tighter than the normal screenshot threshold (0.2), while
              // tolerating Chromium's sub-pixel color rounding.
              includeAA: true,
              threshold: 0.01,
            },
          )
        : 0;
      perceptualDiffPixels.push(diffPixels);

      if (diffPixels > 0) {
        writeFileSync(
          path.join(output, `mismatch-${iteration + 1}.png`),
          image,
        );
      }
      reference ??= decoded;
      await page.goto("about:blank");
    }

    writeFileSync(
      path.join(output, "hashes.json"),
      `${JSON.stringify(
        { scene, repeat, rawPixelHashes, perceptualDiffPixels },
        null,
        2,
      )}\n`,
    );
    expect(
      Math.max(...perceptualDiffPixels),
      "fresh-page screenshots must have zero perceptual pixel differences",
    ).toBe(
      0,
    );
  });
}
