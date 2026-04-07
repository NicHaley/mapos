import { firstUniqueName } from "@renderer/lib/unique-name";
import { z } from "zod";
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
  TriangleAlertIcon,
  XIcon
} from "lucide-react";
import { Reorder } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PropertyType, PropertyTypes } from "../../../shared/types";
import { RESERVED_PROPERTY_KEYS } from "../../../shared/types";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
  ["date", z.string().regex(/^\d{4}-\d{2}-\d{2}$/)],
];

/** When `types.json` has no entry, infer editor type from YAML shape. */
function inferPropertyType(value: unknown): PropertyType | null {
  for (const [type, schema] of inferenceRules) {
    if (schema.safeParse(value).success) return type;
  }
  return null;
}

function effectivePropertyType(
  key: string,
  value: unknown,
  propertyTypes: PropertyTypes
): PropertyType {
  return propertyTypes[key] ?? inferPropertyType(value) ?? "text";
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

/** Whether frontmatter value matches the declared property type (empty values are ok). */
function isValueAlignedWithType(value: unknown, type: PropertyType): boolean {
  if (isEmptyPropertyValue(value)) return true;
  switch (type) {
    case "text":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "date": {
      if (typeof value !== "string") return false;
      return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
    }
    case "checkbox":
      return (
        typeof value === "boolean" ||
        (typeof value === "string" && (value === "true" || value === "false"))
      );
    case "multi_select":
      return Array.isArray(value) && value.every((x) => typeof x === "string");
    default:
      return true;
  }
}

function expectedTypeLabel(type: PropertyType): string {
  return PROPERTY_TYPES.find((t) => t.value === type)?.label.toLowerCase() ?? type;
}

function TypeMismatchAlert({ type }: { type: PropertyType }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="absolute right-1 top-1/2 z-10 -translate-y-1/2 rounded p-0.5 text-amber-600 hover:text-amber-700 dark:text-amber-500 dark:hover:text-amber-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Type mismatch, expected ${expectedTypeLabel(type)}`}
          />
        }
      >
        <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>Type mismatch, expected {expectedTypeLabel(type)}</TooltipContent>
    </Tooltip>
  );
}

function getOrderedKeys(order: string[], fm: Record<string, unknown>): string[] {
  const fmKeys = Object.keys(fm);
  const ordered = order.filter((k) => k in fm);
  const rest = fmKeys.filter((k) => !order.includes(k));
  return [...ordered, ...rest];
}

/** Keys present anywhere in the vault but not yet on this file, in a sensible order. */
function existingPropertyKeysNotOnFile(
  allVaultKeys: string[],
  orderedKeys: string[],
  globalOrder: string[]
): string[] {
  const reserved = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);
  const onFile = new Set(orderedKeys);
  const raw = allVaultKeys.filter((k) => !onFile.has(k) && !reserved.has(k));
  const orderIndex = new Map(globalOrder.map((k, i) => [k, i]));
  return raw.sort((a, b) => {
    const ia = orderIndex.get(a);
    const ib = orderIndex.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.localeCompare(b);
  });
}

// ─── PropertyKey ────────────────────────────────────────────────────────────

interface PropertyKeyProps {
  propKey: string;
  /** Current frontmatter value (used to infer type when not in types.json). */
  value: unknown;
  propertyTypes: PropertyTypes;
  onTypeChange: (key: string, type: PropertyType) => void;
  onRename: (oldKey: string, newKey: string) => void;
  onDelete: (key: string) => void;
}

function PropertyKey({
  propKey,
  value,
  propertyTypes,
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

  const effective = effectivePropertyType(propKey, value, propertyTypes);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
      <DropdownMenuTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted outline-none">
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <span className="flex w-full justify-center opacity-100 transition-opacity group-hover:opacity-0">
            {typeIcon(effective)}
          </span>
          <GripVerticalIcon
            className="pointer-events-none absolute size-3.5 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground/50"
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

  const typeMismatch = !isValueAlignedWithType(value, "multi_select");

  return (
    <div className="relative min-w-0 w-full">
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (v) setDraft("");
        }}
      >
        <PopoverTrigger className="flex w-full cursor-pointer items-center rounded px-2 py-1 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent min-h-8">
          {items.length === 0 ? (
            <span className="text-muted-foreground">Empty</span>
          ) : (
            <span className="truncate text-sidebar-foreground">{items.join(", ")}</span>
          )}
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-72 p-2">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1">
              {items.map((t) => (
                <span
                  key={t}
                  className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-sidebar-accent pl-2 pr-0.5 py-0.5 text-[11px] text-sidebar-foreground/80"
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
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  const part =
                    e.key === ","
                      ? (draft.split(",")[0]?.trim() ?? "")
                      : draft.trim();
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
            <ScrollArea className="h-28 rounded-md border border-sidebar-border">
              <div className="flex flex-col p-1">
                {filtered.length === 0 ? (
                  <span className="text-xs text-muted-foreground px-1 py-1">
                    {suggestions.length === 0 ? "No other values in vault yet" : "No matches"}
                  </span>
                ) : (
                  filtered.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="rounded px-2 py-1.5 text-left text-xs text-sidebar-foreground hover:bg-sidebar-accent truncate"
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
      {typeMismatch ? <TypeMismatchAlert type="multi_select" /> : null}
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
  const typeMismatch = !isValueAlignedWithType(value, type);

  if (type === "multi_select") {
    return (
      <MultiSelectPropertyValue propKey={propKey} value={value} onValueChange={onValueChange} />
    );
  }

  if (type === "checkbox") {
    return (
      <div className="relative min-w-0 w-full flex h-full">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center rounded px-2 py-1 transition-colors hover:bg-sidebar-accent"
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
        {typeMismatch ? <TypeMismatchAlert type={type} /> : null}
      </div>
    );
  }

  if (type === "date") {
    return (
      <div className="relative min-w-0 w-full">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="flex w-full cursor-pointer items-center rounded px-2 py-1 text-sm text-sidebar-foreground hover:bg-sidebar-accent">
            {isEmpty ? (
              <span className="text-muted-foreground">Empty</span>
            ) : (
              <span className="truncate text-sidebar-foreground">{toDisplayString(value)}</span>
            )}
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-auto p-2">
            <input
              type="date"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                onValueChange(propKey, e.target.value);
                setOpen(false);
              }}
              className="rounded border border-input bg-transparent px-2 py-1 text-sm text-sidebar-foreground outline-none focus:ring-1 focus:ring-ring"
              ref={(el) => {
                if (el) el.focus();
              }}
            />
          </PopoverContent>
        </Popover>
        {typeMismatch ? <TypeMismatchAlert type={type} /> : null}
      </div>
    );
  }

  // text / number
  return (
    <div className="relative min-w-0 w-full">
      <Popover
        open={open}
        onOpenChange={(val) => {
          setOpen(val);
          if (!val) commitDraft();
        }}
      >
        <PopoverTrigger className="flex w-full cursor-pointer items-center rounded px-2 py-1 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent">
          {isEmpty ? (
            <span className="text-muted-foreground">Empty</span>
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
      {typeMismatch ? <TypeMismatchAlert type={type} /> : null}
    </div>
  );
}

// ─── PropertiesPanel ─────────────────────────────────────────────────────────

interface PropertiesPanelProps {
  filePath: string;
  frontmatter: Record<string, unknown>;
  propertyTypes: PropertyTypes;
  propertyOrder: string[];
  allVaultKeys: string[];
  onTypesChange: (newTypes: PropertyTypes) => void;
  onOrderChange: (newOrder: string[]) => void;
}

export function PropertiesPanel({
  filePath,
  frontmatter,
  propertyTypes,
  propertyOrder,
  allVaultKeys,
  onTypesChange,
  onOrderChange
}: PropertiesPanelProps): React.JSX.Element {
  const [localFrontmatter, setLocalFrontmatter] = useState(frontmatter);

  const [orderedKeys, setOrderedKeys] = useState<string[]>(() =>
    getOrderedKeys(propertyOrder, frontmatter)
  );

  // Replace local FM only when the file reloads (prop updates). Do not tie this to
  // `propertyOrder` alone — parent order updates after add/delete before `frontmatter`
  // prop catches up, which would overwrite local state and drop new keys.
  useEffect(() => {
    setLocalFrontmatter(frontmatter);
  }, [frontmatter]);

  useEffect(() => {
    setOrderedKeys(getOrderedKeys(propertyOrder, localFrontmatter));
  }, [propertyOrder, localFrontmatter]);

  const existingKeysToAdd = useMemo(
    () => existingPropertyKeysNotOnFile(allVaultKeys, orderedKeys, propertyOrder),
    [allVaultKeys, orderedKeys, propertyOrder]
  );

  async function handleValueChange(key: string, value: unknown): Promise<void> {
    setLocalFrontmatter((prev) => ({ ...prev, [key]: value }));
    await window.api.fs.writeFrontmatterProperty(filePath, key, value);
  }

  async function handleDelete(key: string): Promise<void> {
    setLocalFrontmatter((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    const newOrder = orderedKeys.filter((k) => k !== key);
    setOrderedKeys(newOrder);
    onOrderChange(newOrder);
    await window.api.properties.writeOrder(newOrder);
    await window.api.fs.writeFrontmatterProperty(filePath, key, null);
  }

  async function handleTypeChange(key: string, type: PropertyType): Promise<void> {
    const newTypes = { ...propertyTypes, [key]: type };
    onTypesChange(newTypes);
    await window.api.properties.writeTypes(newTypes);
  }

  async function handleRename(oldKey: string, newKey: string): Promise<void> {
    const trimmed = newKey.trim();
    const reserved = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);
    if (reserved.has(trimmed)) return;
    if (trimmed !== oldKey && Object.hasOwn(localFrontmatter, trimmed)) return;

    const value = localFrontmatter[oldKey];
    const type = propertyTypes[oldKey];

    setLocalFrontmatter((prev) => {
      const next = { ...prev };
      delete next[oldKey];
      next[newKey] = value;
      return next;
    });

    const newOrder = orderedKeys.map((k) => (k === oldKey ? newKey : k));
    setOrderedKeys(newOrder);
    onOrderChange(newOrder);

    await window.api.fs.writeFrontmatterProperty(filePath, oldKey, null);
    await window.api.fs.writeFrontmatterProperty(filePath, newKey, value);
    await window.api.properties.writeOrder(newOrder);

    if (type) {
      const newTypes = { ...propertyTypes };
      delete newTypes[oldKey];
      newTypes[newKey] = type;
      onTypesChange(newTypes);
      await window.api.properties.writeTypes(newTypes);
    }
  }

  function handleReorder(newOrder: string[]): void {
    setOrderedKeys(newOrder);
    onOrderChange(newOrder);
    void window.api.properties.writeOrder(newOrder);
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
    const newOrder = [...orderedKeys, key];
    setLocalFrontmatter((prev) => ({ ...prev, [key]: value }));
    setOrderedKeys(newOrder);
    onOrderChange(newOrder);

    if (type !== "text") {
      const newTypes = { ...propertyTypes, [key]: type };
      onTypesChange(newTypes);
      await window.api.properties.writeTypes(newTypes);
    }
    await window.api.fs.writeFrontmatterProperty(filePath, key, value);
    await window.api.properties.writeOrder(newOrder);
  }

  async function handleAddExistingProperty(key: string): Promise<void> {
    const type = propertyTypes[key] ?? "text";
    const value = defaultValueForType(type);
    const newOrder = [...orderedKeys, key];
    setLocalFrontmatter((prev) => ({ ...prev, [key]: value }));
    setOrderedKeys(newOrder);
    onOrderChange(newOrder);
    await window.api.fs.writeFrontmatterProperty(filePath, key, value);
    await window.api.properties.writeOrder(newOrder);
  }

  return (
    <div className="px-2 py-1 text-sidebar-foreground">
      <Reorder.Group
        axis="y"
        values={orderedKeys}
        onReorder={handleReorder}
        className="flex flex-col"
        as="div"
      >
        {orderedKeys.map((key) => (
          <Reorder.Item
            key={key}
            value={key}
            className="group grid grid-cols-2 items-center"
            as="div"
          >
            <div className="min-w-0">
              <PropertyKey
                propKey={key}
                value={localFrontmatter[key]}
                propertyTypes={propertyTypes}
                onTypeChange={handleTypeChange}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            </div>
            <PropertyValue
              propKey={key}
              value={localFrontmatter[key]}
              type={effectivePropertyType(key, localFrontmatter[key], propertyTypes)}
              onValueChange={handleValueChange}
            />
          </Reorder.Item>
        ))}
      </Reorder.Group>

      <div className="grid grid-cols-2 items-center">
        <div className="min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted transition-colors outline-none">
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
                        {typeIcon(propertyTypes[key] ?? "text")}
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
