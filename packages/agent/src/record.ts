import type { AgentEvent } from "@josharsh/pixelpi-core";
import type { Ref } from "@josharsh/pixelpi-cdp";
import type { Target, Trace, TraceStep } from "./trace";
import { VERSION, defaultOutput } from "./trace";

export interface Recorder {
  onEvent(e: AgentEvent): void;
  build(task: string, model: string): Trace;
}

/** Pull a Ref[] off any observation that carries one (Snapshot / SnapshotDelta). */
function refsOf(observation: unknown): Ref[] | undefined {
  if (observation && typeof observation === "object" && "refs" in observation) {
    const refs = (observation as { refs: unknown }).refs;
    if (Array.isArray(refs)) return refs as Ref[];
  }
  return undefined;
}

/** Compute ordinal = index of `ref` among refs sharing its (role,name), in array order. */
function ordinalOf(refs: Ref[], ref: Ref): number {
  let ordinal = 0;
  for (const r of refs) {
    if (r.ref === ref.ref) break;
    if (r.role === ref.role && r.name === ref.name) ordinal++;
  }
  return ordinal;
}

/** Resolve a numeric ref the model passed to act/fill into a {role,name,ordinal} descriptor. */
function targetFromRef(seenRefs: Ref[], refNum: number): Target | undefined {
  const hit = seenRefs.find((r) => r.ref === refNum);
  if (!hit) return undefined;
  return { role: hit.role, name: hit.name, ordinal: ordinalOf(seenRefs, hit) };
}

// Matches the deterministic act note: `click "value" on [3] button "name"`.
const NOTE_RE = /^(\w+)(?: "(.*?)")?\s+on \[(\d+)\] (\S+) "(.*)"$/;

/** Last-ditch: parse the act result content for {role,name} when seenRefs failed. ordinal=0. */
function targetFromNote(content: string): Target | undefined {
  const m = NOTE_RE.exec(content.split("\n")[0] ?? "");
  if (!m) return undefined;
  return { role: m[4]!, name: m[5]!, ordinal: 0 };
}

export function createRecorder(): Recorder {
  const steps: TraceStep[] = [];
  // The refs the model last SAW; one look behind the current page (which is fine - it is the
  // snapshot present when the model chose its ref). Updated from every tool_end that carries refs.
  let seenRefs: Ref[] = [];
  // Pair tool_start inputs to tool_end results by toolUseId (results carry no input).
  const pendingInput = new Map<string, Record<string, unknown>>();
  let finalText = "";

  function recordAct(input: Record<string, unknown>, content: string): void {
    const refNum = Number(input.ref);
    const op = String(input.op ?? "click");
    const value = typeof input.value === "string" ? input.value : undefined;
    const target = targetFromRef(seenRefs, refNum) ?? targetFromNote(content);
    if (!target) return; // could not resolve - skip silently (rare: a look returned 0 refs)
    steps.push({ tool: "act", op, value, target });
  }

  function recordFill(input: Record<string, unknown>): void {
    const raw = (input.fields as { ref: number; value: string }[] | undefined) ?? [];
    const fields: { target: Target; value: string }[] = [];
    for (const f of raw) {
      const target = targetFromRef(seenRefs, Number(f.ref));
      if (!target) return; // any unresolved field invalidates the whole fill record
      fields.push({ target, value: String(f.value ?? "") });
    }
    if (fields.length) steps.push({ tool: "fill", fields });
  }

  return {
    onEvent(e: AgentEvent): void {
      if (e.type === "assistant_message") {
        const text = e.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (text) finalText = text;
        return;
      }
      if (e.type === "tool_start") {
        if (e.name !== "look") pendingInput.set(e.toolUseId, e.input);
        return;
      }
      if (e.type !== "tool_end") return;

      const input = pendingInput.get(e.toolUseId);
      pendingInput.delete(e.toolUseId);

      // Skip failed attempts entirely; the model's successful retry records separately.
      // Do NOT touch seenRefs - the retry needs the same ref context.
      if (e.result.isError) return;
      if (e.name === "look") {
        const refs = refsOf(e.result.observation);
        if (refs) seenRefs = refs;
        return;
      }
      if (!input) return;

      // Resolve against the refs the model saw BEFORE this tool refreshed the page.
      switch (e.name) {
        case "act":
          recordAct(input, e.result.content);
          break;
        case "fill":
          recordFill(input);
          break;
        case "nav":
          steps.push({
            tool: "nav",
            input: {
              action: String(input.action ?? "goto"),
              arg: typeof input.arg === "string" ? input.arg : undefined,
            },
          });
          break;
        case "eval":
          steps.push({
            tool: "eval",
            input: {
              fn: String(input.fn ?? ""),
              args: Array.isArray(input.args) ? (input.args as unknown[]) : undefined,
              opts:
                input.opts && typeof input.opts === "object"
                  ? (input.opts as Record<string, unknown>)
                  : undefined,
            },
          });
          break;
        case "store": {
          const action = String(input.action ?? "");
          if (action === "set" || action === "delete") {
            steps.push({
              tool: "store",
              input: { action, key: String(input.key ?? ""), value: input.value },
            });
          }
          break;
        }
      }

      // Now advance seenRefs from this successful tool's observation (act/fill/nav carry refs).
      const refs = refsOf(e.result.observation);
      if (refs) seenRefs = refs;
    },

    build(task: string, model: string): Trace {
      const trace: Trace = {
        version: VERSION,
        task,
        model,
        createdAt: new Date().toISOString(),
        steps,
        result: finalText ? { finalText } : undefined,
      };
      // Make the output source explicit (the last eval step, or none) so describe/run are deterministic.
      trace.output = defaultOutput(trace);
      return trace;
    },
  };
}
