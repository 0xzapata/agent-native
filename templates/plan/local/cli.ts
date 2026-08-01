import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderPlanBlockAuthoringExamples } from "../server/plan-block-examples.js";
import { renderPlanBlockVocabulary } from "../shared/plan-block-registry.js";
import { canonicalPlanRoot, validatePlanRoot } from "./files.js";
import {
  ensureRuntimeDir,
  HOST,
  logPath,
  metadataPath,
  PORT,
  readMetadata,
  sessionsPath,
} from "./runtime.js";

const localDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(localDir);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function hashTree(
  root: string,
  hash = createHash("sha256"),
): Promise<ReturnType<typeof createHash>> {
  for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (
      ["node_modules", ".git", ".output", "dist", ".react-router"].includes(
        entry.name,
      )
    )
      continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await hashTree(target, hash);
    else if (entry.isFile()) {
      hash.update(path.relative(appDir, target));
      hash.update(await fs.readFile(target));
    }
  }
  return hash;
}

async function dependenciesInstalled(): Promise<boolean> {
  try {
    return (await fs.stat(path.join(appDir, "node_modules"))).isDirectory();
  } catch {
    return false;
  }
}

async function buildHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const name of [
    "app",
    "src",
    "local",
    "shared",
    "server",
    "package.json",
    "vite.config.ts",
  ]) {
    const target = path.join(appDir, name);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) await hashTree(target, hash);
      else hash.update(await fs.readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return hash.digest("hex");
}

async function healthy(): Promise<{
  ok: boolean;
  pid?: number;
  buildHash?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://${HOST}:${PORT}/health`, {
      signal: controller.signal,
    });
    return response.ok
      ? ((await response.json()) as {
          ok: boolean;
          pid: number;
          buildHash: string;
        })
      : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function outputExists(): Promise<boolean> {
  for (const target of [
    path.join(appDir, ".output", "public", "index.html"),
    path.join(appDir, "dist", "client", "index.html"),
    path.join(appDir, "dist", "index.html"),
    path.join(appDir, "dist", "server", "server.js"),
  ]) {
    try {
      if ((await fs.stat(target)).isFile()) return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: appDir, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}.`)),
    );
  });
}

async function ensureBuild(
  expectedHash: string,
  currentHash?: string,
): Promise<void> {
  if ((await outputExists()) && currentHash === expectedHash) return;
  if (!(await dependenciesInstalled())) {
    await run("pnpm", ["install", "--frozen-lockfile"]);
  }
  await run("pnpm", ["build"]);
  if (!(await outputExists()))
    throw new Error(
      "Build completed without a supported static index.html output.",
    );
}

async function start(expectedHash: string): Promise<{ token: string }> {
  const old = await readMetadata();
  const live = await healthy();
  if (live.ok && old && live.pid === old.pid && live.buildHash === expectedHash)
    return { token: old.token };
  if (live.ok) {
    if (!old || live.pid !== old.pid)
      throw new Error(`Port ${PORT} is occupied by another healthy service.`);
    await fetch(`http://${HOST}:${PORT}/api/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${old.token}` },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  } else if (old && processExists(old.pid)) {
    throw new Error(
      `Recorded daemon PID ${old.pid} is alive but unhealthy; inspect ${old.logFile}.`,
    );
  }

  await ensureRuntimeDir();
  await fs.rm(metadataPath(), { force: true });
  await fs.rm(sessionsPath(), { force: true });
  const token = randomBytes(32).toString("base64url");
  const log = await fs.open(logPath(), "a", 0o600);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(localDir, "daemon.ts")],
    {
      cwd: appDir,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: {
        ...process.env,
        PLAN_LOCAL_TOKEN: token,
        PLAN_LOCAL_BUILD_HASH: expectedHash,
      },
    },
  );
  child.unref();
  await log.close();

  for (let attempt = 0; attempt < 150; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await healthy();
    if (status.ok && status.pid === child.pid) return { token };
    if (child.exitCode !== null) break;
  }
  throw new Error(`Local editor daemon did not start; inspect ${logPath()}.`);
}

async function openBrowser(url: string): Promise<void> {
  if (process.argv.includes("--no-open")) return;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function commandOpen(): Promise<void> {
  const root = await canonicalPlanRoot(requiredArgument("--dir"));
  await validatePlanRoot(root);
  const expectedHash = await buildHash();
  const metadata = await readMetadata();
  await ensureBuild(expectedHash, metadata?.buildHash);
  const daemon = await start(expectedHash);
  const response = await fetch(`http://${HOST}:${PORT}/api/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ root }),
  });
  const result = (await response.json()) as { url?: string; error?: string };
  if (!response.ok || !result.url)
    throw new Error(result.error ?? "Could not register plan folder.");
  await openBrowser(result.url);
  process.stdout.write(`${result.url}\n`);
}

async function commandCheck(): Promise<void> {
  const root = await canonicalPlanRoot(requiredArgument("--dir"));
  await validatePlanRoot(root);
  process.stdout.write(`valid ${root}\n`);
}

async function commandBlocks(): Promise<void> {
  const output = `${renderPlanBlockVocabulary()}\n\n${await renderPlanBlockAuthoringExamples()}\n`;
  const target = argument("--out");
  if (!target) process.stdout.write(output);
  else {
    const resolved = path.resolve(target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, output, "utf8");
    process.stdout.write(`${resolved}\n`);
  }
}

async function commandStatus(): Promise<void> {
  const metadata = await readMetadata();
  const live = await healthy();
  if (!metadata || !live.ok || live.pid !== metadata.pid) {
    process.stdout.write("stopped\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ running: true, pid: metadata.pid, url: `http://${HOST}:${PORT}`, buildHash: metadata.buildHash, logFile: metadata.logFile }, null, 2)}\n`,
  );
}

async function commandStop(): Promise<void> {
  const metadata = await readMetadata();
  const live = await healthy();
  if (!metadata || !live.ok || live.pid !== metadata.pid) {
    if (!metadata || !processExists(metadata.pid)) {
      await fs.rm(metadataPath(), { force: true });
      await fs.rm(sessionsPath(), { force: true });
    }
    process.stdout.write("already stopped\n");
    return;
  }
  const response = await fetch(`http://${HOST}:${PORT}/api/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${metadata.token}` },
  });
  if (!response.ok) throw new Error("Daemon rejected shutdown.");
  await fs.rm(metadataPath(), { force: true });
  await fs.rm(sessionsPath(), { force: true });
  process.stdout.write("stopped\n");
}

const command = process.argv[2];
try {
  if (command === "open") await commandOpen();
  else if (command === "check") await commandCheck();
  else if (command === "blocks") await commandBlocks();
  else if (command === "status") await commandStatus();
  else if (command === "stop") await commandStop();
  else
    throw new Error(
      "Usage: pnpm local <open|check|blocks|status|stop> [options]",
    );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
