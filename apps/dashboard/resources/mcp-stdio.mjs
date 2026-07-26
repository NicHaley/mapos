// MapOS MCP stdio bridge.
//
// MCP clients spawn this with the MapOS binary running as plain Node
// (ELECTRON_RUN_AS_NODE=1), so the server exists from the client's point of view whether or not
// the app does. It relays newline-delimited JSON-RPC on stdio to the app's local
// Streamable-HTTP MCP server, launching MapOS first when nothing is listening — which is the
// whole point: the HTTP endpoint alone can't start the app it lives inside.
//
// Deliberately dependency-free. This file is copied into the bundle verbatim (extraResources),
// never passed through the bundler, so it must run on Node built-ins alone. Keeping it out of
// the bundle also keeps the MCP SDK out of the main-process chunk.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A reply to a probe is enough to prove the listener is up; keep it short. */
const PROBE_TIMEOUT_MS = 1500;
/** Cold Electron start plus vault boot. Generous: the alternative is a confusing failure. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** After a launch, how long to let the vault finish booting before answering `tools/list`. */
const TOOLS_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (msg) => process.stderr.write(`[mapos-bridge] ${msg}\n`);

function parseArgs(argv) {
  let stateDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--state-dir") stateDir = argv[i + 1] ?? null;
  }
  return { stateDir };
}

/**
 * Mirrors Electron's `userData` for `app.setName("MapOS")`. Only a fallback — the app generates
 * client configs with an explicit `--state-dir`, so this covers hand-written ones.
 */
function defaultStateDir() {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "MapOS");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "MapOS");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "MapOS");
}

const stateDir = parseArgs(process.argv.slice(2)).stateDir ?? defaultStateDir();

/**
 * Port + token are read fresh on every attempt rather than cached at startup: the app mints them
 * lazily on first run (so the file may not exist yet when we launch it), and rotating the token
 * in Settings must not require re-editing the client's config.
 */
function readMcpConfig() {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "mapos.json"), "utf8"));
    const mcp = parsed?.mcp;
    if (!mcp || typeof mcp.port !== "number" || typeof mcp.token !== "string") return null;
    return { port: mcp.port, token: mcp.token, enabled: mcp.enabled !== false };
  } catch {
    return null;
  }
}

/** What holds the MCP port. */
const DOWN = "down";
const MAPOS = "mapos";
const FOREIGN = "foreign";

/**
 * Who is listening. An unauthenticated GET is rejected with MapOS's own `WWW-Authenticate`
 * challenge before the MCP transport sees it, so requiring that header tells the app apart from
 * whatever else may have taken the port while it was closed. Treating *any* reply as proof would
 * hand our bearer token to a stranger.
 */
async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
    const mapos = (res.headers.get("www-authenticate") ?? "").includes('realm="mapos"');
    await res.body?.cancel();
    return mapos ? MAPOS : FOREIGN;
  } catch {
    return DOWN;
  }
}

/** Launching the app can't fix this: it would fail to bind the same port. */
function foreignPortError(port) {
  return new Error(
    `Port ${port} is held by another process, so MapOS can't serve MCP there. Quit whatever is ` +
      `using it, or set a different \`mcp.port\` in ${join(stateDir, "mapos.json")}.`
  );
}

/** `/Applications/MapOS.app` from `/Applications/MapOS.app/Contents/MacOS/MapOS`, or null. */
function macAppBundle() {
  const marker = ".app/Contents/MacOS/";
  const at = process.execPath.indexOf(marker);
  return at === -1 ? null : process.execPath.slice(0, at + 4);
}

/**
 * Launch MapOS as a GUI app. `ELECTRON_RUN_AS_NODE` is inherited from our own environment and
 * would start the app as a bare Node process, so it has to be stripped before spawning.
 */
function launchApp() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "ELECTRON_RUN_AS_NODE" && key !== "NODE_OPTIONS"
    )
  );
  const bundle = macAppBundle();
  // `open -a` hands off to LaunchServices, which activates an already-running instance instead
  // of starting a rival one. Elsewhere execPath *is* the app, so spawn it detached.
  const child = bundle
    ? spawn("open", ["-a", bundle], { stdio: "ignore", detached: true, env })
    : spawn(process.execPath, [], { stdio: "ignore", detached: true, env });
  child.on("error", (err) => note(`could not launch MapOS: ${err.message}`));
  child.unref();
}

function post(cfg, body, timeoutMs) {
  return fetch(`http://127.0.0.1:${cfg.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${cfg.token}`
    },
    body,
    ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) })
  });
}

/**
 * First JSON-RPC message in a non-streamed body, which may be plain JSON or a short SSE frame.
 * Returns null when there's nothing parseable (empty 202 body, HTML error page, …).
 */
function firstJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      // Keep scanning: a later frame may be the actual response.
    }
  }
  return null;
}

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/**
 * Transport-level rejections (a stale token → 401) answer with `id: null`, per JSON-RPC, because
 * the app rejects before reading the body. We know which request it belongs to, so put the id
 * back: otherwise the client never matches the error to its request and waits out its timeout.
 */
function reattachId(msg, id) {
  if (id === null || Array.isArray(msg) || !msg?.error) return msg;
  return msg.id === null || msg.id === undefined ? { ...msg, id } : msg;
}

function writeError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Relay an SSE response frame by frame so long-running tool calls stream rather than buffer. */
async function pumpSse(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let split = buf.indexOf("\n\n");
    while (split !== -1) {
      const frame = buf.slice(0, split);
      buf = buf.slice(split + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          writeMessage(JSON.parse(payload));
        } catch {
          note("dropped an unparseable SSE frame");
        }
      }
      split = buf.indexOf("\n\n");
    }
  }
}

/**
 * Tool count, or null when it can't be determined (leave those to the real request rather than
 * guessing at one). Zero is a real state, not just a startup race: an app with no vault open
 * registers no tools at all.
 */
async function toolCount(cfg) {
  try {
    const res = await post(
      cfg,
      JSON.stringify({ jsonrpc: "2.0", id: "mapos-bridge-tools", method: "tools/list" }),
      PROBE_TIMEOUT_MS * 4
    );
    if (!res.ok) return null;
    const tools = firstJson(await res.text())?.result?.tools;
    return Array.isArray(tools) ? tools.length : null;
  } catch {
    return null;
  }
}

let launched = false;

async function bringUp() {
  const existing = readMcpConfig();
  if (existing) {
    const owner = await probe(existing.port);
    if (owner === MAPOS) return existing;
    if (owner === FOREIGN) throw foreignPortError(existing.port);
    // Nothing listening. With the server switched off that's expected, and launching won't help.
    if (!existing.enabled) {
      throw new Error(
        "MapOS's MCP server is turned off. Enable it in MapOS › Settings › Connections."
      );
    }
  }
  if (process.env.MAPOS_MCP_NO_LAUNCH === "1") {
    throw new Error("MapOS isn't running, and autostart is disabled (MAPOS_MCP_NO_LAUNCH=1).");
  }

  note("MapOS isn't running — launching it");
  launchApp();
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    // Re-read each pass: on a first-ever run the app mints `mcp` in mapos.json as it boots.
    const cfg = readMcpConfig();
    if (cfg) {
      const owner = await probe(cfg.port);
      if (owner === MAPOS) {
        launched = true;
        note("MapOS is up");
        return cfg;
      }
      if (owner === FOREIGN) throw foreignPortError(cfg.port);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `MapOS did not start within ${LAUNCH_TIMEOUT_MS / 1000}s. Open it manually and retry.`
      );
    }
  }
}

// One shared attempt: concurrent messages during startup must not each launch the app. Cleared on
// failure so a later message can retry (e.g. the user opened MapOS after the first timeout).
let coming = null;
function ensureUp() {
  if (!coming) {
    coming = bringUp().catch((err) => {
      coming = null;
      throw err;
    });
  }
  return coming;
}

/**
 * Discard a bring-up that has gone stale (the app quit, or its token was rotated) so the next
 * `ensureUp` re-reads config and relaunches if it has to. Identity-checked: concurrent messages
 * all fail against the same attempt, and the second one through must not throw away the newer
 * attempt the first one has already started.
 */
function invalidate(stale) {
  if (coming === stale) coming = null;
}

/**
 * Gate `tools/list` on the vault having registered its tools. Two states look alike over HTTP and
 * have to be separated: straight after a launch the listener is up while the vault is still
 * booting, which is worth waiting out; an app with no vault open (onboarding unfinished, or the
 * vault torn down) will never register any, and forwarding that empty list leaves the client
 * believing for the rest of the session that MapOS has no tools. Wait only for the first, and say
 * why rather than answering empty. `initialize` is never gated, so the client's opening handshake
 * stays inside its own timeout.
 */
async function requireTools(cfg) {
  // Only a launch we performed earns the wait; an already-running app is answering for itself.
  const deadline = launched ? Date.now() + TOOLS_TIMEOUT_MS : 0;
  launched = false;
  for (;;) {
    const count = await toolCount(cfg);
    if (count === null || count > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        "MapOS is running but has no vault open, so it has no tools to offer. Open MapOS, finish " +
          "setting up your vault, then reconnect."
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Send one message, retrying once when the failure is one a retry can actually fix: a transport
 * error (MapOS quit since our last message) or a 401 (the token was rotated in Settings). Both
 * invalidate the memoized bring-up, so the retry re-reads port + token from disk and relaunches
 * the app if it's gone. Nothing has reached stdout yet at that point, so the client sees only the
 * outcome. Everything else is returned as-is for the caller to relay.
 */
async function send(line, isToolsList) {
  for (let attempt = 0; ; attempt += 1) {
    const last = attempt === 1;
    const up = ensureUp();
    const cfg = await up;
    if (isToolsList) await requireTools(cfg);
    let res;
    try {
      // No timeout: tool calls legitimately run long (region-pack downloads, index rebuilds).
      res = await post(cfg, line);
    } catch (err) {
      invalidate(up);
      if (last) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`MapOS stopped answering on port ${cfg.port} (${reason}).`);
      }
      note("MapOS stopped answering — reconnecting");
      continue;
    }
    if (res.status === 401 && !last) {
      await res.body?.cancel();
      invalidate(up);
      note("token was rejected — re-reading it from disk");
      continue;
    }
    return res;
  }
}

async function forward(line) {
  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    note("dropped a non-JSON line on stdin");
    return;
  }
  // Batches carry no single id to answer with, so failures there stay silent (the client times
  // the batch out) rather than fabricating a response to the wrong request.
  const id = Array.isArray(msg) ? null : (msg?.id ?? null);
  try {
    const res = await send(line, !Array.isArray(msg) && msg?.method === "tools/list");
    if (res.status === 202 || res.status === 204) {
      await res.body?.cancel();
      return;
    }
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      await pumpSse(res);
      return;
    }
    const out = firstJson(await res.text());
    if (out !== null) writeMessage(reattachId(out, id));
    else if (id !== null) {
      writeError(id, -32603, `MapOS returned an unreadable response (HTTP ${res.status}).`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(message);
    if (id !== null) writeError(id, -32000, message);
  }
}

// Requests in flight. A client that closes stdin to signal shutdown is still owed the replies to
// whatever it already sent, so exit is deferred until they've all been written.
let pending = 0;
let stdinEnded = false;

function exitWhenDrained() {
  if (stdinEnded && pending === 0) process.exit(0);
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let split = stdinBuf.indexOf("\n");
  while (split !== -1) {
    const line = stdinBuf.slice(0, split).trim();
    stdinBuf = stdinBuf.slice(split + 1);
    if (line) {
      pending += 1;
      // forward() handles its own errors, so settling is enough — nothing here can reject.
      void forward(line).finally(() => {
        pending -= 1;
        exitWhenDrained();
      });
    }
    split = stdinBuf.indexOf("\n");
  }
});
// The client closed the pipe. MapOS itself is left running — the user may well be using it.
process.stdin.on("end", () => {
  stdinEnded = true;
  exitWhenDrained();
});
