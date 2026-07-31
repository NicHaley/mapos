import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installMcpClient, listMcpClients, patchClientConfig, stdioShellCommand } from "./clients";

// The patch functions write over the user's real client configs, so the thing worth pinning down
// is what survives: other MCP servers, unrelated tables/keys, and the user's own additions to the
// mapos entry. Path/detection logic is left to manual verification (it reads $HOME).

const STDIO = {
  command: "/Applications/MapOS.app/Contents/MacOS/MapOS",
  args: ["/Applications/MapOS.app/Contents/Resources/mcp-stdio.mjs", "--state-dir", "/state dir"],
  env: { ELECTRON_RUN_AS_NODE: "1" }
};

describe("patchClientConfig — JSON clients", () => {
  it("creates the file contents from scratch", () => {
    const out = JSON.parse(patchClientConfig("cursor", "", STDIO));
    expect(out).toEqual({ mcpServers: { mapos: STDIO } });
  });

  it("keeps unrelated top-level keys and sibling servers", () => {
    const existing = JSON.stringify({
      numStartups: 12,
      mcpServers: { other: { command: "other-bin", args: [] } }
    });
    const out = JSON.parse(patchClientConfig("claude-code", existing, STDIO));
    expect(out.numStartups).toBe(12);
    expect(out.mcpServers.other).toEqual({ command: "other-bin", args: [] });
    expect(out.mcpServers.mapos).toEqual(STDIO);
  });

  it("overwrites only the launcher fields of an existing mapos entry", () => {
    const existing = JSON.stringify({
      mcpServers: { mapos: { type: "stdio", disabled: true, command: "/old/MapOS", args: [] } }
    });
    const out = JSON.parse(patchClientConfig("claude-desktop", existing, STDIO));
    expect(out.mcpServers.mapos).toEqual({ type: "stdio", disabled: true, ...STDIO });
  });

  it("rejects a malformed config instead of replacing it", () => {
    expect(() => patchClientConfig("cursor", "{ not json", STDIO)).toThrow();
    expect(() => patchClientConfig("cursor", "[]", STDIO)).toThrow();
  });
});

describe("patchClientConfig — Codex TOML", () => {
  it("appends the block to an existing config", () => {
    const existing = '[projects."/tmp/x"]\ntrust_level = "trusted"\n';
    const out = patchClientConfig("codex", existing, STDIO);
    expect(out).toContain(existing.trimEnd());
    expect(out).toContain("[mcp_servers.mapos]");
    expect(out).toContain(`command = "${STDIO.command}"`);
    expect(out).toContain('[mcp_servers.mapos.env]\nELECTRON_RUN_AS_NODE = "1"');
  });

  it("replaces an existing block, env sub-table included, without duplicating it", () => {
    const first = patchClientConfig("codex", '[mcp_servers.other]\ncommand = "o"\n', STDIO);
    const second = patchClientConfig("codex", first, {
      ...STDIO,
      command: "/new/MapOS",
      env: {}
    });
    expect(second.match(/\[mcp_servers\.mapos\]/g)).toHaveLength(1);
    expect(second).toContain('command = "/new/MapOS"');
    expect(second).not.toContain(STDIO.command);
    // The old env sub-table belonged to the block, so it goes with it.
    expect(second).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(second).toContain("[mcp_servers.other]");
  });

  it("leaves a following table intact when the block is replaced mid-file", () => {
    const withBlock = patchClientConfig("codex", "", STDIO);
    const out = patchClientConfig("codex", `${withBlock}\n[after]\nkey = 1\n`, STDIO);
    expect(out).toMatch(/\n\[after\]\nkey = 1\n$/);
    expect(out.match(/\[mcp_servers\.mapos\]/g)).toHaveLength(1);
  });

  it("quotes paths containing spaces", () => {
    expect(patchClientConfig("codex", "", STDIO)).toContain('"--state-dir", "/state dir"');
  });
});

// The write path, against a throwaway $HOME — os.homedir() reads it on POSIX, and every config
// location is derived from it, so nothing here can reach the real configs.
describe("installMcpClient", () => {
  const realHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mapos-clients-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = realHome;
  });

  it("creates the config and its parent directory", () => {
    expect(installMcpClient("cursor", STDIO)).toEqual({ ok: true });
    const written = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf-8"));
    expect(written.mcpServers.mapos).toEqual(STDIO);
  });

  it("reports which clients are configured, and is idempotent", () => {
    installMcpClient("codex", STDIO);
    installMcpClient("codex", STDIO);
    const codex = listMcpClients(STDIO).find((c) => c.id === "codex");
    expect(codex?.configured).toBe(true);
    const contents = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    expect(contents.match(/\[mcp_servers\.mapos\]/g)).toHaveLength(1);
  });

  it("goes stale when the launcher moves, and re-installs over it", () => {
    installMcpClient("cursor", STDIO);
    const moved = { ...STDIO, command: "/Volumes/Elsewhere/MapOS.app/Contents/MacOS/MapOS" };
    expect(listMcpClients(moved).find((c) => c.id === "cursor")?.configured).toBe(false);
    installMcpClient("cursor", moved);
    expect(listMcpClients(moved).find((c) => c.id === "cursor")?.configured).toBe(true);
  });

  it("leaves a malformed config untouched and explains why", () => {
    const path = join(home, ".cursor", "mcp.json");
    installMcpClient("cursor", STDIO);
    writeFileSync(path, "{ broken", "utf-8");
    const result = installMcpClient("cursor", STDIO);
    expect(result.ok).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("{ broken");
  });

  it("offers no untouched client as configured", () => {
    for (const client of listMcpClients(STDIO)) expect(client.configured).toBe(false);
  });

  // Pasting a `mcpServers` blob over ~/.claude.json would wipe the project history it also holds,
  // so Claude Code's manual fallback has to stay the CLI command.
  it("gives Claude Code a CLI command rather than file contents", () => {
    const claudeCode = listMcpClients(STDIO).find((c) => c.id === "claude-code");
    expect(claudeCode?.manual.code).toBe(
      `claude mcp add mapos --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${STDIO.command} ${STDIO.args[0]} --state-dir '/state dir'`
    );
    expect(claudeCode?.manual.code).not.toContain("mcpServers");
  });
});

describe("stdioShellCommand", () => {
  it("prefixes env assignments and quotes only what needs it", () => {
    expect(stdioShellCommand(STDIO)).toBe(
      `ELECTRON_RUN_AS_NODE=1 ${STDIO.command} ${STDIO.args[0]} --state-dir '/state dir'`
    );
  });
});
