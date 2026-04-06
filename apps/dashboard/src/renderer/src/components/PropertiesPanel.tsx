import { firstUniqueName } from "@renderer/lib/unique-name";
import { cn } from "@renderer/lib/utils";
import {
  CalendarIcon,
  CheckIcon,
  GripVerticalIcon,
  HashIcon,
  PlusIcon,
  TextIcon,
  ToggleLeftIcon,
  Trash2Icon,
  TriangleAlertIcon
} from "lucide-react";
import { Reorder } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const PROPERTY_TYPES: { value: PropertyType; label: string; icon: React.ReactNode }[] = [
  { value: "text", label: "Text", icon: <TextIcon className="size-4" /> },
  { value: "number", label: "Number", icon: <HashIcon className="size-4" /> },
  { value: "date", label: "Date", icon: <CalendarIcon className="size-4" /> },
  { value: "checkbox", label: "Checkbox", icon: <ToggleLeftIcon className="size-4" /> }
];

function typeIcon(type: PropertyType): React.ReactNode {
  return PROPERTY_TYPES.find((t) => t.value === type)?.icon ?? <TextIcon className="size-4" />;
}

function defaultValueForType(type: PropertyType): unknown {
  if (type === "number") return 0;
  if (type === "date") return new Date().toISOString().slice(0, 10);
  if (type === "checkbox") return false;
  return "";
}

function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return String(value);
  return String(value);
}

function isEmptyPropertyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
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
    default:
      return true;
  }
}

function expectedTypeLabel(type: PropertyType): string {
  return PROPERTY_TYPES.find((t) => t.value === type)?.label.toLowerCase() ?? type;
}

function TypeMismatchAlert({ type }: { type: PropertyType }): React.JSX.Element {
  return (
    <TooltipProvider>
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
    </TooltipProvider>
  );
}

function getOrderedKeys(order: string[], fm: Record<string, unknown>): string[] {
  const fmKeys = Object.keys(fm);
  const ordered = order.filter((k) => k in fm);
  const rest = fmKeys.filter((k) => !order.includes(k));
  return [...ordered, ...rest];
}

/** Keys registered in the vault catalog but not yet on this file, in a sensible order. */
function existingPropertyKeysNotOnFile(
  propertyTypes: PropertyTypes,
  orderedKeys: string[],
  globalOrder: string[]
): string[] {
  const reserved = new Set<string>(RESERVED_PROPERTY_KEYS as unknown as string[]);
  const onFile = new Set(orderedKeys);
  const raw = Object.keys(propertyTypes).filter((k) => !onFile.has(k) && !reserved.has(k));
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
  type: PropertyType;
  propertyTypes: PropertyTypes;
  onTypeChange: (key: string, type: PropertyType) => void;
  onRename: (oldKey: string, newKey: string) => void;
  onDelete: (key: string) => void;
}

function PropertyKey({
  propKey,
  type,
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
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, propKey]);

  function commitRename(): void {
    const trimmed = draftKey.trim();
    if (trimmed && trimmed !== propKey) onRename(propKey, trimmed);
  }

  function handleOpenChange(val: boolean): void {
    setOpen(val);
    if (!val) commitRename();
  }

  const activeType = propertyTypes[propKey] ?? "text";

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted outline-none">
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <span className="flex w-full justify-center opacity-100 transition-opacity group-hover:opacity-0">
            {typeIcon(type)}
          </span>
          <GripVerticalIcon
            className="pointer-events-none absolute size-3.5 opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground/50"
            aria-hidden
          />
        </span>
        <span className="truncate">{propKey}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-48">
        <div className="px-1.5 py-1">
          <Input
            ref={inputRef}
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => {
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
            {typeIcon(type)}
            Type
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {PROPERTY_TYPES.map((t) => (
              <DropdownMenuItem key={t.value} onClick={() => onTypeChange(propKey, t.value)}>
                {t.icon}
                {t.label}
                {activeType === t.value && <CheckIcon className="ml-auto size-4" />}
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
  onTypesChange: (newTypes: PropertyTypes) => void;
  onOrderChange: (newOrder: string[]) => void;
}

export function PropertiesPanel({
  filePath,
  frontmatter,
  propertyTypes,
  propertyOrder,
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
    () => existingPropertyKeysNotOnFile(propertyTypes, orderedKeys, propertyOrder),
    [propertyTypes, orderedKeys, propertyOrder]
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
                type={propertyTypes[key] ?? "text"}
                propertyTypes={propertyTypes}
                onTypeChange={handleTypeChange}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            </div>
            <PropertyValue
              propKey={key}
              value={localFrontmatter[key]}
              type={propertyTypes[key] ?? "text"}
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
