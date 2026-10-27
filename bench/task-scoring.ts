import type { AgentStopReason } from "@josharsh/pixelpi-core";

export type TaskStatus = "pass" | "fail" | "error" | "unscored" | "not_run";

export function scoreTask(stopReason: AgentStopReason, answer: string, truth: string[]): TaskStatus {
  // Provider/runner errors are returned as finalText, not necessarily thrown.
  if (stopReason === "error" || stopReason === "aborted") return "error";
  if (!truth.length || truth.some((value) => !value?.trim())) return "unscored";
  const norm = (value: string) => value.toLowerCase().replace(/\s+/g, " ");
  return stopReason === "done" && truth.some((value) => norm(answer).includes(norm(value))) ? "pass" : "fail";
}

export function summarizeTasks(rows: { status: TaskStatus }[]) {
  const passed = rows.filter((row) => row.status === "pass").length;
  const evaluated = rows.filter((row) => row.status === "pass" || row.status === "fail").length;
  return {
    passed,
    evaluated,
    total: rows.length,
    // Never present a partial run or failed setup as a suite success rate.
    successRate: evaluated === rows.length && rows.length > 0 ? passed / rows.length : null,
  };
}
