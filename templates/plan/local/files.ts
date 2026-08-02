import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  parsePlanMdxFolder,
  parseSimpleFrontmatter,
  type PlanMdxFolder,
} from "../server/plan-mdx.js";
import {
  PLAN_ASSET_MAX_SINGLE_BYTES,
  PLAN_ASSET_MAX_TOTAL_BYTES,
  mimeTypeFromFilename,
} from "../shared/plan-assets.js";
import { parsePlanHarness, type PlanHarness } from "../shared/plan-harness.js";
import type { PlanComment } from "../shared/types.js";

export const SOURCE_FILES = [
  "plan.mdx",
  "canvas.mdx",
  "prototype.mdx",
  ".plan-state.json",
] as const;
export const COMMENTS_FILE = "comments.json";

export type SourceFile = (typeof SOURCE_FILES)[number];
export type PlanFile = SourceFile | typeof COMMENTS_FILE;

export interface FileSnapshot {
  content: string;
  revision: string;
}

export interface PlanSnapshot {
  metadata: { harness?: PlanHarness };
  files: Partial<Record<PlanFile, FileSnapshot>>;
  bundle: {
    plan: {
      id: string;
      title: string;
      brief: string | null;
      status: "draft";
      source: "agent";
      content: Awaited<ReturnType<typeof parsePlanMdxFolder>>;
      createdAt: string;
      updatedAt: string;
    };
    sections: [];
    comments: PlanComment[];
    events: [];
    summary: {
      sectionCounts: Record<string, number>;
      commentCount: number;
      openCommentCount: number;
    };
  };
  comments: PlanComment[];
  assets: Array<{
    name: string;
    size: number;
    mimeType: string;
    revision: string;
    url: string;
  }>;
}

export class RevisionConflictError extends Error {
  constructor(
    public readonly current: FileSnapshot,
    public readonly file?: PlanFile,
  ) {
    super("The file changed since it was loaded.");
  }
}

export function revision(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function canonicalPlanRoot(input: string): Promise<string> {
  const root = await fs.realpath(path.resolve(input));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("Plan root must be a directory.");
  const planPath = await fs.realpath(path.join(root, "plan.mdx"));
  if (!isInside(root, planPath) || !(await fs.stat(planPath)).isFile()) {
    throw new Error("plan.mdx must be a regular file inside the plan root.");
  }
  return root;
}

export function assertKnownFile(file: string): asserts file is PlanFile {
  if (![...SOURCE_FILES, COMMENTS_FILE].includes(file as PlanFile)) {
    throw new Error("Unknown plan file.");
  }
}

async function containedFile(root: string, relative: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const target = path.join(canonicalRoot, relative);
  const canonical = await fs.realpath(target);
  if (!isInside(canonicalRoot, canonical))
    throw new Error("Plan path escaped its root.");
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error("Plan path is not a regular file.");
  return canonical;
}

async function readOptionalFile(
  root: string,
  file: PlanFile,
): Promise<FileSnapshot | undefined> {
  try {
    const target = await containedFile(root, file);
    const content = await fs.readFile(target, "utf8");
    return { content, revision: revision(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function safeAssetName(raw: string): string {
  const name = raw.trim();
  if (!name || name !== path.basename(name) || name.includes("\0")) {
    throw new Error("Asset name must be a single filename.");
  }
  if (!mimeTypeFromFilename(name)) throw new Error("Unsupported asset type.");
  return name;
}

export async function listAssets(
  root: string,
  sessionId: string,
): Promise<PlanSnapshot["assets"]> {
  const canonicalRoot = await fs.realpath(root);
  const assetsDir = path.join(canonicalRoot, "assets");
  let canonicalAssets: string;
  try {
    canonicalAssets = await fs.realpath(assetsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!isInside(canonicalRoot, canonicalAssets))
    throw new Error("assets escaped the plan root.");

  const result: PlanSnapshot["assets"] = [];
  let total = 0;
  for (const entry of await fs.readdir(canonicalAssets, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const name = safeAssetName(entry.name);
    const target = await containedFile(canonicalAssets, name);
    const bytes = await fs.readFile(target);
    if (bytes.byteLength > PLAN_ASSET_MAX_SINGLE_BYTES) {
      throw new Error(
        `Asset ${name} exceeds ${PLAN_ASSET_MAX_SINGLE_BYTES} bytes.`,
      );
    }
    total += bytes.byteLength;
    if (total > PLAN_ASSET_MAX_TOTAL_BYTES) {
      throw new Error(
        `Assets exceed ${PLAN_ASSET_MAX_TOTAL_BYTES} bytes total.`,
      );
    }
    result.push({
      name,
      size: bytes.byteLength,
      mimeType: mimeTypeFromFilename(name)!,
      revision: revision(bytes),
      url: `/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(name)}`,
    });
  }
  return result;
}

export async function readAsset(
  root: string,
  rawName: string,
): Promise<{ bytes: Buffer; mimeType: string; revision: string }> {
  const name = safeAssetName(rawName);
  const canonicalRoot = await fs.realpath(root);
  const assetsDir = await fs.realpath(path.join(canonicalRoot, "assets"));
  if (!isInside(canonicalRoot, assetsDir))
    throw new Error("assets escaped the plan root.");
  const target = await containedFile(assetsDir, name);
  const bytes = await fs.readFile(target);
  if (bytes.byteLength > PLAN_ASSET_MAX_SINGLE_BYTES)
    throw new Error("Asset is too large.");
  return {
    bytes,
    mimeType: mimeTypeFromFilename(name)!,
    revision: revision(bytes),
  };
}

export async function readPlan(
  root: string,
  sessionId: string,
): Promise<PlanSnapshot> {
  const files: PlanSnapshot["files"] = {};
  for (const file of [...SOURCE_FILES, COMMENTS_FILE] as PlanFile[]) {
    const snapshot = await readOptionalFile(root, file);
    if (snapshot) files[file] = snapshot;
  }
  const content = await parsePlanMdxFolder(await mdxFolder(root));
  const planFile = files["plan.mdx"];
  if (!planFile) throw new Error("plan.mdx is required.");
  const harness = parsePlanHarness(
    parseSimpleFrontmatter(planFile.content).data.harness,
  );
  const { comments } = await readComments(root);
  const timestamp = new Date().toISOString();
  return {
    metadata: { harness },
    files,
    bundle: {
      plan: {
        id: sessionId,
        title: content.title ?? "Untitled plan",
        brief: content.brief ?? null,
        status: "draft",
        source: "agent",
        content,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      sections: [],
      comments,
      events: [],
      summary: {
        sectionCounts: {},
        commentCount: comments.length,
        openCommentCount: comments.filter(
          (comment) => comment.status === "open",
        ).length,
      },
    },
    comments,
    assets: await listAssets(root, sessionId),
  };
}

async function mdxFolder(
  root: string,
  replacement?: { file: SourceFile; content: string },
): Promise<PlanMdxFolder> {
  const result: PlanMdxFolder = { "plan.mdx": "" };
  for (const file of SOURCE_FILES) {
    const content =
      replacement?.file === file
        ? replacement.content
        : (await readOptionalFile(root, file))?.content;
    if (content !== undefined) result[file] = content;
  }
  if (!result["plan.mdx"]) throw new Error("plan.mdx is required.");
  return result;
}

export async function validatePlanRoot(root: string): Promise<void> {
  const folder = await mdxFolder(root);
  await parsePlanMdxFolder(folder);
  const declaredHarness = parseSimpleFrontmatter(folder["plan.mdx"]).data
    .harness;
  if (declaredHarness !== undefined && !parsePlanHarness(declaredHarness)) {
    throw new Error("harness must be codex, claude-code, or opencode.");
  }
  await listAssets(root, "validation");
  const state = await readOptionalFile(root, ".plan-state.json");
  if (state) JSON.parse(state.content);
  const comments = await readOptionalFile(root, COMMENTS_FILE);
  if (comments) validateComments(JSON.parse(comments.content));
}

function validateComments(value: unknown): asserts value is PlanComment[] {
  if (!Array.isArray(value))
    throw new Error("comments.json must contain an array.");
  for (const comment of value) {
    if (!comment || typeof comment !== "object")
      throw new Error("Each comment must be an object.");
    const item = comment as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.message !== "string"
    ) {
      throw new Error(
        "Each comment needs non-empty id and string message fields.",
      );
    }
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  const directory = path.dirname(target);
  const canonicalDirectory = await fs.realpath(directory);
  const temp = path.join(
    canonicalDirectory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(temp, path.join(canonicalDirectory, path.basename(target)));
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

async function writableTarget(root: string, file: PlanFile): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const target = path.join(canonicalRoot, file);
  try {
    const canonical = await fs.realpath(target);
    if (!isInside(canonicalRoot, canonical))
      throw new Error("Plan path escaped its root.");
    if (!(await fs.stat(canonical)).isFile())
      throw new Error("Plan path is not a regular file.");
    return canonical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
    throw error;
  }
}

export async function saveFile(
  root: string,
  file: PlanFile,
  content: string,
  expectedRevision: string | null,
): Promise<FileSnapshot> {
  assertKnownFile(file);
  const current = await readOptionalFile(root, file);
  if ((current?.revision ?? null) !== expectedRevision) {
    throw new RevisionConflictError(current ?? { content: "", revision: "" });
  }
  if (file === COMMENTS_FILE) validateComments(JSON.parse(content));
  else if (file === ".plan-state.json") JSON.parse(content);
  else await parsePlanMdxFolder(await mdxFolder(root, { file, content }));

  const target = await writableTarget(root, file);
  await atomicWrite(target, content);
  const saved = await readOptionalFile(root, file);
  if (!saved || saved.content !== content)
    throw new Error("Saved file verification failed.");
  return saved;
}

export async function saveFiles(
  root: string,
  changes: Partial<
    Record<SourceFile, { content: string; revision: string | null }>
  >,
): Promise<Partial<Record<SourceFile, FileSnapshot>>> {
  const proposed = await mdxFolder(root);
  for (const file of SOURCE_FILES) {
    const change = changes[file];
    if (!change) continue;
    const current = await readOptionalFile(root, file);
    if ((current?.revision ?? null) !== change.revision)
      throw new RevisionConflictError(
        current ?? { content: "", revision: "" },
        file,
      );
    proposed[file] = change.content;
  }
  await parsePlanMdxFolder(proposed);
  const saved: Partial<Record<SourceFile, FileSnapshot>> = {};
  for (const file of SOURCE_FILES) {
    const change = changes[file];
    if (!change) continue;
    saved[file] = await saveFile(root, file, change.content, change.revision);
  }
  return saved;
}

export async function readComments(
  root: string,
): Promise<{ comments: PlanComment[]; revision: string | null }> {
  const file = await readOptionalFile(root, COMMENTS_FILE);
  if (!file) return { comments: [], revision: null };
  const comments: unknown = JSON.parse(file.content);
  validateComments(comments);
  return { comments, revision: file.revision };
}

export async function saveComments(
  root: string,
  comments: PlanComment[],
  expectedRevision: string | null,
): Promise<{ comments: PlanComment[]; revision: string }> {
  validateComments(comments);
  const saved = await saveFile(
    root,
    COMMENTS_FILE,
    `${JSON.stringify(comments, null, 2)}\n`,
    expectedRevision,
  );
  return { comments, revision: saved.revision };
}
