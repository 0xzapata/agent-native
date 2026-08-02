import { describe, expect, it } from "vitest";

import { isTailnetViewerRequest } from "./daemon.js";
import { HOST, PORT } from "./runtime.js";

const request = (method: string, host: string) =>
  ({ method, headers: { host } }) as Parameters<
    typeof isTailnetViewerRequest
  >[0];

describe("tailnet viewer access", () => {
  it.each(["GET", "HEAD"])("allows %s reads", (method) => {
    expect(
      isTailnetViewerRequest(request(method, "mac.example.ts.net:8443"), [
        "api",
        "sessions",
        "session",
        "files",
      ]),
    ).toBe(false);
  });

  it("allows adding a comment", () => {
    expect(
      isTailnetViewerRequest(request("POST", "mac.example.ts.net:8443"), [
        "api",
        "sessions",
        "session",
        "comments",
      ]),
    ).toBe(false);
  });

  it("rejects adding a comment on a longer path", () => {
    expect(
      isTailnetViewerRequest(request("POST", "mac.example.ts.net:8443"), [
        "api",
        "sessions",
        "session",
        "comments",
        "extra",
      ]),
    ).toBe(true);
  });

  it("rejects a missing host as a remote mutation", () => {
    expect(
      isTailnetViewerRequest(
        { method: "POST", headers: {} } as Parameters<
          typeof isTailnetViewerRequest
        >[0],
        ["api", "sessions", "session", "agent", "send"],
      ),
    ).toBe(true);
  });

  it.each([
    ["PUT", ["api", "sessions", "session", "files"]],
    ["PUT", ["api", "sessions", "session", "comments"]],
    ["POST", ["api", "sessions", "session", "agent", "send"]],
    ["POST", ["api", "sessions", "session", "publish"]],
    ["POST", ["api", "register"]],
    ["POST", ["api", "shutdown"]],
  ] as const)("rejects remote %s %s", (method, segments) => {
    expect(
      isTailnetViewerRequest(request(method, "mac.example.ts.net:8443"), [
        ...segments,
      ]),
    ).toBe(true);
  });

  it("does not restrict loopback callers", () => {
    expect(
      isTailnetViewerRequest(request("POST", `${HOST}:${PORT}`), [
        "api",
        "sessions",
        "session",
        "agent",
        "send",
      ]),
    ).toBe(false);
  });
});
