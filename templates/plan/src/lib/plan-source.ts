import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { planContentSchema } from "@shared/plan-content";
import {
  parseSimpleFrontmatter,
  exportPlanContentToMdxFolder,
  serializeCanvas,
  serializePrototype,
} from "../../server/plan-mdx";
import { restoreLocalAssetPaths } from "./asset-paths";

type UnvalidatedPlanContent = Parameters<typeof restoreLocalAssetPaths>[0];

const serializeInput = z.object({
  sessionId: z.string().min(1),
  // Local asset URLs are expanded to session API paths in the browser. Restore
  // them before applying the upstream content schema.
  content: z.unknown(),
  files: z.object({
    "plan.mdx": z.string().min(1),
    "canvas.mdx": z.string().optional(),
    "prototype.mdx": z.string().optional(),
    ".plan-state.json": z.string().optional(),
  }),
});

function replaceFrontmatterValue(
  source: string,
  key: "title" | "brief",
  value: string | undefined,
): string {
  const end = source.startsWith("---\n") ? source.indexOf("\n---", 4) : -1;
  if (end < 0) return source;
  const before = source.slice(0, end);
  const after = source.slice(end);
  const line = new RegExp(`^${key}:.*$`, "m");
  if (value === undefined) return source;
  return line.test(before)
    ? `${before.replace(line, `${key}: ${JSON.stringify(value)}`)}${after}`
    : `${before}\n${key}: ${JSON.stringify(value)}${after}`;
}

export const serializeLocalPlan = createServerFn({ method: "POST" })
  .validator((value) => serializeInput.parse(value))
  .handler(async ({ data }) => {
    const content = planContentSchema.parse(
      restoreLocalAssetPaths(data.content as UnvalidatedPlanContent, data.sessionId),
    );
    const original = parseSimpleFrontmatter(data.files["plan.mdx"]);
    const exported = await exportPlanContentToMdxFolder({
      content,
      title: content.title ?? "Local plan",
      brief: content.brief,
    });
    const exportedBody = parseSimpleFrontmatter(exported["plan.mdx"]).content;
    const originalFrontmatterEnd = data.files["plan.mdx"].indexOf("\n---", 4);
    let planMdx =
      originalFrontmatterEnd >= 0
        ? `${data.files["plan.mdx"].slice(0, originalFrontmatterEnd + 4)}\n\n${exportedBody}`
        : exported["plan.mdx"];
    if (content.title !== original.data.title) {
      planMdx = replaceFrontmatterValue(planMdx, "title", content.title);
    }
    if (content.brief !== original.data.brief) {
      planMdx = replaceFrontmatterValue(planMdx, "brief", content.brief);
    }
    return {
      "plan.mdx": planMdx,
      "canvas.mdx": content.canvas ? serializeCanvas(content) : undefined,
      "prototype.mdx": content.prototype
        ? serializePrototype(content.prototype)
        : undefined,
      ".plan-state.json": exported[".plan-state.json"],
    };
  });
