import { cn } from "@mapos/ui/lib/utils";
import { useState } from "react";
import { AppearanceStep } from "./appearance-step";
import { DoneStep } from "./done-step";
import { OfflineStep } from "./offline-step";
import { type VaultDraft, VaultStep } from "./vault-step";
import { WelcomeStep } from "./welcome-step";

type Step = "welcome" | "vault" | "offline" | "appearance" | "done";
// The stepper shows one pill per "working" step — welcome and done are bookends and get none.
type WorkingStep = "vault" | "offline" | "appearance";

const PROGRESS_STEPS: WorkingStep[] = ["vault", "offline", "appearance"];
const PROGRESS_LABELS: Record<WorkingStep, string> = {
  vault: "Vault",
  offline: "Offline",
  appearance: "Theme"
};

// One consistent column width across every step — wide enough for the content-heavy Offline step
// (map + list) without varying the frame as the user advances.
const PANEL_WIDTH_CLASS = "max-w-lg";

export function OnboardingScreen(): React.JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [furthest, setFurthest] = useState<Step>("welcome");
  const [vaultDraft, setVaultDraft] = useState<VaultDraft | null>(null);

  function goTo(next: Step): void {
    setStep(next);
    if (stepIndex(next) > stepIndex(furthest)) setFurthest(next);
  }

  const showStepper = PROGRESS_STEPS.some((s) => s === step);

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Drag area for the hidden-inset traffic lights — keeps the window movable. */}
      <div
        className="h-[34px] shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* shrink-0 so the panel keeps its full content height instead of being shrunk to the
            scroll container — otherwise overflowing content bleeds past the panel's box and the
            bottom py-12 never shows when scrolled to the end. */}
        <div
          className={cn(
            "mx-auto flex min-h-full w-full shrink-0 flex-col px-6 py-12",
            PANEL_WIDTH_CLASS
          )}
        >
          {showStepper && (
            <nav
              className="mb-8 flex items-center justify-center gap-2"
              aria-label="Onboarding progress"
            >
              {PROGRESS_STEPS.map((s) => {
                const reached = stepIndex(s) <= stepIndex(furthest);
                const active = s === step;
                const clickable = reached && !active;
                return (
                  <button
                    key={s}
                    type="button"
                    aria-label={`Go to ${PROGRESS_LABELS[s]} step`}
                    aria-current={active ? "step" : undefined}
                    disabled={!clickable}
                    onClick={() => {
                      if (clickable) setStep(s);
                    }}
                    className={cn(
                      "h-1.5 rounded-full transition-all",
                      active ? "w-7 bg-foreground" : "w-5",
                      !active && reached && "bg-foreground/40",
                      !active && !reached && "bg-foreground/15",
                      clickable ? "cursor-pointer hover:bg-foreground/70" : "cursor-default"
                    )}
                  />
                );
              })}
            </nav>
          )}
          <div className="flex flex-1 flex-col justify-center">
            {step === "welcome" && <WelcomeStep onNext={() => goTo("vault")} />}
            {step === "vault" && (
              <VaultStep
                draft={vaultDraft}
                onDraftChange={setVaultDraft}
                onBack={() => setStep("welcome")}
                onNext={() => goTo("offline")}
              />
            )}
            {step === "offline" && (
              <OfflineStep onBack={() => setStep("vault")} onNext={() => goTo("appearance")} />
            )}
            {step === "appearance" && (
              <AppearanceStep onBack={() => setStep("offline")} onNext={() => goTo("done")} />
            )}
            {step === "done" && (
              <DoneStep
                vaultDraft={vaultDraft}
                onBack={() => setStep("appearance")}
                onComplete={async () => {
                  if (!vaultDraft) {
                    return { ok: false, error: "No vault picked." };
                  }
                  return await window.api.onboarding.complete(
                    vaultDraft.kind === "create"
                      ? {
                          kind: "create",
                          targetPath: vaultDraft.targetPath,
                          name: vaultDraft.name
                        }
                      : { kind: "existing", path: vaultDraft.path }
                  );
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function stepIndex(s: Step): number {
  switch (s) {
    case "welcome":
      return 0;
    case "vault":
      return 1;
    case "offline":
      return 2;
    case "appearance":
      return 3;
    case "done":
      return 4;
  }
}
