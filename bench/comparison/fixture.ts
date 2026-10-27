import { createServer } from "node:http";

export const tasks = [
  { id: "extract", group: "core", description: "Read the current invoice reference", expected: "INV-2048" },
  { id: "search", group: "core", description: "Search for copper, then open its details", expected: { item: "copper" } },
  { id: "form", group: "core", description: "Fill and save a blank contact form", expected: { name: "Ada Lovelace", email: "ada@example.test", city: "London" } },
  { id: "select", group: "core", description: "Choose the Pro plan and save", expected: { plan: "pro" } },
  { id: "checkbox", group: "core", description: "Enable email updates and save", expected: { updates: true } },
  { id: "long-page", group: "core", description: "Open Record 240 on a page with 240 buttons", expected: { record: 240 } },
  { id: "prefilled", group: "stress", description: "Replace existing values in a contact form", expected: { name: "Ada Lovelace", email: "ada@example.test", city: "London" } },
  { id: "delayed", group: "stress", description: "Prepare, then click Launch as it becomes enabled after 900ms", expected: { launched: true } },
  { id: "shadow", group: "stress", description: "Activate a button inside an open shadow root", expected: { shadow: true } },
  { id: "iframe", group: "stress", description: "Activate a button inside a same-origin iframe", expected: { frame: true } },
] as const;
export type TaskId = typeof tasks[number]["id"];

export async function startFixture() {
  const events = new Map<string, unknown[]>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const run = url.searchParams.get("run") ?? "";
    if (url.pathname === "/event" && req.method === "POST") {
      let body = "";
      for await (const part of req) body += part;
      try { events.set(run, [...(events.get(run) ?? []), JSON.parse(body)]); }
      catch { res.writeHead(400); res.end(); return; }
      res.end("ok"); return;
    }
    const task = url.pathname.slice(1) as TaskId;
    const send = `async function send(value){await fetch('/event?run='+encodeURIComponent(${JSON.stringify(run)}),{method:'POST',body:JSON.stringify(value)});document.querySelector('#status').textContent='Saved';}`;
    const form = `<form id="contact"><label>Name <input name="name" value="${task === "prefilled" ? "Old Name" : ""}"></label><label>Email <input name="email" value="${task === "prefilled" ? "old@example.test" : ""}"></label><label>City <input name="city" value="${task === "prefilled" ? "Paris" : ""}"></label><button>Save contact</button></form>`;
    let body = "", script = "";
    switch (task) {
      case "extract": body = '<h1>Invoice</h1><p id="reference">INV-2048</p>'; break;
      case "form": case "prefilled": body = form; script = `document.querySelector('#contact').onsubmit=e=>{e.preventDefault();send(Object.fromEntries(new FormData(e.target)));}`; break;
      case "search": body = '<label>Search catalog <input id="query"></label><button id="search">Search</button><section id="results"></section>'; script = `document.querySelector('#search').onclick=()=>{if(document.querySelector('#query').value==='copper'){document.querySelector('#results').innerHTML='<button id="details">Open copper details</button>';document.querySelector('#details').onclick=()=>send({item:'copper'});}};`; break;
      case "select": body = '<label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label><button id="save">Save plan</button>'; script = `document.querySelector('#save').onclick=()=>send({plan:document.querySelector('#plan').value});`; break;
      case "checkbox": body = '<label><input type="checkbox" id="updates">Email updates</label><button id="save">Save preferences</button>'; script = `document.querySelector('#save').onclick=()=>send({updates:document.querySelector('#updates').checked});`; break;
      case "long-page": body = Array.from({length:240},(_,i)=>`<p><button data-record="${i+1}">Record ${i+1}</button></p>`).join(""); script = `document.querySelectorAll('[data-record]').forEach(b=>b.onclick=()=>send({record:Number(b.dataset.record)}));`; break;
      case "delayed": body = '<button id="prepare">Prepare</button><button id="launch" disabled>Launch</button>'; script = `document.querySelector('#prepare').onclick=()=>setTimeout(()=>document.querySelector('#launch').disabled=false,900);document.querySelector('#launch').onclick=()=>send({launched:true});`; break;
      case "shadow": body = '<div id="host"></div>'; script = `const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<button>Shadow action</button>';root.querySelector('button').onclick=()=>send({shadow:true});`; break;
      case "iframe": body = `<iframe title="Embedded action" src="/frame?run=${encodeURIComponent(run)}"></iframe>`; break;
      default: if (url.pathname === "/frame") { body = '<button id="frame">Frame action</button>'; script = `document.querySelector('#frame').onclick=()=>send({frame:true});`; } else body = "Warmup";
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(`<!doctype html><html lang="en"><head><title>Controlled browser benchmark</title><style>body{font:16px sans-serif;padding:24px}label{display:block;margin:12px 0}button,input,select{font:inherit}iframe{width:500px;height:140px}</style></head><body>${body}<p id="status" role="status"></p><script>${send}${script}</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to start");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    events,
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  };
}
