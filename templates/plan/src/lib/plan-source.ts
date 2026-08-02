import { planContentSchema } from "@shared/plan-content";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  parseSimpleFrontmatter,
  exportPlanContentToMdxFolder,
  serializeCanvas,
  serializePrototype,
} from "../../server/plan-mdx";
import { restoreLocalAssetPaths } from "./asset-paths";

type UnvalidatedPlanContent = Parameters<typeof restoreLocalAssetPaths>[0];

const traversablePlanContentSchema = z
  .object({
    blocks: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const serializeInput = z.object({
  sessionId: z.string().min(1),
  // Local asset URLs are expanded to session API paths in the browser. Restore
  // them before applying the upstream content schema.
  content: traversablePlanContentSchema,
  files: z.object({
    "plan.mdx": z.string().min(1),
    "canvas.mdx": z.string().optional(),
    "prototype.mdx": z.string().optional(),
    ".plan-state.json": z.string().optional(),
  }),
});

export function replaceFrontmatterValue(
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

export function preserveOriginalFrontmatter(
  original: string,
  exported: string,
): string {
  if (!original.startsWith("---\n")) return exported;
  const end = original.indexOf("\n---", 4);
  if (end < 0) return exported;
  const exportedBody = parseSimpleFrontmatter(exported).content;
  return `${original.slice(0, end + 4)}\n${exportedBody}`;
}

export const serializeLocalPlan = createServerFn({ method: "POST" })
  .validator((value) => serializeInput.parse(value))
  .handler(async ({ data }) => {
    const content = planContentSchema.parse(
      restoreLocalAssetPaths(
        data.content as UnvalidatedPlanContent,
        data.sessionId,
      ),
    );
    const original = parseSimpleFrontmatter(data.files["plan.mdx"]);
    const exported = await exportPlanContentToMdxFolder({
      content,
      title: content.title ?? "Local plan",
      brief: content.brief,
    });
    let planMdx = preserveOriginalFrontmatter(
      data.files["plan.mdx"],
      exported["plan.mdx"],
    );
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
