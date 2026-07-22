#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { launchChrome, spawnHeadedBrowser, type PendingAction } from "@josharsh/pixelpi-cdp";
import { PixelpiProviderError, type ProviderKind } from "@josharsh/pixelpi-ai";
import type { AgentEvent } from "@josharsh/pixelpi-core";
import { createPixelpiSession } from "./session";
import { DEFAULT_PROFILE } from "./config";
import { ensureConfigured, runOnboarding } from "./onboarding";
import { renderEvent, setColorEnabled } from "./render";
import { renderMarkdown } from "./markdown";
import { startRepl } from "./repl";
import { createRecorder } from "./record";
import {
  describeTrace,
  loadTrace,
  resolveTracePath,
  saveTrace,
  slugify,
  type Trace,
  type TraceDescription,
} from "./trace";
import { replayTrace, type ReplayStep } from "./replay";
import { templatizeFromExamples } from "./template";
import { loadData, run, type RowOutcome } from "./run";
import { selectReporter } from "./dashboard";
import { ENV_VAR, type ResolvedSettings } from "./config";
import pkg from "../package.json";

const VERSION = pkg.version;

export interface Flags {
  task: string;
  auth: boolean;
  login: boolean;
  provider?: ProviderKind;
  model?: string;
  headless?: boolean;
  store?: string;
  /** Persistent profile dir, or "" when --profile is present with no value (→ DEFAULT_PROFILE). */
  profile?: string;
  maxSteps?: number;
  /** Total (input+output) token budget circuit breaker. */
  maxTokens?: number;
  /** Navigation fence: hosts (+subdomains) the agent may visit. */
  allowDomains?: string[];
  /** Withhold consequential actions (submit/send/purchase). */
  dryRun: boolean;
  /** Ask y/N before each consequential action. */
  confirm: boolean;
  /** Save a trace of this run: undefined = off, "" = auto-slug the task, or a name/path. */
  record?: string;
  heal: boolean;
  /** Set when "replay" is the first positional; holds the trace name/path (or "" if none given). */
  replay?: string;
  /** Set when "run" is the first positional; holds the trace name/path (or "" if none given). */
  run?: string;
  /** Set when "vars" is the first positional; holds the trace name/path (or "" if none given). */
  varsCmd?: string;
  /** Set when "describe" is the first positional; holds the trace name/path (or "" if none given). */
  describe?: string;
  /** Declared params (--param name=value, alias --vars): at record -> templatize; at run -> binds. */
  vars: Record<string, string>;
  /** Dynamic per-param flags (--query <v>, --foo <v>) collected for a single ad-hoc run. */
  params: Record<string, string>;
  /** Dataset for `run`: a .csv or .jsonl/.ndjson path. */
  over?: string;
  concurrency?: number;
  out?: string;
  resume: boolean;
  /** Stable-identity column for resume. */
  key?: string;
  timeout?: number;
  failFast: boolean;
  /** Read each row's output from the per-row store at this key (instead of the last eval value). */
  outKey?: string;
  /** Row index to run headed (visible) while the rest stay headless. */
  watch?: number;
  quiet: boolean;
  yes: boolean;
  print: boolean;
  json: boolean;
  noInput: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    task: "",
    auth: false,
    login: false,
    record: undefined,
    heal: false,
    replay: undefined,
    run: undefined,
    varsCmd: undefined,
    describe: undefined,
    vars: {},
    params: {},
    dryRun: false,
    confirm: false,
    resume: false,
    failFast: false,
    quiet: false,
    yes: false,
    print: false,
    json: false,
    noInput: false,
    noColor: false,
    help: false,
    version: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--profile=")) { f.profile = a.slice("--profile=".length); continue; }
    if (a.startsWith("--allow-domains=")) {
      f.allowDomains = a.slice("--allow-domains=".length).split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (a.startsWith("--record=")) { f.record = a.slice("--record=".length); continue; }
    if (a.startsWith("--param=")) {
      const pair = a.slice("--param=".length);
      const eq = pair.indexOf("=");
      if (eq > 0) f.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
      continue;
    }
    switch (a) {
      case "auth": positional.length === 0 ? (f.auth = true) : positional.push(a); break;
      case "login": positional.length === 0 ? (f.login = true) : positional.push(a); break;
      case "replay":
        // The next token is the trace name only when it exists and is not another flag.
        if (positional.length === 0 && f.replay === undefined) {
          f.replay = i + 1 < argv.length && !argv[i + 1]!.startsWith("-") ? argv[++i]! : "";
        } else positional.push(a);
        break;
      case "run":
        if (positional.length === 0 && f.run === undefined) {
          f.run = i + 1 < argv.length && !argv[i + 1]!.startsWith("-") ? argv[++i]! : "";
        } else positional.push(a);
        break;
      case "vars":
        if (positional.length === 0 && f.varsCmd === undefined) {
          f.varsCmd = i + 1 < argv.length && !argv[i + 1]!.startsWith("-") ? argv[++i]! : "";
        } else positional.push(a);
        break;
      case "describe":
        if (positional.length === 0 && f.describe === undefined) {
          f.describe = i + 1 < argv.length && !argv[i + 1]!.startsWith("-") ? argv[++i]! : "";
        } else positional.push(a);
        break;
      case "--record":
        // Bare --record auto-slugs; a following token that is not another flag is the name.
        if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) f.record = argv[++i];
        else f.record = "";
        break;
      case "--heal": f.heal = true; break;
      case "--param":
      case "--vars": {
        // Declare a param: name=value (repeatable). --param is canonical; --vars is the alias.
        // At record time these templatize the literal; at run time they also bind a single row.
        const pair = argv[++i] ?? "";
        const eq = pair.indexOf("=");
        if (eq > 0) f.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case "--over": f.over = argv[++i]; break;
      case "--concurrency": f.concurrency = parseInt(argv[++i]!, 10); break;
      case "--out": f.out = argv[++i]; break;
      case "--resume": f.resume = true; break;
      case "--key": f.key = argv[++i]; break;
      case "--timeout": f.timeout = parseInt(argv[++i]!, 10); break;
      case "--fail-fast": f.failFast = true; break;
      case "--out-key": f.outKey = argv[++i]; break;
      case "--watch": { const n = parseInt(argv[++i]!, 10); if (Number.isFinite(n)) f.watch = n; break; }
      case "--quiet": f.quiet = true; break;
      case "--yes": f.yes = true; break;
      case "-m": case "--model": f.model = argv[++i]; break;
      case "--provider": f.provider = argv[++i] as ProviderKind; break;
      case "--headless": f.headless = true; break;
      case "--no-headless": f.headless = false; break;
      case "--store": f.store = argv[++i]; break;
      case "--profile": f.profile = ""; break; // bare flag → DEFAULT_PROFILE (use --profile=<dir> for a custom one)
      case "--max-steps": { const n = parseInt(argv[++i]!, 10); if (Number.isFinite(n)) f.maxSteps = n; break; }
      case "--max-tokens": { const n = parseInt(argv[++i]!, 10); if (Number.isFinite(n)) f.maxTokens = n; break; }
      case "--allow-domains":
        f.allowDomains = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--dry-run": f.dryRun = true; break;
      case "--confirm": f.confirm = true; break;
      case "-p": case "--print": f.print = true; break;
      case "--json": f.json = true; f.print = true; break;
      case "--no-input": f.noInput = true; break;
      case "--no-color": f.noColor = true; break;
      case "-h": case "--help": f.help = true; break;
      case "--version": f.version = true; break;
      default:
        // An unknown --<name> <value> is a dynamic per-param binding for a single ad-hoc run
        // (e.g. --query "wireless mouse"). The name=value form is also accepted.
        if (a.startsWith("--")) {
          const body = a.slice(2);
          const eq = body.indexOf("=");
          if (eq > 0) {
            f.params[body.slice(0, eq)] = body.slice(eq + 1);
          } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
            f.params[body] = argv[++i]!;
          } else {
            f.params[body] = "";
          }
        } else positional.push(a);
    }
  }
  if (
    f.replay === undefined &&
    f.run === undefined &&
    f.varsCmd === undefined &&
    f.describe === undefined
  ) {
    f.task = positional.join(" ").trim();
  }
  return f;
}

const HELP = `pixelpi — a tiny browser agent (6 tools, real Chrome)

USAGE
  pixelpi                      start an interactive browser-agent chat
  pixelpi "<task>"             run one task and exit
  echo "<task>" | pixelpi      run a piped task and exit
  pixelpi auth                 set up or change your API key / model
  pixelpi login [url]          open a headed browser to sign in; saves the session
  pixelpi "<task>" --record [name]   record a run; then offers to make it reusable
  pixelpi replay <name|path>         replay a saved trace (free, no model)
  pixelpi replay <name|path> --heal  replay with one-step self-healing on drift
  pixelpi vars <trace>               name the values you entered as inputs (interactive)
  pixelpi describe <trace> [--json]  show a trace's inputs and output (for humans or agents)
  pixelpi run <trace>                run once, prompting for each input
  pixelpi run <trace> --query <value>                run on one ad-hoc input
  pixelpi run <trace> --over <data.csv|data.jsonl>   map the trace over a dataset

EXAMPLES
  pixelpi "go to news.ycombinator.com and tell me the top story"
  pixelpi --no-headless "log into example.com and screenshot the dashboard"
  pixelpi --json "extract all prices on example.com/pricing" > events.ndjson
  pixelpi login https://example.com   then: pixelpi --profile "do X while logged in"
  pixelpi run price --over queries.csv --concurrency 8 --out results.jsonl
  pixelpi run price --query "wireless mouse"

FLAGS
  -m, --model <id>      model (default: config or claude-sonnet-4-6)
      --provider <n>    anthropic | openai
      --no-headless     show the Chrome window
      --store <path>    durable JSON store (default: .pixelpi-store.json)
      --profile         reuse the persistent profile at ~/.pixelpi/profile
      --profile=<dir>   reuse a persistent profile at a custom dir
                        (omit --profile entirely for a fresh disposable profile each run)
      --max-steps <n>   step circuit breaker (default: 50)
      --max-tokens <n>  token circuit breaker: stop when input+output tokens reach n
      --allow-domains <a.com,b.com>
                        navigation fence: refuse any navigation off these domains
                        (+subdomains); the agent reports BLOCKED instead of wandering
      --dry-run         do everything up to the commit boundary (submit/send/purchase),
                        then withhold it and report what would have been submitted
      --confirm         ask y/N before each consequential action
                        (non-interactive/--json: denied and reported, never committed)
      --record [name]   save trace of this run for replay (omit name to auto-slug)
      --param name=val  with --record: declare a value you used as an input named <name>
                        (repeatable; e.g. --param query=rust). --vars is an alias.
      --heal            on replay/run: self-heal on drift (run heals only the warm-up row)

RUN FLAGS (pixelpi run <trace> ...)
      --over <file>     dataset to map over: .csv (header row) or .jsonl/.ndjson
      --query <value>   single ad-hoc input; --<param> <value> works for any param
      --concurrency <n> parallel browsers (default: 4; forced to 1 with --no-headless)
      --out <path>      stream row outcomes here as JSONL (default: run-out.jsonl)
      --resume          skip rows already present in the out file
      --key <column>    stable identity column for resume (default: row index)
      --timeout <ms>    per-row timeout (default: 60000)
      --fail-fast       abort the batch on the first error (default: collect all)
      --out-key <key>   read each row's output from the store at this key
      --watch <index>   run one row headed (visible) while the rest stay headless
      --quiet           print only the final summary line
      --yes             skip the warm-up confirmation prompt
  -p, --print           one-shot mode (print and exit)
      --json            emit agent events as JSON lines (implies -p)
      --no-input        never prompt (CI)
      --no-color        disable color (also respects NO_COLOR)
  -h, --help            this help
      --version         print version

EXIT CODES
  0 done · 1 error · 2 usage · 3 replay drift · 4 blocked (task could not proceed;
  the agent halted instead of substituting a goal or inventing data) · 130 interrupted

Config: ~/.config/pixelpi/config.json`;

/** Map the --profile flag to a dir: a path → that path, "" (bare flag) → default, absent → disposable. */
function resolveProfile(flag: string | undefined): string | undefined {
  if (flag === undefined) return undefined;
  return flag || DEFAULT_PROFILE;
}

/** Stable error codes an agent can branch on. */
export type ErrorCode =
  | "trace_not_found"
  | "invalid_trace"
  | "needs_tty"
  | "no_input"
  | "missing_param"
  | "no_rows"
  | "bad_data"
  | "bad_flags"
  | "aborted"
  | "runtime";

/** PURE: the JSON shape emitted for a fatal error under --json (the agent-facing error contract). */
export function errorEvent(code: ErrorCode, message: string, detail?: object) {
  return { type: "error" as const, code, message, ...(detail ? { detail } : {}) };
}

/**
 * Emit a fatal error in the right shape for the mode and set the exit code. Under --json it is one
 * JSON line on stdout ({type:"error",code,message,detail?}); otherwise human text on stderr. This is
 * the single place machine-reachable failures are reported, so --json stays a clean contract.
 */
function fail(json: boolean, code: ErrorCode, message: string, exit = 1, detail?: object): void {
  if (json) stdout.write(JSON.stringify(errorEvent(code, message, detail)) + "\n");
  else stderr.write("✗ " + message + "\n");
  process.exitCode = exit;
}

/** Emit a non-fatal warning (a JSON line under --json, dim text otherwise). */
function note(json: boolean, message: string): void {
  if (json) stdout.write(JSON.stringify({ type: "warning", message }) + "\n");
  else stderr.write("⚠ " + message + "\n");
}

/** PURE: distinct {name} placeholders in a task that have no value in `provided`. */
export function requiredPlaceholders(task: string, provided: Record<string, string>): string[] {
  const names = [...new Set([...task.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!))];
  return names.filter((n) => !(n in provided));
}

/** Print one compact progress line per replayed step (or a typed NDJSON line when --json). */
function renderReplay(step: ReplayStep, json: boolean): void {
  if (json) {
    stdout.write(JSON.stringify({ type: "step", ...step }) + "\n");
    return;
  }
  const mark = step.status === "ok" ? "·" : step.status === "drift" ? "≠" : "✗";
  const detail = step.detail ? ` - ${step.detail}` : "";
  stdout.write(`${mark} ${step.label}${detail}\n`);
}

/** Render a trace's signature as a human usage card (the --json form emits the TraceDescription). */
export function renderDescription(d: TraceDescription): string {
  const q = /\s/.test(d.name) ? JSON.stringify(d.name) : d.name;
  const lines = [`${d.name}  ·  ${d.steps} steps`, `  task    ${d.task}`];
  if (d.params.length === 0) {
    lines.push(`  inputs  (none; replay directly with: pixelpi replay ${q})`);
  } else {
    d.params.forEach((p, i) => {
      const lbl = i === 0 ? "inputs " : "       ";
      const req = p.required ? "required" : "optional";
      const ex = p.example !== undefined && p.example !== "" ? `   example ${JSON.stringify(p.example)}` : "";
      lines.push(`  ${lbl} ${p.name}   ${req}${ex}`);
    });
  }
  const out =
    d.output.from === "eval"
      ? `eval (step ${d.output.step})`
      : d.output.from === "store"
        ? `store key "${d.output.key}"`
        : "none";
  lines.push(`  output  ${out}`);
  if (d.params.length > 0) {
    lines.push(`  run     pixelpi run ${q} --${d.params[0]!.name} "<value>"`);
    lines.push(`  batch   pixelpi run ${q} --over data.csv`);
  }
  return lines.join("\n") + "\n";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Does the trace contain at least one eval step (the source of a row's machine output)? */
function hasEvalStep(trace: Trace): boolean {
  return trace.steps.some((s) => s.tool === "eval");
}

/**
 * Candidate values to turn into inputs, the ones a person ENTERED (typed/filled) first, then other
 * literals (URLs, eval/store values), deduped by value. Already-templatized values ({{...}}) are
 * skipped so re-running `vars` on a parametrized trace does not offer to re-tag its placeholders.
 */
export function paramCandidates(trace: Trace): { value: string; label: string }[] {
  const entered: { value: string; label: string }[] = [];
  const other: { value: string; label: string }[] = [];
  for (const s of trace.steps) {
    if (s.tool === "act" && typeof s.value === "string" && s.value) {
      const verb = s.op === "select" ? "selected" : s.op === "press" ? "pressed" : "typed";
      entered.push({ value: s.value, label: `${verb} "${s.value}" into ${s.target.role} "${s.target.name}"` });
    } else if (s.tool === "fill") {
      for (const f of s.fields) {
        if (f.value) entered.push({ value: f.value, label: `filled "${f.value}" into ${f.target.role} "${f.target.name}"` });
      }
    } else if (s.tool === "nav" && typeof s.input.arg === "string" && s.input.arg) {
      other.push({ value: s.input.arg, label: `navigated to ${s.input.arg}` });
    } else if (s.tool === "eval" && s.input.args) {
      for (const a of s.input.args) {
        if (typeof a === "string" && a) other.push({ value: a, label: `eval input "${a}"` });
      }
    } else if (s.tool === "store") {
      if (s.input.key) other.push({ value: s.input.key, label: `store key "${s.input.key}"` });
      if (typeof s.input.value === "string" && s.input.value) {
        other.push({ value: s.input.value, label: `store value "${s.input.value}"` });
      }
    }
  }
  const seen = new Set<string>();
  const out: { value: string; label: string }[] = [];
  for (const c of [...entered, ...other]) {
    if (c.value.includes("{{") || seen.has(c.value)) continue;
    seen.add(c.value);
    out.push(c);
  }
  return out;
}

/**
 * Interactively name recorded values as inputs, templatize them, and save. Shared by the `vars`
 * command and the post-record offer. Returns true if any input was named and the trace rewritten.
 */
async function parametrizeInteractive(trace: Trace, tracePath: string, name: string): Promise<boolean> {
  const cands = paramCandidates(trace);
  if (cands.length === 0) {
    stdout.write("No entered values to turn into inputs.\n");
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const vars: Record<string, string> = {};
  stdout.write("Name a value to make it an input you can vary, or press Enter to skip it.\n\n");
  try {
    for (const c of cands) {
      const ans = (await ask(`  ${c.label}\n    input name (Enter to skip): `)).trim();
      if (ans) vars[ans] = c.value;
    }
  } finally {
    rl.close();
  }
  const names = Object.keys(vars);
  if (names.length === 0) {
    stdout.write("\nNo inputs named; left as a fixed trace.\n");
    return false;
  }
  const updated = templatizeFromExamples(trace, vars);
  saveTrace(tracePath, updated);
  const q = /\s/.test(name) ? JSON.stringify(name) : name;
  stdout.write(`\nSaved ${names.length} input(s): ${names.join(", ")}\n`);
  stdout.write(`run one:   pixelpi run ${q} --${names[0]} "<value>"\n`);
  stdout.write(`or batch:  pixelpi run ${q} --over data.csv\n`);
  return true;
}

/** Wire and run `pixelpi run <trace>`: load data, resolve settings, pick a reporter, call run(). */
async function handleRun(flags: Flags, interactive: boolean): Promise<void> {
  if (!flags.run) {
    fail(flags.json, "no_input", "pixelpi run: needs a trace name or path.", 2);
    return;
  }
  const tracePath = resolveTracePath(flags.run, { forWrite: true });
  let trace: Trace;
  try {
    trace = loadTrace(tracePath);
  } catch (e) {
    fail(flags.json, "trace_not_found", e instanceof Error ? e.message : String(e), 1);
    return;
  }

  // Rows come from --over (a dataset) or from --<param>/--param flags (one ad-hoc row).
  let rows: Record<string, unknown>[];
  if (flags.over) {
    try {
      rows = loadData(flags.over);
    } catch (e) {
      fail(flags.json, "bad_data", e instanceof Error ? e.message : String(e), 2);
      return;
    }
    if (rows.length === 0) {
      fail(flags.json, "no_rows", `pixelpi run: ${flags.over} has no rows.`, 2);
      return;
    }
  } else {
    // One ad-hoc row: declared params (--param, in flags.vars) are binds too, overridden by
    // explicit --<param> flags; then prompt in a TTY for any still missing (default = the example).
    const row: Record<string, unknown> = { ...flags.vars, ...flags.params };
    const params = trace.params ?? [];
    const missing = params.filter((p) => {
      const v = row[p.name];
      return v === undefined || v === "";
    });
    if (missing.length > 0 && interactive && !flags.json) {
      const rl = createInterface({ input: stdin, output: stdout });
      const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
      stdout.write(`Running ${flags.run} once. Enter each input (Enter accepts the default).\n`);
      for (const p of missing) {
        const def = p.example ? ` [${p.example}]` : "";
        const ans = (await ask(`  ${p.name}${def}: `)).trim();
        row[p.name] = ans || p.example || "";
      }
      rl.close();
    }
    if (params.length === 0 && Object.keys(row).length === 0) {
      fail(
        flags.json,
        "no_input",
        'pixelpi run: no input. Map over data with --over data.csv, give one with --query "...", ' +
          "or replay an input-less trace with: pixelpi replay <trace>.",
        2,
      );
      return;
    }
    rows = [row];
  }

  // Validate required params against EVERY row BEFORE launching any browser, so a missing param in
  // any row (not just row 0) is a clean, actionable exit 2 rather than a generic exit-1 throw.
  const required = (trace.params ?? []).filter((p) => p.required).map((p) => p.name);
  if (required.length > 0) {
    for (let r = 0; r < rows.length; r++) {
      const miss = required.filter((name) => {
        const v = rows[r]![name];
        return v === undefined || v === null || v === "";
      });
      if (miss.length > 0) {
        fail(
          flags.json,
          "missing_param",
          `pixelpi run: row ${r} missing required param(s): ${miss.join(", ")}. ` +
            `Provide via a column/key in --over, or a --${miss[0]} <value> flag.`,
          2,
          { row: r, missing: miss },
        );
        return;
      }
    }
  }

  // Output capture needs an eval step or --out-key; warn at load if the run will produce nothing.
  if (!hasEvalStep(trace) && !flags.outKey) {
    note(flags.json, "trace produces no output (no eval step and no --out-key set).");
  }

  // --no-headless (plain headed fan-out) is mutually exclusive with --watch and forces concurrency 1.
  if (flags.headless === false && flags.watch !== undefined) {
    fail(flags.json, "bad_flags", "pixelpi run: --watch and --no-headless cannot be combined.", 2);
    return;
  }
  let concurrency = flags.concurrency && flags.concurrency > 0 ? flags.concurrency : 4;
  if (flags.headless === false) concurrency = 1;

  // Strict run needs NO key; only --heal (the warm-up micro-repair) requires one.
  let settings: ResolvedSettings;
  if (flags.heal) {
    settings = await ensureConfigured(
      {
        provider: flags.provider,
        model: flags.model,
        headless: flags.headless,
        store: flags.store,
        profile: resolveProfile(flags.profile),
      },
      interactive,
    );
  } else {
    const provider = flags.provider ?? "anthropic";
    settings = {
      provider,
      model: flags.model ?? trace.model,
      headless: flags.headless ?? true,
      storePath: flags.store ?? ".pixelpi-store.json",
      profileDir: resolveProfile(flags.profile),
      keySource: "none",
      envVar: ENV_VAR[provider],
    };
  }

  const tty = !!stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const reporter = selectReporter({ json: flags.json, quiet: flags.quiet, tty });
  // Prompt to continue after the warm-up row, only when interactive and not silenced.
  const promptable = interactive && tty && !flags.json && !flags.quiet && !flags.yes;
  const confirm = promptable
    ? async (rowsRemaining: number, row0: RowOutcome): Promise<boolean> => {
        const out =
          row0.output === undefined ? "(no output)" : JSON.stringify(row0.output).slice(0, 200);
        stdout.write(`\nrow 0 -> ${out}\n`);
        const rl = createInterface({ input: stdin, output: stdout });
        const ans = await new Promise<string>((res) =>
          rl.question(`run the remaining ${rowsRemaining} rows? [Y/n] `, res),
        );
        rl.close();
        // The prompt wrote lines into the dashboard's region; re-anchor so the next paint redraws
        // from scratch instead of scrolling over lines it did not draw (avoids a misaligned frame).
        reporter.resetAnchor?.();
        return ans.trim().toLowerCase() !== "n";
      }
    : undefined;

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  try {
    const summary = await run({
      trace,
      tracePath,
      settings,
      rows,
      reporter,
      concurrency,
      outPath: flags.out ?? "run-out.jsonl",
      heal: flags.heal,
      failFast: flags.failFast,
      timeoutMs: flags.timeout && flags.timeout > 0 ? flags.timeout : 60000,
      resume: flags.resume,
      key: flags.key,
      outKey: flags.outKey,
      watch: flags.watch,
      yes: flags.yes || !promptable,
      confirm,
      signal: ac.signal,
    });
    // Exit codes: 0 all clean, 3 drift (no error), 1 any error, 130 on SIGINT abort.
    if (summary.aborted && ac.signal.aborted) process.exitCode = 130;
    else if (summary.error > 0) process.exitCode = 1;
    else if (summary.drift > 0) process.exitCode = 3;
    else process.exitCode = 0;
  } finally {
    process.off("SIGINT", onSig);
  }
}

async function main(): Promise<void> {
  // Load ./.env as an override layer (no flag, no echo). Built into Node ≥20.12.
  try {
    process.loadEnvFile();
  } catch {
    /* no .env — fine */
  }

  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) return void stdout.write(HELP + "\n");
  if (flags.version) return void stdout.write(`pixelpi ${VERSION}\n`);

  const interactive = !!stdin.isTTY && !!stdout.isTTY && !flags.noInput;
  const useColor =
    !flags.noColor && !process.env.NO_COLOR && !!stdout.isTTY && process.env.TERM !== "dumb";
  setColorEnabled(useColor);

  if (flags.auth) {
    if (!interactive) throw new PixelpiProviderError("`pixelpi auth` needs an interactive terminal.");
    await runOnboarding();
    return;
  }

  if (flags.login) {
    if (!interactive) {
      stderr.write("✗ pixelpi login: needs an interactive terminal.\n");
      process.exitCode = 2;
      return;
    }
    const profileDir = resolveProfile(flags.profile) ?? DEFAULT_PROFILE;
    mkdirSync(profileDir, { recursive: true });
    const url = flags.task || "about:blank";
    stdout.write(`Opening Chrome with profile ${profileDir} …\n`);
    // Login uses a plain headed Chrome with NO debug port: bot-walls (X, Google) fingerprint the
    // CDP port launchChrome() opens and block sign-in. The session persists in the profile for
    // later headless CDP runs. See spawnHeadedBrowser().
    const chrome = await spawnHeadedBrowser({ userDataDir: profileDir, startUrl: url });
    stdout.write("Sign in to the sites you need, then press Enter here to save the session.\n");
    const rl = createInterface({ input: stdin, output: stdout });
    await new Promise<void>((resolve) => rl.question("", () => resolve()));
    rl.close();
    await chrome.close();
    stdout.write(`Session saved to ${profileDir}\n`);
    return;
  }

  if (flags.replay !== undefined) {
    if (!flags.replay) {
      fail(flags.json, "no_input", "pixelpi replay: needs a trace name or path.", 2);
      return;
    }
    const tracePath = resolveTracePath(flags.replay);
    let trace: Trace;
    try {
      trace = loadTrace(tracePath);
    } catch (e) {
      fail(flags.json, "trace_not_found", e instanceof Error ? e.message : String(e), 1);
      return;
    }
    // Strict replay needs NO key; only --heal (the micro-repair) requires one.
    let settings: ResolvedSettings;
    if (flags.heal) {
      settings = await ensureConfigured(
        {
          provider: flags.provider,
          model: flags.model,
          headless: flags.headless,
          store: flags.store,
          profile: resolveProfile(flags.profile),
        },
        interactive,
      );
    } else {
      const provider = flags.provider ?? "anthropic";
      settings = {
        provider,
        model: flags.model ?? trace.model,
        headless: flags.headless ?? true,
        storePath: flags.store ?? ".pixelpi-store.json",
        profileDir: resolveProfile(flags.profile),
        keySource: "none",
        envVar: ENV_VAR[provider],
      };
    }
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    const t0 = Date.now();
    try {
      const result = await replayTrace({
        trace,
        settings,
        tracePath,
        heal: flags.heal,
        signal: ac.signal,
        onStep: (s) => renderReplay(s, flags.json),
      });
      const ms = Date.now() - t0;
      if (flags.json) {
        stdout.write(JSON.stringify({ type: "result", ok: result.ok, drift: result.drift, ms }) + "\n");
      } else if (result.ok) {
        stdout.write(`done in ${(ms / 1000).toFixed(1)}s - 0 tokens\n`);
      } else if (result.drift) {
        stdout.write(`drift at step ${result.drift.step}: ${result.drift.reason}\n`);
      }
      process.exitCode = result.ok ? 0 : 3;
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
        fail(flags.json, "aborted", "cancelled", 130);
      } else {
        fail(flags.json, "runtime", err instanceof Error ? err.message : String(err), 1);
      }
    } finally {
      process.off("SIGINT", onSig);
    }
    return;
  }

  if (flags.varsCmd !== undefined) {
    if (!flags.varsCmd) {
      stderr.write("✗ pixelpi vars: needs a trace name or path.\n");
      process.exitCode = 2;
      return;
    }
    if (!interactive) {
      stderr.write("✗ pixelpi vars: needs an interactive terminal.\n");
      process.exitCode = 2;
      return;
    }
    const tracePath = resolveTracePath(flags.varsCmd, { forWrite: true });
    const trace = loadTrace(tracePath);
    await parametrizeInteractive(trace, tracePath, flags.varsCmd);
    return;
  }

  if (flags.describe !== undefined) {
    if (!flags.describe) {
      fail(flags.json, "no_input", "pixelpi describe: needs a trace name or path.", 2);
      return;
    }
    let trace: Trace;
    try {
      trace = loadTrace(resolveTracePath(flags.describe));
    } catch (e) {
      fail(flags.json, "trace_not_found", e instanceof Error ? e.message : String(e), 1);
      return;
    }
    const d = describeTrace(trace, flags.describe);
    if (flags.json) stdout.write(JSON.stringify({ type: "description", ...d }) + "\n");
    else stdout.write(renderDescription(d));
    return;
  }

  if (flags.run !== undefined) {
    await handleRun(flags, interactive);
    return;
  }

  if (Object.keys(flags.vars).length > 0 && flags.record === undefined) {
    note(flags.json, "--param/--vars apply to --record or `pixelpi run`; ignoring them here.");
  }

  // A piped task (no TTY stdin) with no argv task → read the first line as the task.
  let task = flags.task;
  if (!task && !stdin.isTTY) {
    task = (await readStdin()).split("\n")[0]!.trim();
  }

  const oneShot = !!task || flags.print || !interactive;

  // Ensure we have a usable key (onboards if interactive & unconfigured; throws in CI).
  const settings = await ensureConfigured(
    {
      provider: flags.provider,
      model: flags.model,
      headless: flags.headless,
      store: flags.store,
      profile: resolveProfile(flags.profile),
    },
    interactive,
  );

  // The commit-boundary gate (#22): under --confirm, a consequential action pauses for an
  // explicit y/N. With no way to ask (--json / no TTY), it is denied and reported — the
  // safe default is to not commit. --dry-run never reaches this (withheld at the tool layer).
  const confirmAction = flags.confirm
    ? async (a: PendingAction): Promise<boolean> => {
        if (flags.json || !interactive) {
          stdout.write(
            JSON.stringify({ type: "pending_action", action: a, approved: false, reason: "no confirmation channel; denied" }) + "\n",
          );
          return false;
        }
        stdout.write(`\n⚠ pending: ${a.op} on ${a.role} "${a.name}" at ${a.url}\n`);
        const rl = createInterface({ input: stdin, output: stdout });
        const ans = await new Promise<string>((res) => rl.question("  proceed? [y/N] ", res));
        rl.close();
        return ans.trim().toLowerCase() === "y";
      }
    : undefined;
  const sessionInit = {
    settings,
    maxSteps: flags.maxSteps,
    maxTotalTokens: flags.maxTokens,
    allowDomains: flags.allowDomains,
    dryRun: flags.dryRun,
    confirmAction,
  };

  if (oneShot) {
    if (!task) {
      stderr.write(
        "✗ pixelpi: no task and no interactive terminal.\n" +
          '  Pass a task:     pixelpi "go to example.com and ..."\n' +
          "  Or pipe one:     echo \"...\" | pixelpi\n" +
          "  Configure a key: pixelpi auth   (interactive), or set ANTHROPIC_API_KEY\n",
      );
      process.exitCode = 2;
      return;
    }
    // Overwrite guard: if recording to a name that already exists, confirm in an interactive
    // terminal before spending a run. Silent under --yes / --json / non-TTY so scripts and agents
    // overwrite idempotently.
    if (flags.record !== undefined) {
      const recName = flags.record || slugify(task);
      if (existsSync(resolveTracePath(recName, { forWrite: true })) && interactive && !flags.json && !flags.yes) {
        const rl = createInterface({ input: stdin, output: stdout });
        const ans = await new Promise<string>((res) =>
          rl.question(`trace "${recName}" already exists. Overwrite? [y/N] `, res),
        );
        rl.close();
        if (ans.trim().toLowerCase() !== "y") {
          stdout.write("kept the existing trace; recording cancelled.\n");
          return;
        }
      }
    }
    // A {name} placeholder in the task needs a value so the model runs a real task (a bare {q}
    // confuses it). Prompt for missing ones in a TTY (which also declares them as params); fail
    // fast with guidance otherwise. Values land in flags.vars, so the run fills them and the
    // recorded literals templatize back to {{name}}.
    if (flags.record !== undefined && task) {
      const missing = requiredPlaceholders(task, flags.vars);
      if (missing.length > 0 && interactive && !flags.json) {
        const rl = createInterface({ input: stdin, output: stdout });
        const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
        stdout.write(`This task has placeholders. Give each a value to record with (it becomes an input).\n`);
        for (const n of missing) {
          const v = (await ask(`  value for {${n}}: `)).trim();
          if (v) flags.vars[n] = v;
        }
        rl.close();
      }
      const still = requiredPlaceholders(task, flags.vars);
      if (still.length > 0) {
        fail(
          flags.json,
          "missing_param",
          `task has unfilled placeholder(s): {${still.join("}, {")}}. ` +
            `Give --param ${still[0]}=<value>, or write the real value in the task ` +
            `(e.g. "search HN for rust") and name it after recording.`,
          2,
        );
        return;
      }
    }
    const base: (e: AgentEvent) => void = flags.json
      ? (e) => stdout.write(JSON.stringify(e) + "\n")
      : renderEvent;
    const recorder = flags.record !== undefined ? createRecorder() : undefined;
    const onEvent: (e: AgentEvent) => void = recorder
      ? (e) => {
          recorder.onEvent(e);
          base(e);
        }
      : base;
    const session = createPixelpiSession({ ...sessionInit, onEvent });
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    // At record time with --vars, fill the {name} placeholders in the task with the example values
    // so the model performs a real run (it would balk on a literal {q}). The recorded literals are
    // templatized back to {{name}} below; the trace keeps the {q} template form as its description.
    let runTask = task;
    for (const [name, example] of Object.entries(flags.vars)) {
      runTask = runTask.split(`{${name}}`).join(example);
    }
    try {
      const result = await session.send(runTask, ac.signal);
      if (!flags.json) {
        const body = result.finalText ? renderMarkdown(result.finalText, { color: useColor }) : "(no final text)";
        stdout.write("\n" + "─".repeat(40) + "\n" + body + "\n");
      }
      if (recorder && flags.record !== undefined) {
        if (result.stopReason === "done") {
          let trace = recorder.build(task, settings.model);
          // --vars name=example templatizes the trace: exact/substring-replace the example values
          // with {{name}} and record them as params, so the trace can later be run over a dataset.
          if (Object.keys(flags.vars).length > 0) {
            trace = templatizeFromExamples(trace, flags.vars);
          }
          if (trace.steps.length === 0) {
            if (flags.json) stdout.write(JSON.stringify({ type: "trace_skipped", reason: "no_actions" }) + "\n");
            else stdout.write("trace not saved (no actions to replay)\n");
          } else {
            const name = flags.record || slugify(task);
            const tracePath = resolveTracePath(name, { forWrite: true });
            const existed = existsSync(tracePath);
            saveTrace(tracePath, trace);
            if (flags.json) {
              stdout.write(
                JSON.stringify({
                  type: "trace_saved",
                  name,
                  path: tracePath,
                  params: (trace.params ?? []).map((p) => p.name),
                  overwrote: existed,
                }) + "\n",
              );
            } else {
              // Quote the name so the printed command is copy-pasteable when it has whitespace.
              const quoted = /\s/.test(name) ? JSON.stringify(name) : name;
              stdout.write(`Saved trace to ${tracePath}\n`);
              stdout.write(`replay free with: pixelpi replay ${quoted}\n`);
              // Offer to parametrize: only when the user did not already declare params and the run
              // actually entered some values worth naming.
              if (Object.keys(flags.vars).length === 0 && interactive && paramCandidates(trace).length > 0) {
                const rl = createInterface({ input: stdin, output: stdout });
                const ans = await new Promise<string>((res) =>
                  rl.question("\nMake this reusable with inputs? [y/N] ", res),
                );
                rl.close();
                if (ans.trim().toLowerCase() === "y") {
                  await parametrizeInteractive(trace, tracePath, name);
                }
              }
            }
          }
        } else {
          if (flags.json) stdout.write(JSON.stringify({ type: "trace_skipped", reason: "incomplete" }) + "\n");
          else stdout.write("trace not saved (run did not complete)\n");
        }
      }
      process.exitCode =
        result.stopReason === "error" ? 1 : result.stopReason === "blocked" ? 4 : 0;
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
        stderr.write("\n⚠ cancelled\n");
        process.exitCode = 130;
      } else throw err;
    } finally {
      process.off("SIGINT", onSig);
      await session.close();
    }
    return;
  }

  // Interactive REPL.
  const session = createPixelpiSession({ ...sessionInit, onEvent: renderEvent });
  await startRepl(session, settings, { color: useColor });
}

function runCli(): void {
  main().catch((err) => {
    const debug = process.env.PIXELPI_DEBUG === "1";
    if (err instanceof PixelpiProviderError && !debug) {
      stderr.write("\n✗ " + err.message + "\n");
      process.exitCode = 2;
    } else if (err instanceof Error) {
      stderr.write("\n✗ " + (debug ? (err.stack ?? err.message) : err.message) + "\n");
      if (!debug) stderr.write("  (set PIXELPI_DEBUG=1 for the full stack)\n");
      process.exitCode = 1;
    } else {
      stderr.write("\n✗ " + String(err) + "\n");
      process.exitCode = 1;
    }
  });
}

// Run only when invoked as the entry point, so the module can be imported in tests without executing.
// realpath both sides so the symlinked global `pixelpi` bin still resolves to this file.
try {
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
  if (entry && entry === realpathSync(fileURLToPath(import.meta.url))) runCli();
} catch {
  /* not the entry (e.g. imported in a test, or argv[1] missing) - do not run */
}
