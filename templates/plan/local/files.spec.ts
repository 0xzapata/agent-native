import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalPlanRoot,
  readComments,
  revision,
  RevisionConflictError,
  saveComments,
  saveFile,
  saveFiles,
  readPlan,
  validatePlanRoot,
} from "./files.js";

const PLAN = `---
title: "Local runtime test"
version: 2
harness: "claude-code"
---

Local plan body.
`;

describe("local editor filesystem service", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-runtime-"));
    await fs.writeFile(path.join(root, "plan.mdx"), PLAN);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("validates an upstream-compatible plan folder", async () => {
    await expect(
      validatePlanRoot(await canonicalPlanRoot(root)),
    ).resolves.toBeUndefined();
  });

  it("rejects unsupported harness metadata", async () => {
    await fs.writeFile(
      path.join(root, "plan.mdx"),
      PLAN.replace('harness: "claude-code"', 'harness: "cursor"'),
    );
    await expect(validatePlanRoot(root)).rejects.toThrow(
      /harness must be codex, claude-code, or opencode/,
    );
  });

  it("returns parsed content and source revisions for the editor", async () => {
    const snapshot = await readPlan(root, "opaque-session");
    expect(snapshot.files["plan.mdx"]?.revision).toBe(revision(PLAN));
    expect(snapshot.bundle.plan.content.title).toBe("Local runtime test");
    expect(snapshot.metadata).toEqual({ harness: "claude-code" });
    expect(snapshot.comments).toEqual([]);
  });

  it("rejects a plan.mdx symlink that escapes the root", async () => {
    const outside = `${root}-outside.mdx`;
    await fs.writeFile(outside, PLAN);
    await fs.rm(path.join(root, "plan.mdx"));
    await fs.symlink(outside, path.join(root, "plan.mdx"));
    await expect(canonicalPlanRoot(root)).rejects.toThrow(
      /inside the plan root/,
    );
    await fs.rm(outside, { force: true });
  });

  it("rejects optional source symlinks that escape the root on save", async () => {
    const outside = `${root}-outside.json`;
    await fs.writeFile(outside, "{}\n");
    await fs.symlink(outside, path.join(root, ".plan-state.json"));
    await expect(
      saveFile(root, ".plan-state.json", "{}\n", revision("{}\n")),
    ).rejects.toThrow(/escaped its root/);
    expect(await fs.readFile(outside, "utf8")).toBe("{}\n");
    await fs.rm(outside, { force: true });
  });

  it("rejects malformed MDX and malformed comments", async () => {
    await fs.writeFile(path.join(root, "plan.mdx"), '<RichText id="broken">');
    await expect(validatePlanRoot(root)).rejects.toThrow();
    await fs.writeFile(path.join(root, "plan.mdx"), PLAN);
    await fs.writeFile(path.join(root, "comments.json"), '{"not":"an array"}');
    await expect(validatePlanRoot(root)).rejects.toThrow(
      /must contain an array/,
    );
  });

  it("rejects unsupported assets and asset symlink escapes", async () => {
    const assets = path.join(root, "assets");
    await fs.mkdir(assets);
    await fs.writeFile(path.join(assets, "payload.txt"), "nope");
    await expect(validatePlanRoot(root)).rejects.toThrow(
      /Unsupported asset type/,
    );
    await fs.rm(path.join(assets, "payload.txt"));
    const outside = `${root}-outside.png`;
    await fs.writeFile(outside, "not really an image");
    await fs.symlink(outside, path.join(assets, "escape.png"));
    await expect(validatePlanRoot(root)).resolves.toBeUndefined();
    await fs.rm(outside, { force: true });
  });

  it("rejects oversized assets", async () => {
    const assets = path.join(root, "assets");
    await fs.mkdir(assets);
    await fs.writeFile(
      path.join(assets, "large.png"),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    await expect(validatePlanRoot(root)).rejects.toThrow(/exceeds/);
  });

  it("atomically saves with a revision guard", async () => {
    const next = PLAN.replace("Local plan body.", "Updated local plan body.");
    const saved = await saveFile(root, "plan.mdx", next, revision(PLAN));
    expect(saved.revision).toBe(revision(next));
    expect(await fs.readFile(path.join(root, "plan.mdx"), "utf8")).toBe(next);
  });

  it("returns current content without overwriting on conflict", async () => {
    const external = PLAN.replace("Local plan body.", "External change.");
    await fs.writeFile(path.join(root, "plan.mdx"), external);
    const error = await saveFile(root, "plan.mdx", PLAN, revision(PLAN)).catch(
      (value) => value,
    );
    expect(error).toBeInstanceOf(RevisionConflictError);
    expect(error.current).toEqual({
      content: external,
      revision: revision(external),
    });
    expect(await fs.readFile(path.join(root, "plan.mdx"), "utf8")).toBe(
      external,
    );
  });

  it("preflights bundle revisions before changing any source file", async () => {
    const canvas =
      '<DesignBoard title="A"><Artboard id="a" label="A" x={0} y={0} /></DesignBoard>\n';
    await fs.writeFile(path.join(root, "canvas.mdx"), canvas);
    const external = canvas.replace('title="A"', 'title="External"');
    await fs.writeFile(path.join(root, "canvas.mdx"), external);
    const nextPlan = PLAN.replace("Local plan body.", "Bundle edit.");
    await expect(
      saveFiles(root, {
        "plan.mdx": { content: nextPlan, revision: revision(PLAN) },
        "canvas.mdx": { content: canvas, revision: revision(canvas) },
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await fs.readFile(path.join(root, "plan.mdx"), "utf8")).toBe(PLAN);
    expect(await fs.readFile(path.join(root, "canvas.mdx"), "utf8")).toBe(
      external,
    );
  });

  it("keeps a successful write when a later bundle write fails", async () => {
    const canvas =
      '<DesignBoard title="A"><Artboard id="a" x={0} y={0} /></DesignBoard>\n';
    await fs.writeFile(path.join(root, "canvas.mdx"), canvas);
    const nextPlan = PLAN.replace("Local plan body.", "Bundle edit.");
    const nextCanvas = canvas.replace('title="A"', 'title="B"');
    const rename = fs.rename.bind(fs);
    let writes = 0;
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockImplementation(async (...args) => {
        await rename(...args);
        writes += 1;
        if (writes === 2) {
          throw new Error("second write failed");
        }
      });

    const error = await saveFiles(root, {
      "plan.mdx": { content: nextPlan, revision: revision(PLAN) },
      "canvas.mdx": { content: nextCanvas, revision: revision(canvas) },
    }).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(await fs.readFile(path.join(root, "plan.mdx"), "utf8")).toBe(
      nextPlan,
    );
    renameSpy.mockRestore();
  });

  it("round-trips comments with revisions", async () => {
    const comment = {
      id: "cmt_local",
      planId: "local",
      kind: "annotation" as const,
      status: "open" as const,
      message: "Review this.",
      createdBy: "human" as const,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const saved = await saveComments(root, [comment], null);
    expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await readComments(root)).toEqual({
      comments: [comment],
      revision: saved.revision,
    });
  });
});
