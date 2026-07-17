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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@mapos/ui/components/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider
} from "@mapos/ui/components/sidebar";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { cn } from "@mapos/ui/lib/utils";
import { GlobeIcon, InfoIcon, LayersIcon, PaletteIcon, SettingsIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { type MapColor, applyMapColor, readStoredMapColor } from "../lib/map-color";
import { type Theme, applyTheme, readStoredTheme } from "../lib/theme";
import { MapColorPicker } from "./map-color-picker";
import { AboutTab } from "./settings/about-tab";
import { OfflineTab } from "./settings/offline-tab";
import { AiModelTab } from "./settings/providers/ai-model-tab";
import { ThemePicker } from "./theme-picker";

// ── Settings sheet slot ───────────────────────────────────────────────────────

/**
 * Slot element that floating panels (like the custom-endpoint editor) portal into.
 * It's positioned to fully cover the Settings dialog body so panels can slide in
 * from an edge without escaping into the parent app — and so the underlying tab
 * content stays visible behind them rather than being hidden under another modal.
 */
export const SettingsSheetSlotContext = createContext<HTMLDivElement | null>(null);

export function useSettingsSheetSlot(): HTMLDivElement | null {
  return useContext(SettingsSheetSlotContext);
}

// ── Types ────────────────────────────────────────────────────────────────────

type SettingsPage = "general" | "appearance" | "ai" | "offline" | "about";

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

function GeneralPage({
  onRequestDelete
}: {
  onRequestDelete: (name: string, isLastVault: boolean) => void;
}) {
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
  const isLastVault = vaultCount <= 1;

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
        title="Danger zone"
        description={
          isLastVault
            ? "Delete this vault from MapOS. Files on disk are kept — since it's your only vault, you'll be returned to the welcome screen."
            : "Delete this vault from MapOS. Files on disk are kept — you can add the folder back later from the vault switcher."
        }
      >
        <Button
          variant="destructive"
          className="self-start"
          onClick={() => onRequestDelete(currentName, isLastVault)}
          disabled={busy}
        >
          Delete vault
        </Button>
      </Section>
    </div>
  );
}

// ── Appearance page ───────────────────────────────────────────────────────────

function AppearancePage() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [mapColor, setMapColorState] = useState<MapColor>(readStoredMapColor);

  function handleTheme(t: Theme) {
    setThemeState(t);
    applyTheme(t);
  }

  function handleMapColor(c: MapColor) {
    setMapColorState(c);
    applyMapColor(c);
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Theme" description="Choose how MapOS looks. System follows your OS setting.">
        <ThemePicker value={theme} onChange={handleTheme} />
      </Section>
      <Section
        title="Map color"
        description="Full uses the tinted basemap; Monochrome uses a clean white or black one."
      >
        <MapColorPicker value={mapColor} onChange={handleMapColor} />
      </Section>
    </div>
  );
}

// ── Nav items config ──────────────────────────────────────────────────────────

const NAV_ITEMS: { id: SettingsPage; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "ai", label: "AI Models", icon: LayersIcon },
  { id: "offline", label: "Offline", icon: GlobeIcon },
  { id: "about", label: "About", icon: InfoIcon }
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
  const [pendingDelete, setPendingDelete] = useState<{
    name: string;
    isLastVault: boolean;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sheetSlot, setSheetSlot] = useState<HTMLDivElement | null>(null);

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
        <DialogContent
          // Transparent so the translucent sidebar rail shows the (blurred) app
          // behind the dialog. The opaque panel fill lives on the content zone only.
          className="overflow-hidden gap-0 bg-transparent p-0 sm:max-w-[720px]"
        >
          <SidebarProvider
            className="h-[620px] min-h-0 overflow-hidden"
            style={{ "--sidebar-width": "180px" } as React.CSSProperties}
          >
            <Sidebar collapsible="none" className="border-r bg-sidebar/75 backdrop-blur-md">
              <SidebarContent>
                <SidebarGroup>
                  <SidebarMenu className="gap-0.5">
                    {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
                      <SidebarMenuItem key={id}>
                        <SidebarMenuButton
                          isActive={page === id}
                          onClick={() => setPage(id)}
                          // The default active fill (opaque bg-sidebar-accent) washes out on
                          // the translucent rail; use the same dark hover veil so it stays legible.
                          className="data-active:bg-hover"
                        >
                          <Icon />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              </SidebarContent>
            </Sidebar>

            <SettingsSheetSlotContext.Provider value={sheetSlot}>
              <div
                className={cn(
                  surfaceVariants({ variant: "panel" }),
                  "relative flex-1 overflow-hidden"
                )}
              >
                {/* `translateZ(0)` puts this scroll container on its own compositor layer.
                    Without it, fast scrolls share a layer with the stacked backdrop-filter
                    regions (dialog overlay + inner sidebar + app chrome) and Chromium
                    occasionally drops a composite frame, briefly blanking the whole DOM. */}
                <div
                  className="h-full overflow-y-auto bg-transparent p-6"
                  style={{ transform: "translateZ(0)" }}
                >
                  {page === "general" && (
                    <GeneralPage
                      onRequestDelete={(name, isLastVault) => {
                        setDeleteError(null);
                        setPendingDelete({ name, isLastVault });
                      }}
                    />
                  )}
                  {page === "appearance" && <AppearancePage />}
                  {page === "ai" && <AiModelTab />}
                  {page === "offline" && <OfflineTab />}
                  {page === "about" && <AboutTab />}
                </div>
                {/* Sheets and other floating panels portal into this slot so they
                    stay bounded to the Settings dialog body. */}
                <div ref={setSheetSlot} className="pointer-events-none absolute inset-0" />
              </div>
            </SettingsSheetSlotContext.Provider>
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
              not be deleted —{" "}
              {pendingDelete?.isLastVault
                ? "since it's your only vault, you'll be returned to the welcome screen."
                : "you can add it back later from the vault switcher."}
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
