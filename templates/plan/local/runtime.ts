import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HOST = "127.0.0.1";
export const PORT = 8105;

export interface RuntimeMetadata {
  pid: number;
  token: string;
  buildHash: string;
  host: typeof HOST;
  port: typeof PORT;
  startedAt: string;
  logFile: string;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function runtimeDir(): string {
  const configured = process.env.PLAN_LOCAL_RUNTIME_DIR?.trim();
  if (configured) return path.resolve(configured);
  const base = process.env.XDG_RUNTIME_DIR?.trim() || os.tmpdir();
  return path.resolve(
    base,
    `agent-native-plan-${process.getuid?.() ?? "user"}`,
  );
}

export function metadataPath(): string {
  return path.join(runtimeDir(), "daemon.json");
}

export function sessionsPath(): string {
  return path.join(runtimeDir(), "sessions.json");
}

export function logPath(): string {
  return path.join(runtimeDir(), "daemon.log");
}

export async function ensureRuntimeDir(): Promise<string> {
  const dir = runtimeDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const canonical = await fs.realpath(dir);
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error("Runtime directory must be owned by the current user.");
  }
  await fs.chmod(canonical, 0o700);
  return canonical;
}

export async function readMetadata(): Promise<RuntimeMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath(), "utf8"));
    if (
      typeof parsed?.pid !== "number" ||
      typeof parsed?.token !== "string" ||
      typeof parsed?.buildHash !== "string" ||
      typeof parsed?.startedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.startedAt)) ||
      typeof parsed?.logFile !== "string" ||
      !path.isAbsolute(parsed.logFile) ||
      parsed?.host !== HOST ||
      parsed?.port !== PORT
    ) {
      return null;
    }
    return parsed as RuntimeMetadata;
  } catch {
    return null;
  }
}

export async function writePrivateJson(
  target: string,
  value: unknown,
): Promise<void> {
  const dir = await ensureRuntimeDir();
  const resolved = path.resolve(dir, path.basename(target));
  if (!isInside(dir, resolved))
    throw new Error("Runtime metadata path escaped its directory.");
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, resolved);
  await fs.chmod(resolved, 0o600);
}
