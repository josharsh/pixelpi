#!/usr/bin/env node
import { stdin, stdout, stderr } from "node:process";
import { PixelpiProviderError, type ProviderKind } from "@josharsh/pixelpi-ai";
import type { AgentEvent } from "@josharsh/pixelpi-core";
import { createPixelpiSession } from "./session";
import { ensureConfigured, runOnboarding } from "./onboarding";
import { renderEvent, setColorEnabled } from "./render";
import { renderMarkdown } from "./markdown";
import { startRepl } from "./repl";

const VERSION = "0.1.0";

interface Flags {
  task: string;
  auth: boolean;
  provider?: ProviderKind;
  model?: string;
  headless?: boolean;
  store?: string;
  maxSteps?: number;
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
    switch (a) {
      case "auth": positional.length === 0 ? (f.auth = true) : positional.push(a); break;
      case "-m": case "--model": f.model = argv[++i]; break;
      case "--provider": f.provider = argv[++i] as ProviderKind; break;
      case "--headless": f.headless = true; break;
      case "--no-headless": f.headless = false; break;
      case "--store": f.store = argv[++i]; break;
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
  f.task = positional.join(" ").trim();
  return f;
}

const HELP = `pixelpi — a tiny browser agent (6 tools, real Chrome)

USAGE
  pixelpi                      start an interactive browser-agent chat
  pixelpi "<task>"             run one task and exit
  echo "<task>" | pixelpi      run a piped task and exit
  pixelpi auth                 set up or change your API key / model

EXAMPLES
  pixelpi "go to news.ycombinator.com and tell me the top story"
  pixelpi --no-headless "log into example.com and screenshot the dashboard"
  pixelpi --json "extract all prices on example.com/pricing" > events.ndjson

FLAGS
  -m, --model <id>      model (default: config or claude-sonnet-4-6)
      --provider <n>    anthropic | openai
      --no-headless     show the Chrome window
      --store <path>    durable JSON store (default: .pixelpi-store.json)
      --max-steps <n>   step circuit breaker (default: 50)
  -p, --print           one-shot mode (print and exit)
      --json            emit agent events as JSON lines (implies -p)
      --no-input        never prompt (CI)
      --no-color        disable color (also respects NO_COLOR)
  -h, --help            this help
      --version         print version

Config: ~/.config/pixelpi/config.json`;

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

  // A piped task (no TTY stdin) with no argv task → read the first line as the task.
  let task = flags.task;
  if (!task && !stdin.isTTY) {
    task = (await readStdin()).split("\n")[0]!.trim();
  }

  const oneShot = !!task || flags.print || !interactive;

  // Ensure we have a usable key (onboards if interactive & unconfigured; throws in CI).
  const settings = await ensureConfigured(
    { provider: flags.provider, model: flags.model, headless: flags.headless, store: flags.store },
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
    const onEvent: (e: AgentEvent) => void = flags.json
      ? (e) => stdout.write(JSON.stringify(e) + "\n")
      : renderEvent;
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
