import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_OUTPUT = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_COMPLETED_TURNS = 32;

type JsonRecord = Record<string, unknown>;

export type CodexAgentTask = {
  harness: "codex";
  threadId: string;
  url: string;
};

export type CodexAgentClient = {
  request(method: string, params?: JsonRecord): Promise<unknown>;
  notify(method: string, params?: JsonRecord): void;
  closeAfterTurn(threadId: string, turnId: string): void;
  close(): void;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

export function createCodexAgentClient(
  child: ChildProcessWithoutNullStreams = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  }),
): CodexAgentClient {
  let nextId = 1;
  let output = "";
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let turnToClose: { threadId: string; turnId: string } | null = null;
  let turnTimer: NodeJS.Timeout | null = null;
  let stderr = "";
  const completedTurns = new Set<string>();

  const turnKey = (threadId: string, turnId: string) =>
    `${threadId}\0${turnId}`;
  const write = (message: JsonRecord) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    rejectPending(new Error("Codex app-server exited."));
    child.kill();
  };
  const fail = (message: string) => {
    if (closed) return;
    closed = true;
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    rejectPending(
      new Error(stderr.trim() ? `${message} ${stderr.trim()}` : message),
    );
    child.kill();
  };
  const handleLine = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const payload = record(message);
    if (typeof payload.id !== "number") {
      if (payload.method !== "turn/completed") return;
      const params = record(payload.params);
      const turn = record(params.turn);
      if (typeof params.threadId === "string" && typeof turn.id === "string") {
        completedTurns.add(turnKey(params.threadId, turn.id));
        if (completedTurns.size > MAX_COMPLETED_TURNS) {
          completedTurns.delete(completedTurns.values().next().value!);
        }
      }
      if (!turnToClose) return;
      if (
        params.threadId === turnToClose.threadId &&
        turn.id === turnToClose.turnId
      ) {
        close();
      }
      return;
    }
    const request = pending.get(payload.id);
    if (!request) return;
    pending.delete(payload.id);
    clearTimeout(request.timer);
    if (payload.error) {
      const remote = record(payload.error);
      request.reject(
        new Error(
          typeof remote.message === "string"
            ? remote.message
            : "Codex rejected the request.",
        ),
      );
      return;
    }
    request.resolve(payload.result);
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (closed) return;
    output += chunk.toString();
    if (output.length > MAX_OUTPUT) {
      fail("Codex app-server output exceeded its safety limit.");
      return;
    }
    const lines = output.split(/\r?\n/);
    output = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handleLine(line);
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8 * 1024);
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) =>
    fail(
      error.code === "EPIPE"
        ? "Codex app-server could not accept the request."
        : "Codex app-server input failed.",
    ),
  );
  child.once("error", () => fail("Codex CLI could not be started."));
  child.once("exit", () => fail("Codex app-server exited."));

  return {
    request(method, params = {}) {
      if (closed) return Promise.reject(new Error("Codex app-server exited."));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Codex app-server request timed out."));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          (error) => {
            if (!error) return;
            clearTimeout(timer);
            pending.delete(id);
            reject(new Error("Codex app-server could not accept the request."));
          },
        );
      });
    },
    notify(method, params = {}) {
      if (!closed) write({ jsonrpc: "2.0", method, params });
    },
    closeAfterTurn(threadId, turnId) {
      if (turnTimer) clearTimeout(turnTimer);
      turnTimer = null;
      turnToClose = { threadId, turnId };
      const key = turnKey(threadId, turnId);
      if (completedTurns.delete(key)) {
        close();
        return;
      }
      turnTimer = setTimeout(close, TURN_TIMEOUT_MS);
      turnTimer.unref();
    },
    close,
  };
}

export function buildAgentPrompt(input: {
  title: string;
  commentCount: number;
}): string {
  return [
    `Apply the ${input.commentCount} open comment${input.commentCount === 1 ? "" : "s"} on the local visual plan \"${input.title}\".`,
    "Read plan.mdx and comments.json in this working directory, apply the actionable agent feedback to the local plan files, preserve unrelated content, and verify the updated plan before reporting what changed.",
  ].join(" ");
}

export async function sendToCodexAgent(
  input: { root: string; prompt: string },
  createClient: () => CodexAgentClient = () => createCodexAgentClient(),
): Promise<CodexAgentTask> {
  const client = createClient();
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "agent-native-plan-local",
        title: "Agent-Native Plan Local",
        version: "1",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: ["thread/started", "thread/status/changed"],
      },
    });
    client.notify("initialized");
    const started = record(
      await client.request("thread/start", {
        cwd: input.root,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: false,
      }),
    );
    const thread = record(started.thread);
    if (typeof thread.id !== "string" || !thread.id) {
      throw new Error("Codex thread response omitted the task id.");
    }
    const turnStarted = record(
      await client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: input.prompt }],
      }),
    );
    const turn = record(turnStarted.turn);
    if (typeof turn.id !== "string" || !turn.id) {
      throw new Error("Codex turn response omitted the turn id.");
    }
    client.closeAfterTurn(thread.id, turn.id);
    return {
      harness: "codex",
      threadId: thread.id,
      url: `codex://threads/${encodeURIComponent(thread.id)}`,
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
