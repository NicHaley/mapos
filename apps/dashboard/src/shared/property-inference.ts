import type { PropertyType } from "./types";

const DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z?)$/;

export function inferPropertyType(value: unknown): PropertyType {
  if (Array.isArray(value)) return "multi_select";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string" && DATE_RE.test(value)) return "date";
  return "text";
}

export function defaultValueForType(type: PropertyType): unknown {
  if (type === "number") return 0;
  if (type === "date") return new Date().toISOString().slice(0, 10);
  if (type === "checkbox") return false;
  if (type === "multi_select") return [];
  return "";
}
