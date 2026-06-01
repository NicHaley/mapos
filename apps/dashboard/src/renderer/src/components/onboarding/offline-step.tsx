import { Button } from "@mapos/ui/components/button";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
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
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Download a region</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Regions let you use the map, search, and routing without a connection. Grab one now or
        skip — you can manage regions any time in Settings.
      </p>

      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <RegionPicker layout="split" />
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <Button onClick={onNext}>
          Continue
          <ArrowRightIcon className="size-4" />
          <CmdEnterHint tone="primary" />
        </Button>
      </div>
    </div>
  );
}
