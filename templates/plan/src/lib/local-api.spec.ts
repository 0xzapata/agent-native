import type { PlanComment } from "@shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addComment,
  publishPlanToTailnet,
  saveComments,
  sendPlanToAgent,
} from "./local-api";

const savedComment: PlanComment = {
  id: "comment-1",
  planId: "session-1",
  parentCommentId: "root-1",
  kind: "comment",
  status: "open",
  message: "Reply",
  createdBy: "human",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("local comment API", () => {
  it("adds a reply and returns the canonical comments revision", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          comment: savedComment,
          comments: [savedComment],
          revision: "revision-2",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(addComment("session-1", "Reply", "root-1")).resolves.toEqual({
      comment: savedComment,
      comments: [savedComment],
      revision: "revision-2",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/session-1/comments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Reply", parentCommentId: "root-1" }),
      }),
    );
  });

  it("saves edits, resolution, and deletion with the current revision", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ comments: [], revision: "revision-3" })),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(saveComments("session-1", [], "revision-2")).resolves.toEqual({
      comments: [],
      revision: "revision-3",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/session-1/comments",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ comments: [], revision: "revision-2" }),
      }),
    );
  });

  it("sends the opaque session to an agent without browser plan details", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          harness: "codex",
          threadId: "task-1",
          url: "codex://threads/task-1",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(sendPlanToAgent("session-1")).resolves.toEqual({
      harness: "codex",
      threadId: "task-1",
      url: "codex://threads/task-1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/session-1/agent/send",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("publishes the opaque session and returns its tailnet URL", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://mac.example.ts.net:8443/plans/session-1",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(publishPlanToTailnet("session-1")).resolves.toEqual({
      url: "https://mac.example.ts.net:8443/plans/session-1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/session-1/publish",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
