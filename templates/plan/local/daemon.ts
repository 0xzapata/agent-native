import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlanHarness, type PlanHarness } from "../shared/plan-harness.js";
import type { PlanComment } from "../shared/types.js";
import { sendToAgentHarness } from "./agent-handoff.js";
import { buildAgentPrompt } from "./codex-agent.js";
import {
  canonicalPlanRoot,
  readAsset,
  readComments,
  readPlan,
  RevisionConflictError,
  saveComments,
  saveFile,
  saveFiles,
  validatePlanRoot,
  type PlanFile,
} from "./files.js";
import {
  ensureRuntimeDir,
  HOST,
  logPath,
  metadataPath,
  PORT,
  sessionsPath,
  writePrivateJson,
} from "./runtime.js";
import { publishPlanToTailnet } from "./tailscale-publish.js";

type SessionMap = Record<
  string,
  { root: string; registeredAt: string; harness?: PlanHarness }
>;

const localDir = path.dirname(fileURLToPath(import.meta.url));
const packagedRuntime = process.env.KARTELSH_VISUAL_PLAN_PACKAGED === "1";
const appDir = packagedRuntime ? localDir : path.dirname(localDir);
let tanstackFetchPromise: Promise<
  (request: Request) => Promise<Response>
> | null = null;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function errorJson(
  response: ServerResponse,
  status: number,
  error: unknown,
): void {
  json(response, status, {
    error: error instanceof Error ? error.message : String(error),
  });
}

async function body(
  request: IncomingMessage,
  limit = 20 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function rawBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function readSessions(): Promise<SessionMap> {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionsPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const sessions: SessionMap = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9_-]{32,64}$/.test(id)) continue;
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { root?: unknown }).root === "string" &&
        typeof (value as { registeredAt?: unknown }).registeredAt === "string"
      ) {
        sessions[id] = value as SessionMap[string];
      }
    }
    return sessions;
  } catch {
    return {};
  }
}

async function writeSessions(sessions: SessionMap): Promise<void> {
  await writePrivateJson(sessionsPath(), sessions);
}

function authorize(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function sessionRoot(sessions: SessionMap, id: string): string {
  const session = sessions[id];
  if (!session) throw new Error("Unknown plan session.");
  return session.root;
}

function assertLoopbackHost(request: IncomingMessage): void {
  const host = request.headers.host?.toLowerCase();
  if (
    host !== `${HOST}:${PORT}` &&
    host !== `localhost:${PORT}` &&
    !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net:8443$/.test(host ?? "")
  ) {
    throw new Error("Invalid Host header.");
  }
}

function isLoopbackHost(request: IncomingMessage): boolean {
  const host = request.headers.host?.toLowerCase();
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

export function isTailnetViewerRequest(
  request: IncomingMessage,
  segments: string[],
): boolean {
  if (isLoopbackHost(request)) return false;
  if (request.method === "GET" || request.method === "HEAD") return false;
  return !(
    request.method === "POST" &&
    segments[0] === "api" &&
    segments[1] === "sessions" &&
    segments[2] &&
    segments[3] === "comments" &&
    segments.length === 4
  );
}

function defaultComment(
  planId: string,
  input: Record<string, unknown>,
  remote: boolean,
): PlanComment {
  const now = new Date().toISOString();
  return {
    id:
      !remote && typeof input.id === "string" && input.id
        ? input.id
        : `cmt_${randomUUID().replaceAll("-", "")}`,
    planId,
    parentCommentId:
      typeof input.parentCommentId === "string" ? input.parentCommentId : null,
    sectionId: typeof input.sectionId === "string" ? input.sectionId : null,
    kind: input.kind === "comment" ? "comment" : "annotation",
    status: "open",
    anchor: typeof input.anchor === "string" ? input.anchor : null,
    message: typeof input.message === "string" ? input.message : "",
    createdBy: !remote && input.createdBy === "agent" ? "agent" : "human",
    authorEmail: null,
    authorName: typeof input.authorName === "string" ? input.authorName : null,
    resolutionTarget: input.resolutionTarget === "human" ? "human" : "agent",
    mentions: [],
    mentionsJson: null,
    resolvedBy: null,
    resolvedAt: null,
    consumedAt: null,
    deletedAt: null,
    deletedBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

function staticRoots(): string[] {
  return [
    path.join(appDir, ".output", "public"),
    path.join(appDir, "dist", "client"),
    path.join(appDir, "dist"),
  ];
}

async function existingStaticRoot(): Promise<string | null> {
  for (const root of staticRoots()) {
    try {
      if ((await fs.stat(path.join(root, "index.html"))).isFile()) return root;
    } catch {
      // Try the next known TanStack/Vite output directory.
    }
  }
  return null;
}

async function tanstackFetch(): Promise<
  (request: Request) => Promise<Response>
> {
  tanstackFetchPromise ??= import(
    path.join(
      appDir,
      "dist",
      "server",
      packagedRuntime ? "server.mjs" : "server.js",
    )
  ).then((module) => {
    const handler = (module.default as { fetch?: unknown })?.fetch;
    if (typeof handler !== "function")
      throw new Error("TanStack server build has no fetch handler.");
    return handler as (request: Request) => Promise<Response>;
  });
  return tanstackFetchPromise;
}

async function serveTanstack(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const handler = await tanstackFetch();
  const requestBody =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await rawBody(request);
  const webResponse = await handler(
    new Request(`http://${HOST}:${PORT}${request.url ?? "/"}`, {
      method: request.method,
      headers: request.headers as HeadersInit,
      body: requestBody,
    }),
  );
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of webResponse.headers.entries()) {
    headers[name] = value;
  }
  const cookies = webResponse.headers.getSetCookie?.();
  if (cookies?.length) headers["set-cookie"] = cookies;
  response.writeHead(webResponse.status, headers);
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

function staticContentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}

async function serveStatic(
  requestPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const root = await existingStaticRoot();
  const decoded = decodeURIComponent(requestPath);
  const clientAssetRoot = path.join(appDir, "dist", "client");
  if (
    !root &&
    (requestPath.startsWith("/assets/") || requestPath.startsWith("/fonts/"))
  ) {
    const asset = path.resolve(clientAssetRoot, `.${decoded}`);
    const relativeAsset = path.relative(clientAssetRoot, asset);
    if (!relativeAsset.startsWith("..") && !path.isAbsolute(relativeAsset)) {
      try {
        const bytes = await fs.readFile(asset);
        response.writeHead(200, {
          "content-type": staticContentType(asset),
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        response.end(bytes);
        return;
      } catch {
        // Let TanStack return its own 404 below.
      }
    }
  }
  if (!root) {
    try {
      await serveTanstack(request, response);
    } catch {
      errorJson(response, 503, "Editor build is missing. Run pnpm build.");
    }
    return;
  }
  const requested = path.resolve(root, `.${decoded}`);
  const relative = path.relative(root, requested);
  let target = requested;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    errorJson(response, 404, "Not found.");
    return;
  }
  try {
    if (!(await fs.stat(target)).isFile())
      target = path.join(root, "index.html");
  } catch {
    target = path.join(root, "index.html");
  }
  const bytes = await fs.readFile(target);
  response.writeHead(200, {
    "content-type": staticContentType(target),
    "cache-control": target.endsWith("index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

export async function startDaemon(options: {
  token: string;
  buildHash: string;
}): Promise<void> {
  await ensureRuntimeDir();
  let sessions = await readSessions();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    try {
      assertLoopbackHost(request);
      if (isTailnetViewerRequest(request, segments)) {
        return errorJson(
          response,
          403,
          "Tailnet viewers can read plans and add comments only.",
        );
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, {
          ok: true,
          pid: process.pid,
          buildHash: options.buildHash,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/register") {
        if (!authorize(request, options.token))
          return errorJson(response, 401, "Unauthorized.");
        const input = (await body(request)) as {
          root?: unknown;
          harness?: unknown;
        };
        if (typeof input.root !== "string")
          return errorJson(response, 400, "root is required.");
        const root = await canonicalPlanRoot(input.root);
        await validatePlanRoot(root);
        const existing = Object.entries(sessions).find(
          ([, session]) => session.root === root,
        )?.[0];
        const id = existing ?? randomBytes(24).toString("base64url");
        sessions[id] = {
          root,
          registeredAt: new Date().toISOString(),
          harness: parsePlanHarness(input.harness) ?? sessions[id]?.harness,
        };
        await writeSessions(sessions);
        json(response, 200, {
          sessionId: id,
          url: `http://${HOST}:${PORT}/plans/${id}`,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/shutdown") {
        if (!authorize(request, options.token))
          return errorJson(response, 401, "Unauthorized.");
        json(response, 200, { ok: true });
        server.close(() => process.exit(0));
        server.closeIdleConnections();
        setTimeout(() => process.exit(0), 2_000).unref();
        return;
      }
      if (segments[0] === "api" && segments[1] === "sessions" && segments[2]) {
        const id = segments[2];
        const root = await canonicalPlanRoot(sessionRoot(sessions, id));
        if (segments.length === 3 && request.method === "GET") {
          const snapshot = await readPlan(root, id);
          json(response, 200, {
            ...snapshot,
            metadata: {
              harness: snapshot.metadata.harness ?? sessions[id]?.harness,
            },
          });
          return;
        }
        if (
          segments[3] === "files" &&
          segments.length === 4 &&
          request.method === "PUT"
        ) {
          const input = (await body(request)) as { files?: unknown };
          if (!input.files || typeof input.files !== "object")
            return errorJson(response, 400, "files are required.");
          json(response, 200, {
            files: await saveFiles(
              root,
              input.files as Parameters<typeof saveFiles>[1],
            ),
          });
          return;
        }
        if (
          segments[3] === "files" &&
          segments[4] &&
          segments.length === 5 &&
          request.method === "PUT"
        ) {
          const file = segments[4] as PlanFile;
          const input = (await body(request)) as {
            content?: unknown;
            revision?: unknown;
          };
          if (
            typeof input.content !== "string" ||
            !(typeof input.revision === "string" || input.revision === null)
          ) {
            return errorJson(
              response,
              400,
              "content and revision are required.",
            );
          }
          json(
            response,
            200,
            await saveFile(root, file, input.content, input.revision),
          );
          return;
        }
        if (
          segments[3] === "comments" &&
          segments.length === 4 &&
          request.method === "GET"
        ) {
          json(response, 200, await readComments(root));
          return;
        }
        if (
          segments[3] === "comments" &&
          segments.length === 4 &&
          request.method === "PUT"
        ) {
          const input = (await body(request)) as {
            comments?: unknown;
            revision?: unknown;
          };
          if (
            !Array.isArray(input.comments) ||
            !(typeof input.revision === "string" || input.revision === null)
          ) {
            return errorJson(
              response,
              400,
              "comments and revision are required.",
            );
          }
          json(
            response,
            200,
            await saveComments(
              root,
              input.comments as PlanComment[],
              input.revision,
            ),
          );
          return;
        }
        if (
          segments[3] === "comments" &&
          segments.length === 4 &&
          request.method === "POST"
        ) {
          const input = (await body(request)) as Record<string, unknown>;
          const current = await readComments(root);
          const comment = defaultComment(id, input, !isLoopbackHost(request));
          if (!comment.message.trim())
            return errorJson(response, 400, "message is required.");
          const saved = await saveComments(
            root,
            [...current.comments, comment],
            current.revision,
          );
          json(response, 201, {
            comment,
            comments: saved.comments,
            revision: saved.revision,
          });
          return;
        }
        if (
          segments[3] === "publish" &&
          segments.length === 4 &&
          request.method === "POST"
        ) {
          if (!isLoopbackHost(request)) {
            return errorJson(
              response,
              403,
              "Plans can only be published from the local editor.",
            );
          }
          json(response, 200, await publishPlanToTailnet(id));
          return;
        }
        if (
          segments[3] === "agent" &&
          segments[4] === "send" &&
          segments.length === 5 &&
          request.method === "POST"
        ) {
          if (!isLoopbackHost(request)) {
            return errorJson(
              response,
              403,
              "Plans can only be sent to an agent from the local editor.",
            );
          }
          const snapshot = await readPlan(root, id);
          const openComments = snapshot.comments.filter(
            (comment) => comment.status === "open" && !comment.deletedAt,
          );
          if (openComments.length === 0) {
            return errorJson(
              response,
              400,
              "Add an open comment before sending this plan to an agent.",
            );
          }
          const harness =
            snapshot.metadata.harness ?? sessions[id]?.harness ?? "codex";
          json(
            response,
            202,
            await sendToAgentHarness({
              harness,
              root,
              prompt: buildAgentPrompt({
                title: snapshot.bundle.plan.title,
                commentCount: openComments.length,
              }),
            }),
          );
          return;
        }
        if (
          segments[3] === "assets" &&
          segments[4] &&
          request.method === "GET"
        ) {
          const asset = await readAsset(root, segments[4]);
          response.writeHead(200, {
            "content-type": asset.mimeType,
            etag: `"${asset.revision}"`,
            "cache-control": "no-cache",
            "x-content-type-options": "nosniff",
          });
          response.end(asset.bytes);
          return;
        }
      }
      if (request.method === "GET" || request.method === "HEAD") {
        await serveStatic(url.pathname, request, response);
        return;
      }
      if (request.method === "POST" && url.pathname.startsWith("/_serverFn/")) {
        await serveTanstack(request, response);
        return;
      }
      errorJson(response, 404, "Not found.");
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        const file = error.file ?? segments[4];
        json(response, 409, {
          error: error.message,
          current: error.current,
          ...(file ? { revisions: { [file]: error.current.revision } } : {}),
        });
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        errorJson(response, 404, "Not found.");
      } else if (isLoopbackHost(request)) {
        errorJson(response, 400, error);
      } else {
        errorJson(response, 400, "Request failed.");
      }
    }
  });

  server.on("error", (error) => {
    void fs
      .appendFile(logPath(), `${new Date().toISOString()} ${String(error)}\n`, {
        mode: 0o600,
      })
      .finally(() => process.exit(1));
  });
  server.listen(PORT, HOST, async () => {
    await writePrivateJson(metadataPath(), {
      pid: process.pid,
      token: options.token,
      buildHash: options.buildHash,
      host: HOST,
      port: PORT,
      startedAt: new Date().toISOString(),
      logFile: logPath(),
    });
    await fs.appendFile(
      logPath(),
      `${new Date().toISOString()} listening on http://${HOST}:${PORT}\n`,
      { mode: 0o600 },
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const token = process.env.PLAN_LOCAL_TOKEN;
  const buildHash = process.env.PLAN_LOCAL_BUILD_HASH;
  if (!token || !buildHash)
    throw new Error("PLAN_LOCAL_TOKEN and PLAN_LOCAL_BUILD_HASH are required.");
  await startDaemon({ token, buildHash });
}
