import matter from "gray-matter";
import { dump } from "js-yaml";

/** gray-matter ships `engines` at runtime but omits it from its types. */
const defaultYamlParse = (
  matter as unknown as { engines: { yaml: { parse: (s: string) => object } } }
).engines.yaml.parse;

const YAML_ENGINE = {
  yaml: {
    // Delegated to gray-matter's own engine rather than js-yaml 4's `load`. `matter.stringify`
    // parses its `body` argument with these same engines before re-emitting, so this does run —
    // and read semantics must stay exactly as they were everywhere else.
    parse: defaultYamlParse,
    // `lineWidth: -1` disables line folding, so a long WKT `geometry` stays on one line.
    stringify: (data: object): string => dump(data, { lineWidth: -1 })
  }
};

/**
 * Serialize a place file's frontmatter + body. Use this for every vault write rather than calling
 * `matter.stringify` directly.
 *
 * gray-matter bundles js-yaml 3, whose dumper escapes astral characters — an emoji `icon` lands in
 * the file as `icon: "\U0001F35C"`. That round-trips correctly, but vault files are the source of
 * truth and meant to be hand-edited (the vault is also a valid Obsidian vault), and an escape
 * nobody can read undermines both. js-yaml 4 writes the glyph.
 */
export function stringifyPlaceFile(body: string, data: Record<string, unknown>): string {
  return matter.stringify(body, data, { engines: YAML_ENGINE });
}
