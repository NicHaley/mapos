import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpClientId, McpClientTarget, McpStdioLauncher } from "../../shared/types";

/**
 * One-click install for the MCP clients we know the config shape of. Each client is described by
 * where its config lives, how to render the `mapos` entry, and how to splice that entry into an
 * existing file without disturbing the rest of it.
 *
 * The install and the manual snippet are generated from the same launcher, so the two paths can't
 * drift: whatever the button writes is exactly what the collapsible tells you to paste.
 */

/** The server name written into every client's config. */
const SERVER_NAME = "mapos";

type ClientSpec = {
  id: McpClientId;
  label: string;
  /** Absolute config path, or null when the platform has no known location for this client. */
  configPath: () => string | null;
  /** The config contents an install writes for this launcher. */
  render: (stdio: McpStdioLauncher) => string;
  /**
   * The paste-it-yourself equivalent, when showing the file contents would be a trap. Defaults to
   * `render` plus the config path, which is right whenever the file is small enough to hand-edit.
   */
  manual?: (stdio: McpStdioLauncher) => { hint: string; code: string };
  /** Where `render`'s output goes, for the snippet header. */
  hint: (configLabel: string) => string;
  /** Whether the file already points `mapos` at this launcher. */
  isConfigured: (contents: string, stdio: McpStdioLauncher) => boolean;
  /** Merge the `mapos` entry into existing file contents (`""` when the file is absent). */
  patch: (contents: string, stdio: McpStdioLauncher) => string;
};

function appSupportDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  if (process.platform === "win32")
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

// --- JSON clients (`{ mcpServers: { mapos: … } }`) --------------------------------------------

function jsonEntry(stdio: McpStdioLauncher): Record<string, unknown> {
  return { command: stdio.command, args: stdio.args, env: stdio.env };
}

function renderJson(stdio: McpStdioLauncher): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonEntry(stdio) } }, null, 2);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonConfig(contents: string): Record<string, unknown> {
  const trimmed = contents.trim();
  if (!trimmed) return {};
  const root = asObject(JSON.parse(trimmed));
  if (!root) throw new Error("Config file is not a JSON object");
  return root;
}

function patchJson(contents: string, stdio: McpStdioLauncher): string {
  const root = parseJsonConfig(contents);
  const servers = asObject(root.mcpServers) ?? {};
  // Merge onto any existing entry so client-specific keys the user added (e.g. `type`,
  // `disabled`) survive a reinstall; only the launcher fields are ours to overwrite.
  const existing = asObject(servers[SERVER_NAME]) ?? {};
  servers[SERVER_NAME] = { ...existing, ...jsonEntry(stdio) };
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function isJsonConfigured(contents: string, stdio: McpStdioLauncher): boolean {
  let entry: Record<string, unknown> | null;
  try {
    entry = asObject(asObject(parseJsonConfig(contents).mcpServers)?.[SERVER_NAME]);
  } catch {
    return false;
  }
  if (!entry) return false;
  return (
    entry.command === stdio.command && JSON.stringify(entry.args) === JSON.stringify(stdio.args)
  );
}

// --- Codex (`~/.codex/config.toml`) ------------------------------------------------------------

// TOML basic strings escape the same way JSON strings do for everything that can appear in a
// path or an env value, so JSON.stringify is a safe quoter here.
function renderToml(stdio: McpStdioLauncher): string {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(stdio.command)}`,
    `args = [${stdio.args.map((a) => JSON.stringify(a)).join(", ")}]`
  ];
  const env = Object.entries(stdio.env);
  if (env.length > 0) {
    lines.push(
      "",
      `[mcp_servers.${SERVER_NAME}.env]`,
      ...env.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    );
  }
  return lines.join("\n");
}

const OWN_TABLE = new RegExp(`^\\s*\\[\\s*mcp_servers\\.${SERVER_NAME}[.\\]]`);

/** Index of the `[mcp_servers.mapos]` header, or -1. */
function tomlBlockStart(lines: string[]): number {
  return lines.findIndex((l) => OWN_TABLE.test(l) && /\]\s*$/.test(l.split("#")[0] ?? l));
}

/**
 * Replace the whole `[mcp_servers.mapos]` block (including its `.env` sub-table) rather than
 * editing lines in place, so a stale block from an older install can't leak fields into the new
 * one. Everything outside the block is passed through byte for byte.
 */
function patchToml(contents: string, stdio: McpStdioLauncher): string {
  const block = renderToml(stdio);
  const lines = contents.split("\n");
  const start = tomlBlockStart(lines);
  if (start === -1) {
    const base = contents.trimEnd();
    return base ? `${base}\n\n${block}\n` : `${block}\n`;
  }
  // The block runs until the next table header that isn't ours; trailing blank lines swept up
  // along the way are separators, replaced by exactly one below.
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !OWN_TABLE.test(lines[end]))) end++;
  const replacement = block.split("\n");
  if (end < lines.length) replacement.push("");
  lines.splice(start, end - start, ...replacement);
  return `${lines.join("\n").trimEnd()}\n`;
}

function isTomlConfigured(contents: string, stdio: McpStdioLauncher): boolean {
  const lines = contents.split("\n");
  const start = tomlBlockStart(lines);
  if (start === -1) return false;
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !OWN_TABLE.test(lines[end]))) end++;
  const block = lines.slice(start, end).join("\n");
  return (
    block.includes(`command = ${JSON.stringify(stdio.command)}`) &&
    stdio.args.every((a) => block.includes(JSON.stringify(a)))
  );
}

// --- Shell rendering (for clients configured by a CLI rather than by hand) ---------------------

// Quote for a POSIX shell only where needed, so the common (space-free) path stays readable.
function shellQuote(value: string): string {
  return /^[\w./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function shellCommand(stdio: McpStdioLauncher): string {
  return [stdio.command, ...stdio.args].map(shellQuote).join(" ");
}

/**
 * The launcher as a single shell command, env assignments included: what to hand a client that
 * spawns a stdio server but that MapOS can't configure itself.
 */
export function stdioShellCommand(stdio: McpStdioLauncher): string {
  const env = Object.entries(stdio.env)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  return `${env} ${shellCommand(stdio)}`.trim();
}

function envFlags(stdio: McpStdioLauncher): string {
  return Object.entries(stdio.env)
    .map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`)
    .join(" ");
}

// --- Registry ---------------------------------------------------------------------------------

const SPECS: ClientSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    // User scope, so the server is available in every project rather than one working directory.
    configPath: () => join(homedir(), ".claude.json"),
    render: renderJson,
    // `~/.claude.json` also holds per-project history, so it's far too big to hand-edit and
    // "paste this" would read as "replace the file". The CLI does the same merge the button does.
    manual: (stdio) => ({
      hint: "Run in your terminal",
      code: `claude mcp add ${SERVER_NAME} --scope user ${envFlags(stdio)} -- ${shellCommand(stdio)}`
    }),
    hint: (configLabel) => configLabel,
    isConfigured: isJsonConfigured,
    patch: patchJson
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    configPath: () =>
      process.platform === "linux"
        ? null
        : join(appSupportDir(), "Claude", "claude_desktop_config.json"),
    render: renderJson,
    hint: () => "claude_desktop_config.json",
    isConfigured: isJsonConfigured,
    patch: patchJson
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: () => join(homedir(), ".cursor", "mcp.json"),
    render: renderJson,
    hint: (configLabel) => configLabel,
    isConfigured: isJsonConfigured,
    patch: patchJson
  },
  {
    id: "codex",
    label: "Codex",
    configPath: () => join(homedir(), ".codex", "config.toml"),
    render: renderToml,
    hint: (configLabel) => configLabel,
    isConfigured: isTomlConfigured,
    patch: patchToml
  }
];

/**
 * Merge the `mapos` entry into one client's config contents, without touching the filesystem.
 * The pure half of `installMcpClient`, split out so the splicing can be tested directly: these
 * are the user's real config files, and a bad patch loses their other servers.
 *
 * Throws if `contents` is present but unparseable.
 */
export function patchClientConfig(
  id: McpClientId,
  contents: string,
  stdio: McpStdioLauncher
): string {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown MCP client: ${id}`);
  return spec.patch(contents, stdio);
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Contents, or `""` when there is genuinely no file there. Anything other than ENOENT — a
 * permissions denial, a directory in the way — is rethrown rather than reported as absent: a
 * config we can't read is one we mustn't overwrite, and treating it as empty would hand the
 * caller a from-scratch patch that drops every server already in it.
 */
function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/**
 * Whether the client's config already points `mapos` at this launcher. A config that can't be
 * read or parsed counts as not configured — the panel offers the button, and the install is where
 * the unreadable file gets reported, since that's the point at which it blocks something.
 */
function isConfigured(spec: ClientSpec, configPath: string, stdio: McpStdioLauncher): boolean {
  let contents: string;
  try {
    contents = readIfExists(configPath);
  } catch {
    return false;
  }
  return contents ? spec.isConfigured(contents, stdio) : false;
}

/**
 * The install targets for the current platform. A client that can't be installed automatically
 * here (no known config location) is left out entirely rather than offered with a button that
 * can't work — the manual "Other" fields still cover it.
 *
 * Deliberately no "is this client installed?" signal: nothing actionable hangs off it (the write
 * is the same either way), and every way to detect it is a per-client, per-platform guess that
 * would be wrong for Homebrew casks, portable installs, and CLI-only clients.
 */
export function listMcpClients(stdio: McpStdioLauncher): McpClientTarget[] {
  const targets: McpClientTarget[] = [];
  for (const spec of SPECS) {
    const configPath = spec.configPath();
    if (!configPath) continue;
    const configLabel = displayPath(configPath);
    targets.push({
      id: spec.id,
      label: spec.label,
      configPath,
      configLabel,
      configured: isConfigured(spec, configPath, stdio),
      manual: spec.manual?.(stdio) ?? { hint: spec.hint(configLabel), code: spec.render(stdio) }
    });
  }
  return targets;
}

/**
 * Write the `mapos` entry into one client's config, creating the file and its directory if
 * needed. Writes through a sibling temp file so a crash mid-write can't truncate a config the
 * user depends on — but note this is still last-writer-wins against a client that keeps its own
 * copy in memory, which is why the panel tells you to restart it.
 */
export function installMcpClient(
  id: McpClientId,
  stdio: McpStdioLauncher
): { ok: true } | { ok: false; error: string } {
  const spec = SPECS.find((s) => s.id === id);
  if (!spec) return { ok: false, error: `Unknown MCP client: ${id}` };
  const configPath = spec.configPath();
  if (!configPath) return { ok: false, error: `${spec.label} isn't supported on this platform` };

  let next: string;
  try {
    next = patchClientConfig(id, readIfExists(configPath), stdio);
  } catch {
    // An existing file we can't read or can't parse. Bailing out beats replacing it wholesale:
    // the user's own edits and other servers are in there, and the manual snippet still gets
    // them connected.
    return {
      ok: false,
      error: `Couldn't read ${displayPath(configPath)}. Fix or remove it, or use manual setup.`
    };
  }

  const tmp = `${configPath}.mapos-tmp`;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(tmp, next, "utf-8");
    renameSync(tmp, configPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}
