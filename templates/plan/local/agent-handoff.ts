import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PlanHarness } from "../shared/plan-harness.js";
import { sendToCodexAgent } from "./codex-agent.js";

const START_TIMEOUT_MS = 15_000;

export type AgentHandoff = {
  harness: PlanHarness;
  threadId: string;
  url?: string;
};

type Run = (
  command: string,
  args: string[],
  options: { cwd: string; removeEnv?: string[] },
) => Promise<string>;

const run: Run = async (command, args, options) =>
  new Promise((resolve, reject) => {
    const environment = { ...process.env };
    for (const name of options.removeEnv ?? []) delete environment[name];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(
              stderr.trim() || `${command} exited with status ${code}.`,
            ),
          ),
    );
  });

export type StartOpenCode = (input: {
  root: string;
  prompt: string;
}) => Promise<string>;

function openCodeSessionId(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.sessionID === "string" && event.sessionID) {
        return event.sessionID;
      }
    } catch {
      // Ignore non-JSON launcher output.
    }
  }
}

export const startOpenCode = async (
  { root, prompt }: Parameters<StartOpenCode>[0],
  launch: typeof spawn = spawn,
): Promise<string> => {
  const outputPath = path.join(
    os.tmpdir(),
    `agent-native-opencode-${randomUUID()}.log`,
  );
  const output = await fs.open(outputPath, "w", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = launch(
      "opencode",
      [
        "run",
        "--auto",
        "--format",
        "json",
        "--title",
        "Local visual plan feedback",
        "--dir",
        root,
        prompt,
      ],
      { cwd: root, detached: true, stdio: ["ignore", output.fd, output.fd] },
    );
  } catch (error) {
    await output.close().catch(() => undefined);
    await fs.rm(outputPath, { force: true });
    throw error;
  }

  const started = new Promise<string>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    let pollTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (pollTimer) clearTimeout(pollTimer);
      child.removeListener("error", onError);
      void fs.unlink(outputPath).catch(() => undefined);
    };
    const finish = (error?: Error, sessionId?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(sessionId!);
    };
    const stopProcessGroup = () => {
      try {
        if (!child.pid) throw new Error("OpenCode process has no pid.");
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const poll = async () => {
      if (settled) return;
      try {
        const sessionId = openCodeSessionId(
          await fs.readFile(outputPath, "utf8"),
        );
        if (sessionId) return finish(undefined, sessionId);
      } catch (error) {
        return finish(error as Error);
      }
      if (child.exitCode !== null) {
        return finish(
          new Error(`OpenCode exited with status ${child.exitCode}.`),
        );
      }
      if (Date.now() - startedAt >= START_TIMEOUT_MS) {
        stopProcessGroup();
        return finish(new Error("OpenCode task startup timed out."));
      }
      pollTimer = setTimeout(() => void poll(), 50);
    };
    const onError = (error: Error) => finish(error);
    child.once("error", onError);
    void poll();
  });
  child.unref();
  await output.close().catch(() => undefined);
  return started;
};

export async function sendToAgentHarness(
  input: { harness: PlanHarness; root: string; prompt: string },
  execute: Run = run,
  launchOpenCode: StartOpenCode = startOpenCode,
): Promise<AgentHandoff> {
  if (input.harness === "codex") return sendToCodexAgent(input);
  if (input.harness === "claude-code") {
    const output = await execute(
      "claude",
      ["--background", "--permission-mode", "acceptEdits", input.prompt],
      {
        cwd: input.root,
        removeEnv: [
          "CLAUDECODE",
          "CLAUDE_CODE_SESSION",
          "CLAUDE_CODE_SESSION_ID",
        ],
      },
    );
    const threadId = output.match(/backgrounded\s+·\s+([A-Za-z0-9_-]+)/)?.[1];
    if (!threadId) {
      throw new Error("Claude Code response omitted the task id.");
    }
    return { harness: input.harness, threadId };
  }
  const session = await launchOpenCode(input);
  if (!session) {
    throw new Error("OpenCode response omitted the task id.");
  }
  return { harness: input.harness, threadId: session };
}
