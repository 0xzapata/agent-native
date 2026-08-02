import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendToAgentHarness, startOpenCode } from "./agent-handoff.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local agent harness handoff", () => {
  it("creates a persistent Claude Code session", async () => {
    const run = vi.fn().mockResolvedValue("backgrounded · claude-task\n");
    await expect(
      sendToAgentHarness(
        { harness: "claude-code", root: "/tmp/plan", prompt: "Apply it." },
        run,
      ),
    ).resolves.toEqual({ harness: "claude-code", threadId: "claude-task" });
    expect(run).toHaveBeenCalledWith(
      "claude",
      ["--background", "--permission-mode", "acceptEdits", "Apply it."],
      {
        cwd: "/tmp/plan",
        removeEnv: [
          "CLAUDECODE",
          "CLAUDE_CODE_SESSION",
          "CLAUDE_CODE_SESSION_ID",
        ],
      },
    );
  });

  it("creates a persistent OpenCode session", async () => {
    const launch = vi.fn().mockResolvedValue("opencode-task");
    await expect(
      sendToAgentHarness(
        { harness: "opencode", root: "/tmp/plan", prompt: "Apply it." },
        vi.fn(),
        launch,
      ),
    ).resolves.toEqual({ harness: "opencode", threadId: "opencode-task" });
    expect(launch).toHaveBeenCalledWith({
      harness: "opencode",
      root: "/tmp/plan",
      prompt: "Apply it.",
    });
  });

  it("launches OpenCode with detached file output and returns its session id", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null as number | null,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    const spawn = vi.fn().mockReturnValue(child);
    vi.spyOn(fs, "readFile").mockResolvedValue(
      `${JSON.stringify({ sessionID: "opencode-live-task" })}\n`,
    );
    vi.spyOn(fs, "unlink").mockResolvedValue();

    await expect(
      startOpenCode({ root: "/tmp/plan", prompt: "Apply it." }, spawn as never),
    ).resolves.toBe("opencode-live-task");
    expect(spawn).toHaveBeenCalledWith(
      "opencode",
      expect.arrayContaining(["run", "--auto", "--format", "json"]),
      expect.objectContaining({
        cwd: "/tmp/plan",
        detached: true,
        stdio: ["ignore", expect.any(Number), expect.any(Number)],
      }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects when OpenCode exits before reporting a session id", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: 7,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    vi.spyOn(fs, "open").mockResolvedValue({
      fd: 1,
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.spyOn(fs, "readFile").mockResolvedValue("");
    vi.spyOn(fs, "unlink").mockResolvedValue();

    await expect(
      startOpenCode(
        { root: "/tmp/plan", prompt: "Apply it." },
        vi.fn().mockReturnValue(child) as never,
      ),
    ).rejects.toThrow("OpenCode exited with status 7.");
  });

  it("rejects an OpenCode launch error", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null as number | null,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    vi.spyOn(fs, "open").mockResolvedValue({
      fd: 1,
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.spyOn(fs, "readFile").mockResolvedValue("");
    vi.spyOn(fs, "unlink").mockResolvedValue();
    const started = startOpenCode(
      { root: "/tmp/plan", prompt: "Apply it." },
      vi.fn().mockReturnValue(child) as never,
    );
    await vi.waitFor(() => expect(child.listenerCount("error")).toBe(1));

    child.emit("error", new Error("OpenCode unavailable"));

    await expect(started).rejects.toThrow("OpenCode unavailable");
  });

  it("terminates OpenCode when startup times out", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null as number | null,
      unref: vi.fn(),
      kill: vi.fn(),
    });
    vi.spyOn(fs, "open").mockResolvedValue({
      fd: 1,
      close: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.spyOn(fs, "readFile").mockResolvedValue("");
    vi.spyOn(fs, "unlink").mockResolvedValue();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const started = startOpenCode(
      { root: "/tmp/plan", prompt: "Apply it." },
      vi.fn().mockReturnValue(child) as never,
    );
    const result = expect(started).rejects.toThrow(
      "OpenCode task startup timed out.",
    );
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(15_000);

    await result;
    expect(process.kill).toHaveBeenCalledWith(-123, "SIGTERM");
  });

  it.each([
    ["claude-code", "Claude Code response omitted the task id."],
    ["opencode", "OpenCode response omitted the task id."],
  ] as const)(
    "fails loudly when %s omits its task id",
    async (harness, error) => {
      await expect(
        sendToAgentHarness(
          { harness, root: "/tmp/plan", prompt: "Apply it." },
          vi.fn().mockResolvedValue("backgrounded without an id"),
          vi.fn().mockResolvedValue(""),
        ),
      ).rejects.toThrow(error);
    },
  );
});
