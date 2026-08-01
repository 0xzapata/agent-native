import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconMessageCircle,
  IconMoon,
  IconRefresh,
  IconSend,
  IconSun,
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

import type {
  PlanContent,
  PlanContentPatch,
} from "@shared/plan-content";
import type { PlanComment } from "@shared/types";
import { PlanContentRenderer } from "@/components/plan/PlanContentRenderer";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  LocalApiError,
  addComment,
  applyContentPatch,
  loadSession,
  saveFiles,
  type LocalSession,
  type PlanFilename,
} from "../lib/local-api";
import { serializeLocalPlan } from "../lib/plan-source";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

type Conflict = {
  message: string;
  file: PlanFilename;
  revision: string;
};

function conflictRevision(error: LocalApiError): string {
  if (!error.payload || typeof error.payload !== "object") return "";
  const payload = error.payload as Record<string, unknown>;
  const current =
    payload.current && typeof payload.current === "object"
      ? (payload.current as Record<string, unknown>)
      : {};
  return typeof current.revision === "string" ? current.revision : "";
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
  onSubmit,
}: {
  comments: PlanComment[];
  onSubmit: (message: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = message.trim();
    if (!next || sending) return;
    setSending(true);
    try {
      await onSubmit(next);
      setMessage("");
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="flex min-h-0 w-[22rem] shrink-0 flex-col border-l border-border bg-background max-lg:hidden">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <IconMessageCircle className="size-4" />
        <h2 className="text-sm font-medium">Comments</h2>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {comments.length}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-4">
          {comments.length === 0 ? (
            <p className="py-8 text-center text-sm leading-6 text-muted-foreground">
              Leave a note for the coding agent. Feedback stays in
              <code className="mx-1">comments.json</code>.
            </p>
          ) : (
            comments.map((comment) => (
              <article key={comment.id} className="border-b border-border pb-4 last:border-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {comment.authorName || "You"}
                  </span>
                  <span>{comment.status === "resolved" ? "Resolved" : "Open"}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                  {comment.message}
                </p>
              </article>
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
        <Button className="mt-2 w-full" size="sm" disabled={!message.trim() || sending}>
          <IconSend className="size-4" />
          {sending ? "Saving…" : "Add comment"}
        </Button>
      </form>
    </aside>
  );
}

export function LocalPlanEditor({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [content, setContent] = useState<PlanContent | null>(null);
  const [comments, setComments] = useState<PlanComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const saveTimer = useRef<number | null>(null);
  const savePromise = useRef<Promise<void> | null>(null);
  const pendingSave = useRef(false);
  const contentRef = useRef<PlanContent | null>(null);
  const sessionRef = useRef<LocalSession | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadSession(sessionId);
      const nextContent = next.bundle.plan.content;
      if (!nextContent) throw new Error("The local daemon returned no content.");
      setSession(next);
      sessionRef.current = next;
      setContent(nextContent);
      contentRef.current = nextContent;
      setComments(next.comments);
      setSaveState("idle");
      setConflict(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this plan.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => void refresh(), [refresh]);

  const persist = useCallback(async () => {
    if (savePromise.current) {
      pendingSave.current = true;
      return savePromise.current;
    }
    const current = contentRef.current;
    const activeSession = sessionRef.current;
    if (!current || !activeSession || conflict) return;
    const savingContent = current;
    setSaveState("saving");
    const operation = (async () => {
      try {
        const serialized = await serializeLocalPlan({
          data: { sessionId, content: savingContent, files: activeSession.files },
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
            Object.fromEntries(names.map((name) => [name, {
              content: serialized[name] as string,
              revision: revisions[name] ?? null,
            }])),
          );
          revisions = { ...revisions, ...saved };
        } catch (cause) {
          if (cause instanceof LocalApiError && cause.status === 409) {
            const file = names.find((name) => conflictRevision(cause)) ?? names[0];
            setConflict({ message: cause.message, file, revision: conflictRevision(cause) });
          }
          throw cause;
        }
        const nextSession = { ...activeSession, revisions };
        setSession(nextSession);
        sessionRef.current = nextSession;
        setSaveState(contentRef.current === savingContent ? "saved" : "dirty");
      } catch (cause) {
        setSaveState("error");
        toast.error(
          cause instanceof Error ? cause.message : "Could not save this plan.",
        );
      } finally {
        savePromise.current = null;
        if (pendingSave.current) {
          pendingSave.current = false;
          void persist();
        }
      }
    })();
    savePromise.current = operation;
    return operation;
  }, [conflict, sessionId]);

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
      toast.error(cause instanceof Error ? cause.message : "Could not apply edit.");
    }
  };

  const submitComment = async (message: string) => {
    try {
      const next = await addComment(sessionId, message);
      setComments((current) => [...current, next]);
      toast.success("Comment saved locally");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not save comment.");
      throw cause;
    }
  };

  const acceptConflictRevision = () => {
    const active = sessionRef.current;
    if (!active || !conflict) return;
    const next = {
      ...active,
      revisions: {
        ...active.revisions,
        [conflict.file]: conflict.revision,
      },
    };
    setSession(next);
    sessionRef.current = next;
    const conflictFile = conflict.file;
    setConflict(null);
    setSaveState("dirty");
    toast.warning(`${conflictFile} disk revision accepted. Saving your version.`);
    window.setTimeout(() => void persist(), 0);
  };

  const copyUnsaved = async () => {
    if (!contentRef.current) return;
    await navigator.clipboard.writeText(JSON.stringify(contentRef.current, null, 2));
    toast.success("Unsaved plan JSON copied");
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
        <p className="animate-pulse text-sm text-muted-foreground">Opening local plan…</p>
      </main>
    );
  }

  if (error || !content || !session) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <div className="max-w-md text-center">
          <IconAlertTriangle className="mx-auto size-8 text-destructive" />
          <h1 className="mt-4 text-xl font-semibold">Could not open this plan</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{error}</p>
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
          <Button variant="ghost" size="icon" title="Reload from disk" onClick={() => void refresh()}>
            <IconRefresh className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Toggle theme"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? <IconSun className="size-4" /> : <IconMoon className="size-4" />}
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
              Your unsaved editor content is preserved. Reload to use disk content, or explicitly accept its revision before overwriting it.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void copyUnsaved()}>
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
            onContentChange={scheduleSave}
            onContentPatch={onPatch}
            onMetadataChange={(patch) =>
              scheduleSave({
                ...contentRef.current!,
                title: patch.title ?? contentRef.current!.title,
                brief: patch.brief ?? contentRef.current!.brief,
              })
            }
            onCanvasViewportChange={(viewport) => {
              const current = contentRef.current;
              if (!current?.canvas) return;
              scheduleSave({
                ...current,
                canvas: { ...current.canvas, viewport },
              });
            }}
            contentUpdatedAt={session.bundle.plan.updatedAt}
            planId={session.id}
            localOnly
          />
        </main>
        <CommentRail comments={comments} onSubmit={submitComment} />
      </div>

      {commentsOpen && (
        <div className="fixed inset-x-0 bottom-0 z-40 h-[70dvh] border-t border-border bg-background shadow-2xl lg:hidden">
          <div className="flex h-12 items-center border-b border-border px-4">
            <span className="text-sm font-medium">Comments</span>
            <Button className="ml-auto" variant="ghost" size="sm" onClick={() => setCommentsOpen(false)}>
              Close
            </Button>
          </div>
          <CommentRail comments={comments} onSubmit={submitComment} />
        </div>
      )}
    </div>
  );
}
