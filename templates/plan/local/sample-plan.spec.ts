import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parsePlanMdxFolder } from "../server/plan-mdx.js";
import {
  canonicalPlanRoot,
  readAsset,
  readPlan,
  validatePlanRoot,
} from "./files.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sample-plan",
);

describe("complete local sample plan", () => {
  it("validates every compatible source file, comments, asset, and editor state", async () => {
    const root = await canonicalPlanRoot(fixture);
    await expect(validatePlanRoot(root)).resolves.toBeUndefined();

    const snapshot = await readPlan(root, "sample-session");
    expect(snapshot.metadata).toEqual({ harness: "codex" });
    expect(Object.keys(snapshot.files).sort()).toEqual([
      ".plan-state.json",
      "canvas.mdx",
      "comments.json",
      "plan.mdx",
      "prototype.mdx",
    ]);
    expect(
      snapshot.bundle.plan.content.canvas?.frames.map(({ id }) => id),
    ).toEqual(["canvas-welcome", "canvas-confirmation"]);
    expect(snapshot.bundle.plan.content.canvas?.viewport).toEqual({
      zoom: 0.72,
      pan: { x: 96, y: 64 },
    });
    expect(
      snapshot.bundle.plan.content.prototype?.screens.map(({ id }) => id),
    ).toEqual(["welcome", "confirmation"]);
    expect(snapshot.comments.map(({ message }) => message)).toContain(
      "Seed feedback loaded from comments.json.",
    );
    expect(snapshot.assets).toMatchObject([
      { name: "local-plan-mark.svg", mimeType: "image/svg+xml" },
    ]);

    const asset = await readAsset(root, "local-plan-mark.svg");
    expect(asset.mimeType).toBe("image/svg+xml");
    expect(asset.bytes.toString("utf8")).toContain("Local plan sample mark");
  });

  it("round-trips the fixture through the authoritative folder parser without id loss", async () => {
    const files = await Promise.all(
      ["plan.mdx", "canvas.mdx", "prototype.mdx", ".plan-state.json"].map(
        async (name) =>
          [name, await fs.readFile(path.join(fixture, name), "utf8")] as const,
      ),
    );
    const parsed = await parsePlanMdxFolder(
      Object.fromEntries(files) as Parameters<typeof parsePlanMdxFolder>[0],
    );
    expect(parsed.blocks.map(({ id }) => id)).toEqual([
      "overview",
      "local-only",
      "acceptance",
      "coverage",
      "sample-asset",
      "commands",
      "completion",
    ]);
    expect(parsed.canvas?.annotations?.[0]).toMatchObject({
      id: "canvas-note",
      targetId: "canvas-confirmation",
    });
    expect(parsed.prototype?.transitions).toHaveLength(2);
  });
});
