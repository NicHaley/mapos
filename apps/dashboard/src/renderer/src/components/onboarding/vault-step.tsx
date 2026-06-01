import { Alert, AlertAction, AlertDescription, AlertTitle } from "@mapos/ui/components/alert";
import { Button } from "@mapos/ui/components/button";
import { InputGroup, InputGroupInput } from "@mapos/ui/components/input-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle
} from "@mapos/ui/components/item";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FolderIcon,
  FolderInputIcon,
  FolderPlusIcon,
  Loader2Icon
} from "lucide-react";
import { useState } from "react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { DEFAULT_VAULT_NAME, validateVaultName } from "../../lib/vault-name";
import { CmdEnterHint } from "./cmd-enter-hint";

export type VaultDraft =
  | { kind: "create"; name: string; targetPath: string; parentPath: string }
  | { kind: "existing"; path: string };

type Mode = "create" | "existing";

export function VaultStep({
  draft,
  onDraftChange,
  onBack,
  onNext
}: {
  draft: VaultDraft | null;
  onDraftChange: (next: VaultDraft | null) => void;
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(draft?.kind === "existing" ? "existing" : "create");
  const [name, setName] = useState(
    draft?.kind === "create" ? draft.name : DEFAULT_VAULT_NAME
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchingDraft =
    draft &&
    ((draft.kind === "create" && mode === "create" && draft.name === name.trim()) ||
      (draft.kind === "existing" && mode === "existing"))
      ? draft
      : null;

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
      onDraftChange({
        kind: "create",
        name: name.trim(),
        targetPath: r.targetPath,
        parentPath: r.parentPath
      });
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
      onDraftChange({ kind: "existing", path: r.path });
    } finally {
      setBusy(false);
    }
  }

  function changeMode(next: Mode): void {
    if (mode === next) return;
    setMode(next);
    setError(null);
  }

  // ⌘↵ drives whatever the primary button currently does: advance when a vault is picked,
  // otherwise open the relevant folder picker.
  const primaryEnabled = matchingDraft
    ? true
    : !busy && !(mode === "create" && !name.trim());
  function primaryAction(): void {
    if (matchingDraft) onNext();
    else if (mode === "create") void pickCreateLocation();
    else void pickExistingVault();
  }
  useCmdEnter(primaryAction, primaryEnabled);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Set up your vault</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        All your places, files, and notes live in one folder. You can rename it or move
        it later.
      </p>

      <ItemGroup className="mt-6 grid grid-cols-2 gap-2">
        <Item
          render={<button type="button" />}
          variant="outline"
          selected={mode === "create"}
          disabled={busy}
          onClick={() => changeMode("create")}
          className="cursor-pointer not-data-[selected]:hover:bg-accent/50 disabled:cursor-default disabled:opacity-50"
        >
          <ItemMedia variant="icon">
            <FolderPlusIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Create new</ItemTitle>
            <ItemDescription>MapOS makes the folder for you.</ItemDescription>
          </ItemContent>
        </Item>
        <Item
          render={<button type="button" />}
          variant="outline"
          selected={mode === "existing"}
          disabled={busy}
          onClick={() => changeMode("existing")}
          className="cursor-pointer not-data-[selected]:hover:bg-accent/50 disabled:cursor-default disabled:opacity-50"
        >
          <ItemMedia variant="icon">
            <FolderInputIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Use existing</ItemTitle>
            <ItemDescription>Point at a folder you already have.</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>

      {mode === "create" && (
        <div className="mt-6 flex flex-col gap-2">
          <label
            htmlFor="vault-name"
            className="text-xs font-medium text-muted-foreground"
          >
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

      {mode === "existing" && (
        <p className="mt-6 text-sm text-muted-foreground">
          Pick a folder you already have. MapOS will index its contents but won't move or
          rename anything.
        </p>
      )}

      {matchingDraft && (
        <Alert className="mt-4 has-[>svg]:grid-cols-[auto_minmax(0,1fr)]">
          <FolderIcon />
          <AlertTitle>
            {matchingDraft.kind === "create" ? "New vault" : "Existing vault"}
          </AlertTitle>
          <AlertDescription
            className="truncate font-mono"
            title={
              matchingDraft.kind === "create"
                ? matchingDraft.targetPath
                : matchingDraft.path
            }
          >
            {matchingDraft.kind === "create"
              ? matchingDraft.targetPath
              : matchingDraft.path}
          </AlertDescription>
          <AlertAction className="top-1/2 -translate-y-1/2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                onDraftChange(null);
                if (mode === "create") void pickCreateLocation();
                else void pickExistingVault();
              }}
            >
              Change
            </Button>
          </AlertAction>
        </Alert>
      )}

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-8 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        {matchingDraft ? (
          <Button onClick={onNext}>
            Continue
            <ArrowRightIcon className="size-4" />
            <CmdEnterHint tone="primary" />
          </Button>
        ) : (
          <Button
            onClick={() => void (mode === "create" ? pickCreateLocation() : pickExistingVault())}
            disabled={busy || (mode === "create" && !name.trim())}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {mode === "create" ? "Choose location" : "Pick folder"}
            <CmdEnterHint tone="primary" />
          </Button>
        )}
      </div>
    </div>
  );
}
