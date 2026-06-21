import type { Ref } from "@josharsh/pixelpi-cdp";
import type { Target } from "./trace";

export type MatchResult = { ref: number } | { drift: true; reason: string };

/**
 * PURE: resolve a recorded descriptor against a fresh look's refs. No model, no fuzzy matching.
 * 1. exact (role===role && name===name).
 * 2. one candidate -> use it; several -> candidates[ordinal] else candidates[0].
 * 3. zero -> one relaxed pass (case-insensitive + trimmed name, same role).
 * 4. still zero -> drift with a precise reason.
 */
export function resolveTarget(refs: Ref[], target: Target): MatchResult {
  const exact = refs.filter((r) => r.role === target.role && r.name === target.name);
  if (exact.length === 1) return { ref: exact[0]!.ref };
  if (exact.length > 1) return { ref: (exact[target.ordinal] ?? exact[0]!).ref };

  const wantName = target.name.trim().toLowerCase();
  const relaxed = refs.filter(
    (r) => r.role === target.role && r.name.trim().toLowerCase() === wantName,
  );
  if (relaxed.length === 1) return { ref: relaxed[0]!.ref };
  if (relaxed.length > 1) return { ref: (relaxed[target.ordinal] ?? relaxed[0]!).ref };

  const sameRole = refs.filter((r) => r.role === target.role).length;
  const reason =
    sameRole > 0
      ? `${target.role} "${target.name}" not found; found ${sameRole} ${target.role}(s) but no match on name`
      : `${target.role} "${target.name}" not found; no ${target.role} on the current page`;
  return { drift: true, reason };
}
