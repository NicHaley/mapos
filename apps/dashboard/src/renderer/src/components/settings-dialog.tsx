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
import { GlobeIcon, InfoIcon, PaletteIcon, PlugIcon, SettingsIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { setAccent, useAccent } from "../lib/accent";
import { setMapColor, useMapColor } from "../lib/map-color";
import { setTheme, useTheme } from "../lib/theme";
import { AccentPicker } from "./accent-picker";
import { MapColorPicker } from "./map-color-picker";
import { AboutTab } from "./settings/about-tab";
import { ConnectionsTab } from "./settings/connections-tab";
import { OfflineTab } from "./settings/offline-tab";
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

type SettingsPage = "general" | "appearance" | "connections" | "offline" | "about";

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
  // Accent, map colour, and theme are per-vault stores; the hooks re-render on
  // change, so the pickers stay controlled without local state mirrors.
  const accent = useAccent();
  const mapColor = useMapColor();
  const theme = useTheme();

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Accent color"
        description="Tints buttons, the vault icon, and map features. Monochrome follows the theme."
      >
        <AccentPicker value={accent} onChange={setAccent} />
      </Section>
      <Section title="Theme" description="Choose how MapOS looks. System follows your OS setting.">
        <ThemePicker value={theme} onChange={setTheme} />
      </Section>
      <Section
        title="Map color"
        description="Full uses the tinted basemap; Monochrome uses a clean white or black one."
      >
        <MapColorPicker value={mapColor} onChange={setMapColor} />
      </Section>
    </div>
  );
}

// ── Nav items config ──────────────────────────────────────────────────────────

const NAV_ITEMS: { id: SettingsPage; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "connections", label: "Connections", icon: PlugIcon },
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
              {/* Plain relative cell: no backdrop-filter here, so it does NOT form a
                  stacking context. The glass fill lives on an inner layer instead —
                  keeping it off this wrapper lets the sheet slot's z-index promote
                  into the dialog's stacking context and win against the dialog's
                  close button (a sibling of the whole body, painted after it). */}
              <div className="relative flex-1 overflow-hidden">
                <div className={cn(surfaceVariants({ variant: "panel" }), "absolute inset-0")}>
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
                    {page === "connections" && <ConnectionsTab />}
                    {page === "offline" && <OfflineTab />}
                    {page === "about" && <AboutTab />}
                  </div>
                </div>
                {/* Sheets and other floating panels portal into this slot so they
                    stay bounded to the Settings dialog body. `z-10` lifts an open
                    drawer above the dialog's close button (the X). */}
                <div ref={setSheetSlot} className="pointer-events-none absolute inset-0 z-10" />
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
