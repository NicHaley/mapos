import { cn } from "@renderer/lib/utils";
import {
  CheckIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SettingsIcon,
  SunIcon
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent } from "./ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "./ui/sidebar";

// ── Types ────────────────────────────────────────────────────────────────────

type SettingsPage = "general" | "vault" | "appearance";
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

function GeneralPage() {
  const [vaults, setVaults] = useState<string[]>([]);
  const [activeVaultPath, setActiveVaultPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void window.api.mapos.getVaultsConfig().then(({ vaults: v, activeVaultPath: a }) => {
      setVaults(v);
      setActiveVaultPath(a);
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleSwitch(path: string) {
    if (path === activeVaultPath) return;
    setBusy(true);
    setError(null);
    const r = await window.api.mapos.switchVault(path);
    setBusy(false);
    if (!r.ok) setError(r.error);
    else reload();
  }

  async function handleSetFolder() {
    setBusy(true);
    setError(null);
    const r = await window.api.mapos.setFolderAsVault();
    setBusy(false);
    if ("canceled" in r) return;
    if (!r.ok) {
      setError(r.error);
      return;
    }
    reload();
  }

  async function handleCreateNew() {
    setBusy(true);
    setError(null);
    const r = await window.api.mapos.createNewVault();
    setBusy(false);
    if ("canceled" in r) return;
    if (!r.ok) {
      setError(r.error);
      return;
    }
    reload();
  }

  function vaultBasename(path: string): string {
    const n = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return n >= 0 ? path.slice(n + 1) : path;
  }

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Vaults"
        description="Vaults are folders on your machine where MapOS stores your notes and places."
      >
        <div className="flex flex-col gap-1">
          {vaults.map((path) => {
            const isActive = path === activeVaultPath;
            return (
              <button
                key={path}
                type="button"
                disabled={busy}
                onClick={() => void handleSwitch(path)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                  isActive
                    ? "border-foreground/20 bg-accent"
                    : "border-border hover:bg-accent/50 cursor-pointer"
                )}
              >
                {isActive ? (
                  <FolderOpenIcon className="size-4 shrink-0 text-foreground/70" />
                ) : (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn("truncate font-medium", !isActive && "text-muted-foreground")}
                  >
                    {vaultBasename(path)}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{path}</span>
                </div>
                {isActive && <CheckIcon className="size-3.5 shrink-0 text-foreground/60" />}
              </button>
            );
          })}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSetFolder()}
            disabled={busy}
          >
            <FolderPlusIcon className="size-3.5" />
            Add existing folder
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCreateNew()}
            disabled={busy}
          >
            Create new vault
          </Button>
        </div>
      </Section>
    </div>
  );
}

// ── Vault page ────────────────────────────────────────────────────────────────

function VaultPage() {
  const [vaultRoot, setVaultRoot] = useState<string>("");

  useEffect(() => {
    void window.api.fs.getVaultRoot().then(setVaultRoot);
  }, []);

  function vaultBasename(path: string): string {
    const n = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return n >= 0 ? path.slice(n + 1) : path;
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Active vault">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <span className="text-sm font-medium">{vaultBasename(vaultRoot) || "—"}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Location</span>
            <span className="break-all font-mono text-xs text-foreground/80">
              {vaultRoot || "—"}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => vaultRoot && void window.api.fs.revealInFinder(vaultRoot)}
            disabled={!vaultRoot}
          >
            Open in Finder
          </Button>
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
  { id: "vault", label: "Vault", icon: FolderIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon }
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

  useEffect(() => {
    if (open) setPage(initialPage);
  }, [open, initialPage]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] p-0 gap-0 overflow-hidden">
        <SidebarProvider
          className="h-[460px] min-h-0 overflow-hidden"
          style={{ "--sidebar-width": "180px" } as React.CSSProperties}
        >
          <Sidebar collapsible="none" className="border-r">
            <SidebarContent>
              <SidebarGroup>
                <SidebarMenu>
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

          {/* Right content */}
          <div className="flex-1 overflow-y-auto bg-background p-6 pr-10">
            {page === "general" && <GeneralPage />}
            {page === "vault" && <VaultPage />}
            {page === "appearance" && <AppearancePage />}
          </div>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
