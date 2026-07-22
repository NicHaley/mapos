import { cn } from "@mapos/ui/lib/utils";
import { useState } from "react";
import { SetupStep } from "./setup-step";
import type { VaultDraft } from "./vault-sheet";
import { WelcomeStep } from "./welcome-step";

type Page = "welcome" | "setup";
const PAGES: Page[] = ["welcome", "setup"];

export function OnboardingScreen(): React.JSX.Element {
  const [page, setPage] = useState<Page>("welcome");
  const [vaultDraft, setVaultDraft] = useState<VaultDraft | null>(null);

  // The setup page is a wider column of label-left / control-right rows; the welcome splash
  // stays a narrow centered column.
  const panelWidth = page === "setup" ? "max-w-2xl" : "max-w-md";

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Drag area for the hidden-inset traffic lights — keeps the window movable. */}
      <div
        className="h-[34px] shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <div className={cn("mx-auto flex min-h-0 w-full flex-1 flex-col px-6 pb-6", panelWidth)}>
        <div className="flex min-h-0 flex-1 flex-col pt-6">
          {page === "welcome" && <WelcomeStep onNext={() => setPage("setup")} />}
          {page === "setup" && (
            <SetupStep
              draft={vaultDraft}
              onDraftChange={setVaultDraft}
              onBack={() => setPage("welcome")}
              onComplete={async () => {
                if (!vaultDraft) {
                  return { ok: false, error: "No vault picked." };
                }
                return await window.api.onboarding.complete(
                  vaultDraft.kind === "create"
                    ? { kind: "create", targetPath: vaultDraft.targetPath, name: vaultDraft.name }
                    : { kind: "existing", path: vaultDraft.path }
                );
              }}
            />
          )}
        </div>
        <nav
          className="flex shrink-0 items-center justify-center gap-2 py-4"
          aria-label="Onboarding progress"
        >
          {PAGES.map((p) => (
            <span
              key={p}
              aria-current={p === page ? "step" : undefined}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                p === page ? "bg-foreground" : "bg-foreground/25"
              )}
            />
          ))}
        </nav>
      </div>
    </div>
  );
}
