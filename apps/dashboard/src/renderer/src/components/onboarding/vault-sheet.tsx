import { Button } from "@mapos/ui/components/button";
import { InputGroup, InputGroupInput } from "@mapos/ui/components/input-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from "@mapos/ui/components/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@mapos/ui/components/sheet";
import { cn } from "@mapos/ui/lib/utils";
import { FolderInputIcon, FolderPlusIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { DEFAULT_VAULT_NAME, validateVaultName } from "../../lib/vault-name";

export type VaultDraft =
  | { kind: "create"; name: string; targetPath: string; parentPath: string }
  | { kind: "existing"; path: string };

type Mode = "create" | "existing";

/**
 * Drawer for choosing a vault — the one blocking decision on the condensed setup page. Lifts the
 * create/existing picker off the main page (Conductor-style) so the page stays scannable. Sets the
 * draft and closes itself on a successful pick; the native folder dialog is the actual chooser.
 */
export function VaultSheet({
  open,
  onOpenChange,
  draft,
  onDraftChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: VaultDraft | null;
  onDraftChange: (next: VaultDraft) => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(draft?.kind === "existing" ? "existing" : "create");
  const [name, setName] = useState(draft?.kind === "create" ? draft.name : DEFAULT_VAULT_NAME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickCreateLocation(): Promise<void> {
    const local = validateVaultName(name);
    if (!local.ok) {
      setError(local.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.onboarding.pickCreateLocation(name.trim());
      if ("canceled" in r && r.canceled) return;
      if ("ok" in r && r.ok === false) {
        setError(r.error);
        return;
      }
      if ("ok" in r && r.ok) {
        onDraftChange({
          kind: "create",
          name: name.trim(),
          targetPath: r.targetPath,
          parentPath: r.parentPath
        });
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }

  async function pickExistingVault(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.onboarding.pickExistingVault();
      if ("canceled" in r && r.canceled) return;
      if ("ok" in r && r.ok === false) {
        setError(r.error);
        return;
      }
      if ("ok" in r && r.ok) {
        onDraftChange({ kind: "existing", path: r.path });
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  }

  function changeMode(next: Mode): void {
    if (mode === next) return;
    setMode(next);
    setError(null);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Set up your vault</SheetTitle>
          <SheetDescription>
            Select where your files are stored. You can rename it or move it later.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4">
          <ItemGroup className="grid grid-cols-2 gap-3">
            <Item
              render={<button type="button" disabled={busy} />}
              variant="outline"
              onClick={() => changeMode("create")}
              className={cn(
                "flex-col items-start gap-2 cursor-pointer disabled:cursor-default disabled:opacity-50",
                mode === "create" ? "border-foreground/40 bg-accent" : "hover:bg-hover"
              )}
            >
              <FolderPlusIcon className="size-5 text-muted-foreground" />
              <ItemContent className="flex-none">
                <ItemTitle>Create new</ItemTitle>
                <ItemDescription>MapOS makes the folder for you.</ItemDescription>
              </ItemContent>
            </Item>
            <Item
              render={<button type="button" disabled={busy} />}
              variant="outline"
              onClick={() => changeMode("existing")}
              className={cn(
                "flex-col items-start gap-2 cursor-pointer disabled:cursor-default disabled:opacity-50",
                mode === "existing" ? "border-foreground/40 bg-accent" : "hover:bg-hover"
              )}
            >
              <FolderInputIcon className="size-5 text-muted-foreground" />
              <ItemContent className="flex-none">
                <ItemTitle>Use existing</ItemTitle>
                <ItemDescription>Point at a folder you already have.</ItemDescription>
              </ItemContent>
            </Item>
          </ItemGroup>

          {mode === "create" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="vault-name" className="text-xs font-medium text-muted-foreground">
                Vault name
              </label>
              <InputGroup className="bg-background">
                <InputGroupInput
                  id="vault-name"
                  autoFocus
                  value={name}
                  disabled={busy}
                  aria-invalid={!!error}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void pickCreateLocation();
                    }
                  }}
                />
              </InputGroup>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <SheetFooter>
          <Button
            size="lg"
            onClick={() => void (mode === "create" ? pickCreateLocation() : pickExistingVault())}
            disabled={busy || (mode === "create" && !name.trim())}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {mode === "create" ? "Choose location" : "Pick folder"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
