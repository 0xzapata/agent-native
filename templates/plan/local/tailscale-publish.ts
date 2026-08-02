import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { HOST, PORT } from "./runtime.js";

export const TAILSCALE_HTTPS_PORT = 8443;

type Execute = (command: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const execute: Execute = (command, args) =>
  execFileAsync(command, args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

async function readJson(
  run: Execute,
  args: string[],
): Promise<Record<string, unknown>> {
  const { stdout } = await run("tailscale", args);
  try {
    return record(JSON.parse(stdout));
  } catch {
    throw new Error(`Could not read "tailscale ${args.join(" ")}" output.`);
  }
}

export async function publishPlanToTailnet(
  sessionId: string,
  run: Execute = execute,
): Promise<{ url: string }> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(sessionId)) {
    throw new Error("Invalid plan session id.");
  }

  const status = await readJson(run, ["status", "--json"]);
  if (status.BackendState !== "Running") {
    throw new Error("Tailscale must be connected before publishing a plan.");
  }
  const dnsName = record(status.Self).DNSName;
  if (typeof dnsName !== "string" || !dnsName.endsWith(".ts.net.")) {
    throw new Error("Tailscale MagicDNS and HTTPS must be enabled.");
  }

  const target = `http://${HOST}:${PORT}`;
  const serveStatus = await readJson(run, ["serve", "status", "--json"]);
  const allowFunnel = record(serveStatus.AllowFunnel);
  const existingPort = record(serveStatus.TCP)[String(TAILSCALE_HTTPS_PORT)];
  const hostname = dnsName.slice(0, -1);
  const existingHandler = record(
    record(record(serveStatus.Web)[`${hostname}:${TAILSCALE_HTTPS_PORT}`])
      .Handlers,
  )["/"];
  if (allowFunnel[`${hostname}:${TAILSCALE_HTTPS_PORT}`] === true) {
    throw new Error(
      `Tailscale Funnel is enabled on port ${TAILSCALE_HTTPS_PORT}; disable it before publishing a tailnet-only plan.`,
    );
  }
  if (
    existingPort &&
    (!record(existingPort).HTTPS || record(existingHandler).Proxy !== target)
  ) {
    throw new Error(
      `Tailscale Serve port ${TAILSCALE_HTTPS_PORT} is already in use.`,
    );
  }

  if (!existingPort) {
    await run("tailscale", [
      "serve",
      "--bg",
      "--yes",
      `--https=${TAILSCALE_HTTPS_PORT}`,
      target,
    ]);
    const verified = await readJson(run, ["serve", "status", "--json"]);
    const verifiedPort = record(verified.TCP)[String(TAILSCALE_HTTPS_PORT)];
    const verifiedHandler = record(
      record(record(verified.Web)[`${hostname}:${TAILSCALE_HTTPS_PORT}`])
        .Handlers,
    )["/"];
    if (
      !record(verifiedPort).HTTPS ||
      record(verifiedHandler).Proxy !== target ||
      record(verified.AllowFunnel)[`${hostname}:${TAILSCALE_HTTPS_PORT}`] ===
        true
    ) {
      throw new Error("Tailscale Serve did not publish the tailnet-only plan.");
    }
  }

  return {
    url: `https://${hostname}:${TAILSCALE_HTTPS_PORT}/plans/${sessionId}`,
  };
}
