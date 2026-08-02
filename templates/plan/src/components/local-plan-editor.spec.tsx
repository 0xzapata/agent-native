// @vitest-environment happy-dom

import type { PlanContent } from "@shared/plan-content";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalSession } from "../lib/local-api";

const localApi = vi.hoisted(() => ({
  addComment: vi.fn(),
  applyContentPatch: vi.fn(),
  loadSession: vi.fn(),
  publishPlanToTailnet: vi.fn(),
  saveComments: vi.fn(),
  saveFiles: vi.fn(),
  sendPlanToAgent: vi.fn(),
}));
const serializeLocalPlan = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("../lib/local-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/local-api")>()),
  ...localApi,
}));
vi.mock("../lib/plan-source", () => ({ serializeLocalPlan }));
vi.mock("@/components/plan/PlanContentRenderer", () => ({
  PlanContentRenderer: ({
    onContentChange,
  }: {
    onContentChange?: (content: PlanContent) => void;
  }) => (
    <button
      type="button"
      onClick={() => onContentChange?.({ ...CONTENT, title: "Edited plan" })}
    >
      Edit plan
    </button>
  ),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast }));

import { LocalApiError } from "../lib/local-api";
import { LocalPlanEditor } from "./local-plan-editor";

const CONTENT = {
  version: 2,
  title: "Local plan",
  brief: "Test plan",
  blocks: [],
} as unknown as PlanContent;
const SERIALIZED = {
  "plan.mdx": "edited plan",
  "canvas.mdx": "edited canvas",
  ".plan-state.json": "{}",
};

function session(): LocalSession {
  const now = "2026-08-01T00:00:00.000Z";
  return {
    id: "session-1",
    bundle: {
      plan: {
        id: "session-1",
        title: "Local plan",
        brief: "Test plan",
        kind: "plan",
        status: "draft",
        source: "imported",
        content: CONTENT,
        createdAt: now,
        updatedAt: now,
      },
      access: { role: "editor", visibility: "private" },
      sections: [],
      comments: [],
      events: [],
      summary: {
        sectionCounts: {},
        commentCount: 0,
        openCommentCount: 0,
      },
    },
    files: {
      "plan.mdx": "original plan",
      "canvas.mdx": "original canvas",
      ".plan-state.json": "{}",
    },
    revisions: {
      "plan.mdx": "plan-revision-1",
      "canvas.mdx": "canvas-revision-1",
      ".plan-state.json": "state-revision-1",
    },
    comments: [],
    metadata: {},
  };
}

let container: HTMLElement;
let root: Root;
let originalClipboard: PropertyDescriptor | undefined;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function button(label: string) {
  const match = Array.from(container.querySelectorAll("button")).find((item) =>
    item.textContent?.includes(label),
  );
  expect(match, `button containing ${label}`).toBeTruthy();
  return match!;
}

beforeEach(async () => {
  vi.useFakeTimers();
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  localApi.loadSession.mockResolvedValue(session());
  serializeLocalPlan.mockResolvedValue(SERIALIZED);
  localApi.saveFiles.mockResolvedValue({
    "plan.mdx": "plan-revision-2",
    "canvas.mdx": "canvas-revision-2",
    ".plan-state.json": "state-revision-2",
  });
  await act(async () => root.render(<LocalPlanEditor sessionId="session-1" />));
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("LocalPlanEditor", () => {
  it("uses the conflicting file revision when Keep mine retries the save", async () => {
    localApi.saveFiles
      .mockRejectedValueOnce(
        new LocalApiError("canvas changed", 409, {
          current: { revision: "canvas-server-revision" },
          revisions: { "canvas.mdx": "canvas-server-revision" },
        }),
      )
      .mockResolvedValueOnce({
        "plan.mdx": "plan-revision-2",
        "canvas.mdx": "canvas-revision-2",
        ".plan-state.json": "state-revision-2",
      });

    act(() => button("Edit plan").click());
    await act(async () => vi.advanceTimersByTimeAsync(700));

    expect(container.textContent).toContain("The plan changed on disk");
    act(() => button("Keep mine").click());
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(localApi.saveFiles).toHaveBeenCalledTimes(2);
    expect(localApi.saveFiles.mock.calls[1][1]).toMatchObject({
      "plan.mdx": { revision: "plan-revision-1" },
      "canvas.mdx": { revision: "canvas-server-revision" },
      ".plan-state.json": { revision: "state-revision-1" },
    });
    expect(container.textContent).toContain("Saved to disk");
    expect(container.textContent).not.toContain("The plan changed on disk");
  });

  it("retries with a null revision when the conflicting file was deleted", async () => {
    localApi.saveFiles
      .mockRejectedValueOnce(
        new LocalApiError("canvas deleted", 409, {
          current: { content: "", revision: "" },
          revisions: { "canvas.mdx": "" },
        }),
      )
      .mockResolvedValueOnce({ "canvas.mdx": "canvas-revision-2" });

    act(() => button("Edit plan").click());
    await act(async () => vi.advanceTimersByTimeAsync(700));
    act(() => button("Keep mine").click());
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(localApi.saveFiles.mock.calls[1][1]).toMatchObject({
      "canvas.mdx": { revision: null },
    });
  });

  it("reports clipboard rejection without an unhandled promise rejection", async () => {
    localApi.saveFiles.mockRejectedValueOnce(
      new LocalApiError("canvas changed", 409, {
        revisions: { "canvas.mdx": "canvas-server-revision" },
      }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("Clipboard denied")),
      },
    });
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    act(() => button("Edit plan").click());
    await act(async () => vi.advanceTimersByTimeAsync(700));
    act(() => button("Copy mine").click());
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Clipboard denied");
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("toasts API failures handled by void event callbacks", async () => {
    localApi.publishPlanToTailnet.mockRejectedValueOnce(
      new Error("Publish unavailable"),
    );
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    act(() => button("Publish to tailnet").click());
    await flush();

    expect(toast.error).toHaveBeenCalledWith("Publish unavailable");
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("keeps comment text when the daemon rejects the save", async () => {
    localApi.addComment.mockRejectedValueOnce(new Error("Comment unavailable"));
    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Add feedback for the agent…"]',
    );
    expect(textarea).toBeTruthy();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Keep this draft");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    await act(async () => button("Add comment").click());
    await flush();

    expect(localApi.addComment).toHaveBeenCalledWith(
      "session-1",
      "Keep this draft",
      undefined,
    );
    expect(textarea!.value).toBe("Keep this draft");
    expect(toast.error).toHaveBeenCalledWith("Comment unavailable");
  });
});
