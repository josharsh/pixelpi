import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { launchChrome, createBrowserTools } from "@josharsh/pixelpi-cdp";
import { MemoryStore } from "@josharsh/pixelpi-core";
import { replayTrace } from "../../packages/agent/src/replay.ts";

const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  const url = new URL(req.url!, "http://localhost");
  if (url.pathname === "/child")
    return res.end(
      `<button onclick="this.textContent='Clicked'">Frame action</button><label>Frame input<input value="old"></label>`,
    );
  if (url.pathname === "/nested")
    return res.end(`<iframe src="/child" style="margin:20px"></iframe>`);
  if (url.pathname === "/frame")
    return res.end(
      `<h1>Parent</h1><iframe style="margin:30px;width:500px;height:300px" src="http://${url.searchParams.get("cross") ? "localhost" : "127.0.0.1"}:${port}/${url.searchParams.get("nested") ? "nested" : "child"}"></iframe>`,
    );
  res.end(`<h1>Fixture</h1><label>Name<input value="old"></label><label>Notes<textarea>old notes</textarea></label><div role="textbox" aria-label="Editable" contenteditable>old content</div>
<button id="wait" disabled onclick="this.textContent='Done'">Delayed</button><button disabled>Disabled forever</button>
<button id="covered" onclick="this.textContent='WRONG'">Covered</button><div id="overlay" style="position:fixed;inset:0;z-index:999;display:none"></div>
<script>setTimeout(()=>document.getElementById('wait').disabled=false,350);window.inputs=[];document.addEventListener('input',e=>inputs.push({value:e.target.value,trusted:e.isTrusted}));</script>`);
});
let port: number;
const context = () => ({
  signal: new AbortController().signal,
  emit: () => {},
});

test("real Chrome browser readiness", { timeout: 120000 }, async (t) => {
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const browser = await launchChrome({
    headless: true,
    args: ["--site-per-process"],
  });
  t.after(async () => {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const tools = new Map(
    createBrowserTools({
      session: browser.session,
      store: new MemoryStore(),
      timeoutMs: 900,
    }).map((t) => [t.name, t]),
  );
  const call = async (
    name: string,
    input: Record<string, unknown>,
    ctx = context(),
  ) => tools.get(name)!.execute(input, ctx);
  const good = async (name: string, input: Record<string, unknown>) => {
    const r = await call(name, input);
    assert.ok(!r.isError, r.content);
    return r;
  };
  const go = () => good("nav", { action: "goto", arg: origin });
  const value = async (fn: string) =>
    (
      (await good("eval", { fn, opts: { world: "main" } })).observation as {
        value: unknown;
      }
    ).value;
  const ref = async (name: string) => {
    const r = await good("look", {});
    const refs = (
      r.observation as { refs: { name: string; ref: number; role: string }[] }
    ).refs;
    const hit = refs.find(
      (r) => r.name === name && ["button", "textbox"].includes(r.role),
    );
    assert.ok(hit, JSON.stringify(refs));
    return hit.ref;
  };
  await t.test(
    "replacement, clearing, contenteditable and trusted input events",
    async () => {
      await go();
      for (const [name, text] of [
        ["Name", "Ada"],
        ["Notes", "multi\nline"],
        ["Editable", "new content"],
      ])
        await good("fill", { fields: [{ ref: await ref(name), value: text }] });
      assert.deepEqual(
        await value(
          '()=>[document.querySelector("input").value,document.querySelector("textarea").value,document.querySelector("[contenteditable]").innerText]',
        ),
        ["Ada", "multi\nline", "new content"],
      );
      assert.equal(
        await value("()=>inputs.length>0&&inputs.every(e=>e.trusted)"),
        true,
      );
      await good("fill", { fields: [{ ref: await ref("Name"), value: "" }] });
      assert.equal(
        await value('()=>document.querySelector("input").value'),
        "",
      );
    },
  );
  await t.test("missing refs fail before any fields are changed", async () => {
    await go();
    const id = await ref("Name");
    assert.equal(
      (
        await call("fill", {
          fields: [
            { ref: id, value: "wrong" },
            { ref: 99999, value: "bad" },
          ],
        })
      ).isError,
      true,
    );
    assert.equal(
      await value('()=>document.querySelector("input").value'),
      "old",
    );
    assert.equal(
      (await call("act", { ref: 99999, op: "click" })).isError,
      true,
    );
  });
  await t.test(
    "waits for enabled state and refuses covered or permanently disabled targets",
    async () => {
      await go();
      await good("act", { ref: await ref("Delayed"), op: "click" });
      assert.equal(
        await value('()=>document.querySelector("#wait").textContent'),
        "Done",
      );
      assert.equal(
        (await call("act", { ref: await ref("Disabled forever"), op: "click" }))
          .isError,
        true,
      );
      const covered = await ref("Covered");
      await value(
        '()=>document.querySelector("#overlay").style.display="block"',
      );
      assert.equal(
        (await call("act", { ref: covered, op: "click" })).isError,
        true,
      );
      assert.equal(
        await value('()=>document.querySelector("#covered").textContent'),
        "Covered",
      );
    },
  );
  for (const query of ["", "?nested=1", "?cross=1", "?cross=1&nested=1"])
    await t.test(`frame actions and inputs ${query}`, async () => {
      await good("nav", { action: "goto", arg: origin + "/frame" + query });
      await good("fill", {
        fields: [{ ref: await ref("Frame input"), value: "frame value" }],
      });
      await good("act", { ref: await ref("Frame action"), op: "click" });
      assert.ok(await ref("Clicked"));
    });
  await t.test(
    "frame replacement invalidates old nodes and a fresh look discovers the replacement",
    async () => {
      await good("nav", { action: "goto", arg: origin + "/frame?cross=1" });
      const old = await ref("Frame action");
      await value('()=>document.querySelector("iframe").remove()');
      assert.equal(
        (await call("act", { ref: old, op: "click" })).isError,
        true,
      );
      await value(
        `()=>{const f=document.createElement('iframe');f.src=${JSON.stringify(origin + "/child")};document.body.append(f);return new Promise(r=>f.onload=()=>r(true));}`,
      );
      await good("act", { ref: await ref("Frame action"), op: "click" });
      assert.ok(await ref("Clicked"));
    },
  );
  await t.test(
    "controlled input rejection and stale refs report errors",
    async () => {
      await go();
      const id = await ref("Name");
      await value(
        '()=>document.querySelector("input").addEventListener("input",()=>setTimeout(()=>document.querySelector("input").value="rejected",100))',
      );
      assert.equal(
        (await call("fill", { fields: [{ ref: id, value: "requested" }] }))
          .isError,
        true,
      );
      await value('()=>document.querySelector("input").remove()');
      assert.equal(
        (await call("fill", { fields: [{ ref: id, value: "stale" }] })).isError,
        true,
      );
    },
  );
  await t.test("new tabs and switching use the selected target", async () => {
    await go();
    const { targetInfo } = await browser.session.send<{
      targetInfo: { targetId: string };
    }>("Target.getTargetInfo");
    await good("eval", {
      fn: '()=>document.title="original"',
      opts: { world: "main" },
    });
    await good("nav", { action: "newtab", arg: origin + "/child" });
    assert.equal(await value("()=>location.pathname"), "/child");
    await good("nav", { action: "switchtab", arg: targetInfo.targetId });
    assert.equal(await value("()=>document.title"), "original");
  });
  await t.test("navigation and wait errors cannot report success", async () => {
    assert.equal(
      (await call("nav", { action: "goto", arg: "http://127.0.0.1:1" }))
        .isError,
      true,
    );
    await go();
    assert.equal(
      (await call("nav", { action: "waitfor", arg: "missing-unique-text" }))
        .isError,
      true,
    );
  });
  await t.test("screenshots carry real PNG data", async () => {
    const r = await good("look", { mode: "screenshot" });
    assert.equal(r.images?.[0].mimeType, "image/png");
    assert.equal(
      Buffer.from(r.images![0].data, "base64").subarray(1, 4).toString(),
      "PNG",
    );
  });
  await t.test(
    "abort interrupts page and host eval and the session recovers",
    async () => {
      const hostResult = await good("eval", {
        fn: "(a)=>a+1",
        args: [41],
        opts: { host: true },
      });
      assert.equal((hostResult.observation as { value: unknown }).value, 42);
      for (const host of [false, true]) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 150);
        const start = Date.now();
        const r = await call(
          "eval",
          { fn: "()=>new Promise(()=>{})", opts: { host } },
          { signal: ac.signal, emit: () => {} },
        );
        clearTimeout(timer);
        assert.equal(r.isError, true);
        assert.match(r.content, /abort|cancel/i);
        assert.ok(Date.now() - start < 3000);
        assert.equal(await value("()=>42"), 42);
      }
    },
  );
  await t.test(
    "operation deadline bounds infinite page and host code",
    async () => {
      const bounded = createBrowserTools({
        session: browser.session,
        store: new MemoryStore(),
        operationTimeoutMs: 300,
      }).find((t) => t.name === "eval")!;
      for (const host of [false, true]) {
        const start = Date.now();
        const r = await bounded.execute(
          { fn: "()=>{while(true){}}", opts: { host } },
          context(),
        );
        assert.equal(r.isError, true);
        assert.ok(Date.now() - start < 3000, r.content);
        assert.equal(await value("()=>42"), 42);
      }
    },
  );
  await t.test(
    "replay propagates errors, separates recorded text, and validates assertions",
    async () => {
      const base = {
        version: 1,
        task: "test",
        model: "unused",
        createdAt: new Date().toISOString(),
        steps: [],
        result: { finalText: "old answer" },
      };
      const settings = {
        headless: true,
        storePath: "/tmp/pixelpi-readiness-unused.json",
        provider: "anthropic",
        model: "unused",
        keySource: "none",
        envVar: "ANTHROPIC_API_KEY",
      } as any;
      const run = (trace: any) =>
        replayTrace({
          trace,
          settings,
          tracePath: "/tmp/pixelpi-readiness-unused-trace.json",
          heal: false,
          store: new MemoryStore(),
        });
      const failed = await run({
        ...base,
        steps: [
          {
            tool: "eval",
            input: { fn: '()=>{throw new Error("Required heading missing")}' },
          },
        ],
      });
      assert.equal(failed.ok, false);
      assert.match(failed.error!, /Required heading missing/);
      assert.equal(failed.steps[0].status, "error");
      const fresh = await run({
        ...base,
        steps: [{ tool: "eval", input: { fn: "()=>42" } }],
        assertions: [{ fn: "()=>true", equals: true }],
      });
      assert.equal(fresh.output, 42);
      assert.equal(fresh.finalText, undefined);
      assert.equal(fresh.recordedFinalText, "old answer");
      assert.equal(fresh.verified, true);
      const mismatch = await run({
        ...base,
        assertions: [{ fn: "()=>false", equals: true }],
      });
      assert.equal(mismatch.ok, false);
      const multiTab = await run({
        ...base,
        steps: [
          {
            tool: "eval",
            input: {
              fn: '()=>document.title="original"',
              opts: { world: "main" },
            },
          },
          {
            tool: "nav",
            input: { action: "newtab", arg: origin + "/child", tab: 1 },
          },
          { tool: "nav", input: { action: "switchtab", tab: 0 } },
          { tool: "eval", input: { fn: "()=>document.title" } },
        ],
      });
      assert.equal(multiTab.ok, true, multiTab.error);
      assert.equal(multiTab.output, "original");
      const missing = await run({
        ...base,
        output: { from: "none", required: true },
      });
      assert.equal(missing.ok, false);
    },
  );
});
