import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  buildAgentPrompt,
  createCodexAgentClient,
  sendToCodexAgent,
  type CodexAgentClient,
} from "./codex-agent.js";

describe("local Codex agent handoff", () => {
  it("closes the app-server after the submitted turn completes", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const client = createCodexAgentClient(
      child as unknown as Parameters<typeof createCodexAgentClient>[0],
    );

    client.closeAfterTurn("thread-1", "turn-1");
    child.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("closes when completion arrives before the turn is registered", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const client = createCodexAgentClient(
      child as unknown as Parameters<typeof createCodexAgentClient>[0],
    );

    child.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.closeAfterTurn("thread-1", "turn-1");

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("starts a persisted workspace task and submits the plan feedback prompt", async () => {
    const request = vi
      .fn<CodexAgentClient["request"]>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ thread: { id: "thread-local-plan" } })
      .mockResolvedValueOnce({ turn: { id: "turn-local-plan" } });
    const close = vi.fn();
    const closeAfterTurn = vi.fn();
    const notify = vi.fn();

    await expect(
      sendToCodexAgent(
        { root: "/tmp/local-plan", prompt: "Apply local feedback." },
        () => ({ request, notify, closeAfterTurn, close }),
      ),
    ).resolves.toEqual({
      harness: "codex",
      threadId: "thread-local-plan",
      url: "codex://threads/thread-local-plan",
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "initialize",
      expect.any(Object),
    );
    expect(notify).toHaveBeenCalledWith("initialized");
    expect(request).toHaveBeenNthCalledWith(2, "thread/start", {
      cwd: "/tmp/local-plan",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
    });
    expect(request).toHaveBeenNthCalledWith(3, "turn/start", {
      threadId: "thread-local-plan",
      input: [{ type: "text", text: "Apply local feedback." }],
    });
    expect(close).not.toHaveBeenCalled();
    expect(closeAfterTurn).toHaveBeenCalledWith(
      "thread-local-plan",
      "turn-local-plan",
    );
  });

  it("builds a bounded prompt that tells Codex to use local source and feedback", () => {
    expect(buildAgentPrompt({ title: "Checkout flow", commentCount: 2 })).toBe(
      'Apply the 2 open comments on the local visual plan "Checkout flow". Read plan.mdx and comments.json in this working directory, apply the actionable agent feedback to the local plan files, preserve unrelated content, and verify the updated plan before reporting what changed.',
    );
  });

  it("closes the app-server when Codex omits the task id", async () => {
    const close = vi.fn();
    const closeAfterTurn = vi.fn();
    const notify = vi.fn();
    const request = vi
      .fn<CodexAgentClient["request"]>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ thread: {} });

    await expect(
      sendToCodexAgent(
        { root: "/tmp/local-plan", prompt: "Apply local feedback." },
        () => ({ request, notify, closeAfterTurn, close }),
      ),
    ).rejects.toThrow("omitted the task id");
    expect(close).toHaveBeenCalledOnce();
  });
});
