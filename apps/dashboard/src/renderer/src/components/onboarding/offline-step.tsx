import { Button } from "@mapos/ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { RegionPicker } from "../settings/region-picker";
import { CmdEnterHint } from "./cmd-enter-hint";

export function OfflineStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  useCmdEnter(onNext);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Keep maps for offline</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Download regions to browse and search them with no connection. Grab one now or skip — you
        can add or remove regions any time in Settings.
      </p>

      {/* Bounded height so the map + search stay put and only the list scrolls. */}
      <div className="mt-6 flex h-[420px] flex-col">
        <RegionPicker />
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button size="lg" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <div className="flex items-center gap-3">
          <Button size="lg" variant="ghost" onClick={onNext}>
            Skip for now
          </Button>
          <Button size="lg" onClick={onNext}>
            Continue
            <CmdEnterHint tone="primary" />
          </Button>
        </div>
      </div>
    </div>
  );
}
