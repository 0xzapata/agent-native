import { parsePlanHarness, type PlanHarness } from "../shared/plan-harness.js";

export function detectPlanHarness(
  environment: NodeJS.ProcessEnv = process.env,
): PlanHarness | undefined {
  const explicit = environment.AGENT_NATIVE_HARNESS?.trim();
  if (explicit) {
    const harness = parsePlanHarness(explicit);
    if (!harness) {
      throw new Error(
        "AGENT_NATIVE_HARNESS must be codex, claude-code, or opencode.",
      );
    }
    return harness;
  }
  if (
    environment.CLAUDE_CODE_SESSION_ID ||
    environment.CLAUDECODE ||
    environment.CLAUDE_CODE_SESSION
  ) {
    return "claude-code";
  }
  if (environment.OPENCODE_PID || environment.OPENCODE_CLIENT) {
    return "opencode";
  }
  if (environment.CODEX_THREAD_ID || environment.CODEX_SHELL) return "codex";
  return undefined;
}
