import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { HOST, PORT } from "./runtime.js";

export const TAILSCALE_HTTPS_PORT = 8443;

type Execute = (command: string, args: string[]) => Promise<{ stdout: string }>;

const execute: Execute = promisify(execFile);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export async function publishPlanToTailnet(
  sessionId: string,
  run: Execute = execute,
): Promise<{ url: string }> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(sessionId)) {
    throw new Error("Invalid plan session id.");
  }

  const status = record(
    JSON.parse((await run("tailscale", ["status", "--json"])).stdout),
  );
  if (status.BackendState !== "Running") {
    throw new Error("Tailscale must be connected before publishing a plan.");
  }
  const dnsName = record(status.Self).DNSName;
  if (typeof dnsName !== "string" || !dnsName.endsWith(".ts.net.")) {
    throw new Error("Tailscale MagicDNS and HTTPS must be enabled.");
  }

  const target = `http://${HOST}:${PORT}`;
  const serveStatus = record(
    JSON.parse((await run("tailscale", ["serve", "status", "--json"])).stdout),
  );
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
    const verified = record(
      JSON.parse(
        (await run("tailscale", ["serve", "status", "--json"])).stdout,
      ),
    );
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
