import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient } from "./mcp-client";

test("MCP tool errors cannot silently become successful benchmark observations", { timeout: 3000 }, async () => {
  const script = `
    const rl = require('node:readline').createInterface({input:process.stdin});
    rl.on('line', line => {
      const request = JSON.parse(line);
      if (!request.id) return;
      const result = request.method === 'tools/call'
        ? {content:[{type:'text',text:'extraction failed'}],isError:true}
        : request.method === 'tools/list' ? {tools:[]} : {};
      console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
    });
  `;
  const client = new McpClient(process.execPath, ["-e", script]);
  try {
    await client.initialize();
    assert.deepEqual(await client.listTools(), []);
    assert.equal((await client.call("broken", {})).isError, true);
    await assert.rejects(client.callText("broken", {}), /extraction failed/);
  } finally { await client.close(); }
});

test("a crashed server rejects pending calls immediately", { timeout: 3000 }, async () => {
  const client = new McpClient(process.execPath, ["-e", "process.stdin.once('data',()=>process.exit(4))"]);
  try { await assert.rejects(client.initialize(), /MCP process exited/); }
  finally { await client.close(); }
});
