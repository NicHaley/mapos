import { cn } from "@mapos/ui/lib/utils";
import { useState } from "react";
import { AiStep } from "./ai-step";
import { DoneStep } from "./done-step";
import { type VaultDraft, VaultStep } from "./vault-step";
import { WelcomeStep } from "./welcome-step";

type Step = "welcome" | "vault" | "ai" | "done";

const PROGRESS_STEPS: Step[] = ["vault", "ai", "done"];
const PROGRESS_LABELS: Record<(typeof PROGRESS_STEPS)[number], string> = {
  vault: "Vault",
  ai: "AI",
  done: "Finish"
};

export function OnboardingScreen(): React.JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [furthest, setFurthest] = useState<Step>("welcome");
  const [vaultDraft, setVaultDraft] = useState<VaultDraft | null>(null);

  function goTo(next: Step): void {
    setStep(next);
    if (stepIndex(next) > stepIndex(furthest)) setFurthest(next);
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Drag area for the hidden-inset traffic lights — keeps the window movable. */}
      <div
        className="h-[34px] shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-12">
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
          <div className="flex flex-1 flex-col justify-center">
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
              <AiStep onBack={() => setStep("vault")} onNext={() => goTo("done")} />
            )}
            {step === "done" && (
              <DoneStep
                vaultDraft={vaultDraft}
                onBack={() => setStep("ai")}
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
    case "done":
      return 3;
  }
}
