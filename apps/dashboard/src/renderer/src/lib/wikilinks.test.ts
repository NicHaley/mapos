import { describe, expect, it } from "vitest";
import { resolveWikilinkPath, wikilinkForFile } from "./wikilinks";

const ROOT = "/Users/x/MapOS";
const HOME = `${ROOT}/Home.md`;
const WORK = `${ROOT}/tokyo/Work.md`;
const OTHER_WORK = `${ROOT}/paris/Work.md`;

describe("wikilinkForFile", () => {
  it("uses the bare filename when it is unique in the vault", () => {
    expect(wikilinkForFile(HOME, ROOT, [HOME, WORK])).toBe("[[Home]]");
  });

  it("qualifies with the vault-relative path when the filename is ambiguous", () => {
    expect(wikilinkForFile(WORK, ROOT, [HOME, WORK, OTHER_WORK])).toBe("[[tokyo/Work]]");
    expect(wikilinkForFile(OTHER_WORK, ROOT, [HOME, WORK, OTHER_WORK])).toBe("[[paris/Work]]");
  });
});

describe("resolveWikilinkPath", () => {
  it("resolves a bare filename", () => {
    expect(resolveWikilinkPath("[[Home]]", ROOT, [HOME, WORK])).toBe(HOME);
  });

  it("resolves a vault-relative path", () => {
    expect(resolveWikilinkPath("[[tokyo/Work]]", ROOT, [HOME, WORK, OTHER_WORK])).toBe(WORK);
  });

  it("prefers an exact path over a filename match", () => {
    expect(resolveWikilinkPath("[[paris/Work]]", ROOT, [WORK, OTHER_WORK])).toBe(OTHER_WORK);
  });

  it("accepts link text with or without brackets, and tolerates whitespace", () => {
    expect(resolveWikilinkPath("Home", ROOT, [HOME])).toBe(HOME);
    expect(resolveWikilinkPath("  [[ Home ]] ", ROOT, [HOME])).toBe(HOME);
  });

  // Renames never rewrite wikilinks, so an unresolvable link is expected, not exceptional:
  // the stop falls back to its stored coordinates and the route still routes.
  it("returns null when nothing matches", () => {
    expect(resolveWikilinkPath("[[Casa]]", ROOT, [HOME, WORK])).toBeNull();
    expect(resolveWikilinkPath("[[]]", ROOT, [HOME])).toBeNull();
  });
});

describe("round trip", () => {
  it.each([
    ["unique filename", HOME, [HOME, WORK]],
    ["ambiguous filename", WORK, [HOME, WORK, OTHER_WORK]]
  ])("%s survives write → read", (_name, filePath, vault) => {
    expect(resolveWikilinkPath(wikilinkForFile(filePath, ROOT, vault), ROOT, vault)).toBe(filePath);
  });
});
