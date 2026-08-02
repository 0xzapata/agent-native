import type { PlanContent, PlanContentPatch } from "@shared/plan-content";
import type { PlanComment } from "@shared/types";
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconEdit,
  IconMessageCircle,
  IconMoon,
  IconNetwork,
  IconRefresh,
  IconRotateClockwise,
  IconSend,
  IconSun,
  IconTrash,
} from "@tabler/icons-react";
import { useTheme } from "next-themes";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { toast } from "sonner";

import { PlanContentRenderer } from "@/components/plan/PlanContentRenderer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  LocalApiError,
  addComment,
  applyContentPatch,
  loadSession,
  saveComments,
  saveFiles,
  publishPlanToTailnet,
  sendPlanToAgent,
  type LocalSession,
  type PlanFilename,
} from "../lib/local-api";
import {
  deleteLocalComment,
  localCommentReplies,
  rootLocalComments,
  updateLocalComment,
  visibleLocalComments,
} from "../lib/local-comment-state";
import { serializeLocalPlan } from "../lib/plan-source";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

type Conflict = {
  message: string;
  file: PlanFilename;
  revision: string | null;
};

function conflictDetails(
  error: LocalApiError,
  names: PlanFilename[],
): Pick<Conflict, "file" | "revision"> | null {
  if (!error.payload || typeof error.payload !== "object") return null;
  const payload = error.payload as Record<string, unknown>;
  const revisions =
    payload.revisions && typeof payload.revisions === "object"
      ? (payload.revisions as Record<string, unknown>)
      : {};
  const file = names.find((name) => typeof revisions[name] === "string");
  if (file) return { file, revision: (revisions[file] as string) || null };
  const current =
    payload.current && typeof payload.current === "object"
      ? (payload.current as Record<string, unknown>)
      : {};
  return names.length === 1 && typeof current.revision === "string"
    ? { file: names[0], revision: current.revision || null }
    : null;
}

function statusLabel(state: SaveState) {
  if (state === "saving") return "Saving locally…";
  if (state === "dirty") return "Unsaved changes";
  if (state === "saved") return "Saved to disk";
  if (state === "error") return "Save failed";
  return "Local files";
}

function CommentRail({
  comments,
  className,
  mutating,
  onAdd,
  onDelete,
  onSendToAgent,
  onUpdate,
  readOnly,
  sendingToAgent,
}: {
  comments: PlanComment[];
  className?: string;
  mutating: boolean;
  onAdd: (message: string, parentCommentId?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSendToAgent: () => Promise<void>;
  onUpdate: (
    id: string,
    patch: Partial<Pick<PlanComment, "message" | "status">>,
  ) => Promise<void>;
  sendingToAgent: boolean;
  readOnly?: boolean;
}) {
  const [message, setMessage] = useState("");
  const visibleComments = visibleLocalComments(comments);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = message.trim();
    if (!next || mutating) return;
    await onAdd(next);
    setMessage("");
  };

  return (
    <aside
      className={cn(
        "flex min-h-0 w-[22rem] shrink-0 flex-col border-l border-border bg-background",
        className,
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <IconMessageCircle className="size-4" />
        <h2 className="text-sm font-medium">Comments</h2>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {visibleComments.length}
        </span>
        {!readOnly && (
          <Button
            type="button"
            size="sm"
            disabled={
              sendingToAgent ||
              !visibleComments.some(({ status }) => status === "open")
            }
            onClick={() => void onSendToAgent()}
          >
            <IconSend className="size-4" />
            {sendingToAgent ? "Sending…" : "Send to agent"}
          </Button>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          {visibleComments.length === 0 ? (
            <p className="py-8 text-center text-sm leading-6 text-muted-foreground">
              Leave a note for the coding agent. Feedback stays in
              <code className="mx-1">comments.json</code>.
            </p>
          ) : (
            rootLocalComments(visibleComments).map((comment) => (
              <CommentThread
                key={comment.id}
                comment={comment}
                replies={localCommentReplies(visibleComments, comment.id)}
                mutating={mutating}
                onAdd={onAdd}
                onDelete={onDelete}
                onUpdate={onUpdate}
                readOnly={readOnly}
              />
            ))
          )}
        </div>
      </ScrollArea>
      <form onSubmit={submit} className="border-t border-border p-3">
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Add feedback for the agent…"
          rows={3}
          className="resize-none"
        />
        <Button
          className="mt-2 w-full"
          size="sm"
          disabled={!message.trim() || mutating}
        >
          <IconSend className="size-4" />
          {mutating ? "Saving…" : "Add comment"}
        </Button>
      </form>
    </aside>
  );
}

function CommentThread({
  comment,
  replies,
  mutating,
  onAdd,
  onDelete,
  onUpdate,
  readOnly,
}: {
  comment: PlanComment;
  replies: PlanComment[];
  mutating: boolean;
  onAdd: (message: string, parentCommentId?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onUpdate: (
    id: string,
    patch: Partial<Pick<PlanComment, "message" | "status">>,
  ) => Promise<void>;
  readOnly?: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState("");
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const items = [comment, ...replies];

  const startEdit = (item: PlanComment) => {
    setEditingId(item.id);
    setEditMessage(item.message);
  };

  return (
    <article className="border-b border-border pb-4 last:border-0">
      <div className="space-y-3">
        {items.map((item, index) => (
          <div
            key={item.id}
            className={cn(index > 0 && "ml-4 border-l border-border pl-3")}
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {item.authorName || "You"}
              </span>
              <span>{item.status === "resolved" ? "Resolved" : "Open"}</span>
            </div>
            {editingId === item.id ? (
              <form
                className="mt-2"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const next = editMessage.trim();
                  if (!next || mutating) return;
                  await onUpdate(item.id, { message: next });
                  setEditingId(null);
                }}
              >
                <Textarea
                  aria-label="Edit comment"
                  value={editMessage}
                  onChange={(event) => setEditMessage(event.target.value)}
                  rows={2}
                  className="resize-none"
                />
                <div className="mt-2 flex gap-2">
                  <Button size="sm" disabled={!editMessage.trim() || mutating}>
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                {item.message}
              </p>
            )}
            {editingId !== item.id && (
              <div className="mt-2 flex flex-wrap gap-1">
                {index === 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={mutating}
                    onClick={() => setReplying((value) => !value)}
                  >
                    Reply
                  </Button>
                )}
                {!readOnly && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Edit comment"
                    disabled={mutating}
                    onClick={() => startEdit(item)}
                  >
                    <IconEdit className="size-3.5" />
                  </Button>
                )}
                {!readOnly && index === 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title={
                      item.status === "resolved"
                        ? "Reopen comment"
                        : "Resolve comment"
                    }
                    disabled={mutating}
                    onClick={() =>
                      void onUpdate(item.id, {
                        status:
                          item.status === "resolved" ? "open" : "resolved",
                      })
                    }
                  >
                    {item.status === "resolved" ? (
                      <IconRotateClockwise className="size-3.5" />
                    ) : (
                      <IconCheck className="size-3.5" />
                    )}
                  </Button>
                )}
                {!readOnly && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Delete comment"
                        disabled={mutating}
                      >
                        <IconTrash className="size-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          Delete this comment?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {index === 0 && replies.length > 0
                            ? "This permanently removes the comment and its replies from comments.json."
                            : "This permanently removes the comment from comments.json."}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => void onDelete(item.id)}
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {replying && (
        <form
          className="mt-3 ml-4 border-l border-border pl-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const next = reply.trim();
            if (!next || mutating) return;
            await onAdd(next, comment.id);
            setReply("");
            setReplying(false);
          }}
        >
          <Textarea
            aria-label="Reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={2}
            className="resize-none"
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={!reply.trim() || mutating}>
              <IconSend className="size-3.5" /> Reply
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setReplying(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}

export function LocalPlanEditor({ sessionId }: { sessionId: string }) {
  const tailnetViewer =
    typeof window !== "undefined" &&
    window.location.hostname.endsWith(".ts.net");
  const [session, setSession] = useState<LocalSession | null>(null);
  const [content, setContent] = useState<PlanContent | null>(null);
  const [comments, setComments] = useState<PlanComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsMutating, setCommentsMutating] = useState(false);
  const [sendingToAgent, setSendingToAgent] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const saveTimer = useRef<number | null>(null);
  const savePromise = useRef<Promise<void> | null>(null);
  const pendingSave = useRef(false);
  const forcePendingSave = useRef(false);
  const contentRef = useRef<PlanContent | null>(null);
  const sessionRef = useRef<LocalSession | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadSession(sessionId);
      const nextContent = next.bundle.plan.content;
      if (!nextContent)
        throw new Error("The local daemon returned no content.");
      setSession(next);
      sessionRef.current = next;
      setContent(nextContent);
      contentRef.current = nextContent;
      setComments(next.comments);
      setSaveState("idle");
      setConflict(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load this plan.",
      );
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => void refresh(), [refresh]);

  const persist = useCallback(
    async (ignoreConflict = false) => {
      if (savePromise.current) {
        pendingSave.current = true;
        forcePendingSave.current ||= ignoreConflict;
        return savePromise.current;
      }
      const current = contentRef.current;
      const activeSession = sessionRef.current;
      if (!current || !activeSession || (conflict && !ignoreConflict)) return;
      const savingContent = current;
      setSaveState("saving");
      const operation = (async () => {
        try {
          const serialized = await serializeLocalPlan({
            data: {
              sessionId,
              content: savingContent,
              files: activeSession.files,
            },
          });
          const names = Object.keys(serialized).filter(
            (name): name is PlanFilename =>
              serialized[name as PlanFilename] !== undefined,
          );
          for (const name of ["canvas.mdx", "prototype.mdx"] as const) {
            if (
              activeSession.files[name] !== undefined &&
              serialized[name] === undefined
            ) {
              throw new Error(
                `${name} cannot be removed through the local editor yet. Reload to keep the source file intact.`,
              );
            }
          }
          let revisions = { ...activeSession.revisions };
          try {
            const saved = await saveFiles(
              sessionId,
              Object.fromEntries(
                names.map((name) => [
                  name,
                  {
                    content: serialized[name] as string,
                    revision: revisions[name] ?? null,
                  },
                ]),
              ),
            );
            revisions = { ...revisions, ...saved };
          } catch (cause) {
            if (cause instanceof LocalApiError && cause.status === 409) {
              const details = conflictDetails(cause, names);
              if (details) setConflict({ message: cause.message, ...details });
            }
            throw cause;
          }
          const nextSession = { ...activeSession, revisions };
          setSession(nextSession);
          sessionRef.current = nextSession;
          setSaveState(
            contentRef.current === savingContent ? "saved" : "dirty",
          );
        } catch (cause) {
          setSaveState("error");
          toast.error(
            cause instanceof Error
              ? cause.message
              : "Could not save this plan.",
          );
        } finally {
          savePromise.current = null;
          if (pendingSave.current) {
            pendingSave.current = false;
            const force = forcePendingSave.current;
            forcePendingSave.current = false;
            void persist(force);
          }
        }
      })();
      savePromise.current = operation;
      return operation;
    },
    [conflict, sessionId],
  );

  const scheduleSave = useCallback(
    (next: PlanContent) => {
      contentRef.current = next;
      setContent(next);
      setSaveState("dirty");
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        void persist();
      }, 700);
    },
    [persist],
  );

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const onPatch = (patch: PlanContentPatch) => {
    const current = contentRef.current;
    if (!current) return;
    try {
      scheduleSave(applyContentPatch(current, patch));
    } catch (cause) {
      setSaveState("error");
      toast.error(
        cause instanceof Error ? cause.message : "Could not apply edit.",
      );
    }
  };

  const setCommentState = (nextComments: PlanComment[], revision: string) => {
    setComments(nextComments);
    const active = sessionRef.current;
    if (!active) return;
    const next = {
      ...active,
      comments: nextComments,
      revisions: { ...active.revisions, "comments.json": revision },
    };
    setSession(next);
    sessionRef.current = next;
  };

  const submitComment = async (message: string, parentCommentId?: string) => {
    if (commentsMutating) return;
    setCommentsMutating(true);
    try {
      const saved = await addComment(sessionId, message, parentCommentId);
      setCommentState(saved.comments, saved.revision);
      toast.success(
        parentCommentId ? "Reply saved locally" : "Comment saved locally",
      );
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Could not save comment.",
      );
    } finally {
      setCommentsMutating(false);
    }
  };

  const persistComments = async (nextComments: PlanComment[]) => {
    if (commentsMutating) return;
    setCommentsMutating(true);
    try {
      const saved = await saveComments(
        sessionId,
        nextComments,
        sessionRef.current?.revisions["comments.json"] ?? null,
      );
      setCommentState(saved.comments, saved.revision);
      toast.success("Comments updated locally");
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Could not update comments.",
      );
    } finally {
      setCommentsMutating(false);
    }
  };

  const updateComment = async (
    id: string,
    patch: Partial<Pick<PlanComment, "message" | "status">>,
  ) => persistComments(updateLocalComment(comments, id, patch));

  const deleteComment = async (id: string) =>
    persistComments(deleteLocalComment(comments, id));

  const dispatchToAgent = async () => {
    if (sendingToAgent) return;
    setSendingToAgent(true);
    try {
      const { harness, threadId, url } = await sendPlanToAgent(sessionId);
      toast.success(`Sent to ${harness} task ${threadId}`);
      if (url) window.location.href = url;
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Could not send to agent.",
      );
    } finally {
      setSendingToAgent(false);
    }
  };

  const publishToTailnet = async () => {
    if (publishing) return;
    setPublishing(true);
    try {
      const { url } = await publishPlanToTailnet(sessionId);
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Tailnet URL copied");
      } catch {
        toast.success(`Published to ${url}`);
      }
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Could not publish plan.",
      );
    } finally {
      setPublishing(false);
    }
  };

  const acceptConflictRevision = () => {
    const active = sessionRef.current;
    if (!active || !conflict) return;
    const revisions = { ...active.revisions };
    if (conflict.revision === null) delete revisions[conflict.file];
    else revisions[conflict.file] = conflict.revision;
    const next = {
      ...active,
      revisions,
    };
    setSession(next);
    sessionRef.current = next;
    const conflictFile = conflict.file;
    setConflict(null);
    setSaveState("dirty");
    toast.warning(
      `${conflictFile} disk revision accepted. Saving your version.`,
    );
    window.setTimeout(() => void persist(true), 0);
  };

  const copyUnsaved = async () => {
    if (!contentRef.current) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(contentRef.current, null, 2),
      );
      toast.success("Unsaved plan JSON copied");
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Could not copy unsaved plan JSON.",
      );
    }
  };

  const title = content?.title || session?.bundle.plan.title || "Local plan";
  const statusTone =
    saveState === "error"
      ? "text-destructive"
      : saveState === "saved"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-muted-foreground";

  if (loading && !content) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <p className="animate-pulse text-sm text-muted-foreground">
          Opening local plan…
        </p>
      </main>
    );
  }

  if (error || !content || !session) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <div className="max-w-md text-center">
          <IconAlertTriangle className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 text-xl font-semibold">
            Could not open this plan
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {error}
          </p>
          <Button className="mt-5" onClick={() => void refresh()}>
            <IconRefresh className="size-4" /> Retry
          </Button>
        </div>
      </main>
    );
  }

  return (
    <div className="local-plan-shell flex h-screen min-h-0 flex-col text-foreground">
      <header className="local-plan-toolbar z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className={cn("flex items-center gap-1 text-xs", statusTone)}>
            {saveState === "saved" && <IconCheck className="size-3" />}
            {statusLabel(saveState)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {!tailnetViewer && (
            <Button
              variant="ghost"
              size="sm"
              disabled={publishing}
              onClick={() => void publishToTailnet()}
            >
              <IconNetwork className="size-4" />
              {publishing ? "Publishing…" : "Publish to tailnet"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            title="Reload from disk"
            onClick={() => void refresh()}
          >
            <IconRefresh className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Toggle theme"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            {resolvedTheme === "dark" ? (
              <IconSun className="size-4" />
            ) : (
              <IconMoon className="size-4" />
            )}
          </Button>
          <Button
            variant={commentsOpen ? "secondary" : "ghost"}
            size="sm"
            className="lg:hidden"
            onClick={() => setCommentsOpen((open) => !open)}
          >
            <IconMessageCircle className="size-4" /> {comments.length}
          </Button>
        </div>
      </header>

      {conflict && (
        <section className="z-20 flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <IconAlertTriangle className="size-5 shrink-0" />
          <div className="min-w-[16rem] flex-1">
            <p className="text-sm font-semibold">The plan changed on disk</p>
            <p className="text-xs opacity-80">
              Your unsaved editor content is preserved. Reload to use disk
              content, or explicitly accept its revision before overwriting it.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyUnsaved()}
          >
            <IconCopy className="size-4" /> Copy mine
          </Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Reload disk
          </Button>
          <Button size="sm" onClick={acceptConflictRevision}>
            Keep mine
          </Button>
        </section>
      )}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto">
          <PlanContentRenderer
            key={session.id}
            content={content}
            fallbackTitle={title}
            fallbackBrief={content.brief || session.bundle.plan.brief || ""}
            onContentChange={tailnetViewer ? undefined : scheduleSave}
            onContentPatch={tailnetViewer ? undefined : onPatch}
            onMetadataChange={
              tailnetViewer
                ? undefined
                : (patch) =>
                    scheduleSave({
                      ...contentRef.current!,
                      title: patch.title ?? contentRef.current!.title,
                      brief: patch.brief ?? contentRef.current!.brief,
                    })
            }
            onCanvasViewportChange={
              tailnetViewer
                ? undefined
                : (viewport) => {
                    const current = contentRef.current;
                    if (!current?.canvas) return;
                    scheduleSave({
                      ...current,
                      canvas: { ...current.canvas, viewport },
                    });
                  }
            }
            contentUpdatedAt={session.bundle.plan.updatedAt}
            planId={session.id}
            localOnly
          />
        </main>
        <CommentRail
          className="max-lg:hidden"
          comments={comments}
          mutating={commentsMutating}
          onAdd={submitComment}
          onDelete={tailnetViewer ? async () => undefined : deleteComment}
          onSendToAgent={
            tailnetViewer ? async () => undefined : dispatchToAgent
          }
          onUpdate={tailnetViewer ? async () => undefined : updateComment}
          sendingToAgent={sendingToAgent}
          readOnly={tailnetViewer}
        />
      </div>

      {commentsOpen && (
        <div className="fixed inset-x-0 bottom-0 z-40 h-[70dvh] border-t border-border bg-background shadow-2xl lg:hidden">
          <div className="flex h-12 items-center border-b border-border px-4">
            <span className="text-sm font-medium">Comments</span>
            <Button
              className="ml-auto"
              variant="ghost"
              size="sm"
              onClick={() => setCommentsOpen(false)}
            >
              Close
            </Button>
          </div>
          <CommentRail
            className="h-[calc(70dvh-3rem)] w-full border-l-0"
            comments={comments}
            mutating={commentsMutating}
            onAdd={submitComment}
            onDelete={tailnetViewer ? async () => undefined : deleteComment}
            onSendToAgent={
              tailnetViewer ? async () => undefined : dispatchToAgent
            }
            onUpdate={tailnetViewer ? async () => undefined : updateComment}
            sendingToAgent={sendingToAgent}
            readOnly={tailnetViewer}
          />
        </div>
      )}
    </div>
  );
}
