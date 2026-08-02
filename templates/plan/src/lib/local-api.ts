import {
  applyPlanContentPatches,
  type PlanContent,
  type PlanContentPatch,
} from "@shared/plan-content";
import { parsePlanHarness, type PlanHarness } from "@shared/plan-harness";
import type { PlanBundle, PlanComment } from "@shared/types";

import { resolveLocalAssetPaths } from "./asset-paths";

export const PLAN_FILES = [
  "plan.mdx",
  "canvas.mdx",
  "prototype.mdx",
  ".plan-state.json",
] as const;

export type PlanFilename = (typeof PLAN_FILES)[number];

type RevisionMap = Partial<Record<PlanFilename | "comments.json", string>>;

export type LocalSession = {
  id: string;
  bundle: PlanBundle;
  files: Partial<Record<PlanFilename, string>>;
  revisions: RevisionMap;
  comments: PlanComment[];
  metadata: { harness?: PlanHarness };
};

export class LocalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Local plan request failed (${response.status}).`;
    throw new LocalApiError(message, response.status, payload);
  }
  return payload;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringMap(value: unknown): Record<string, string> {
  const source = record(value);
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, entry]) => {
      if (typeof entry === "string") return [[key, entry]];
      const item = record(entry);
      return typeof item.content === "string" ? [[key, item.content]] : [];
    }),
  );
}

function revisionMap(value: unknown, files: unknown): RevisionMap {
  const direct = stringMap(value);
  const fromFiles = Object.fromEntries(
    Object.entries(record(files)).flatMap(([key, entry]) => {
      const revision = record(entry).revision;
      return typeof revision === "string" ? [[key, revision]] : [];
    }),
  );
  return { ...fromFiles, ...direct } as RevisionMap;
}

export function decodeSession(id: string, value: unknown): LocalSession {
  const payload = record(value);
  const returnedBundle = record(payload.bundle);
  const returnedPlan = record(returnedBundle.plan);
  const rawContent = (payload.content ?? returnedPlan.content) as
    | PlanContent
    | undefined;
  if (!rawContent?.blocks) {
    throw new Error("The local daemon did not return parsed plan content.");
  }
  const content = resolveLocalAssetPaths(rawContent, id);
  const files = stringMap(payload.files) as LocalSession["files"];
  const comments = Array.isArray(payload.comments)
    ? (payload.comments as PlanComment[])
    : [];
  const now = new Date().toISOString();
  const bundle: PlanBundle = {
    plan: {
      id,
      title: content.title ?? "Local plan",
      brief: content.brief ?? "Local files",
      kind: "plan",
      status: "draft",
      source: "imported",
      content,
      createdAt: now,
      updatedAt: now,
    },
    access: { role: "editor", visibility: "private" },
    sections: [],
    comments,
    events: [],
    summary: {
      sectionCounts: {},
      commentCount: comments.length,
      openCommentCount: comments.filter((comment) => comment.status === "open")
        .length,
    },
  };
  return {
    id,
    bundle,
    files,
    revisions: revisionMap(payload.revisions, payload.files),
    comments,
    metadata: { harness: parsePlanHarness(record(payload.metadata).harness) },
  };
}

export async function loadSession(id: string): Promise<LocalSession> {
  const payload = await request(`/api/sessions/${encodeURIComponent(id)}`);
  return decodeSession(id, payload);
}

export async function saveFiles(
  sessionId: string,
  files: Partial<
    Record<PlanFilename, { content: string; revision: string | null }>
  >,
): Promise<RevisionMap> {
  const payload = record(
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
      method: "PUT",
      body: JSON.stringify({ files }),
    }),
  );
  return revisionMap(undefined, payload.files);
}

export async function addComment(
  sessionId: string,
  message: string,
  parentCommentId?: string,
): Promise<{
  comment: PlanComment;
  comments: PlanComment[];
  revision: string;
}> {
  const payload = await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({
        message,
        parentCommentId: parentCommentId ?? null,
      }),
    },
  );
  const value = record(payload);
  if (
    value.comment &&
    typeof value.comment === "object" &&
    Array.isArray(value.comments) &&
    typeof value.revision === "string"
  ) {
    return {
      comment: value.comment as PlanComment,
      comments: value.comments as PlanComment[],
      revision: value.revision,
    };
  }
  throw new Error("Comment response omitted the saved comment state.");
}

export async function saveComments(
  sessionId: string,
  comments: PlanComment[],
  revision: string | null,
): Promise<{ comments: PlanComment[]; revision: string }> {
  const payload = record(
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
      method: "PUT",
      body: JSON.stringify({ comments, revision }),
    }),
  );
  if (
    !Array.isArray(payload.comments) ||
    typeof payload.revision !== "string"
  ) {
    throw new Error("Comment response omitted the saved comment state.");
  }
  return {
    comments: payload.comments as PlanComment[],
    revision: payload.revision,
  };
}

export async function sendPlanToAgent(
  sessionId: string,
): Promise<{ harness: PlanHarness; threadId: string; url?: string }> {
  const payload = record(
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/agent/send`, {
      method: "POST",
    }),
  );
  const harness = parsePlanHarness(payload.harness);
  if (!harness || typeof payload.threadId !== "string") {
    throw new Error("Agent response omitted the task metadata.");
  }
  return {
    harness,
    threadId: payload.threadId,
    url: typeof payload.url === "string" ? payload.url : undefined,
  };
}

export async function publishPlanToTailnet(
  sessionId: string,
): Promise<{ url: string }> {
  const payload = record(
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/publish`, {
      method: "POST",
    }),
  );
  if (typeof payload.url !== "string") {
    throw new Error("Publish response omitted the tailnet URL.");
  }
  return { url: payload.url };
}

export function applyContentPatch(
  content: PlanContent,
  patch: PlanContentPatch,
): PlanContent {
  return applyPlanContentPatches(content, [patch]);
}
