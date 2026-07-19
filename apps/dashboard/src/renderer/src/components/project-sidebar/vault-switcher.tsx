import { Button } from "@mapos/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@mapos/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@mapos/ui/components/dropdown-menu";
import { InputGroup, InputGroupInput } from "@mapos/ui/components/input-group";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from "@mapos/ui/components/sidebar";
import { surfaceVariants } from "@mapos/ui/components/surface";
import { cn } from "@mapos/ui/lib/utils";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PlusIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_VAULT_NAME, validateVaultName } from "../../lib/vault-name";

type VaultOption = {
  path: string;
  name: string;
  subtitle: string;
  logo: React.ElementType;
};

function vaultBasename(path: string): string {
  const n = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const s = n >= 0 ? path.slice(n + 1) : path;
  return (s || path).trim() || path;
}

type AddVaultStep = "choose" | "name";

export function VaultSwitcher() {
  const { isMobile } = useSidebar();
  const [vaultOptions, setVaultOptions] = useState<VaultOption[]>([]);
  const [activeVaultPath, setActiveVaultPath] = useState<string | null>(null);
  const [addVaultOpen, setAddVaultOpen] = useState(false);
  const [addVaultBusy, setAddVaultBusy] = useState(false);
  const [addVaultError, setAddVaultError] = useState<string | null>(null);
  const [addVaultStep, setAddVaultStep] = useState<AddVaultStep>("choose");
  const [vaultNameDraft, setVaultNameDraft] = useState<string>(DEFAULT_VAULT_NAME);

  const reloadVaults = useCallback(() => {
    void window.api.mapos.getVaultsConfig().then(({ vaults, activeVaultPath: active }) => {
      const trimmed = vaults.map((p) => p.trim()).filter(Boolean);
      setActiveVaultPath(active);
      setVaultOptions(
        trimmed.map((path) => ({
          path,
          name: vaultBasename(path),
          subtitle: path,
          logo: path === active ? FolderOpenIcon : FolderIcon
        }))
      );
    });
  }, []);

  useEffect(() => {
    reloadVaults();
  }, [reloadVaults]);

  const activeVault = useMemo((): VaultOption => {
    const found = vaultOptions.find((v) => v.path === activeVaultPath);
    if (found) return found;
    if (vaultOptions[0]) return vaultOptions[0];
    return {
      path: "",
      name: "Vault",
      subtitle: "Loading…",
      logo: FolderOpenIcon
    };
  }, [vaultOptions, activeVaultPath]);

  const runCreateNewVault = useCallback(
    async (name: string) => {
      const local = validateVaultName(name);
      if (!local.ok) {
        setAddVaultError(local.error);
        return;
      }
      setAddVaultBusy(true);
      setAddVaultError(null);
      try {
        const r = await window.api.mapos.createNewVault(name.trim());
        if ("canceled" in r && r.canceled) return;
        if ("ok" in r && r.ok === false) {
          setAddVaultError(r.error);
          return;
        }
        if ("ok" in r && r.ok) {
          // On success the switch reloads the renderer into the new vault, so the
          // dialog never needs closing; on failure the vault is still registered.
          const sw = await window.api.mapos.switchVault(r.path);
          if (!sw.ok) {
            setAddVaultError(sw.error);
            reloadVaults();
          }
        }
      } finally {
        setAddVaultBusy(false);
      }
    },
    [reloadVaults]
  );

  const runSetFolderAsVault = useCallback(async () => {
    setAddVaultBusy(true);
    setAddVaultError(null);
    try {
      const r = await window.api.mapos.setFolderAsVault();
      if ("canceled" in r && r.canceled) return;
      if ("ok" in r && r.ok === false) {
        setAddVaultError(r.error);
        return;
      }
      if ("ok" in r && r.ok) {
        // On success the switch reloads the renderer into the new vault, so the
        // dialog never needs closing; on failure the vault is still registered.
        const sw = await window.api.mapos.switchVault(r.path);
        if (!sw.ok) {
          setAddVaultError(sw.error);
          reloadVaults();
        }
      }
    } finally {
      setAddVaultBusy(false);
    }
  }, [reloadVaults]);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Dialog
          open={addVaultOpen}
          onOpenChange={(open) => {
            setAddVaultOpen(open);
            if (!open) {
              setAddVaultError(null);
              setAddVaultStep("choose");
              setVaultNameDraft(DEFAULT_VAULT_NAME);
            }
          }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                />
              }
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <activeVault.logo className="size-4" />
              </div>
              <div className="grid flex-1 min-w-0 text-left text-sm leading-tight">
                <span className="truncate font-medium">{activeVault.name}</span>
                <span className="truncate text-xs text-sidebar-foreground/70">
                  {activeVault.subtitle}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-(--anchor-width) min-w-56 rounded-lg"
              align="start"
              side={isMobile ? "bottom" : "right"}
              sideOffset={4}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>Vaults</DropdownMenuLabel>
                {vaultOptions.map((vault) => {
                  const isActive = vault.path === activeVaultPath;
                  return (
                    <DropdownMenuItem
                      key={vault.path}
                      className="gap-2 p-2"
                      onClick={() => {
                        if (isActive) return;
                        void window.api.mapos.switchVault(vault.path);
                      }}
                    >
                      <div className="flex size-6 items-center justify-center rounded-md border border-sidebar-border">
                        <vault.logo className="size-3.5 shrink-0" />
                      </div>
                      <div className="grid min-w-0 flex-1">
                        <span className="truncate font-medium">{vault.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {vault.subtitle}
                        </span>
                      </div>
                      {isActive && <CheckIcon className="ml-auto size-4 shrink-0 opacity-70" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 p-2"
                onClick={() => {
                  setAddVaultOpen(true);
                }}
              >
                <div className="flex size-6 items-center justify-center rounded-md border border-sidebar-border bg-transparent">
                  <PlusIcon className="size-4" />
                </div>
                <div className="font-medium text-muted-foreground">Add vault</div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DialogContent
            // `fixed` re-asserts the dialog's centering — the popover variant's `relative`
            // (for its before: blur layer) would otherwise clobber DialogContent's position.
            className={cn(surfaceVariants({ variant: "popover" }), "fixed sm:max-w-md")}
            showCloseButton={!addVaultBusy}
          >
            {addVaultStep === "choose" ? (
              <>
                <DialogHeader>
                  <DialogTitle>Add vault</DialogTitle>
                  <DialogDescription>
                    Create a new vault or register an existing folder on disk.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal"
                    disabled={addVaultBusy}
                    onClick={() => {
                      setAddVaultError(null);
                      setVaultNameDraft(DEFAULT_VAULT_NAME);
                      setAddVaultStep("name");
                    }}
                  >
                    <FolderPlusIcon className="size-5 shrink-0 opacity-80" />
                    <div className="grid min-w-0 gap-0.5">
                      <span className="font-medium">Create new vault</span>
                      <span className="text-muted-foreground text-xs font-normal">
                        Pick a name and a parent location. MapOS creates the folder for you.
                      </span>
                    </div>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto justify-start gap-3 px-3 py-3 text-left whitespace-normal"
                    disabled={addVaultBusy}
                    onClick={() => void runSetFolderAsVault()}
                  >
                    <FolderInputIcon className="size-5 shrink-0 opacity-80" />
                    <div className="grid min-w-0 gap-0.5">
                      <span className="font-medium">Set folder as vault</span>
                      <span className="text-muted-foreground text-xs font-normal">
                        Choose an existing folder on disk to use as a vault.
                      </span>
                    </div>
                  </Button>
                </div>
                {addVaultError ? (
                  <p className="text-destructive text-sm" role="alert">
                    {addVaultError}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Name your vault</DialogTitle>
                  <DialogDescription>
                    Choose a name for the new vault folder. You can rename it later from Settings.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                  <InputGroup>
                    <InputGroupInput
                      autoFocus
                      value={vaultNameDraft}
                      disabled={addVaultBusy}
                      aria-invalid={!!addVaultError}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => {
                        setVaultNameDraft(e.target.value);
                        if (addVaultError) setAddVaultError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void runCreateNewVault(vaultNameDraft);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setAddVaultError(null);
                          setAddVaultStep("choose");
                        }
                      }}
                    />
                  </InputGroup>
                  {addVaultError ? (
                    <p className="text-destructive text-sm" role="alert">
                      {addVaultError}
                    </p>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={addVaultBusy}
                      onClick={() => {
                        setAddVaultError(null);
                        setAddVaultStep("choose");
                      }}
                    >
                      <ArrowLeftIcon className="size-4" />
                      Back
                    </Button>
                    <Button
                      type="button"
                      disabled={addVaultBusy || !validateVaultName(vaultNameDraft).ok}
                      onClick={() => void runCreateNewVault(vaultNameDraft)}
                    >
                      Choose location…
                    </Button>
                  </div>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
