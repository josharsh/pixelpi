import { isDeepStrictEqual } from "node:util";
import { createProvider } from "@josharsh/pixelpi-ai";
import { runAgent, JsonFileStore } from "@josharsh/pixelpi-core";
import type {
  AgentEvent,
  Store,
  ToolContext,
  ToolResult,
} from "@josharsh/pixelpi-core";
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import type { Ref } from "@josharsh/pixelpi-cdp";
import type { ResolvedSettings } from "./config";
import { resolveTarget } from "./match";
import { createRecorder } from "./record";
import { defaultOutput, saveTrace, type Trace, type TraceStep } from "./trace";

type TargetedStep = Extract<TraceStep, { tool: "act" | "fill" }>;

export interface ReplayStep {
  i: number;
  tool: string;
  label: string;
  status: "ok" | "drift" | "error";
  detail?: string;
}

export interface ReplayResult {
  ok: boolean;
  steps: ReplayStep[];
  drift?: { step: number; reason: string };
  finalText?: string;
  recordedFinalText?: string;
  error?: string;
  verified?: boolean;
  /** Return value of the last successfully executed eval step, if any. */
  output?: unknown;
}

export interface ReplayOptions {
  trace: Trace;
  settings: ResolvedSettings;
  tracePath: string;
  store?: Store;
  heal: boolean;
  signal?: AbortSignal;
  onStep?: (step: ReplayStep) => void;
}

class AbortError extends Error {
  constructor(message = "replay aborted") {
    super(message);
    this.name = "AbortError";
  }
}

function labelFor(step: TraceStep): string {
  switch (step.tool) {
    case "nav":
      return `nav ${step.input.action}${step.input.arg ? ` ${step.input.arg}` : ""}`;
    case "act":
      return `act ${step.op} ${step.target.role} "${step.target.name}"`;
    case "fill":
      return `fill ${step.fields.length} field(s)`;
    case "eval":
      return "eval";
    case "store":
      return `store ${step.input.action} ${step.input.key}`;
  }
}

/**
 * Pull the returned value out of an eval ToolResult. The eval tool sets observation to the
 * EvalReturn ({ value } | { handle } | { error }); prefer observation.value, else JSON.parse the
 * content (which is JSON.stringify(value)), else the raw content string.
 */
function evalOutput(res: ToolResult): unknown {
  const obs = res.observation;
  if (obs && typeof obs === "object" && "value" in obs) {
    return (obs as { value: unknown }).value;
  }
  try {
    return JSON.parse(res.content);
  } catch {
    return res.content;
  }
}

function refsOf(observation: unknown): Ref[] {
  if (observation && typeof observation === "object" && "refs" in observation) {
    const refs = (observation as { refs: unknown }).refs;
    if (Array.isArray(refs)) return refs as Ref[];
  }
  return [];
}

export async function replayTrace(opts: ReplayOptions): Promise<ReplayResult> {
  const { settings, tracePath, heal, signal, onStep } = opts;
  const trace = structuredClone(opts.trace);
  let repairedTrace = false;
  const ctx: ToolContext = {
    signal: signal ?? new AbortController().signal,
    emit: () => {},
  };
  // The output is the value of the designated eval step (defaults to the last eval). Capturing only
  // that step keeps result.output deterministic and matches what `describe` reports.
  const outSpec = defaultOutput(trace);

  const launched = await launchChrome({
    headless: settings.headless,
    userDataDir: settings.profileDir,
  });
  // Abort/timeout must tear down Chrome even mid-tool-call. The step loop only checks the signal
  // BETWEEN steps, so a hung nav/look would otherwise keep the browser (and its temp profile) alive
  // until the call settled. Closing on abort rejects the in-flight CDP call, so the finally does not
  // wait on a hung page. closeOnce guards against the abort + finally both closing.
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await launched.close();
  };
  const onAbort = () => void closeOnce().catch(() => undefined);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const store: Store = opts.store ?? new JsonFileStore(settings.storePath);
  const tools = createBrowserTools({ session: launched.session, store });
  const checked = tools.map((t) => ({
    ...t,
    execute: async (...args: Parameters<typeof t.execute>) => {
      const res = await t.execute(...args);
      if (res.isError) throw new Error(`${t.name}: ${res.content}`);
      return res;
    },
  }));
  const byName = new Map(checked.map((t) => [t.name, t]));
  const lookTool = byName.get("look")!;
  const actTool = byName.get("act")!;
  const fillTool = byName.get("fill")!;
  const navTool = byName.get("nav")!;
  const evalTool = byName.get("eval")!;
  const storeTool = byName.get("store")!;

  const result: ReplayResult = {
    ok: true,
    steps: [],
    recordedFinalText: trace.result?.finalText,
    verified: false,
  };

  function emitStep(step: ReplayStep): void {
    result.steps.push(step);
    onStep?.(step);
  }

  let currentStep = 0;
  const tabs = new Map<number, string>();
  try {
    if (
      trace.steps.some((s) => s.tool === "nav" && s.input.tab !== undefined)
    ) {
      const { targetInfo } = await launched.session.send<{
        targetInfo: { targetId: string };
      }>("Target.getTargetInfo", {});
      tabs.set(0, targetInfo.targetId);
    }
    for (let i = 0; i < trace.steps.length; i++) {
      if (signal?.aborted) throw new AbortError();
      currentStep = i;
      const step = trace.steps[i]!;
      const label = labelFor(step);

      if (step.tool === "nav") {
        let arg = step.input.arg;
        if (step.input.action === "switchtab" && step.input.tab !== undefined) {
          arg = tabs.get(step.input.tab);
          if (!arg)
            throw new Error(`Recorded tab ${step.input.tab} is unavailable`);
        }
        const navResult = await navTool.execute(
          { action: step.input.action, arg },
          ctx,
        );
        if (step.input.action === "newtab" && step.input.tab !== undefined) {
          const id = (navResult.observation as { targetId?: string })?.targetId;
          if (!id) throw new Error("New tab did not return an identity");
          tabs.set(step.input.tab, id);
        }
        emitStep({ i, tool: "nav", label, status: "ok" });
        continue;
      }

      if (step.tool === "eval") {
        const evalRes = await evalTool.execute(
          { fn: step.input.fn, args: step.input.args, opts: step.input.opts },
          ctx,
        );
        if (outSpec.from === "eval" && outSpec.step === i)
          result.output = evalOutput(evalRes);
        emitStep({ i, tool: "eval", label, status: "ok" });
        continue;
      }

      if (step.tool === "store") {
        await storeTool.execute(
          {
            action: step.input.action,
            key: step.input.key,
            value: step.input.value,
          },
          ctx,
        );
        emitStep({ i, tool: "store", label, status: "ok" });
        continue;
      }

      // act / fill need a fresh look to populate ctx.lastRefs and read current refs.
      const looked = await lookTool.execute({}, ctx);
      const refs = refsOf(looked.observation);

      if (step.tool === "act") {
        const match = resolveTarget(refs, step.target);
        if ("ref" in match) {
          await actTool.execute(
            { ref: match.ref, op: step.op, value: step.value },
            ctx,
          );
          emitStep({ i, tool: "act", label, status: "ok" });
          continue;
        }
        const healed = await onDrift(i, step, match.reason);
        if (!healed) return result;
        continue;
      }

      // fill: resolve EVERY field first; any miss is drift (all-or-nothing).
      const resolved: { ref: number; value: string }[] = [];
      let driftReason: string | undefined;
      for (const field of step.fields) {
        const match = resolveTarget(refs, field.target);
        if ("ref" in match) {
          resolved.push({ ref: match.ref, value: field.value });
        } else {
          driftReason = match.reason;
          break;
        }
      }
      if (!driftReason) {
        await fillTool.execute({ fields: resolved }, ctx);
        emitStep({ i, tool: "fill", label, status: "ok" });
        continue;
      }
      const healed = await onDrift(i, step, driftReason);
      if (!healed) return result;
    }

    if (outSpec.from === "store")
      result.output = await store.get(outSpec.key ?? "");
    if (outSpec.required && result.output == null)
      throw new Error("Required replay output is missing");
    for (const assertion of trace.assertions ?? []) {
      const checked = await evalTool.execute(
        { fn: assertion.fn, args: assertion.args },
        ctx,
      );
      if (!isDeepStrictEqual(evalOutput(checked), assertion.equals))
        throw new Error(
          `Replay assertion failed: ${assertion.name ?? assertion.fn}`,
        );
    }
    result.verified = !!trace.assertions?.length;
    if (repairedTrace) {
      Object.assign(opts.trace, trace);
      saveTrace(tracePath, trace);
    }
    return result;
  } catch (error) {
    if (signal?.aborted) throw new AbortError();
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
    const step = trace.steps[currentStep];
    emitStep({
      i: currentStep,
      tool: step?.tool ?? "verification",
      label: step ? labelFor(step) : "verification",
      status: "error",
      detail: result.error,
    });
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeOnce();
  }

  /**
   * Handle a drift at step i. Returns true if replay should continue (healed or recoverable),
   * false if it should stop (strict drift, or healed too far). Mutates result on stop.
   */
  async function onDrift(
    i: number,
    step: TargetedStep,
    reason: string,
  ): Promise<boolean> {
    if (!heal) {
      emitStep({
        i,
        tool: step.tool,
        label: labelFor(step),
        status: "drift",
        detail: reason,
      });
      result.ok = false;
      result.drift = { step: i, reason };
      return false;
    }

    const progressed = await microRepair(i, step);
    if (progressed) {
      emitStep({
        i,
        tool: step.tool,
        label: labelFor(trace.steps[i]!),
        status: "ok",
        detail: "healed",
      });
      return true;
    }

    // A repair that made no progress is a hard stop: the step never executed, and skipping it
    // would leave the flow in a wrong state with no drift reported. Abort immediately so the run
    // reports drift (exit 3) instead of a false success.
    emitStep({
      i,
      tool: step.tool,
      label: labelFor(step),
      status: "drift",
      detail: reason,
    });
    result.ok = false;
    result.drift = {
      step: i,
      reason: `${reason}; repair made no progress; re-record with --record`,
    };
    return false;
  }

  /**
   * Run a focused one-step model repair. Returns true if a new act/fill was recorded and spliced
   * into trace.steps[i] (then persisted). Requires an API key (heal mode guarantees it).
   */
  async function microRepair(i: number, step: TargetedStep): Promise<boolean> {
    const provider = createProvider({
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
    });
    const looked = await lookTool.execute({}, ctx);
    const want =
      step.tool === "act"
        ? `${step.op} the ${step.target.role} named "${step.target.name}" with value ${JSON.stringify(step.value)}`
        : `fill ${step.fields.map((f) => `the ${f.target.role} named "${f.target.name}" with value ${JSON.stringify(f.value)}`).join(" and ")}`;

    const recorder = createRecorder();
    const onEvent = (e: AgentEvent) => recorder.onEvent(e);
    const system =
      "You are repairing one step of a saved browser flow. Do the single equivalent action and then stop. Do not explain.";
    const user =
      `You needed to ${want} but it is not on the current page. Here is the page:\n\n${looked.content}\n\n` +
      `Do the equivalent single action with act/fill (or nav) to make progress, then stop.`;

    await runAgent({
      provider,
      model: settings.model,
      system,
      tools,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      maxSteps: 4,
      signal,
      onEvent,
    });

    const repaired = recorder.build("repair", settings.model);
    const newStep = repaired.steps.find(
      (s) => s.tool === "act" || s.tool === "fill",
    );
    if (!newStep) return false;
    trace.steps[i] = newStep;
    repairedTrace = true;
    return true;
  }
}
