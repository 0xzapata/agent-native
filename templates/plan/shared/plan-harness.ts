export const PLAN_HARNESSES = ["codex", "claude-code", "opencode"] as const;

export type PlanHarness = (typeof PLAN_HARNESSES)[number];

export function parsePlanHarness(value: unknown): PlanHarness | undefined {
  return typeof value === "string" &&
    PLAN_HARNESSES.includes(value as PlanHarness)
    ? (value as PlanHarness)
    : undefined;
}
