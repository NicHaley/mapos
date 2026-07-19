import { Button } from "@mapos/ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import { setTheme, useTheme } from "../../lib/theme";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { ThemePicker } from "../theme-picker";
import { CmdEnterHint } from "./cmd-enter-hint";

export function AppearanceStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const theme = useTheme();

  useCmdEnter(onNext);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Choose your appearance</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Pick a theme for the map and panels. System follows your operating system — you can change
        this any time in Settings.
      </p>

      <div className="mt-6">
        <ThemePicker value={theme} onChange={setTheme} />
      </div>

      <div className="mt-8 flex items-center justify-between">
        <Button size="lg" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <Button size="lg" onClick={onNext}>
          Continue
          <CmdEnterHint tone="primary" />
        </Button>
      </div>
    </div>
  );
}
