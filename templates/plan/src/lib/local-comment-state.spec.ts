import type { PlanComment } from "@shared/types";
import { describe, expect, it } from "vitest";

import {
  deleteLocalComment,
  localCommentReplies,
  rootLocalComments,
  updateLocalComment,
  visibleLocalComments,
} from "./local-comment-state";

const createdAt = "2026-08-01T00:00:00.000Z";

function comment(
  id: string,
  parentCommentId: string | null = null,
): PlanComment {
  return {
    id,
    planId: "plan-local",
    parentCommentId,
    kind: "comment",
    status: "open",
    message: id,
    createdBy: "human",
    createdAt,
    updatedAt: createdAt,
  };
}

describe("local comment state", () => {
  it("groups roots and replies while preserving orphaned comments", () => {
    const root = comment("root");
    const reply = comment("reply", root.id);
    const nested = comment("nested", reply.id);
    const orphan = comment("orphan", "missing");
    const comments = [root, reply, nested, orphan];

    expect(rootLocalComments(comments).map(({ id }) => id)).toEqual([
      "root",
      "orphan",
    ]);
    expect(localCommentReplies(comments, root.id)).toEqual([reply, nested]);
  });

  it("hides comments already soft-deleted on disk", () => {
    const visible = comment("visible");
    const deleted = { ...comment("deleted"), deletedAt: createdAt };
    expect(visibleLocalComments([visible, deleted])).toEqual([visible]);
  });

  it("edits, resolves, and reopens without changing unrelated comments", () => {
    const root = comment("root");
    const other = comment("other");
    const resolvedAt = "2026-08-01T01:00:00.000Z";
    const resolved = updateLocalComment(
      [root, other],
      root.id,
      { message: "updated", status: "resolved" },
      resolvedAt,
    );

    expect(resolved[0]).toMatchObject({
      message: "updated",
      status: "resolved",
      resolvedAt,
      resolvedBy: "local-reviewer",
      updatedAt: resolvedAt,
    });
    expect(resolved[1]).toBe(other);

    expect(
      updateLocalComment(resolved, root.id, { status: "open" }, resolvedAt)[0],
    ).toMatchObject({ status: "open", resolvedAt: null, resolvedBy: null });
  });

  it("deletes a thread recursively but deletes a single reply independently", () => {
    const root = comment("root");
    const reply = comment("reply", root.id);
    const nested = comment("nested", reply.id);
    const other = comment("other");

    expect(deleteLocalComment([root, reply, nested, other], reply.id)).toEqual([
      root,
      other,
    ]);
    expect(deleteLocalComment([root, reply, nested, other], root.id)).toEqual([
      other,
    ]);
  });

  it("stops traversing cyclic reply chains", () => {
    const first = comment("first", "second");
    const second = comment("second", "first");

    expect(localCommentReplies([first, second], first.id)).toEqual([second]);
  });
});
