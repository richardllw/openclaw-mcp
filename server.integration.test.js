"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mcp-proxy-test-"));
  const requester = "agent:main:discord:direct:integration-test";
  const calls = [];
  const fakeGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const payload = JSON.stringify({ ok: true, result: { active: [], recent: [] } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });

  await new Promise((resolve) => fakeGateway.listen(0, "127.0.0.1", resolve));
  const port = fakeGateway.address().port;
  fs.mkdirSync(path.join(root, "workspace", "temp"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({ gateway: { port, auth: { mode: "token", token: "test-token" } } }),
    "utf8"
  );

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_WORKSPACE: path.join(root, "workspace"),
      OPENCLAW_REQUESTER_SESSION_KEY: requester,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });

  function rpc(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }) + "\n");
    });
  }

  function request(id, name, args) {
    return rpc(id, "tools/call", { name, arguments: args });
  }

  try {
    const toolList = await rpc(10, "tools/list", {});
    const message = toolList.result.tools.find((tool) => tool.name === "message");
    const spawnTool = toolList.result.tools.find((tool) => tool.name === "sessions_spawn");
    assert.ok(message.inputSchema.properties.to);
    assert.ok(message.inputSchema.properties.filePath);
    assert.ok(message.inputSchema.properties.components);
    assert.deepStrictEqual(spawnTool.inputSchema.properties.mode.enum, ["run", "session"]);
    assert.strictEqual(spawnTool.inputSchema.properties.thread.type, "boolean");

    const listed = await request(1, "subagents", { action: "list" });
    assert.strictEqual(listed.result.isError, false, stderr);
    assert.strictEqual(calls[0].sessionKey, requester);
    assert.strictEqual(calls[0].args.sessionKey, undefined);

    const image = await request(2, "image", { path: "/tmp/test.jpg", prompt: "describe" });
    assert.strictEqual(image.result.isError, false, stderr);
    assert.strictEqual(calls[1].sessionKey, requester);
    assert.strictEqual(calls[1].args.image, "/tmp/test.jpg");

    const yielded = await request(3, "sessions_yield", { timeoutMs: 100 });
    assert.strictEqual(yielded.result.isError, false, stderr);
    assert.strictEqual(calls[2].sessionKey, requester);
    assert.match(yielded.result.content[0].text, /no_pending_subagent/);

    // An agent-prefixed requester key already names its owner; sending agentId
    // too is rejected by the gateway when the two disagree.
    for (const call of calls) assert.strictEqual(call.agentId, undefined);
    process.stdout.write("server integration: requester fallback ok\n");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fakeGateway.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Since 2026.8 a multi-agent roster sets agents.ownership:"explicit", and the
// gateway rejects any session key without a named owner — including the bare
// "main" it falls back to when the proxy sends no sessionKey. Unscoped requests
// must therefore carry a top-level agentId or every tools/invoke fails with
// "has no explicit owner".
async function unscopedRequesterAddsAgentId() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mcp-proxy-agentid-"));
  const calls = [];
  const fakeGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { active: [], recent: [] } }));
    });
  });
  await new Promise((resolve) => fakeGateway.listen(0, "127.0.0.1", resolve));
  const port = fakeGateway.address().port;
  fs.mkdirSync(path.join(root, "workspace", "temp"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({
      gateway: { port, auth: { mode: "token", token: "test-token" } },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, dad: {} },
      },
    }),
    "utf8"
  );

  const env = { ...process.env, OPENCLAW_HOME: root, OPENCLAW_WORKSPACE: path.join(root, "workspace") };
  delete env.OPENCLAW_REQUESTER_SESSION_KEY;
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });

  try {
    await new Promise((resolve) => {
      pending.set(1, resolve);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "subagents", arguments: { action: "list" } },
      }) + "\n");
    });
    assert.strictEqual(calls.length, 1, stderr);
    assert.strictEqual(calls[0].sessionKey, undefined);
    assert.strictEqual(calls[0].agentId, "main");
    process.stdout.write("server integration: unscoped requester carries agentId ok\n");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fakeGateway.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// http.request's `timeout` only fires on socket inactivity, so a gateway that
// accepts the request and then never answers would pin the call until the MCP
// client gives up — losing the whole Claude turn instead of one tool call. The
// proxy enforces its own wall-clock deadline; this holds the request open and
// asserts the deadline fires and reports itself as a normal tool error.
async function gatewayWallClockTimeout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mcp-proxy-timeout-"));
  const held = [];
  const fakeGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // Hold the socket open without writing: an idle-timeout-only guard on a
      // trickling response would never fire here.
      if (call.args?.integrationHang === true) {
        held.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { active: [], recent: [] } }));
    });
  });
  await new Promise((resolve) => fakeGateway.listen(0, "127.0.0.1", resolve));
  const port = fakeGateway.address().port;
  fs.mkdirSync(path.join(root, "workspace", "temp"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({ gateway: { port, auth: { mode: "token", token: "test-token" } } }),
    "utf8"
  );

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_WORKSPACE: path.join(root, "workspace"),
      OPENCLAW_REQUESTER_SESSION_KEY: "agent:main:integration:timeout",
      OPENCLAW_MCP_GATEWAY_TOOL_TIMEOUT_MS: "100",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });

  try {
    const startedAt = Date.now();
    const timedOut = await new Promise((resolve) => {
      pending.set(1, resolve);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "subagents", arguments: { action: "list", integrationHang: true } },
      }) + "\n");
    });
    assert.strictEqual(timedOut.result.isError, true, stderr);
    assert.match(timedOut.result.content[0].text, /Gateway request timed out after 100ms/);
    // The deadline must be what ended the call, not the client or a socket idle timer.
    assert.ok(Date.now() - startedAt < 2000, "deadline did not fire promptly");
    process.stdout.write("server integration: gateway wall-clock timeout ok\n");
  } finally {
    for (const res of held) res.destroy();
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fakeGateway.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// OPENCLAW_MCP_ENABLED_TOOLS is a server-side boundary, so it must survive a
// client that ignores the advertised list and calls a name anyway.
async function serverSideAllowlist() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mcp-proxy-allowlist-"));
  const calls = [];
  const fakeGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { active: [], recent: [] } }));
    });
  });
  await new Promise((resolve) => fakeGateway.listen(0, "127.0.0.1", resolve));
  const port = fakeGateway.address().port;
  fs.mkdirSync(path.join(root, "workspace", "temp"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "openclaw.json"),
    JSON.stringify({ gateway: { port, auth: { mode: "token", token: "test-token" } } }),
    "utf8"
  );

  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      OPENCLAW_HOME: root,
      OPENCLAW_WORKSPACE: path.join(root, "workspace"),
      OPENCLAW_REQUESTER_SESSION_KEY: "agent:main:integration:allowlist",
      OPENCLAW_MCP_ENABLED_TOOLS: "subagents",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  try {
    const toolList = await rpc(1, "tools/list", {});
    assert.deepStrictEqual(
      toolList.result.tools.map((tool) => tool.name),
      ["subagents"],
      stderr
    );

    const allowed = await rpc(2, "tools/call", { name: "subagents", arguments: { action: "list" } });
    assert.strictEqual(allowed.result.isError, false, stderr);
    assert.strictEqual(calls.length, 1);

    // "read" is a proxy-local tool, so a client calling it unadvertised would
    // otherwise reach the filesystem without ever touching the gateway.
    const blocked = await rpc(3, "tools/call", { name: "read", arguments: { path: "/etc/hosts" } });
    assert.strictEqual(blocked.result, undefined, "disallowed tool must not return a result");
    assert.strictEqual(blocked.error.code, -32601);
    assert.match(blocked.error.message, /disabled by the server-side allowlist/);
    assert.strictEqual(calls.length, 1, "blocked call must not reach the gateway");
    process.stdout.write("server integration: server-side allowlist ok\n");
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => fakeGateway.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main()
  .then(unscopedRequesterAddsAgentId)
  .then(gatewayWallClockTimeout)
  .then(serverSideAllowlist)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
