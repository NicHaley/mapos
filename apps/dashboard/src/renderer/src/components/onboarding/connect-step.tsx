import { Button } from "@mapos/ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { McpConnect } from "../settings/mcp-connect";
import { CmdEnterHint } from "./cmd-enter-hint";
import { OnboardingStep } from "./onboarding-step";

export function ConnectStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  useCmdEnter(onNext);

  return (
    <OnboardingStep
      footer={
        <div className="flex items-center justify-between">
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
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight">Connect an AI client</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        MapOS can be driven by an MCP client like Claude Code or Cursor. This can be configured
        later in Settings › Connections.
      </p>

      <div className="mt-8 flex w-full min-w-0 flex-col">
        <McpConnect />
      </div>
    </OnboardingStep>
  );
}
