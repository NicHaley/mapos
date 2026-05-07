import { cn } from "@mapos/ui/lib/utils";
import { BoxIcon, MonitorIcon, MoonIcon, PaletteIcon, SettingsIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AiTab } from "./settings/ai-tab";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@mapos/ui/components/alert-dialog";
import { Button } from "@mapos/ui/components/button";
import { Dialog, DialogContent } from "@mapos/ui/components/dialog";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@mapos/ui/components/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "@mapos/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@mapos/ui/components/tooltip";

// ── Types ────────────────────────────────────────────────────────────────────

type SettingsPage = "general" | "appearance" | "ai";
type Theme = "light" | "dark" | "system";

const THEME_KEY = "mapos_theme";

// ── Theme helpers ─────────────────────────────────────────────────────────────

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function applyTheme(theme: Theme): void {
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", prefersDark);
  } else {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
  localStorage.setItem(THEME_KEY, theme);
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-base font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

// ── General page ──────────────────────────────────────────────────────────────

function vaultBasename(path: string): string {
  const n = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return n >= 0 ? path.slice(n + 1) : path;
}

function GeneralPage({ onRequestDelete }: { onRequestDelete: (name: string) => void }) {
  const [vaultCount, setVaultCount] = useState<number>(0);
  const [activeVaultPath, setActiveVaultPath] = useState<string>("");
  const [draftName, setDraftName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void window.api.mapos.getVaultsConfig().then(({ vaults, activeVaultPath: a }) => {
      setVaultCount(vaults.length);
      setActiveVaultPath(a);
      setDraftName(vaultBasename(a));
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const currentName = vaultBasename(activeVaultPath);
  const isDirty = draftName !== currentName;
  const canDelete = vaultCount > 1;

  async function handleSave() {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === currentName) return;
    setBusy(true);
    setRenameError(null);
    const r = await window.api.mapos.renameVault(trimmed);
    if (!r.ok) {
      setBusy(false);
      setRenameError(r.error);
    }
    // On success, the main process reloads the renderer — no further work here.
  }

  function handleCancel() {
    setDraftName(currentName);
    setRenameError(null);
  }

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Vault name"
        description="Rename the folder on disk. All references to the folder path will update."
      >
        <div className="flex flex-col gap-2">
          <InputGroup className="bg-background">
            <InputGroupInput
              value={draftName}
              disabled={busy}
              onChange={(e) => {
                setDraftName(e.target.value);
                if (renameError) setRenameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSave();
                } else if (e.key === "Escape") {
                  handleCancel();
                }
              }}
              aria-invalid={!!renameError}
            />
            {isDirty && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  variant="default"
                  disabled={busy || !draftName.trim()}
                  onClick={() => void handleSave()}
                >
                  Save
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          {renameError && <p className="text-xs text-destructive">{renameError}</p>}
        </div>
      </Section>

      <Section
        title="Index"
        description="The spatial index caches file metadata for fast map queries. It can always be rebuilt from vault files."
      >
        <div className="rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          Index rebuild is available from the command palette (coming soon).
        </div>
      </Section>

      <Section
        title="Danger zone"
        description="Delete this vault from MapOS. Files on disk are kept — you can add the folder back later from the vault switcher."
      >
        {canDelete ? (
          <Button
            variant="destructive"
            size="sm"
            className="self-start"
            onClick={() => onRequestDelete(currentName)}
            disabled={busy}
          >
            Delete vault
          </Button>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex self-start">
                    <Button variant="destructive" size="sm" disabled>
                      Delete vault
                    </Button>
                  </span>
                }
              />
              <TooltipContent side="right">You need at least one vault.</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </Section>
    </div>
  );
}

// ── Appearance page ───────────────────────────────────────────────────────────

function AppearancePage() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  function handleTheme(t: Theme) {
    setThemeState(t);
    applyTheme(t);
  }

  const themeOptions: { value: Theme; label: string; icon: React.ReactNode }[] = [
    { value: "light", label: "Light", icon: <SunIcon className="size-4" /> },
    { value: "system", label: "System", icon: <MonitorIcon className="size-4" /> },
    { value: "dark", label: "Dark", icon: <MoonIcon className="size-4" /> }
  ];

  return (
    <div className="flex flex-col gap-6">
      <Section title="Theme" description="Choose how MapOS looks. System follows your OS setting.">
        <div className="flex gap-2">
          {themeOptions.map(({ value, label, icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => handleTheme(value)}
              className={cn(
                "flex flex-1 cursor-pointer flex-col items-center gap-2 rounded-lg border px-3 py-3 text-xs transition-colors",
                theme === value
                  ? "border-foreground/40 bg-accent font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── Nav items config ──────────────────────────────────────────────────────────

const NAV_ITEMS: { id: SettingsPage; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "ai", label: "Models", icon: BoxIcon }
];

// ── Main dialog ───────────────────────────────────────────────────────────────

export function SettingsDialog({
  open,
  onOpenChange,
  initialPage = "general"
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPage?: SettingsPage;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [pendingDelete, setPendingDelete] = useState<{ name: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPage(initialPage);
  }, [open, initialPage]);

  async function confirmDelete() {
    setIsDeleting(true);
    setDeleteError(null);
    const r = await window.api.mapos.deleteVault();
    if (!r.ok) {
      setIsDeleting(false);
      setDeleteError(r.error);
    }
    // Success: main process reloads the renderer, wiping this state.
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[640px] p-0 gap-0 overflow-hidden bg-sidebar/80 backdrop-blur-md">
          <SidebarProvider
            className="h-[460px] min-h-0 overflow-hidden"
            style={{ "--sidebar-width": "180px" } as React.CSSProperties}
          >
            <Sidebar collapsible="none" className="border-r bg-transparent">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarMenu className="gap-0.5">
                    {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
                      <SidebarMenuItem key={id}>
                        <SidebarMenuButton isActive={page === id} onClick={() => setPage(id)}>
                          <Icon />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>

            {/* `translateZ(0)` puts this scroll container on its own compositor layer.
                Without it, fast scrolls share a layer with the stacked backdrop-filter
                regions (dialog overlay + inner sidebar + app chrome) and Chromium
                occasionally drops a composite frame, briefly blanking the whole DOM. */}
            <div
              className="flex-1 overflow-y-auto bg-transparent p-6 pr-10"
              style={{ transform: "translateZ(0)" }}
            >
              {page === "general" && (
                <GeneralPage
                  onRequestDelete={(name) => {
                    setDeleteError(null);
                    setPendingDelete({ name });
                  }}
                />
              )}
              {page === "appearance" && <AppearancePage />}
              {page === "ai" && <AiTab />}
            </div>
          </SidebarProvider>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o && !isDeleting) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this vault?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{pendingDelete?.name}&quot; will be removed from MapOS. The folder on disk will
              not be deleted — you can add it back later from the vault switcher.
            </AlertDialogDescription>
            {deleteError ? (
              <AlertDialogDescription className="text-destructive">
                {deleteError}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (isDeleting) return;
                setPendingDelete(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={() => {
                void confirmDelete();
              }}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
