import { describe, expect, it } from "vitest";

import { detectPlanHarness } from "./plan-harness.js";

describe("local plan harness detection", () => {
  it.each([
    [{ CODEX_THREAD_ID: "thread" }, "codex"],
    [{ CLAUDE_CODE_SESSION_ID: "session" }, "claude-code"],
    [{ OPENCODE_PID: "123" }, "opencode"],
  ] as const)("detects the originating harness", (environment, expected) => {
    expect(detectPlanHarness(environment)).toBe(expected);
  });

  it("lets explicit plan metadata override inherited harness variables", () => {
    expect(
      detectPlanHarness({
        AGENT_NATIVE_HARNESS: "opencode",
        CODEX_THREAD_ID: "parent-thread",
      }),
    ).toBe("opencode");
  });

  it("prefers Claude Code, then OpenCode, when inherited signals overlap", () => {
    expect(
      detectPlanHarness({
        CLAUDECODE: "1",
        OPENCODE_CLIENT: "desktop",
        CODEX_SHELL: "1",
      }),
    ).toBe("claude-code");
    expect(
      detectPlanHarness({ OPENCODE_CLIENT: "desktop", CODEX_SHELL: "1" }),
    ).toBe("opencode");
  });

  it("supports alternate signals and no-harness legacy sessions", () => {
    expect(detectPlanHarness({ CLAUDE_CODE_SESSION: "session" })).toBe(
      "claude-code",
    );
    expect(detectPlanHarness({ OPENCODE_CLIENT: "desktop" })).toBe("opencode");
    expect(detectPlanHarness({ CODEX_SHELL: "1" })).toBe("codex");
    expect(detectPlanHarness({})).toBeUndefined();
  });

  it("rejects unsupported explicit harness metadata", () => {
    expect(() => detectPlanHarness({ AGENT_NATIVE_HARNESS: "cursor" })).toThrow(
      /must be codex, claude-code, or opencode/,
    );
  });
});
