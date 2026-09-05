#!/usr/bin/env node
/**
 * OpenClaw MCP Proxy Server
 * Exposes all OpenClaw tools over MCP stdio, proxying calls to /tools/invoke.
 *
 * Usage (add to Claude Code ~/.claude.json):
 *   "mcpServers": {
 *     "openclaw": {
 *       "command": "node",
 *       "args": ["/absolute/path/to/openclaw-mcp/server.js"]
 *     }
 *   }
 */

const http = require("http");
const fs = require("fs");
const fspath = require("path");
const readline = require("readline");
const { exec: nodeExec, execFile: nodeExecFile } = require("child_process");
const { createPendingYieldStore } = require("./pending-yield-store");

const OPENCLAW_HOME = process.env.OPENCLAW_HOME
  || fspath.join(require("node:os").homedir(), ".openclaw");
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE
  || fspath.join(OPENCLAW_HOME, "workspace");

function parseCsvEnv(name) {
  return new Set(
    String(process.env[name] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function parsePositiveIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Optional server-side restriction for least-privilege bridges. Enforced by the
// proxy itself; a client-side MCP enabled_tools list is not a security boundary
// because a different MCP client could ignore it. Empty means allow everything.
const CONFIGURED_TOOL_ALLOWLIST = parseCsvEnv("OPENCLAW_MCP_ENABLED_TOOLS");

function isToolAllowed(name) {
  return CONFIGURED_TOOL_ALLOWLIST.size === 0 || CONFIGURED_TOOL_ALLOWLIST.has(name);
}

// Anthropic closes an idle tool-use turn at roughly five minutes, so the default
// deadline stays under that boundary: a recoverable MCP error beats losing the
// whole turn to "Connection closed mid-response".
const GATEWAY_TOOL_TIMEOUT_MS = parsePositiveIntEnv(
  "OPENCLAW_MCP_GATEWAY_TOOL_TIMEOUT_MS",
  240000
);

// ── Config ──────────────────────────────────────────────────────────────────

// gateway.auth.token / .password may be either a literal string or a secret
// reference {source:"file"|"env", provider, id}. Older configs used literals;
// once the value moves into secrets.providers, string-concatenating the object
// yields "Bearer [object Object]" and every gateway tool fails with 401.
function resolveSecretRef(cfg, ref) {
  if (ref == null) return "";
  if (typeof ref === "string") return ref;
  if (typeof ref !== "object") return "";

  if (ref.source === "env") {
    return process.env[ref.id || ref.name] || "";
  }
  if (ref.source !== "file") {
    throw new Error("Unsupported secret source: " + ref.source);
  }

  const provider = ((cfg.secrets || {}).providers || {})[ref.provider];
  if (!provider) throw new Error("Unknown secret provider: " + ref.provider);
  const raw = fs.readFileSync(provider.path, "utf8");

  if (provider.mode === "json") {
    // ref.id is a JSON pointer, e.g. "/config/gatewayAuthToken"
    let node = JSON.parse(raw);
    for (const seg of String(ref.id || "").split("/").filter(Boolean)) {
      node = node?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    if (typeof node !== "string") {
      throw new Error("Secret " + ref.provider + ref.id + " is not a string");
    }
    return node;
  }
  return raw.trim();
}

function loadGatewayConfig() {
  const cfg = JSON.parse(
    fs.readFileSync(fspath.join(OPENCLAW_HOME, "openclaw.json"), "utf8")
  );
  const gw = cfg.gateway || {};
  const auth = gw.auth || {};
  const token = resolveSecretRef(cfg, auth.token)
    || process.env.OPENCLAW_GATEWAY_TOKEN
    || "";
  const mode = auth.mode || "token";
  const password = resolveSecretRef(cfg, auth.password);
  if (mode === "token" && !token) {
    throw new Error("gateway.auth.mode is 'token' but no token could be resolved");
  }
  return {
    port: gw.port || 18789,
    token,
    mode,
    password,
    requesterAgentId: resolveRequesterAgentId(cfg),
  };
}

// Since 2026.8, a multi-agent roster sets `agents.ownership: "explicit"`, and the
// gateway refuses to resolve a session key that does not name an owner — including
// the bare "main" it falls back to when no sessionKey is sent. Every tools/invoke
// then fails with "has no explicit owner". Requests must therefore carry either an
// agent-prefixed session key or a top-level agentId.
function resolveRequesterAgentId(cfg) {
  const agents = cfg.agents || {};
  const configured = agents.defaults?.systemAgent?.agentId;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  const ids = Object.keys(agents.entries || {});
  // A single-agent roster resolves unambiguously on its own; leave it alone.
  return ids.length === 1 ? ids[0] : "main";
}

// Agent-prefixed keys are `agent:<agent-id>:<session-key>` and already name their
// owner. Sending agentId alongside one is rejected when the two disagree
// ("does not match session key agent"), so only supply it for unscoped keys.
function isAgentScopedSessionKey(sessionKey) {
  return typeof sessionKey === "string" && /^agent:[^:]+:.+/.test(sessionKey);
}

let gwConfig;
try {
  gwConfig = loadGatewayConfig();
} catch (e) {
  process.stderr.write("[openclaw-mcp] Failed to load config: " + e.message + "\n");
  process.exit(1);
}

// ── Simulated yield state ─────────────────────────────────────────────────────
// Each run is persisted in its own atomically-renamed file. This avoids the
// lost-update race from a shared read/modify/write JSON array when multiple
// Claude CLI gateway requests spawn subagents concurrently. Reads are scoped to
// the requester session so one conversation never waits on another's children.
const pendingYieldStore = createPendingYieldStore({
  dir: fspath.join(OPENCLAW_WORKSPACE, "temp", "openclaw-mcp-pending-yields"),
  legacyFile: fspath.join(OPENCLAW_WORKSPACE, "temp", ".pending_yield_runids.json"),
});

async function simulatedYield(timeoutMs, callerSessionKey) {
  const maxWait = timeoutMs || 30 * 60 * 1000; // default 30 min
  const pollInterval = 5000; // 5s
  const startTime = Date.now();

  const scopedSessionKey = normalizeOptionalSessionKey(callerSessionKey);
  let pending = pendingYieldStore.read(scopedSessionKey);

  // Fallback: if no captured runIds, check active subagent list
  if (pending.length === 0) {
    process.stderr.write("[openclaw-mcp] sessions_yield: no pending runIds in file, trying fallback\n");
    let listResult;
    try {
      listResult = await invokeGatewayTool("subagents", { action: "list" }, scopedSessionKey);
    } catch (e) {
      return JSON.stringify({ status: "error", message: "Could not list subagents: " + e.message });
    }
    let parsed;
    try {
      parsed = typeof listResult === "string" ? JSON.parse(listResult) : listResult;
      if (parsed?.content?.[0]?.text) { try { parsed = JSON.parse(parsed.content[0].text); } catch (_) {} }
    } catch (_) {}
    const active = Array.isArray(parsed?.active) ? parsed.active : [];
    if (active.length === 0) {
      return JSON.stringify({ status: "no_pending_subagent", message: "No active subagents found to yield on." });
    }
    pending = active.map(s => ({ runId: s.runId || s.id, sessionKey: scopedSessionKey || null })).filter(e => e.runId);
    process.stderr.write("[openclaw-mcp] sessions_yield: fallback runIds=" + pending.map(e => e.runId).join(",") + "\n");
  }

  process.stderr.write("[openclaw-mcp] sessions_yield: waiting for " + pending.length + " subagent(s): " + pending.map(e => e.runId).join(",") + "\n");

  const remaining = new Map(pending.map(e => [e.runId, e]));
  const completedEntries = [];

  // The gateway scopes `subagents list` to the requester session, so poll once
  // per distinct sessionKey among pending entries (plus the caller's, as fallback).
  const distinctKeys = [...new Set([...remaining.values()].map(e => e.sessionKey || scopedSessionKey || null))];

  while (Date.now() - startTime < maxWait) {
    const active = [];
    const recent = [];
    let anyListOk = false;
    for (const key of distinctKeys) {
      let listResult;
      try {
        listResult = await invokeGatewayTool("subagents", { action: "list" }, key || undefined);
      } catch (e) { continue; }
      let parsed;
      try {
        parsed = typeof listResult === "string" ? JSON.parse(listResult) : listResult;
      } catch (_) { continue; }
      anyListOk = true;
      if (Array.isArray(parsed?.active)) active.push(...parsed.active);
      if (Array.isArray(parsed?.recent)) recent.push(...parsed.recent);
    }
    if (!anyListOk) {
      await new Promise(r => setTimeout(r, pollInterval));
      continue;
    }

    for (const runId of [...remaining.keys()]) {
      const isActive = active.some(s => s.runId === runId || s.id === runId);
      if (!isActive) {
        const completedEntry = recent.find(s => s.runId === runId || s.id === runId);
        completedEntries.push({ runId, subagent: completedEntry || null });
        remaining.delete(runId);
        pendingYieldStore.remove(runId);
        process.stderr.write("[openclaw-mcp] sessions_yield: subagent " + runId + " completed\n");
      }
    }

    if (remaining.size === 0) {
      return JSON.stringify({
        status: "completed",
        count: completedEntries.length,
        elapsed: Math.round((Date.now() - startTime) / 1000) + "s",
        subagents: completedEntries,
      });
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  return JSON.stringify({
    status: "timeout",
    pending: [...remaining.keys()],
    message: "Some subagents did not complete within the timeout window.",
  });
}

// ── Tool definitions ─────────────────────────────────────────────────────────
// Local tools are implemented in this file. Gateway tool schemas are loaded
// from tools-schema.json, generated from the openclaw dist by
// regen-tools-schema.mjs — rerun it after every OpenClaw upgrade.

const LOCAL_TOOL_DEFS = [
  {
    name: "read",
    description: "Read the contents of a file at the specified path",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        encoding: { type: "string", description: "File encoding, defaults to utf-8" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write content to a file, creating directories if needed",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Edit a file by replacing oldString with newString",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit" },
        oldString: { type: "string", description: "The text to replace" },
        newString: { type: "string", description: "The replacement text" },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  {
    name: "exec",
    description: "Execute a bash command and return the output",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to execute" },
        cwd: { type: "string", description: "Working directory for the command" },
      },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern like **/*.ts" },
        cwd: { type: "string", description: "Base directory for the search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search for a pattern in files",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in" },
        include: { type: "string", description: "File pattern to include, e.g., *.ts" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "process",
    description: "Manage background exec sessions",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action: start, stop, poll, list, kill" },
        command: { type: "string" },
        sessionId: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["action"],
    },
  },
];

// sessions_yield is intercepted by this proxy (simulatedYield) rather than
// forwarded, so its schema stays proxy-owned too.
const SESSIONS_YIELD_DEF = {
  name: "sessions_yield",
  description:
    "Suspend current turn and wait for the last spawned subagent to complete. Returns when done so the response routes back to the originating channel. Optional timeoutMs (default: 1800000 = 30min).",
  inputSchema: {
    type: "object",
    properties: {
      timeoutMs: { type: "number", description: "Max wait in milliseconds (default 1800000 = 30min)" },
      sessionKey: {
        type: "string",
        description:
          "Requester session key fallback for polling when no pending runIds were captured (normally unnecessary — spawn records each runId with its sessionKey).",
      },
    },
  },
};

const SCHEMA_FILE = fspath.join(__dirname, "tools-schema.json");
let gatewayToolDefs;
try {
  const parsed = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
  gatewayToolDefs = parsed.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  process.stderr.write(
    "[openclaw-mcp] Loaded " + gatewayToolDefs.length + " gateway tool schemas (openclaw " + parsed.openclawVersion + ", generated " + parsed.generatedAt + ")\n"
  );
} catch (e) {
  process.stderr.write(
    "[openclaw-mcp] Failed to load tools-schema.json (" + e.message + ") — run regen-tools-schema.mjs\n"
  );
  process.exit(1);
}

const PROXY_OWNED = new Set([...LOCAL_TOOL_DEFS.map((t) => t.name), SESSIONS_YIELD_DEF.name]);
const TOOLS = [
  ...LOCAL_TOOL_DEFS,
  SESSIONS_YIELD_DEF,
  ...gatewayToolDefs.filter((t) => !PROXY_OWNED.has(t.name)),
].filter((t) => isToolAllowed(t.name));

// ── Local tool implementations ───────────────────────────────────────────────
// These tools are implemented directly using Node.js built-ins
// instead of proxying to the gateway HTTP endpoint.

const LOCAL_TOOLS = new Set(["exec", "read", "write", "edit", "glob", "grep", "process"]);

// Background process sessions for `process` tool
const bgSessions = new Map();
let bgSessionCounter = 0;

async function invokeLocalTool(name, args) {
  switch (name) {
    case "read": {
      const { path: filePath, encoding = "utf8" } = args;
      if (!filePath) throw new Error("path is required");
      return fs.readFileSync(filePath, encoding);
    }

    case "write": {
      const { path: filePath, content } = args;
      if (!filePath) throw new Error("path is required");
      const dir = fspath.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content != null ? content : "", "utf8");
      return "Written to " + filePath;
    }

    case "edit": {
      const { path: filePath, oldString, newString } = args;
      if (!filePath || oldString === undefined || newString === undefined)
        throw new Error("path, oldString, and newString are required");
      const original = fs.readFileSync(filePath, "utf8");
      if (!original.includes(oldString))
        throw new Error("oldString not found in " + filePath);
      // Use split/join to avoid special replacement pattern interpretation
      const parts = original.split(oldString);
      const updated = parts[0] + newString + parts.slice(1).join(oldString);
      fs.writeFileSync(filePath, updated, "utf8");
      return "Edited " + filePath;
    }

    case "exec": {
      const { command, cwd } = args;
      if (!command) throw new Error("command is required");
      return new Promise((resolve, reject) => {
        nodeExec(command, { cwd: cwd || process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          let out = (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
          if (err && !stdout) {
            reject(new Error(stderr || err.message));
          } else {
            if (err) out += "\n[exit code " + (typeof err.code === "number" ? err.code : 1) + "]";
            resolve(out.trim());
          }
        });
      });
    }

    case "glob": {
      const { pattern, cwd: baseCwd } = args;
      if (!pattern) throw new Error("pattern is required");
      const base = baseCwd || process.cwd();
      return new Promise((resolve, reject) => {
        // Exclude common large dirs to avoid maxBuffer overflow
        const findCmd = "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/__pycache__/*' | sort";
        nodeExec(findCmd, { cwd: base, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(err);
          const lines = stdout.trim().split("\n").filter(Boolean).map(function(l) {
            return l.replace(/^\.\//, "");
          });
          // Convert glob pattern to regex
          var regexStr = "";
          var i = 0;
          while (i < pattern.length) {
            if (pattern[i] === "*" && pattern[i + 1] === "*") {
              regexStr += ".*";
              i += 2;
              if (pattern[i] === "/") i++;
            } else if (pattern[i] === "*") {
              regexStr += "[^/]*";
              i++;
            } else if (pattern[i] === "?") {
              regexStr += "[^/]";
              i++;
            } else if (".+^${}()|[]\\".indexOf(pattern[i]) >= 0) {
              regexStr += "\\" + pattern[i];
              i++;
            } else {
              regexStr += pattern[i];
              i++;
            }
          }
          var regex = new RegExp("^" + regexStr + "$");
          var matches = lines.filter(function(l) { return regex.test(l); });
          resolve(matches.join("\n"));
        });
      });
    }

    case "grep": {
      const { pattern, path: searchPath, include } = args;
      if (!pattern) throw new Error("pattern is required");
      const target = searchPath || process.cwd();
      // execFile: no shell involved, so regex metacharacters ($, backticks, quotes)
      // in the pattern reach grep verbatim instead of being shell-expanded.
      const grepArgs = ["-rn", "-E"];
      if (include) grepArgs.push("--include=" + include);
      grepArgs.push("--", pattern, target);
      return new Promise((resolve) => {
        nodeExecFile("grep", grepArgs, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
          // grep exits with 1 when no matches — not an error
          const lines = (stdout || "").split("\n").filter(Boolean).slice(0, 500);
          resolve(lines.join("\n") || "(no matches)");
        });
      });
    }

    case "process": {
      const { action, command, sessionId, timeout } = args;
      if (action === "start") {
        if (!command) throw new Error("command is required for start");
        const sid = "bg-" + (++bgSessionCounter);
        const proc = { output: "", done: false, exitCode: null, startedAt: Date.now() };
        bgSessions.set(sid, proc);
        const child = nodeExec(command, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          proc.output += (stdout || "") + (stderr ? "\n[stderr]\n" + stderr : "");
          proc.done = true;
          proc.exitCode = err ? (err.code || 1) : 0;
        });
        if (child.stdout) child.stdout.on("data", function(d) { proc.output += d; });
        if (child.stderr) child.stderr.on("data", function(d) { proc.output += d; });
        return JSON.stringify({ sessionId: sid, status: "started" });
      }
      if (action === "poll") {
        const s = bgSessions.get(sessionId);
        if (!s) throw new Error("Session " + sessionId + " not found");
        const waitMs = timeout || 0;
        if (!s.done && waitMs > 0) {
          await new Promise(function(r) { setTimeout(r, Math.min(waitMs, 30000)); });
        }
        return JSON.stringify({ sessionId, done: s.done, exitCode: s.exitCode, output: s.output });
      }
      if (action === "list") {
        const list = [];
        for (const [id, s] of bgSessions) list.push({ sessionId: id, done: s.done, exitCode: s.exitCode });
        return JSON.stringify(list);
      }
      if (action === "kill" || action === "stop") {
        bgSessions.delete(sessionId);
        return JSON.stringify({ sessionId, status: "removed" });
      }
      throw new Error("Unknown process action: " + action);
    }

    default:
      throw new Error("No local implementation for " + name);
  }
}

// ── HTTP invoke ──────────────────────────────────────────────────────────────

// Tools where args.sessionKey means "who is asking" (hoisted to body top level),
// not a target session argument.
const SESSION_IDENTITY_TOOLS = new Set(["sessions_spawn", "subagents"]);

function normalizeOptionalSessionKey(v) {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s !== "main" ? s : undefined;
}

// claude-cli-gateway extracts the originating OpenClaw session from the system
// prompt and injects it into this MCP child. Explicit model-provided identity
// still wins, while the environment fallback keeps spawn/announce routing safe.
const DEFAULT_REQUESTER_SESSION_KEY = normalizeOptionalSessionKey(
  process.env.OPENCLAW_REQUESTER_SESSION_KEY
);

function normalizeToolArgs(toolName, args) {
  const input = args || {};

  if (toolName === "image") {
    // 旧版上游只认 image / images，不认 path
    if (typeof input.path === "string" && !input.image) {
      const { path, ...rest } = input;
      return { ...rest, image: path };
    }
  }

  if (toolName === "pdf") {
    // 上游 pdf tool 只认 pdf / pdfs，不认 path / paths
    const { path, paths, ...rest } = input;
    if (typeof path === "string" && !rest.pdf) rest.pdf = path;
    if (Array.isArray(paths) && !rest.pdfs) rest.pdfs = paths;
    if (path !== undefined || paths !== undefined) return rest;
  }

  if (toolName === "web_search" && input.limit !== undefined) {
    // 上游只认 count，不认 limit
    const { limit, ...rest } = input;
    if (rest.count === undefined) rest.count = limit;
    return rest;
  }

  if (toolName === "memory_search" && input.limit !== undefined) {
    // 上游只认 maxResults，不认 limit
    const { limit, ...rest } = input;
    if (rest.maxResults === undefined) rest.maxResults = limit;
    return rest;
  }

  if (toolName === "feishu_chat" && input.member_type !== undefined) {
    // 上游参数名是 member_id_type
    const { member_type, ...rest } = input;
    if (rest.member_id_type === undefined) rest.member_id_type = member_type;
    return rest;
  }

  return input;
}

function invokeGatewayTool(toolName, args, sessionKey) {
  return new Promise((resolve, reject) => {
    // sessionKey at body top level identifies the requester session to the gateway
    // (tools-invoke-shared resolveSessionKey). Without it the gateway falls back to
    // agent:main:main, which breaks subagent announce routing (spawnedBy mis-recorded).
    const payload = { tool: toolName, args: args || {} };
    if (sessionKey) payload.sessionKey = sessionKey;
    // Unscoped keys (and the absent-key default) need an explicit owner; an
    // agent-prefixed key already carries one and would conflict.
    if (!isAgentScopedSessionKey(sessionKey) && gwConfig.requesterAgentId) {
      payload.agentId = gwConfig.requesterAgentId;
    }
    const body = JSON.stringify(payload);
    const authHeader =
      gwConfig.mode === "token"
        ? "Bearer " + gwConfig.token
        : "Basic " + Buffer.from(":" + gwConfig.password).toString("base64");

    const opts = {
      hostname: "127.0.0.1",
      port: gwConfig.port,
      path: "/tools/invoke",
      method: "POST",
      // Long-running tools (pdf/image analysis, image_generate) can take minutes;
      // without a deadline a hung gateway call would block the MCP client forever.
      timeout: GATEWAY_TOOL_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: authHeader,
      },
    };

    // One settle path for the deadline, socket errors and the response, so a
    // timeout that races a late reply cannot resolve and reject the same call.
    let settled = false;
    let deadlineTimer = null;
    let response = null;
    const settle = (callback, value) => {
      if (settled) return false;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      callback(value);
      return true;
    };
    const succeed = (value) => settle(resolve, value);
    const fail = (error) => settle(reject, error);

    const req = http.request(opts, (res) => {
      response = res;
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("aborted", () => fail(new Error("Gateway response aborted: " + toolName)));
      res.on("error", fail);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok === false) {
            fail(new Error(parsed.error?.message || "Tool invocation failed"));
          } else if (parsed.error) {
            fail(new Error(parsed.error.message || "Tool invocation failed"));
          } else {
            succeed(parsed.result !== undefined ? parsed.result : parsed);
          }
        } catch (e) {
          succeed(data);
        }
      });
    });

    const onDeadline = () => {
      const error = new Error(
        "Gateway request timed out after " + GATEWAY_TOOL_TIMEOUT_MS + "ms: " + toolName
      );
      error.code = "GATEWAY_TOOL_TIMEOUT";
      if (!fail(error)) return;
      req.destroy(error);
      if (response && !response.destroyed) response.destroy(error);
    };
    // http.request's `timeout` is a socket-idle timeout, not a wall-clock
    // deadline. Keep it as a secondary guard, but enforce the real deadline
    // explicitly so a trickling or half-open response cannot pin a Claude turn.
    deadlineTimer = setTimeout(onDeadline, GATEWAY_TOOL_TIMEOUT_MS);
    deadlineTimer.unref?.();
    req.on("timeout", onDeadline);
    req.on("error", fail);
    req.write(body);
    req.end();
  });
}

// ── MCP JSON-RPC server ──────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openclaw-proxy", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return; // no-op
  }

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    if (!name) return replyError(id, -32602, "Missing tool name");
    // Filtering tools/list alone is not a boundary: a client can call a name it
    // was never advertised, so the allowlist is re-checked on every invocation.
    if (!isToolAllowed(name)) {
      return replyError(id, -32601, "Tool is disabled by the server-side allowlist: " + name);
    }

    try {
      let result;
      if (LOCAL_TOOLS.has(name)) {
        result = await invokeLocalTool(name, args);
      } else if (name === "sessions_yield") {
        // Simulated blocking yield: poll subagents list until last spawned runId is done.
        // This keeps the current Claude Code turn open, so the response routes back to the
        // originating channel (Discord) rather than falling back to webchat.
        result = await simulatedYield(
          args?.timeoutMs,
          normalizeOptionalSessionKey(args?.sessionKey) || DEFAULT_REQUESTER_SESSION_KEY
        );
      } else {
        let normalizedArgs = normalizeToolArgs(name, args);

        // For these tools, args.sessionKey is the *requester identity*, not a tool arg:
        // strip it from args and hoist to the /tools/invoke body top level so the
        // gateway records the right requester (spawnedBy → announce routing).
        // Tools like sessions_history/sessions_send/cron use sessionKey as a real
        // target arg and must NOT be hoisted.
        // Scope every gateway tool to the originating OpenClaw session. This is
        // required not only for subagent routing but also for agent-scoped
        // workspaces/media roots (for example dad/mom inbound image paths).
        // Tools whose args.sessionKey names a target keep that argument; the
        // top-level sessionKey only identifies the requester.
        let hoistedSessionKey = DEFAULT_REQUESTER_SESSION_KEY;
        if (SESSION_IDENTITY_TOOLS.has(name) && normalizedArgs && normalizedArgs.sessionKey !== undefined) {
          hoistedSessionKey = normalizeOptionalSessionKey(normalizedArgs.sessionKey)
            || DEFAULT_REQUESTER_SESSION_KEY;
          const { sessionKey: _drop, ...rest } = normalizedArgs;
          normalizedArgs = rest;
        }
        result = await invokeGatewayTool(name, normalizedArgs, hoistedSessionKey);

        // Capture runId from sessions_spawn so sessions_yield can poll for it
        if (name === "sessions_spawn") {
          try {
            let obj = typeof result === "string" ? JSON.parse(result) : result;
            // Handle MCP content wrapper: {content: [{type: "text", text: "{...json...}"}]}
            if (!obj?.runId && obj?.content?.[0]?.text) {
              try { obj = JSON.parse(obj.content[0].text); } catch (_) {}
            }
            if (obj?.runId) {
              pendingYieldStore.write(obj.runId, hoistedSessionKey);
              process.stderr.write("[openclaw-mcp] sessions_spawn: captured runId=" + obj.runId + " sessionKey=" + (hoistedSessionKey || "(none)") + "\n");
            } else {
              process.stderr.write("[openclaw-mcp] sessions_spawn: no runId found in result: " + JSON.stringify(obj).slice(0, 300) + "\n");
            }
          } catch (e) {
            process.stderr.write("[openclaw-mcp] sessions_spawn: capture error: " + e.message + "\n");
          }
        }
      }
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return reply(id, {
        content: [{ type: "text", text }],
        isError: false,
      });
    } catch (err) {
      return reply(id, {
        content: [{ type: "text", text: "Error: " + err.message }],
        isError: true,
      });
    }
  }

  if (method === "ping") {
    return reply(id, {});
  }

  // Unknown method — return not-found
  if (id != null) {
    replyError(id, -32601, "Method not found: " + method);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write("[openclaw-mcp] Invalid JSON: " + trimmed + "\n");
    return;
  }
  try {
    await handleRequest(msg);
  } catch (e) {
    process.stderr.write("[openclaw-mcp] Handler error: " + e.message + "\n");
    if (msg.id != null) replyError(msg.id, -32603, e.message);
  }
});

rl.on("close", () => process.exit(0));

process.stderr.write("[openclaw-mcp] Proxy started — gateway port " + gwConfig.port + "\n");
