/** No-model browser-tool comparison. See README for scope and reproducibility. */
import { chromium, type Browser, type Page } from "playwright";
import { getEncoding } from "js-tiktoken";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, platform, arch, cpus } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { McpClient, type McpToolDef } from "../mcp-client";
import { startFixture, tasks, type TaskId } from "./fixture";
import { findRef, parseEvaluation } from "./refs";

type System = "pixelpi" | "playwright-mcp" | "playwright-script";
const systems: System[] = ["pixelpi", "playwright-mcp", "playwright-script"];
const option = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const repeats = Number(option("--repeats", "5"));
if (!Number.isInteger(repeats) || repeats < 1)
  throw new Error("--repeats must be a positive integer");
const out = resolve(option("--out", "bench/results/playwright-2026-10-26"));
mkdirSync(out, { recursive: true });
// Avoid overwriting raw trials from an earlier run.
const rawPath = join(out, "trials.jsonl");
writeFileSync(rawPath, "", { flag: "wx" });
const scratch = mkdtempSync(join(tmpdir(), "pixelpi-comparison-"));
const enc = getEncoding("o200k_base");
const tok = (text: string) => enc.encode(text).length;
const fixture = await startFixture();
const definitions: Partial<Record<System, McpToolDef[]>> = {};
const browserInfo: Partial<Record<System, unknown>> = {};
let viewport = { width: 800, height: 600 };

interface Call {
  name: string;
  args: unknown;
  text: string;
  isError: boolean;
  ms: number;
  inputTokens: number;
  outputTokens: number;
}
interface Driver {
  calls: Call[];
  bootMs: number;
  navigate(url: string): Promise<void>;
  fill(fields: { name: string; value: string }[]): Promise<void>;
  click(role: string, name: string): Promise<void>;
  select(name: string, value: string): Promise<void>;
  evaluate(fn: string): Promise<unknown>;
  close(): Promise<void>;
}

async function startDriver(
  system: System,
  run: string,
  frame = false,
): Promise<Driver> {
  const boot = performance.now();
  const calls: Call[] = [];
  if (system === "playwright-script") {
    const browser: Browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    const page: Page = await browser.newPage({ viewport });
    page.setDefaultTimeout(5000);
    const root = () => (frame ? page.frameLocator("iframe") : page);
    await page.goto(`${fixture.origin}/warmup`);
    browserInfo[system] = { version: browser.version(), viewport };
    return {
      calls,
      bootMs: performance.now() - boot,
      navigate: async (url) => {
        await page.goto(url, { waitUntil: "load" });
      },
      fill: async (fields) => {
        for (const f of fields)
          await page
            .getByRole("textbox", { name: f.name, exact: true })
            .fill(f.value);
      },
      click: async (role, name) => {
        await root()
          .getByRole(role as "button", { name, exact: true })
          .click();
      },
      select: async (name, value) => {
        await page
          .getByRole("combobox", { name, exact: true })
          .selectOption(value);
      },
      evaluate: async (fn) => page.evaluate(`(${fn})()`),
      close: async () => {
        await browser.close();
      },
    };
  }
  const mcpSystem: "pixelpi" | "playwright-mcp" = system;
  const client = new McpClient(
    process.execPath,
    system === "pixelpi"
      ? [
          "packages/agent/dist/cli.js",
          "mcp",
          "--headless",
          "--store",
          join(scratch, `${run}.json`),
        ]
      : [
          "node_modules/@playwright/mcp/cli.js",
          "--headless",
          "--browser",
          "chrome",
          "--isolated",
          "--viewport-size",
          `${viewport.width}x${viewport.height}`,
        ],
  );
  let snapshot = "";
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const start = performance.now();
    const response = await client.call(name, args);
    const ms = performance.now() - start;
    const text = client.text(response);
    calls.push({
      name,
      args,
      text,
      isError: !!response.isError,
      ms,
      inputTokens: 0,
      outputTokens: 0,
    });
    if (response.isError) throw new Error(text);
    // Evaluate responses are not snapshots and must not discard current refs.
    if (
      (system === "pixelpi" && name !== "eval") ||
      (system === "playwright-mcp" && name === "browser_snapshot")
    )
      snapshot = text;
    // This MCP release returns a file link after actions. Request the actual snapshot
    // through its public tool, count that extra call, and charge for all returned text.
    // A filename alone is not equivalent to PixelPi's inline page representation.
    if (
      system === "playwright-mcp" &&
      name !== "browser_snapshot" &&
      text.includes("- [Snapshot](")
    ) {
      await call("browser_snapshot", {});
    }
    return text;
  }
  async function target(role: string, name: string): Promise<string> {
    let ref = findRef(snapshot, mcpSystem, role, name);
    // Only page through results explicitly omitted by PixelPi; no hidden DOM access.
    while (!ref && system === "pixelpi") {
      const next = snapshot.match(/look again with offset=(\d+)/);
      if (!next) break;
      await call("look", { offset: Number(next[1]) });
      ref = findRef(snapshot, mcpSystem, role, name);
    }
    if (!ref)
      throw new Error(
        `Target absent from snapshot: ${role} ${JSON.stringify(name)}`,
      );
    return ref;
  }
  const driver: Driver = {
    calls,
    bootMs: 0,
    navigate: async (url) => {
      await call(
        system === "pixelpi" ? "nav" : "browser_navigate",
        system === "pixelpi" ? { action: "goto", arg: url } : { url },
      );
    },
    fill: async (fields) => {
      const resolved = [];
      for (const field of fields) {
        const ref = await target("textbox", field.name);
        resolved.push(
          system === "pixelpi"
            ? { ref: Number(ref), value: field.value }
            : {
                target: ref,
                name: field.name,
                type: "textbox",
                value: field.value,
              },
        );
      }
      await call(system === "pixelpi" ? "fill" : "browser_fill_form", {
        fields: resolved,
      });
    },
    click: async (role, name) => {
      const ref = await target(role, name);
      await call(
        system === "pixelpi" ? "act" : "browser_click",
        system === "pixelpi"
          ? { ref: Number(ref), op: "click" }
          : { target: ref, element: name },
      );
    },
    select: async (name, value) => {
      const ref = await target("combobox", name);
      await call(
        system === "pixelpi" ? "act" : "browser_select_option",
        system === "pixelpi"
          ? { ref: Number(ref), op: "select", value }
          : { target: ref, element: name, values: [value] },
      );
    },
    evaluate: async (fn) =>
      parseEvaluation(
        await call(
          system === "pixelpi" ? "eval" : "browser_evaluate",
          system === "pixelpi" ? { fn } : { function: fn },
        ),
        system,
      ),
    close: async () => {
      await client.close();
    },
  };
  try {
    await client.initialize();
    definitions[system] ??= await client.listTools();
    await driver.navigate(`${fixture.origin}/warmup`);
    // Measure PixelPi's native viewport and use the same dimensions for both baselines.
    if (system === "pixelpi")
      viewport = (await driver.evaluate(
        "() => ({width:innerWidth,height:innerHeight})",
      )) as typeof viewport;
    browserInfo[system] = await driver.evaluate(
      "() => ({userAgent:navigator.userAgent,width:innerWidth,height:innerHeight})",
    );
    driver.bootMs = performance.now() - boot;
    calls.length = 0;
    return driver;
  } catch (e) {
    client.close();
    throw e;
  }
}

async function perform(
  driver: Driver,
  task: TaskId,
  url: string,
): Promise<unknown> {
  await driver.navigate(url);
  switch (task) {
    case "extract":
      return driver.evaluate(
        '() => document.querySelector("#reference").textContent',
      );
    case "form":
    case "prefilled":
      await driver.fill([
        { name: "Name", value: "Ada Lovelace" },
        { name: "Email", value: "ada@example.test" },
        { name: "City", value: "London" },
      ]);
      await driver.click("button", "Save contact");
      break;
    case "search":
      await driver.fill([{ name: "Search catalog", value: "copper" }]);
      await driver.click("button", "Search");
      await driver.click("button", "Open copper details");
      break;
    case "select":
      await driver.select("Plan", "pro");
      await driver.click("button", "Save plan");
      break;
    case "checkbox":
      await driver.click("checkbox", "Email updates");
      await driver.click("button", "Save preferences");
      break;
    case "long-page":
      await driver.click("button", "Record 240");
      break;
    case "delayed":
      await driver.click("button", "Prepare");
      await driver.click("button", "Launch");
      break;
    case "shadow":
      await driver.click("button", "Shadow action");
      break;
    case "iframe":
      await driver.click("button", "Frame action");
      break;
  }
}

const sourceFiles = [
  "bench/comparison/run.ts",
  "bench/comparison/fixture.ts",
  "bench/comparison/refs.ts",
  "bench/mcp-client.ts",
  "pnpm-lock.yaml",
  ...execFileSync("git", ["ls-files", "packages"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((f) => f.endsWith(".ts")),
  "packages/cdp/src/frames.ts",
  "packages/cdp/src/browser-session.ts",
];
const manifest = {
  startedAt: new Date().toISOString(),
  repeats,
  tasks,
  pixelpiCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  pixelpiVersion: JSON.parse(
    readFileSync("packages/agent/package.json", "utf8"),
  ).version,
  playwrightMcpVersion: JSON.parse(
    readFileSync("node_modules/@playwright/mcp/package.json", "utf8"),
  ).version,
  playwrightVersion: JSON.parse(
    readFileSync("node_modules/playwright/package.json", "utf8"),
  ).version,
  environment: {
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
  },
  sourceHashes: Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  ),
  protocol: `Ten fixed synthetic tasks; fresh process/browser per trial; local fixture reset via unique run ID; defaults for action wait/settle; warmup and boot separate from task timing; rotating system order; ${repeats} repetitions; independent server-side exact event oracle; no LLM or retries; no adaptive repair; production source state identified by manifest hashes.`,
};
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
let failures = 0;
try {
  // Excluded calibration only establishes the native viewport, not a task result.
  const calibration = await startDriver("pixelpi", "calibration");
  await calibration.close();
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      const rotation = (repeat + index) % systems.length;
      const order = [...systems.slice(rotation), ...systems.slice(0, rotation)];
      for (const system of order) {
        const run = `${repeat}-${task.id}-${system}`;
        let driver: Driver | undefined;
        let error = "",
          returned: unknown,
          ms: number | null = null;
        try {
          driver = await startDriver(system, run, task.id === "iframe");
          const start = performance.now();
          try {
            returned = await perform(
              driver,
              task.id,
              `${fixture.origin}/${task.id}?run=${run}`,
            );
          } finally {
            ms = performance.now() - start;
          }
        } catch (e) {
          error = (e as Error).message;
        }
        // Judge outside task timing; give network event delivery up to 1 second.
        if (task.id !== "extract") {
          const deadline = Date.now() + 1000;
          while (!fixture.events.has(run) && Date.now() < deadline)
            await new Promise((r) => setTimeout(r, 20));
        }
        const events = fixture.events.get(run) ?? [];
        const actual =
          task.id === "extract"
            ? returned
            : events.length === 1
              ? events[0]
              : events;
        const pass =
          !error && JSON.stringify(actual) === JSON.stringify(task.expected);
        if (!pass) failures++;
        const calls = driver?.calls ?? [];
        // Count tokens only after the clock stops, so tokenization is not charged as browser latency.
        for (const c of calls) {
          c.inputTokens = tok(
            JSON.stringify({ name: c.name, arguments: c.args }),
          );
          c.outputTokens = tok(c.text);
        }
        const row = {
          repeat,
          task: task.id,
          group: task.group,
          system,
          pass,
          error,
          actual,
          expected: task.expected,
          ms,
          bootMs: driver?.bootMs ?? null,
          toolCalls: calls.length,
          inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
          outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
          toolErrors: calls.filter((c) => c.isError).length,
          falseSuccess: !!driver && !error && !pass,
          calls,
        };
        appendFileSync(rawPath, JSON.stringify(row) + "\n");
        console.error(
          `${repeat + 1}/${repeats} ${system.padEnd(17)} ${task.id.padEnd(10)} ${pass ? "PASS" : "FAIL"} ${ms?.toFixed(0) ?? "setup"}ms${error ? ` ${error.slice(0, 100).replace(/\n/g, " ")}` : ""}`,
        );
        await driver?.close();
      }
    }
  }
} finally {
  await fixture.close();
  // Stores are benchmark-specific; no user's browser profile or store is touched.
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(
    join(out, "tool-definitions.json"),
    JSON.stringify(definitions, null, 2) + "\n",
  );
  writeFileSync(
    join(out, "environment.json"),
    JSON.stringify(
      {
        viewport,
        browserInfo,
        definitionTokens: Object.fromEntries(
          Object.entries(definitions).map(([name, defs]) => [
            name,
            {
              tools: defs.length,
              pretty: tok(JSON.stringify(defs, null, 2)),
              compact: tok(JSON.stringify(defs)),
              normalizedCompact: tok(
                JSON.stringify(
                  defs.map(({ name, description, inputSchema }) => ({
                    name,
                    description,
                    inputSchema,
                  })),
                ),
              ),
            },
          ]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
}

if (process.argv.includes("--require-all-pass") && failures)
  process.exitCode = 1;
