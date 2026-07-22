import { Button } from "@mapos/ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import { setAccent, useAccent } from "../../lib/accent";
import { setTheme, useTheme } from "../../lib/theme";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { AccentPicker } from "../accent-picker";
import { ThemePicker } from "../theme-picker";
import { CmdEnterHint } from "./cmd-enter-hint";
import { OnboardingStep } from "./onboarding-step";

export function AppearanceStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const accent = useAccent();

  useCmdEnter(onNext);

  return (
    <OnboardingStep
      footer={
        <div className="flex items-center justify-between">
          <Button size="lg" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
          <Button size="lg" onClick={onNext}>
            Continue
            <CmdEnterHint tone="primary" />
          </Button>
        </div>
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight">Choose your appearance</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Pick a theme and accent for the map and panels. You can change this any time in Settings.
      </p>

      <div className="mt-8 flex flex-col gap-1.5">
        <span className="text-sm font-medium">Theme</span>
        <ThemePicker value={theme} onChange={setTheme} />
      </div>

      <div className="mt-8 flex flex-col gap-3">
        <span className="text-sm font-medium">Accent color</span>
        <AccentPicker value={accent} onChange={setAccent} />
      </div>
    </OnboardingStep>
  );
}
