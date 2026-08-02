import type { PlanComment } from "@shared/types";

export function updateLocalComment(
  comments: PlanComment[],
  id: string,
  patch: Partial<Pick<PlanComment, "message" | "status">>,
  now = new Date().toISOString(),
): PlanComment[] {
  return comments.map((comment) => {
    if (comment.id !== id) return comment;
    const status = patch.status ?? comment.status;
    return {
      ...comment,
      ...patch,
      status,
      resolvedAt: status === "resolved" ? (comment.resolvedAt ?? now) : null,
      resolvedBy:
        status === "resolved" ? (comment.resolvedBy ?? "local-reviewer") : null,
      updatedAt: now,
    };
  });
}

export function deleteLocalComment(
  comments: PlanComment[],
  id: string,
): PlanComment[] {
  const removed = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const comment of comments) {
      if (comment.parentCommentId && removed.has(comment.parentCommentId)) {
        changed = !removed.has(comment.id) || changed;
        removed.add(comment.id);
      }
    }
  }
  return comments.filter((comment) => !removed.has(comment.id));
}

export function rootLocalComments(comments: PlanComment[]): PlanComment[] {
  const ids = new Set(comments.map(({ id }) => id));
  return comments.filter(
    ({ parentCommentId }) => !parentCommentId || !ids.has(parentCommentId),
  );
}

export function localCommentReplies(
  comments: PlanComment[],
  parentId: string,
): PlanComment[] {
  const replies: PlanComment[] = [];
  const appendChildren = (id: string) => {
    for (const comment of comments) {
      if (comment.parentCommentId !== id) continue;
      replies.push(comment);
      appendChildren(comment.id);
    }
  };
  appendChildren(parentId);
  return replies;
}

export function visibleLocalComments(comments: PlanComment[]): PlanComment[] {
  return comments.filter(({ deletedAt }) => !deletedAt);
}
