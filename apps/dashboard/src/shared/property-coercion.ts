// ─── Types ───────────────────────────────────────────────────────────────────

export type FrontmatterPrimitive = string | number | boolean | Date;
export type FrontmatterValue = FrontmatterPrimitive | FrontmatterPrimitive[];

// ─── Patterns ────────────────────────────────────────────────────────────────

const PATTERNS = {
  quotedString: /^"((?:[^"\\]|\\.)*)"$/,           // "hello"
  integer:      /^-?\d+$/,                           // 42, -7
  float:        /^-?\d+\.\d+$/,                      // 3.14
  boolean:      /^(true|false)$/i,                   // true / false
  list:         /^\[(.*)?\]$/,                       // [a, b, c]

  // Unquoted dates (no surrounding quotes = Date type)
  dateOnly:     /^\d{4}-\d{2}-\d{2}$/,              // 1991-01-10
  dateTime:     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z?$/, // 1991-01-10T12:00
  dateSlash:    /^\d{4}\/\d{2}\/\d{2}$/,            // 1991/01/10
  dateLong:     /^\d{1,2} \w+ \d{4}$/,              // 10 January 1991
} as const;

// ─── Parse a single primitive value ──────────────────────────────────────────

export function parsePrimitive(raw: string): FrontmatterPrimitive {
  const s = raw.trim();

  // Quoted string → always a string, unescape inner quotes
  const quoted = s.match(PATTERNS.quotedString);
  if (quoted) return quoted[1].replace(/\\"/g, '"');

  // Boolean
  if (PATTERNS.boolean.test(s)) return s.toLowerCase() === "true";

  // Number
  if (PATTERNS.integer.test(s)) return Number.parseInt(s, 10);
  if (PATTERNS.float.test(s)) return Number.parseFloat(s);

  // Unquoted dates → Date type
  if (
    PATTERNS.dateOnly.test(s) ||
    PATTERNS.dateTime.test(s) ||
    PATTERNS.dateSlash.test(s) ||
    PATTERNS.dateLong.test(s)
  ) {
    const d = new Date(s.replace(/\//g, "-")); // normalize slashes
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Fallback: unquoted string
  return s;
}

// ─── Parse a full value (primitive or list) ───────────────────────────────────

export function parseValue(raw: string): FrontmatterValue {
  const s = raw.trim();

  const listMatch = s.match(PATTERNS.list);
  if (listMatch) {
    const inner = listMatch[1].trim();
    if (!inner) return [];
    return splitList(inner).map(parsePrimitive);
  }

  return parsePrimitive(s);
}

// Split list items, respecting quoted strings with commas inside
function splitList(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") inQuote = !inQuote;
    if (!inQuote && ch === "[") depth++;
    if (!inQuote && ch === "]") depth--;
    if (!inQuote && depth === 0 && ch === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

// ─── Serialize ────────────────────────────────────────────────────────────────

export type DateFormat = "date" | "datetime" | "datetime-seconds";

export function serializePrimitive(value: FrontmatterPrimitive, dateFormat: DateFormat = "date"): string {
  if (value instanceof Date) {
    if (dateFormat === "datetime-seconds") return value.toISOString().slice(0, 19); // 1991-01-10T12:00:00
    if (dateFormat === "datetime") return value.toISOString().slice(0, 16);          // 1991-01-10T12:00
    return value.toISOString().slice(0, 10);                                         // 1991-01-10
  }
  if (typeof value === "string") return `"${value.replace(/"/g, '\\"')}"`;
  return String(value); // number, boolean
}

export function serializeValue(value: FrontmatterValue, dateFormat: DateFormat = "date"): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializePrimitive(v, dateFormat)).join(", ")}]`;
  }
  return serializePrimitive(value, dateFormat);
}
