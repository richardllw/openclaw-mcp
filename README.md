# OpenClaw MCP bridge

Local stdio MCP server that exposes OpenClaw gateway tools to Claude Code, Codex,
and other MCP clients. This is the deployed bridge from
`~/.openclaw/workspace/scripts/openclaw-mcp-proxy/`, verified against OpenClaw
2026.9.1 on Node 24.18.

It is a local bridge, not an OpenClaw installation or a hosted service. No
gateway config, credentials, or chat history are in this repository.

## What it does

- Proxies gateway tool calls through the local `/tools/invoke` endpoint, using a
  generated argument schema with compatibility aliases.
- Implements `read`, `write`, `edit`, `exec`, `glob`, `grep`, and `process`
  directly in Node rather than proxying them.
- Adds `sessions_yield`: suspends the turn until spawned subagents finish, with
  per-run pending state persisted through atomic renames so concurrent spawns
  cannot lose updates.
- Resolves the requester agent so tool calls work under
  `agents.ownership: "explicit"` (see below).

With a 46-tool gateway schema it advertises 53 tools (46 gateway + 7 proxy-local).

## Requirements

- Node.js 24+, and Python 3 for the generator's managed-install discovery.
- A running local OpenClaw gateway with config at `~/.openclaw/openclaw.json`.

There are no npm dependencies.

```sh
npm test
npm run regen
```

## Client configuration

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "node",
      "args": ["/absolute/path/to/openclaw-mcp/server.js"]
    }
  }
}
```

A running MCP client keeps its own child process, so restart the client (or
reconnect the server) after regenerating the schema.

## Tool schema

`tools-schema.json` is a generated, credential-free snapshot. **Regenerate it
after every OpenClaw upgrade**, then reconnect the client:

```sh
npm run regen
# or, for a non-default layout:
OPENCLAW_INSTALL_ROOT=/absolute/path/to/node_modules/openclaw npm run regen
```

The generator inspects installed runtime factories and the HTTP deny list; it
never executes a discovered tool. Plugin tools are read from the **active plugin
registry** (`openclaw plugins list --json`), so an abandoned project generation
left behind by an upgrade cannot leak stale tools into the schema. It depends on
OpenClaw internals, so a future release may require a generator update.

Some plugin tools report `captured 0/N` because they are runtime- or
factory-dependent (currently `memory-core` and `codex`); those are reachable
through the gateway but cannot be captured by a static scan.

## Runtime settings

| Environment variable | Purpose |
| --- | --- |
| `OPENCLAW_HOME` | State/config root; default `~/.openclaw`. |
| `OPENCLAW_WORKSPACE` | Workspace root; default `$OPENCLAW_HOME/workspace`. |
| `OPENCLAW_REQUESTER_SESSION_KEY` | Requester scope for gateway/subagent calls. |
| `OPENCLAW_MCP_ENABLED_TOOLS` | Comma-separated server-enforced tool allowlist. Empty means allow all. |
| `OPENCLAW_MCP_GATEWAY_TOOL_TIMEOUT_MS` | Gateway wall-clock deadline; default 240000. |

### Explicit agent ownership

Since 2026.8 a multi-agent roster sets `agents.ownership: "explicit"`, and the
gateway refuses a session key that names no owner — including the bare `"main"`
it falls back to when no key is sent. Every `tools/invoke` then fails with
"has no explicit owner". The bridge resolves a requester agent id once at startup
(`agents.defaults.systemAgent.agentId` → sole agent → `"main"`) and attaches it
as a top-level `agentId` **only** for unscoped keys; an `agent:<id>:<key>` key
already names its owner and would be rejected for disagreeing.

### Gateway deadline

`http.request`'s `timeout` is socket-idle only, so a gateway that accepts a
request and then trickles or stalls could pin a call indefinitely. The bridge
enforces its own wall-clock deadline (default 240 s, under Anthropic's ~5 minute
idle tool-use boundary) and returns a recoverable MCP error instead of losing the
whole turn to "Connection closed mid-response". A single settle path prevents a
deadline that races a late reply from resolving and rejecting the same call.

### Allowlist

`OPENCLAW_MCP_ENABLED_TOOLS` is enforced by the server on both `tools/list` and
`tools/call`. Filtering the advertised list alone is not a boundary, because a
client can call a name it was never advertised. A client-side `enabled_tools`
setting is not a boundary either, since another client could ignore it.

Local exec and file tools run with the MCP process's OS permissions; this bridge
is not a filesystem sandbox. Gateway-proxied tools remain subject to the
gateway's own policies.

## Tests

```sh
npm test
```

Covers requester fallback and argument aliasing, unscoped-requester `agentId`
injection, the gateway wall-clock deadline, server-side allowlist enforcement on
both list and call, and pending-yield persistence. Tests use temporary state and
a fake loopback gateway; they never invoke live provider tools or send messages.

## Relationship to everflowinv/openclaw-mcp

`everflowinv/openclaw-mcp` is a sibling bridge from a different installation, not
an upstream of this one. This version takes its schema generator (registry-based
plugin discovery, `os.homedir()`, `OPENCLAW_INSTALL_ROOT`), its wall-clock
gateway deadline, and its tool allowlist.

Deliberately not taken:

- **Hardcoded upstream MCP passthrough.** That bridge contacts
  `127.0.0.1:8943` (guidepoint), `127.0.0.1:8950` (alphaengine), and
  `https://mcp.firecrawl.dev` at every startup, with `tools/list` awaiting the
  discovery. None of those exist for this installation, and there is no
  environment toggle to disable them.
- **Eve Desktop dynamic sessions** and the SQLite transcript reconstruction that
  serves them — installation-specific and disabled by default there.

Both bridges produce a byte-identical 46-tool schema against OpenClaw 2026.9.1.
