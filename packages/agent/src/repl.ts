import * as readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import type { InteractiveSession } from "./session";
import { readSkillDescriptions } from "./session";
import { runOnboarding } from "./onboarding";
import { loadConfig, resolveSettings, resolveCredential, type ResolvedSettings } from "./config";

const ANSI = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError");
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const HELP = `commands:
  /model [id]        show or switch the model (keeps the conversation)
  /provider <name>   switch provider (anthropic | openai)
  /headless on|off   headless preference for the next browser launch
  /new               start a fresh conversation + browser
  /store [key]       list stored keys, or print one value
  /skills            list the agent's self-installed skills
  /status            provider, model, key source, browser state, token usage
  /login             reload your key from env/config (or re-run setup)
  /clear             clear the screen
  /help              this list
  /exit, /quit       quit and close Chrome   (or press Ctrl-D)

Type anything else to give the agent a task. Ctrl-C cancels a running task.`;

export interface ReplOptions {
  color: boolean;
}

export async function startRepl(
  session: InteractiveSession,
  settings: ResolvedSettings,
  opts: ReplOptions,
): Promise<void> {
  const c = (code: string, s: string) => (opts.color ? `${code}${s}${ANSI.reset}` : s);
  const prompt = c(ANSI.dim, "pixelpi ") ;

  const banner =
    c(ANSI.bold, "pixelpi") +
    c(ANSI.dim, ` · ${settings.provider}/${settings.model} · ${settings.headless ? "headless" : "windowed"} · store ${settings.storePath}\n`) +
    c(ANSI.dim, "/help for commands · Ctrl-C cancels a run · Ctrl-D exits\n");
  stderr.write("\n" + banner + "\n");

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt,
    historySize: 200,
    removeHistoryDuplicates: true,
    terminal: true,
  });

  let running: AbortController | null = null;
  let quitting = false;

  /** Run `fn` with the readline interface paused (so it doesn't fight for stdin). */
  async function paused<T>(fn: () => Promise<T>): Promise<T> {
    rl.pause();
    try {
      return await fn();
    } finally {
      rl.resume();
    }
  }

  async function handleSlash(line: string): Promise<void> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        stdout.write(HELP + "\n");
        break;
      case "model":
        if (!arg) {
          stdout.write(`model: ${settings.model}  (switch with /model <id>)\n`);
        } else {
          settings.model = arg;
          session.applyProvider({ provider: settings.provider, model: arg, apiKey: settings.apiKey });
          stdout.write(c(ANSI.green, `✓ model → ${arg}\n`));
        }
        break;
      case "provider": {
        if (arg !== "anthropic" && arg !== "openai") {
          stdout.write("usage: /provider anthropic|openai\n");
          break;
        }
        const cred = resolveCredential(arg, loadConfig());
        settings.provider = arg;
        settings.keySource = cred.source;
        settings.envVar = cred.envVar;
        settings.apiKey = cred.key;
        if (cred.source === "none") {
          stdout.write(c(ANSI.yellow, `⚠ no ${arg} key found — set ${cred.envVar} or run /login\n`));
        } else {
          session.applyProvider({ provider: arg, model: settings.model, apiKey: cred.key });
          stdout.write(c(ANSI.green, `✓ provider → ${arg} (key from ${cred.source})\n`));
        }
        break;
      }
      case "headless": {
        const on = arg === "" ? !settings.headless : arg === "on" || arg === "true";
        settings.headless = on;
        session.setHeadless(on);
        const note = session.chromeRunning() ? " — run /new to apply to the open browser" : "";
        stdout.write(c(ANSI.green, `✓ headless ${on ? "on" : "off"}${note}\n`));
        break;
      }
      case "new":
        await session.reset();
        stdout.write(c(ANSI.green, "✓ fresh conversation + browser\n"));
        break;
      case "store": {
        if (!arg) {
          const keys = await session.store.list("");
          stdout.write(keys.length ? keys.map((k) => "  " + k).join("\n") + "\n" : "(store empty)\n");
        } else {
          const value = await session.store.get(arg);
          stdout.write(value === undefined ? `(no key ${arg})\n` : JSON.stringify(value, null, 2) + "\n");
        }
        break;
      }
      case "skills": {
        const skills = await readSkillDescriptions(session.store);
        stdout.write(skills.length ? skills.map((s) => "  • " + s).join("\n") + "\n" : "(no skills yet)\n");
        break;
      }
      case "status": {
        const u = session.usage();
        stdout.write(
          [
            `provider:  ${settings.provider}`,
            `model:     ${settings.model}`,
            `key:       ${settings.keySource === "env" ? `env ${settings.envVar}` : settings.keySource === "config" ? "config file" : "none"}`,
            `headless:  ${settings.headless}`,
            `store:     ${settings.storePath}`,
            `browser:   ${session.chromeRunning() ? "running" : "not launched"}`,
            `usage:     ${u.inputTokens} in / ${u.outputTokens} out`,
          ].join("\n") + "\n",
        );
        break;
      }
      case "login": {
        // Cheap path: re-read env/config. If still no key (and interactive), run the wizard.
        let cred = resolveCredential(settings.provider, loadConfig());
        if (cred.source === "none") {
          await paused(() => runOnboarding());
          cred = resolveCredential(settings.provider, loadConfig());
        }
        const cfg = loadConfig();
        const next = resolveSettings({ provider: settings.provider, model: settings.model }, cfg);
        Object.assign(settings, next);
        if (settings.keySource !== "none") {
          session.applyProvider({ provider: settings.provider, model: settings.model, apiKey: settings.apiKey });
          stdout.write(c(ANSI.green, `✓ key reloaded (${settings.keySource})\n`));
        } else {
          stdout.write(c(ANSI.yellow, `⚠ still no ${settings.provider} key\n`));
        }
        break;
      }
      case "clear":
        stdout.write("\x1b[2J\x1b[H");
        break;
      case "exit":
      case "quit":
        quitting = true;
        rl.close();
        break;
      default:
        stdout.write(c(ANSI.dim, `unknown command /${cmd} — /help for the list\n`));
    }
  }

  rl.on("SIGINT", () => {
    if (running) {
      running.abort(); // cancel the run; the send() catch prints and we stay in the REPL
    } else {
      stdout.write("\n" + c(ANSI.dim, "(press Ctrl-D or type /exit to quit)") + "\n");
      rl.prompt();
    }
  });

  const closed = new Promise<void>((resolve) => {
    rl.on("close", () => {
      void session.close().finally(() => {
        stderr.write(c(ANSI.dim, "bye\n"));
        resolve();
      });
    });
  });

  rl.prompt();
  rl.on("line", (raw) => {
    const line = raw.trim();
    void (async () => {
      try {
        if (!line) return;
        if (line.startsWith("/")) {
          await handleSlash(line);
          return;
        }
        if (!session.chromeRunning()) stderr.write(c(ANSI.dim, "· starting Chrome…\n"));
        running = new AbortController();
        try {
          await session.send(line, running.signal);
        } catch (err) {
          if (isAbort(err)) stdout.write(c(ANSI.yellow, "\n⚠ cancelled — Chrome stays open\n"));
          else stdout.write(c(ANSI.red, "\n✗ " + errMsg(err)) + (errMsg(err).includes("rejected") ? c(ANSI.dim, "  (try /login)") : "") + "\n");
        } finally {
          running = null;
        }
      } finally {
        if (!quitting) rl.prompt();
      }
    })();
  });

  await closed;
}
