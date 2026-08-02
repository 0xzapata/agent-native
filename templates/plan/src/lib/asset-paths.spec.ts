import type { PlanColumnsBlock, PlanContent } from "@shared/plan-content";
import { describe, expect, it } from "vitest";

import { resolveLocalAssetPaths, restoreLocalAssetPaths } from "./asset-paths";

describe("local asset paths", () => {
  it("preserves columns metadata while rewriting nested assets", () => {
    const columnsData: PlanColumnsBlock["data"] & { layout: string } = {
      layout: "wide",
      columns: [
        {
          id: "left",
          blocks: [
            {
              id: "image",
              type: "image",
              data: { url: "assets/example.png", alt: "Example" },
            },
          ],
        },
      ],
    };
    const content: PlanContent = {
      version: 2,
      blocks: [
        {
          id: "columns",
          type: "columns",
          data: columnsData,
        },
      ],
    };

    const resolved = resolveLocalAssetPaths(content, "session");
    const columns = resolved.blocks[0];

    expect(columns?.data).toMatchObject({ layout: "wide" });
    expect(columns?.type).toBe("columns");
    if (columns?.type !== "columns") throw new Error("Expected columns block.");
    expect(columns.data.columns[0]?.blocks[0]?.data).toMatchObject({
      url: "/api/sessions/session/assets/example.png",
    });
  });

  it.each(['"Screenshot title"', "'Screenshot title'", "(Screenshot title)"])(
    "round-trips a markdown asset with title %s",
    (title) => {
      const content = {
        version: 2,
        blocks: [
          {
            id: "markdown",
            type: "rich-text",
            data: { markdown: `![Example](assets/example.png ${title})` },
          },
        ],
      } as PlanContent;

      const resolved = resolveLocalAssetPaths(content, "session");
      const restored = restoreLocalAssetPaths(resolved, "session");

      expect(restored).toEqual(content);
    },
  );
});
