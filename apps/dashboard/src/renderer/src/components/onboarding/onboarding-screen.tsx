import { cn } from "@mapos/ui/lib/utils";
import { useState } from "react";
import { AiStep } from "./ai-step";
import { AppearanceStep } from "./appearance-step";
import { DoneStep } from "./done-step";
import { OfflineStep } from "./offline-step";
import { type VaultDraft, VaultStep } from "./vault-step";
import { WelcomeStep } from "./welcome-step";

type Step = "welcome" | "vault" | "ai" | "appearance" | "offline" | "done";

const PROGRESS_STEPS: Step[] = ["vault", "ai", "appearance", "offline", "done"];
const PROGRESS_LABELS: Record<(typeof PROGRESS_STEPS)[number], string> = {
  vault: "Vault",
  ai: "AI",
  appearance: "Theme",
  offline: "Offline",
  done: "Finish"
};

// Hero steps stay centered and narrow; the wizard's form steps go wide. Offline is widest of
// all so its globe + list can sit side by side.
function maxWidthClass(step: Step): string {
  if (step === "welcome" || step === "done") return "max-w-md";
  if (step === "offline") return "max-w-4xl";
  return "max-w-2xl";
}

const HERO_STEPS: Step[] = ["welcome", "done"];

export function OnboardingScreen(): React.JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [furthest, setFurthest] = useState<Step>("welcome");
  const [vaultDraft, setVaultDraft] = useState<VaultDraft | null>(null);

  function goTo(next: Step): void {
    setStep(next);
    if (stepIndex(next) > stepIndex(furthest)) setFurthest(next);
  }

  const hero = HERO_STEPS.includes(step);

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Drag area for the hidden-inset traffic lights — keeps the window movable. */}
      <div
        className="h-[34px] shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <div className="flex flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex min-h-full w-full flex-col px-6 pb-12",
            maxWidthClass(step)
          )}
        >
          {step !== "welcome" && (
            <nav
              className="mb-8 flex items-center justify-center gap-1.5"
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
                      "h-1.5 w-6 rounded-full transition-colors",
                      reached ? "bg-foreground/70" : "bg-foreground/15",
                      clickable && "cursor-pointer hover:bg-foreground",
                      !clickable && "cursor-default"
                    )}
                  />
                );
              })}
            </nav>
          )}
          <div className={cn("flex flex-1 flex-col", hero ? "justify-center" : "justify-start")}>
            {step === "welcome" && <WelcomeStep onNext={() => goTo("vault")} />}
            {step === "vault" && (
              <VaultStep
                draft={vaultDraft}
                onDraftChange={setVaultDraft}
                onBack={() => setStep("welcome")}
                onNext={() => goTo("ai")}
              />
            )}
            {step === "ai" && (
              <AiStep onBack={() => setStep("vault")} onNext={() => goTo("appearance")} />
            )}
            {step === "appearance" && (
              <AppearanceStep onBack={() => setStep("ai")} onNext={() => goTo("offline")} />
            )}
            {step === "offline" && (
              <OfflineStep onBack={() => setStep("appearance")} onNext={() => goTo("done")} />
            )}
            {step === "done" && (
              <DoneStep
                vaultDraft={vaultDraft}
                onBack={() => setStep("offline")}
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
    case "ai":
      return 2;
    case "appearance":
      return 3;
    case "offline":
      return 4;
    case "done":
      return 5;
  }
}
