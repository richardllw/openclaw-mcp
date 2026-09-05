#!/usr/bin/env node
/**
 * Regenerate tools-schema.json for the OpenClaw MCP proxy.
 *
 * Authoritative source: the installed openclaw dist's createOpenClawTools()
 * factory (same code path the agent runtime uses), instantiated with the live
 * config — so tool names, descriptions, and parameter schemas can never drift
 * from what the gateway actually accepts.
 *
 * Tools blocked on the gateway HTTP face are dropped statically: the default
 * /tools/invoke hard deny list (docs/gateway/tools-invoke-http-api.md) minus
 * gateway.tools.allow, plus gateway.tools.deny. No live probing — some tools
 * (e.g. feishu_bitable_create_app) execute even with garbage args, so probe
 * calls can have real side effects.
 *
 * Run after every OpenClaw upgrade:
 *   node scripts/openclaw-mcp-proxy/regen-tools-schema.mjs
 *
 * Local tools (read/write/edit/exec/glob/grep/process) and sessions_yield are
 * implemented inside server.js itself and are NOT part of this file.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const USER_HOME = os.homedir();
const OUT_PATH = new URL("./tools-schema.json", import.meta.url).pathname;

// ── Locate openclaw dist (hash filenames change across versions) ─────────────

function findOpenClawRoot() {
  const explicit = process.env.OPENCLAW_INSTALL_ROOT || process.env.OPENCLAW_ROOT;
  if (explicit && fs.existsSync(path.join(explicit, "dist/index.js"))) return explicit;
  const helper = path.resolve(path.dirname(new URL(import.meta.url).pathname), "compat/openclaw_install.py");
  const root = execFileSync(process.env.PYTHON || "python3", [helper], { encoding: "utf8" }).trim();
  if (fs.existsSync(path.join(root, "dist/index.js"))) return root;
  throw new Error(`managed openclaw dist not found: ${root}`);
}

// Find the dist file whose source contains `marker`, import it, and return the
// export whose function name is `fnName`.
async function locateExport(distDir, marker, fnName) {
  const files = fs.readdirSync(distDir).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const full = path.join(distDir, f);
    let src;
    try {
      src = fs.readFileSync(full, "utf8");
    } catch (_) {
      continue;
    }
    if (!src.includes(marker)) continue;
    let mod;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (_) {
      continue;
    }
    for (const key of Object.keys(mod)) {
      const v = mod[key];
      if (typeof v === "function" && v.name === fnName) return v;
    }
  }
  throw new Error(`Could not locate export ${fnName} (marker: ${marker}) in ${distDir}`);
}

// ── Schema cleanup ───────────────────────────────────────────────────────────

// TypeBox schemas are plain JSON but carry noise: symbol keys drop in the JSON
// round-trip; anyOf-of-consts flatten to enum for MCP client friendliness.
function cleanSchema(node) {
  if (Array.isArray(node)) return node.map(cleanSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$id" || k === "$schema") continue;
    out[k] = cleanSchema(v);
  }
  if (Array.isArray(out.anyOf) && out.anyOf.every((s) => s && typeof s === "object" && "const" in s)) {
    const types = [...new Set(out.anyOf.map((s) => s.type).filter(Boolean))];
    const flat = { enum: out.anyOf.map((s) => s.const) };
    if (types.length === 1) flat.type = types[0];
    for (const [k, v] of Object.entries(out)) if (k !== "anyOf") flat[k] = v;
    return flat;
  }
  return out;
}

// MCP requires every tool inputSchema to declare an object at the root. Some
// OpenClaw plugin tools use a top-level anyOf discriminator union where every
// branch is already an object; keep the union and add the required root type.
function ensureMcpObjectRoot(schema) {
  if (
    schema
    && !schema.type
    && Array.isArray(schema.anyOf)
    && schema.anyOf.length > 0
    && schema.anyOf.every((branch) => branch?.type === "object")
  ) {
    return { type: "object", ...schema };
  }
  return schema;
}

// ── Gateway HTTP-face availability (static, no side effects) ────────────────

// Default hard deny list for POST /tools/invoke, from
// docs/gateway/tools-invoke-http-api.md. Verify against docs after upgrades.
const DEFAULT_HTTP_DENY = [
  "exec",
  "spawn",
  "shell",
  "fs_write",
  "fs_delete",
  "fs_move",
  "apply_patch",
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "nodes",
  "whatsapp_login",
];

// The deny list grows across releases (2026.8 added terminal/portal/computer/
// mobile_ui/openclaw/conversations_* and renamed cron→automations), so read it
// from the installed dist and only fall back to the constant above.
async function resolveHttpDenyList(distDir) {
  for (const f of fs.readdirSync(distDir).filter((n) => n.endsWith(".js"))) {
    const full = path.join(distDir, f);
    let src;
    try { src = fs.readFileSync(full, "utf8"); } catch (_) { continue; }
    if (!src.includes("DEFAULT_GATEWAY_HTTP_TOOL_DENY = [")) continue;
    try {
      const mod = await import(pathToFileURL(full).href);
      const list = Object.values(mod).find(
        (v) => Array.isArray(v) && v.includes("exec") && v.includes("gateway") && v.includes("nodes"),
      );
      if (list) return { list: [...list], source: f };
    } catch (_) {}
  }
  return { list: [...DEFAULT_HTTP_DENY], source: "fallback constant (stale risk)" };
}

// `gateway.tools.allow` entries may use aliases (config says "cron", the tool is
// now "automations"), so compare normalized names or an allow entry silently misses.
const TOOL_NAME_ALIASES = { bash: "exec", "apply-patch": "apply_patch", cron: "automations" };
const normalizeToolName = (n) => {
  const s = String(n || "").trim().toLowerCase();
  return TOOL_NAME_ALIASES[s] ?? s;
};

function computeHttpDeniedTools(denyList) {
  const cfg = JSON.parse(fs.readFileSync(path.join(USER_HOME, ".openclaw/openclaw.json"), "utf8"));
  const gwTools = cfg.gateway?.tools || {};
  const allow = new Set((gwTools.allow || []).map(normalizeToolName));
  const denied = new Set(denyList.filter((t) => !allow.has(normalizeToolName(t))));
  for (const t of gwTools.deny || []) denied.add(t);
  return denied;
}

// ── Plugin tools ─────────────────────────────────────────────────────────────

// createOpenClawTools() only returns core tools when called outside the gateway
// process — plugin tools need the plugin host, which we cannot stand up here.
// Instead, load each installed plugin's module and capture the definitions it
// hands to registerTool(). Nothing is executed, so this has no side effects.
//
// Registration is guarded on the plugin being "configured", so we synthesize a
// config from the manifest's toolMetadata.configSignals (which names exactly the
// fields each tool requires) rather than using real credentials.
function buildSyntheticPluginConfig(manifest, realCfg) {
  const cfg = JSON.parse(JSON.stringify({ channels: realCfg.channels || {} }));
  for (const meta of Object.values(manifest.toolMetadata || {})) {
    for (const signal of meta.configSignals || []) {
      const rootPath = signal.rootPath;
      if (!rootPath) continue;
      let node = cfg;
      const parts = rootPath.split(".");
      for (const p of parts) node = node[p] = node[p] || {};
      node.enabled = true;
      for (const field of signal.required || []) {
        if (node[field] === undefined || typeof node[field] === "object") node[field] = "probe";
      }
    }
  }
  return cfg;
}

async function collectPluginTools(realCfg) {
  // Use the active plugin registry, never an abandoned generation or disabled plugin.
  const raw = execFileSync(process.execPath, [path.join(findOpenClawRoot(), "dist/entry.js"), "plugins", "list", "--json"], {encoding: "utf8", maxBuffer: 8 * 1024 * 1024});
  const registry = JSON.parse(raw.slice(raw.indexOf("{\n")));
  const byId = new Map();
  for (const plugin of registry.plugins || []) {
    if (!plugin.enabled || plugin.status !== "loaded" || !plugin.rootDir) continue;
    const mf = path.join(plugin.rootDir, "openclaw.plugin.json");
    if (!fs.existsSync(mf)) continue;
    const manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
    if (!manifest.contracts?.tools?.length) continue;
    byId.set(manifest.id, {pkgDir: plugin.rootDir, manifest, version: plugin.version});
  }

  const collected = [];
  for (const { pkgDir, manifest, version } of byId.values()) {
    const declared = new Set(manifest.contracts.tools);
    const synthetic = buildSyntheticPluginConfig(manifest, realCfg);
    const captured = [];
    const api = { config: synthetic, registerTool: (f) => captured.push(f) };
    const dir = path.join(pkgDir, "dist");
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f))
      : [];
    for (const file of files) {
      let src;
      try { src = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
      if (!/register\w*Tools?\b/.test(src)) continue;
      let mod;
      try { mod = await import(pathToFileURL(file).href); } catch (_) { continue; }
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn !== "function" || !/^register\w*Tools?$/.test(name)) continue;
        try { fn(api); } catch (_) {}
      }
    }
    const seen = new Set();
    for (const entry of captured) {
      let def;
      try { def = typeof entry === "function" ? entry({ agentAccountId: undefined }) : entry; }
      catch (_) { continue; }
      if (!def?.name || seen.has(def.name) || !declared.has(def.name)) continue;
      seen.add(def.name);
      collected.push({
        name: def.name,
        description: typeof def.description === "string" ? def.description : String(def.description || def.name),
        inputSchema: ensureMcpObjectRoot(
          cleanSchema(JSON.parse(JSON.stringify(def.parameters || { type: "object", properties: {} }))),
        ),
      });
    }
    const missing = [...declared].filter((n) => !seen.has(n));
    console.log(
      `plugin ${manifest.id}@${version}: captured ${seen.size}/${declared.size}`
      + (missing.length ? ` — not captured by helper scan (runtime/factory-dependent): ${missing.join(", ")}` : ""),
    );
  }
  return collected;
}

// ── Proxy-specific schema overlays ───────────────────────────────────────────

// update_plan is registered on the gateway HTTP face but not returned by the
// factory for this session shape; schema transcribed from
// src/agents/tools/update-plan-tool.ts (verify after upgrades).
const EXTRA_TOOLS = [
  {
    name: "update_plan",
    description: "Update the current run's work plan (ordered steps; max one in_progress).",
    inputSchema: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Short note: what changed." },
        plan: {
          type: "array",
          minItems: 1,
          description: "Ordered steps; max one in_progress.",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "Short step." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "pending | in_progress | completed." },
            },
            required: ["step", "status"],
            additionalProperties: true,
          },
        },
      },
      required: ["plan"],
    },
  },
];

// Extra properties merged into generated schemas (proxy-level semantics).
const PROPERTY_OVERLAYS = {
  message: {
    to: {
      type: "string",
      description: "Recipient alias for target; accepted by the message runtime.",
    },
    filePath: {
      type: "string",
      description: "Local file attachment alias for media; accepted by the message runtime.",
    },
    components: {
      type: "object",
      description: "Discord components payload (buttons, selects, forms, or modal).",
    },
  },
  sessions_spawn: {
    sessionKey: {
      type: "string",
      description:
        "Requester session key (NOT the child session). The Claude CLI gateway supplies this automatically; pass it only when an explicit requester override is required.",
    },
    thread: {
      type: "boolean",
      description: "Bind the spawned session to a supported chat thread.",
    },
    mode: {
      type: "string",
      enum: ["run", "session"],
      description: "run is one-shot; session is persistent and requires thread=true.",
    },
  },
  subagents: {
    sessionKey: {
      type: "string",
      description:
        "Requester session key scoping the list (e.g. agent:main:discord:channel:<id>). Pass the same key used at sessions_spawn; omit to scope to the main session.",
    },
  },
  // Back-compat aliases normalized by server.js before forwarding; declared so
  // MCP clients that send them don't get the value stripped by their harness.
  web_search: { limit: { type: "number", description: "Alias for count (proxy back-compat)." } },
  memory_search: { limit: { type: "number", description: "Alias for maxResults (proxy back-compat)." } },
  image: { path: { type: "string", description: "Alias for image (proxy back-compat)." } },
  pdf: {
    path: { type: "string", description: "Alias for pdf (proxy back-compat)." },
    paths: { type: "array", items: { type: "string" }, description: "Alias for pdfs (proxy back-compat)." },
  },
  feishu_chat: { member_type: { type: "string", description: "Alias for member_id_type (proxy back-compat)." } },
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const root = findOpenClawRoot();
  const distDir = path.join(root, "dist");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  console.log(`openclaw ${version} at ${root}`);

  const loadConfig = await locateExport(distDir, "function loadConfig(", "loadConfig");
  const createOpenClawTools = await locateExport(distDir, "function createOpenClawTools", "createOpenClawTools");
  const config = loadConfig();
  const loadAuthStore = await locateExport(distDir, "function loadAuthProfileStoreForSecretsRuntime(", "loadAuthProfileStoreForSecretsRuntime");
  const authProfileStore = loadAuthStore(path.join(USER_HOME, ".openclaw/agents/main/agent"));

  // 2026.9 conditionally exposes provider tools using the active model, even
  // when their plugin config explicitly enables them (notably x_search).
  const modelConfig = config.agents?.entries?.main?.model ?? config.agents?.defaults?.model;
  const primaryModel = typeof modelConfig === "string" ? modelConfig : modelConfig?.primary;
  if (typeof primaryModel !== "string" || !primaryModel.includes("/")) {
    throw new Error("Cannot resolve main's configured model for tool discovery");
  }
  const slash = primaryModel.indexOf("/");
  const tools = await createOpenClawTools({
    config,
    authProfileStore,
    modelProvider: primaryModel.slice(0, slash),
    modelId: primaryModel.slice(slash + 1),
    agentSessionKey: "agent:main:main",
    modelHasVision: true,
    agentDir: path.join(USER_HOME, ".openclaw/agents/main/agent"),
    workspaceDir: path.join(USER_HOME, ".openclaw/workspace"),
  });
  console.log(`factory returned ${tools.length} tools`);

  const generated = tools.map((t) => ({
    name: t.name,
    description: typeof t.description === "string" ? t.description : String(t.description || t.name),
    inputSchema: ensureMcpObjectRoot(
      cleanSchema(JSON.parse(JSON.stringify(t.parameters || { type: "object", properties: {} }))),
    ),
  }));
  const pluginTools = await collectPluginTools(config);
  for (const tool of pluginTools) {
    if (!generated.some((t) => t.name === tool.name)) generated.push(tool);
  }
  console.log(`plugin tools merged: ${pluginTools.length}`);

  for (const extra of EXTRA_TOOLS) {
    if (!generated.some((t) => t.name === extra.name)) generated.push(extra);
  }

  // Drop tools blocked on the gateway HTTP face (deny list minus allow).
  const { list: denyList, source: denySource } = await resolveHttpDenyList(distDir);
  if (denySource.startsWith("fallback")) throw new Error("Cannot resolve current gateway tool deny list");
  console.log(`http deny list from: ${denySource}`);
  const denied = computeHttpDeniedTools(denyList);
  const dropped = generated.filter((t) => denied.has(t.name)).map((t) => t.name);
  const finalTools = generated.filter((t) => !denied.has(t.name));
  if (dropped.length) console.log(`dropped (denied on /tools/invoke): ${dropped.join(", ")}`);

  for (const tool of finalTools) {
    const overlay = PROPERTY_OVERLAYS[tool.name];
    if (!overlay) continue;
    tool.inputSchema.properties = tool.inputSchema.properties || {};
    for (const [prop, schema] of Object.entries(overlay)) {
      const existing = tool.inputSchema.properties[prop];
      tool.inputSchema.properties[prop] = existing && typeof existing === "object"
        ? { ...existing, ...schema }
        : schema;
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    openclawVersion: version,
    note: "Generated by regen-tools-schema.mjs — do not hand-edit; rerun after OpenClaw upgrades.",
    tools: finalTools.sort((a, b) => a.name.localeCompare(b.name)),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`wrote ${finalTools.length} tools to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("regen failed:", e.message);
  process.exit(1);
});
