import { firstUniqueName } from "@renderer/lib/unique-name";
import { format } from "date-fns";
import {
  CalendarIcon,
  CheckIcon,
  GripVerticalIcon,
  HashIcon,
  PlusIcon,
  TagsIcon,
  TextIcon,
  ToggleLeftIcon,
  Trash2Icon,
  XIcon
} from "lucide-react";
import { Reorder } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { PropertyType } from "../../../shared/types";
import { RESERVED_PROPERTY_KEYS } from "../../../shared/types";
import { Calendar } from "./ui/calendar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Switch } from "./ui/switch";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z?$/;

function isDatePropertyString(s: string): boolean {
  return DATE_ONLY_RE.test(s) || DATE_TIME_RE.test(s);
}

/** Parse stored YYYY-MM-DD or local YYYY-MM-DDTHH:mm(:ss)? into a Date in local time. */
function parseDatePropertyString(s: string): Date {
  if (DATE_ONLY_RE.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  if (DATE_TIME_RE.test(s)) {
    const [datePart, rest] = s.split("T");
    const [y, mo, d] = datePart.split("-").map(Number);
    const timePart = rest.replace(/Z$/, "");
    const parts = timePart.split(":");
    const h = Number.parseInt(parts[0] ?? "0", 10);
    const mi = Number.parseInt(parts[1] ?? "0", 10);
    const sec = Number.parseInt(parts[2] ?? "0", 10);
    return new Date(y, mo - 1, d, h, mi, sec);
  }
  return new Date();
}

/** Serialize: date-only when midnight; otherwise local datetime without timezone. */
function serializeDateProperty(d: Date, opts?: { asLocalDateTime?: boolean }): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = d.getHours();
  const mi = d.getMinutes();
  const s = d.getSeconds();
  const hh = String(h).padStart(2, "0");
  const mm = String(mi).padStart(2, "0");
  if (opts?.asLocalDateTime) {
    if (s !== 0) {
      const ss = String(s).padStart(2, "0");
      return `${y}-${mo}-${da}T${hh}:${mm}:${ss}`;
    }
    return `${y}-${mo}-${da}T${hh}:${mm}`;
  }
  if (h === 0 && mi === 0 && s === 0) return `${y}-${mo}-${da}`;
  if (s !== 0) {
    const ss = String(s).padStart(2, "0");
    return `${y}-${mo}-${da}T${hh}:${mm}:${ss}`;
  }
  return `${y}-${mo}-${da}T${hh}:${mm}`;
}

const PROPERTY_TYPES: { value: PropertyType; label: string; icon: React.ReactNode }[] = [
  { value: "text", label: "Text", icon: <TextIcon className="size-4" /> },
  { value: "number", label: "Number", icon: <HashIcon className="size-4" /> },
  { value: "date", label: "Date", icon: <CalendarIcon className="size-4" /> },
  { value: "checkbox", label: "Checkbox", icon: <ToggleLeftIcon className="size-4" /> },
  { value: "multi_select", label: "Multi-select", icon: <TagsIcon className="size-4" /> }
];

function typeIcon(type: PropertyType): React.ReactNode {
  return PROPERTY_TYPES.find((t) => t.value === type)?.icon ?? <TextIcon className="size-4" />;
}

function defaultValueForType(type: PropertyType): unknown {
  if (type === "number") return 0;
  if (type === "date") return new Date().toISOString().slice(0, 10);
  if (type === "checkbox") return false;
  if (type === "multi_select") return [];
  return "";
}

const inferenceRules: Array<[PropertyType, z.ZodType]> = [
  ["multi_select", z.array(z.unknown())],
  ["checkbox", z.boolean()],
  ["number", z.number()],
  ["date", z.string().regex(/^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z?)$/)]
];

function inferPropertyType(value: unknown): PropertyType | null {
  for (const [type, schema] of inferenceRules) {
    if (schema.safeParse(value).success) return type;
  }
  return null;
}

function effectivePropertyType(value: unknown): PropertyType {
  return inferPropertyType(value) ?? "text";
}

function coerceToType(value: unknown, type: PropertyType): unknown {
  switch (type) {
    case "text":
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (Array.isArray(value)) return value.join(", ");
      break;
    case "number":
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const n = Number(value);
        if (!Number.isNaN(n)) return n;
      }
      break;
    case "date":
      if (typeof value === "string" && isDatePropertyString(value)) return value;
      break;
    case "checkbox":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      break;
    case "multi_select":
      if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
      if (typeof value === "string" && value.trim()) return [value.trim()];
      break;
  }
  return defaultValueForType(type);
}

function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return String(value);
  return String(value);
}

function isEmptyPropertyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/** Keys present anywhere in the vault but not yet on this file, sorted alphabetically. */
function existingPropertyKeysNotOnFile(allVaultKeys: string[], fileKeys: string[]): string[] {
  const reserved = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);
  const onFile = new Set(fileKeys);
  return allVaultKeys
    .filter((k) => !onFile.has(k) && !reserved.has(k))
    .sort((a, b) => a.localeCompare(b));
}

// ─── PropertyKey ────────────────────────────────────────────────────────────

interface PropertyKeyProps {
  propKey: string;
  value: unknown;
  onTypeChange: (key: string, type: PropertyType) => void;
  onRename: (oldKey: string, newKey: string) => void;
  onDelete: (key: string) => void;
}

function PropertyKey({
  propKey,
  value,
  onTypeChange,
  onRename,
  onDelete
}: PropertyKeyProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(propKey);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setDraftKey(propKey);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, propKey]);

  const systemKeys = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);

  function commitRename(): void {
    const trimmed = draftKey.trim();
    if (!trimmed || trimmed === propKey) return;
    if (systemKeys.has(trimmed)) {
      setDraftKey(propKey);
      return;
    }
    onRename(propKey, trimmed);
  }

  function handleOpenChange(val: boolean): void {
    setOpen(val);
    if (!val) commitRename();
  }

  const effective = effectivePropertyType(value);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
      <DropdownMenuTrigger className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent outline-none">
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <span className="flex w-full justify-center opacity-100 transition-opacity group-hover:opacity-0">
            {typeIcon(effective)}
          </span>
          <GripVerticalIcon
            className="pointer-events-none absolute size-3.5 opacity-0 transition-opacity group-hover:opacity-100 text-sidebar-foreground/50"
            aria-hidden
          />
        </span>
        <span className="truncate">{propKey}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-48">
        <div
          className="px-1.5 py-1"
          onKeyDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Input
            ref={inputRef}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => {
              // Menu steals printable keys for typeahead / roving focus unless we isolate the field.
              e.stopPropagation();
              if (e.key === "Enter") {
                commitRename();
                setOpen(false);
              }
              if (e.key === "Escape") {
                setDraftKey(propKey);
                setOpen(false);
              }
            }}
            className="h-7 text-sm"
          />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {typeIcon(effective)}
            Type
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {PROPERTY_TYPES.map((t) => (
              <DropdownMenuItem key={t.value} onClick={() => onTypeChange(propKey, t.value)}>
                {t.icon}
                {t.label}
                {effective === t.value && <CheckIcon className="ml-auto size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(propKey)}>
          <Trash2Icon />
          Delete property
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function normalizeMultiSelectValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

// ─── MultiSelectPropertyValue ────────────────────────────────────────────────

function MultiSelectPropertyValue({
  propKey,
  value,
  onValueChange
}: {
  propKey: string;
  value: unknown;
  onValueChange: (key: string, value: unknown) => void;
}): React.JSX.Element {
  const items = normalizeMultiSelectValue(value);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const loadSuggestions = useCallback(async () => {
    const vals = await window.api.properties.valuesForKey(propKey);
    setSuggestions(vals);
  }, [propKey]);

  useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  useEffect(() => {
    if (open) void loadSuggestions();
  }, [open, loadSuggestions]);

  function setItems(next: string[]): void {
    onValueChange(propKey, next);
  }

  function addToken(raw: string): void {
    const t = raw.trim();
    if (!t || items.includes(t)) return;
    setItems([...items, t]);
  }

  function removeToken(t: string): void {
    setItems(items.filter((x) => x !== t));
  }

  const q = draft.trim().toLowerCase();
  const filtered = suggestions.filter(
    (s) => !items.includes(s) && (q === "" || s.toLowerCase().includes(q))
  );

  return (
    <div className="relative flex h-7 min-w-0 w-full items-center">
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (v) setDraft("");
        }}
      >
        <PopoverTrigger className="flex h-7 w-full cursor-pointer items-center rounded px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent">
          {items.length === 0 ? (
            <span className="text-sidebar-foreground/60">Empty</span>
          ) : (
            <span className="truncate text-sidebar-foreground">{items.join(", ")}</span>
          )}
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-72 p-2">
          <div className="flex flex-col gap-2">
            {items.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {items.map((t) => (
                  <span
                    key={t}
                    className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-sidebar-accent pl-2 pr-0.5 py-0.5 text-sm text-sidebar-foreground/80"
                  >
                    <span className="truncate">{t}</span>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-sidebar-border/60 text-sidebar-foreground/50 hover:text-sidebar-foreground shrink-0"
                      aria-label={`Remove ${t}`}
                      onClick={() => removeToken(t)}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  const part = e.key === "," ? (draft.split(",")[0]?.trim() ?? "") : draft.trim();
                  if (part) addToken(part);
                  setDraft("");
                }
                if (e.key === "Backspace" && draft === "") {
                  const last = items.at(-1);
                  if (last !== undefined) removeToken(last);
                }
              }}
              placeholder="Add value…"
              className="h-7 text-sm"
            />
            <ScrollArea className="max-h-28 rounded-md">
              <div className="flex flex-col">
                {filtered.length === 0 ? (
                  <span className="text-xs text-sidebar-foreground/60 px-1 py-1">
                    {suggestions.length === 0 ? "No other values in vault yet" : "No matches"}
                  </span>
                ) : (
                  filtered.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="relative flex w-full cursor-default select-none items-center rounded-md py-1 pl-1.5 pr-2 text-left text-sm text-popover-foreground outline-hidden transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 truncate"
                      onClick={() => {
                        addToken(s);
                        setDraft("");
                      }}
                    >
                      {s}
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── DatePropertyValue ───────────────────────────────────────────────────────

/** True when the value was stored with an explicit time (incl. midnight), not date-only. */
function storedValueHasDateTime(value: unknown): boolean {
  return typeof value === "string" && DATE_TIME_RE.test(value);
}

function DatePropertyValue({
  propKey,
  value,
  isEmpty,
  onValueChange
}: {
  propKey: string;
  value: unknown;
  isEmpty: boolean;
  onValueChange: (key: string, value: unknown) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [timeEnabled, setTimeEnabled] = useState(false);

  useEffect(() => {
    if (open) {
      setTimeEnabled(storedValueHasDateTime(value));
    }
  }, [open, value]);

  const hasDate = typeof value === "string" && isDatePropertyString(value);
  const selected = hasDate ? parseDatePropertyString(value) : undefined;
  const timeInputValue = `${String(selected?.getHours() ?? 0).padStart(2, "0")}:${String(
    selected?.getMinutes() ?? 0
  ).padStart(2, "0")}`;

  function commitFromDate(d: Date, options?: { asLocalDateTime?: boolean }): void {
    onValueChange(propKey, serializeDateProperty(d, options));
  }

  function handleTimeToggle(checked: boolean): void {
    setTimeEnabled(checked);
    if (!selected) return;
    if (checked) {
      commitFromDate(new Date(selected), { asLocalDateTime: true });
    } else {
      const d = new Date(selected);
      d.setHours(0, 0, 0, 0);
      commitFromDate(d);
    }
  }

  return (
    <div className="relative flex h-7 min-w-0 w-full items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent">
          {/* <CalendarIcon className="size-3.5 shrink-0 text-sidebar-foreground/60" aria-hidden /> */}
          {isEmpty || !hasDate ? (
            <span className="text-sidebar-foreground/60">Empty</span>
          ) : (
            <span className="truncate text-sidebar-foreground">
              {selected &&
                (typeof value === "string" && DATE_ONLY_RE.test(value)
                  ? format(selected, "PPP")
                  : `${format(selected, "PPP")} · ${format(selected, "p")}`)}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-auto p-0">
          <div className="flex flex-col gap-0">
            <Calendar
              mode="single"
              selected={selected}
              onSelect={(d) => {
                if (!d) return;
                const next = new Date(d);
                if (timeEnabled && selected) {
                  next.setHours(
                    selected.getHours(),
                    selected.getMinutes(),
                    selected.getSeconds(),
                    0
                  );
                  commitFromDate(next, { asLocalDateTime: true });
                } else {
                  next.setHours(0, 0, 0, 0);
                  commitFromDate(next);
                }
              }}
              defaultMonth={selected ?? new Date()}
              className="bg-transparent"
            />
            {selected ? (
              <div className="border-t border-sidebar-border">
                <div
                  className="flex items-center justify-between gap-3 px-3 py-2"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <span className="text-xs text-sidebar-foreground/60">Time</span>
                  <Switch size="sm" checked={timeEnabled} onCheckedChange={handleTimeToggle} />
                </div>
                {timeEnabled ? (
                  <div className="px-3 pb-2">
                    <Input
                      type="time"
                      step={60}
                      value={timeInputValue}
                      onChange={(e) => {
                        const v = e.target.value;
                        const [hh, mm] = v.split(":").map((x) => Number.parseInt(x, 10));
                        const base = new Date(selected);
                        base.setHours(
                          Number.isFinite(hh) ? hh : 0,
                          Number.isFinite(mm) ? mm : 0,
                          0,
                          0
                        );
                        commitFromDate(base, { asLocalDateTime: true });
                      }}
                      className="h-8 w-full bg-transparent text-sm appearance-none [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── PropertyValue ───────────────────────────────────────────────────────────

interface PropertyValueProps {
  propKey: string;
  value: unknown;
  type: PropertyType;
  onValueChange: (key: string, value: unknown) => void;
}

function PropertyValue({
  propKey,
  value,
  type,
  onValueChange
}: PropertyValueProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(toDisplayString(value));

  useEffect(() => {
    setDraft(toDisplayString(value));
  }, [value]);

  function commitDraft(): void {
    if (type === "number") {
      const n = Number(draft);
      if (!Number.isNaN(n)) onValueChange(propKey, n);
    } else {
      onValueChange(propKey, draft);
    }
  }

  const isEmpty = isEmptyPropertyValue(value);

  if (type === "multi_select") {
    return (
      <MultiSelectPropertyValue propKey={propKey} value={value} onValueChange={onValueChange} />
    );
  }

  if (type === "checkbox") {
    return (
      <div className="relative flex h-7 min-w-0 w-full items-center">
        <button
          type="button"
          className="flex h-full w-full cursor-pointer items-center rounded px-2 transition-colors hover:bg-sidebar-accent"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('[role="switch"]')) return;
            onValueChange(propKey, !(value === true || value === "true"));
          }}
        >
          <Switch
            size="sm"
            checked={value === true || value === "true"}
            onCheckedChange={(checked) => onValueChange(propKey, checked)}
          />
        </button>
      </div>
    );
  }

  if (type === "date") {
    return (
      <DatePropertyValue
        propKey={propKey}
        value={value}
        isEmpty={isEmpty}
        onValueChange={onValueChange}
      />
    );
  }

  // text / number
  return (
    <div className="relative flex h-7 min-w-0 w-full items-center">
      <Popover
        open={open}
        onOpenChange={(val) => {
          setOpen(val);
          if (!val) commitDraft();
        }}
      >
        <PopoverTrigger className="flex h-7 w-full cursor-pointer items-center rounded px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent">
          {isEmpty ? (
            <span className="text-sidebar-foreground/60">Empty</span>
          ) : (
            <span className="truncate text-sidebar-foreground">{toDisplayString(value)}</span>
          )}
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-52 p-2">
          <Input
            type={type === "number" ? "number" : "text"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitDraft();
                setOpen(false);
              }
              if (e.key === "Escape") {
                setDraft(toDisplayString(value));
                setOpen(false);
              }
            }}
            className="h-7 text-sm"
            ref={(el) => {
              if (el) el.focus();
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── PropertiesPanel ─────────────────────────────────────────────────────────

interface PropertiesPanelProps {
  filePath: string;
  frontmatter: Record<string, unknown>;
  allVaultKeys: string[];
  /** Override the default write implementation (which uses YAML frontmatter). */
  onWriteProperty?: (key: string, value: unknown) => Promise<void>;
  /** Whether drag-to-reorder persists. Default true. */
  reorderable?: boolean;
}

function PropertiesPanelInner({
  filePath,
  frontmatter,
  allVaultKeys,
  onWriteProperty,
  reorderable = true
}: PropertiesPanelProps): React.JSX.Element {
  const [localFrontmatter, setLocalFrontmatter] = useState(frontmatter);

  const fileKeys = useMemo(() => Object.keys(localFrontmatter), [localFrontmatter]);

  const existingKeysToAdd = useMemo(
    () => existingPropertyKeysNotOnFile(allVaultKeys, fileKeys),
    [allVaultKeys, fileKeys]
  );

  async function writeProperty(key: string, value: unknown): Promise<void> {
    if (onWriteProperty) {
      await onWriteProperty(key, value);
    } else {
      await window.api.fs.writeFrontmatterProperty(filePath, key, value);
    }
  }

  async function handleValueChange(key: string, value: unknown): Promise<void> {
    setLocalFrontmatter((prev) => ({ ...prev, [key]: value }));
    await writeProperty(key, value);
  }

  async function handleDelete(key: string): Promise<void> {
    setLocalFrontmatter((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    await writeProperty(key, null);
  }

  async function handleTypeChange(key: string, type: PropertyType): Promise<void> {
    await handleValueChange(key, coerceToType(localFrontmatter[key], type));
  }

  function handleReorder(newOrder: string[]): void {
    setLocalFrontmatter((prev) => {
      const next: Record<string, unknown> = {};
      for (const key of newOrder) {
        if (Object.hasOwn(prev, key)) next[key] = prev[key];
      }
      return next;
    });
    if (reorderable) void window.api.fs.reorderFrontmatter(filePath, newOrder);
  }

  async function handleRename(oldKey: string, newKey: string): Promise<void> {
    const trimmed = newKey.trim();
    const reserved = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);
    if (reserved.has(trimmed)) return;
    if (trimmed !== oldKey && Object.hasOwn(localFrontmatter, trimmed)) return;

    const value = localFrontmatter[oldKey];

    setLocalFrontmatter((prev) => {
      const next = { ...prev };
      delete next[oldKey];
      next[newKey] = value;
      return next;
    });

    await writeProperty(oldKey, null);
    await writeProperty(newKey, value);
  }

  async function handleAddProperty(type: PropertyType): Promise<void> {
    const label = PROPERTY_TYPES.find((t) => t.value === type)?.label ?? "Text";
    const reserved = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);
    const key = firstUniqueName(label, (k) => reserved.has(k) || k in localFrontmatter, {
      suffixStyle: "spaceNumbered",
      maxCandidates: 1000,
      fallback: (b) => `${b} ${Date.now()}`
    });
    const value = defaultValueForType(type);
    setLocalFrontmatter((prev) => ({ ...prev, [key]: value }));
    await writeProperty(key, value);
  }

  async function handleAddExistingProperty(key: string): Promise<void> {
    const value = defaultValueForType("text");
    setLocalFrontmatter((prev) => ({ ...prev, [key]: value }));
    await writeProperty(key, value);
  }

  return (
    <div className="px-2 pb-6 text-sidebar-foreground">
      <Reorder.Group
        axis="y"
        values={fileKeys}
        onReorder={handleReorder}
        className="flex flex-col"
        as="div"
      >
        {fileKeys.map((key) => (
          <Reorder.Item
            key={key}
            value={key}
            className="group grid h-7 grid-cols-2 items-center"
            as="div"
          >
            <div className="flex min-h-0 min-w-0 items-center">
              <PropertyKey
                propKey={key}
                value={localFrontmatter[key]}
                onTypeChange={handleTypeChange}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            </div>
            <div className="flex min-h-0 min-w-0 items-center">
              <PropertyValue
                propKey={key}
                value={localFrontmatter[key]}
                type={effectivePropertyType(localFrontmatter[key])}
                onValueChange={handleValueChange}
              />
            </div>
          </Reorder.Item>
        ))}
      </Reorder.Group>

      <div className="grid h-7 grid-cols-2 items-center">
        <div className="flex min-h-0 min-w-0 items-center">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded px-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors outline-none">
              <PlusIcon className="size-4" />
              Add property
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" className="w-56 max-h-72">
              {existingKeysToAdd.length > 0 && (
                <>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Existing properties</DropdownMenuLabel>
                    {existingKeysToAdd.map((key) => (
                      <DropdownMenuItem
                        key={key}
                        onClick={() => void handleAddExistingProperty(key)}
                        className="gap-2"
                      >
                        {typeIcon("text")}
                        <span className="truncate">{key}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuGroup>
                <DropdownMenuLabel>New property</DropdownMenuLabel>
                {PROPERTY_TYPES.map((t) => (
                  <DropdownMenuItem key={t.value} onClick={() => void handleAddProperty(t.value)}>
                    {t.icon}
                    {t.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="min-w-0" aria-hidden />
      </div>
    </div>
  );
}

export function PropertiesPanel(props: PropertiesPanelProps): React.JSX.Element {
  return <PropertiesPanelInner key={props.filePath} {...props} />;
}
