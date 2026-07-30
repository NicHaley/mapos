import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProtectedVaultPath, resolveInVault } from "./vault-path";

// This is the write-safety boundary for every agent-facing vault tool, so the
// fixtures are real directories and real symlinks rather than mocks — the whole
// point of resolveInVault is what the filesystem does, and a mocked fs would
// prove nothing about it.

let base: string;
let vault: string;
let outside: string;
let sibling: string;

beforeAll(() => {
  // realpath the temp root: on macOS tmpdir() is itself a symlink (/var ->
  // /private/var), and resolveInVault returns canonicalized paths, so an
  // un-realpathed expectation would fail for the wrong reason.
  base = realpathSync(mkdtempSync(join(tmpdir(), "mapos-vault-path-")));
  vault = join(base, "vault");
  outside = join(base, "outside");
  // Shares a string prefix with the vault root, which is what defeats a naive
  // `startsWith(vaultRoot)` confinement check.
  sibling = join(base, "vault-evil");

  mkdirSync(join(vault, "tokyo"), { recursive: true });
  mkdirSync(join(vault, ".mapos"), { recursive: true });
  mkdirSync(join(vault, ".maposx"), { recursive: true });
  mkdirSync(join(vault, "notes", ".mapos"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(sibling, { recursive: true });

  writeFileSync(join(vault, "tokyo", "kinka.md"), "# kinka");
  writeFileSync(join(outside, "secret.txt"), "secret");
  writeFileSync(join(sibling, "evil.md"), "evil");

  symlinkSync(join(vault, "tokyo"), join(vault, "inside-link"));
  symlinkSync(outside, join(vault, "escape-dir-link"));
  symlinkSync(join(outside, "secret.txt"), join(vault, "escape-file-link"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveInVault", () => {
  it("resolves a relative path to an existing file", () => {
    expect(resolveInVault(vault, "tokyo/kinka.md")).toBe(join(vault, "tokyo", "kinka.md"));
  });

  it("resolves a leaf that does not exist yet, so writes can create files", () => {
    expect(resolveInVault(vault, "tokyo/new-place.md")).toBe(join(vault, "tokyo", "new-place.md"));
  });

  it("resolves through several directory levels that do not exist yet", () => {
    expect(resolveInVault(vault, "a/b/c.md")).toBe(join(vault, "a", "b", "c.md"));
  });

  it("returns the vault root itself", () => {
    expect(resolveInVault(vault, ".")).toBe(vault);
  });

  it("accepts an absolute path already inside the vault", () => {
    const abs = join(vault, "tokyo", "kinka.md");
    expect(resolveInVault(vault, abs)).toBe(abs);
  });

  it("rejects an empty path", () => {
    expect(resolveInVault(vault, "")).toBeNull();
  });

  it("rejects a non-string path", () => {
    expect(resolveInVault(vault, 42 as unknown as string)).toBeNull();
  });

  it("rejects a bare parent traversal", () => {
    expect(resolveInVault(vault, "..")).toBeNull();
  });

  it("rejects traversal out of the vault", () => {
    expect(resolveInVault(vault, "../../etc/passwd")).toBeNull();
    expect(resolveInVault(vault, "tokyo/../../outside/secret.txt")).toBeNull();
  });

  it("rejects an absolute path outside the vault", () => {
    expect(resolveInVault(vault, "/etc/passwd")).toBeNull();
    expect(resolveInVault(vault, join(outside, "secret.txt"))).toBeNull();
  });

  it("rejects a sibling directory that shares the vault's string prefix", () => {
    // `${vault}-evil/evil.md` starts with the vault root as a string but is not
    // inside it. This is the case a startsWith check gets wrong.
    expect(resolveInVault(vault, join(sibling, "evil.md"))).toBeNull();
    expect(resolveInVault(vault, "../vault-evil/evil.md")).toBeNull();
  });

  it("rejects reads through a symlinked directory pointing outside", () => {
    expect(resolveInVault(vault, "escape-dir-link/secret.txt")).toBeNull();
  });

  it("rejects a symlinked file pointing outside", () => {
    expect(resolveInVault(vault, "escape-file-link")).toBeNull();
  });

  it("rejects writes to a new file under a symlink that escapes", () => {
    // The leaf does not exist, so confinement has to be decided from the
    // symlinked parent. This is the attack that matters: creating a file
    // outside the vault, not just reading one.
    expect(resolveInVault(vault, "escape-dir-link/new-file.md")).toBeNull();
  });

  it("follows a symlink that stays inside the vault, returning its real target", () => {
    expect(resolveInVault(vault, "inside-link/kinka.md")).toBe(join(vault, "tokyo", "kinka.md"));
  });
});

describe("isProtectedVaultPath", () => {
  it("protects the .mapos directory itself", () => {
    expect(isProtectedVaultPath(vault, ".mapos")).toBe(true);
  });

  it("protects files inside .mapos", () => {
    expect(isProtectedVaultPath(vault, ".mapos/appearance.json")).toBe(true);
    expect(isProtectedVaultPath(vault, "./.mapos/index.db")).toBe(true);
  });

  it("does not protect ordinary place files", () => {
    expect(isProtectedVaultPath(vault, "tokyo/kinka.md")).toBe(false);
  });

  it("does not protect a directory that merely starts with .mapos", () => {
    expect(isProtectedVaultPath(vault, ".maposx/notes.md")).toBe(false);
  });

  it("only protects .mapos at the vault root, not nested ones", () => {
    expect(isProtectedVaultPath(vault, "notes/.mapos/whatever.md")).toBe(false);
  });
});
