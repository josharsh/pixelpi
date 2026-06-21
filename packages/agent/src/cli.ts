#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { launchChrome } from "@josharsh/pixelpi-cdp";
import { PixelpiProviderError, type ProviderKind } from "@josharsh/pixelpi-ai";
import type { AgentEvent } from "@josharsh/pixelpi-core";
import { createPixelpiSession } from "./session";
import { DEFAULT_PROFILE } from "./config";
import { ensureConfigured, runOnboarding } from "./onboarding";
import { renderEvent, setColorEnabled } from "./render";
import { renderMarkdown } from "./markdown";
import { startRepl } from "./repl";
import { createRecorder } from "./record";
import { loadTrace, resolveTracePath, saveTrace, slugify } from "./trace";
import { replayTrace, type ReplayStep } from "./replay";
import { ENV_VAR, type ResolvedSettings } from "./config";
import pkg from "../package.json";

const VERSION = pkg.version;

interface Flags {
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
  /** Save a trace of this run: undefined = off, "" = auto-slug the task, or a name/path. */
  record?: string;
  heal: boolean;
  /** Set when "replay" is the first positional; holds the trace name/path (or "" if none given). */
  replay?: string;
  print: boolean;
  json: boolean;
  noInput: boolean;
  noColor: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    task: "",
    auth: false,
    login: false,
    record: undefined,
    heal: false,
    replay: undefined,
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
    if (a.startsWith("--record=")) { f.record = a.slice("--record=".length); continue; }
    switch (a) {
      case "auth": positional.length === 0 ? (f.auth = true) : positional.push(a); break;
      case "login": positional.length === 0 ? (f.login = true) : positional.push(a); break;
      case "replay":
        // The next token is the trace name only when it exists and is not another flag.
        if (positional.length === 0 && f.replay === undefined) {
          f.replay = i + 1 < argv.length && !argv[i + 1]!.startsWith("-") ? argv[++i]! : "";
        } else positional.push(a);
        break;
      case "--record":
        // Bare --record auto-slugs; a following token that is not another flag is the name.
        if (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) f.record = argv[++i];
        else f.record = "";
        break;
      case "--heal": f.heal = true; break;
      case "-m": case "--model": f.model = argv[++i]; break;
      case "--provider": f.provider = argv[++i] as ProviderKind; break;
      case "--headless": f.headless = true; break;
      case "--no-headless": f.headless = false; break;
      case "--store": f.store = argv[++i]; break;
      case "--profile": f.profile = ""; break; // bare flag → DEFAULT_PROFILE (use --profile=<dir> for a custom one)
      case "--max-steps": f.maxSteps = parseInt(argv[++i]!, 10); break;
      case "-p": case "--print": f.print = true; break;
      case "--json": f.json = true; f.print = true; break;
      case "--no-input": f.noInput = true; break;
      case "--no-color": f.noColor = true; break;
      case "-h": case "--help": f.help = true; break;
      case "--version": f.version = true; break;
      default: positional.push(a);
    }
  }
  if (f.replay === undefined) f.task = positional.join(" ").trim();
  return f;
}

const HELP = `pixelpi — a tiny browser agent (6 tools, real Chrome)

USAGE
  pixelpi                      start an interactive browser-agent chat
  pixelpi "<task>"             run one task and exit
  echo "<task>" | pixelpi      run a piped task and exit
  pixelpi auth                 set up or change your API key / model
  pixelpi login [url]          open a headed browser to sign in; saves the session
  pixelpi "<task>" --record [name]   run and save a trace (auto-name if omitted)
  pixelpi replay <name|path>         replay a saved trace (free, no model)
  pixelpi replay <name|path> --heal  replay with one-step self-healing on drift

EXAMPLES
  pixelpi "go to news.ycombinator.com and tell me the top story"
  pixelpi --no-headless "log into example.com and screenshot the dashboard"
  pixelpi --json "extract all prices on example.com/pricing" > events.ndjson
  pixelpi login https://example.com   then: pixelpi --profile "do X while logged in"

FLAGS
  -m, --model <id>      model (default: config or claude-sonnet-4-6)
      --provider <n>    anthropic | openai
      --no-headless     show the Chrome window
      --store <path>    durable JSON store (default: .pixelpi-store.json)
      --profile         reuse the persistent profile at ~/.pixelpi/profile
      --profile=<dir>   reuse a persistent profile at a custom dir
                        (omit --profile entirely for a fresh disposable profile each run)
      --max-steps <n>   step circuit breaker (default: 50)
      --record [name]   save trace of this run for replay (omit name to auto-slug)
      --heal            on replay: self-heal one step at a time on drift
  -p, --print           one-shot mode (print and exit)
      --json            emit agent events as JSON lines (implies -p)
      --no-input        never prompt (CI)
      --no-color        disable color (also respects NO_COLOR)
  -h, --help            this help
      --version         print version

Config: ~/.config/pixelpi/config.json`;

/** Map the --profile flag to a dir: a path → that path, "" (bare flag) → default, absent → disposable. */
function resolveProfile(flag: string | undefined): string | undefined {
  if (flag === undefined) return undefined;
  return flag || DEFAULT_PROFILE;
}

/** Print one compact progress line per replayed step (or NDJSON when --json). */
function renderReplay(step: ReplayStep, json: boolean): void {
  if (json) {
    stdout.write(JSON.stringify(step) + "\n");
    return;
  }
  const mark = step.status === "ok" ? "·" : step.status === "drift" ? "≠" : "✗";
  const detail = step.detail ? ` - ${step.detail}` : "";
  stdout.write(`${mark} ${step.label}${detail}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
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
    const chrome = await launchChrome({ headless: false, userDataDir: profileDir, startUrl: url });
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
      stderr.write("✗ pixelpi replay: needs a trace name or path.\n");
      process.exitCode = 2;
      return;
    }
    const tracePath = resolveTracePath(flags.replay);
    const trace = loadTrace(tracePath); // throws a clear error if missing/invalid/wrong version
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
      if (!flags.json) {
        if (result.ok) {
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          stdout.write(`done in ${secs}s - 0 tokens\n`);
        } else if (result.drift) {
          stdout.write(`drift at step ${result.drift.step}: ${result.drift.reason}\n`);
        }
      }
      process.exitCode = result.ok ? 0 : 3;
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
        stderr.write("\n⚠ cancelled\n");
        process.exitCode = 130;
      } else {
        stderr.write("\n✗ " + (err instanceof Error ? err.message : String(err)) + "\n");
        process.exitCode = 1;
      }
    } finally {
      process.off("SIGINT", onSig);
    }
    return;
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
    const session = createPixelpiSession({ settings, maxSteps: flags.maxSteps, onEvent });
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    try {
      const result = await session.send(task, ac.signal);
      if (!flags.json) {
        const body = result.finalText ? renderMarkdown(result.finalText, { color: useColor }) : "(no final text)";
        stdout.write("\n" + "─".repeat(40) + "\n" + body + "\n");
      }
      if (recorder && flags.record !== undefined) {
        if (result.stopReason === "done") {
          const trace = recorder.build(task, settings.model);
          if (trace.steps.length === 0) {
            stdout.write("trace not saved (no actions to replay)\n");
          } else {
            const name = flags.record || slugify(task);
            const tracePath = resolveTracePath(name, { forWrite: true });
            saveTrace(tracePath, trace);
            // Quote the name so the printed command is copy-pasteable when it contains whitespace.
            const quoted = /\s/.test(name) ? JSON.stringify(name) : name;
            stdout.write(`Saved trace to ${tracePath}\n`);
            stdout.write(`replay free with: pixelpi replay ${quoted}\n`);
          }
        } else {
          stdout.write("trace not saved (run did not complete)\n");
        }
      }
      process.exitCode = result.stopReason === "error" ? 1 : 0;
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
  const session = createPixelpiSession({ settings, maxSteps: flags.maxSteps, onEvent: renderEvent });
  await startRepl(session, settings, { color: useColor });
}

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
