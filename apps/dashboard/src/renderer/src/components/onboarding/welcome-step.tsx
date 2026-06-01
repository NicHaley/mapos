import { Button } from "@mapos/ui/components/button";
import maposLogo from "../../assets/mapos.svg";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { CmdEnterHint } from "./cmd-enter-hint";

export function WelcomeStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  useCmdEnter(onNext);

  return (
    <div className="flex flex-col items-center text-center">
      <img src={maposLogo} alt="" aria-hidden className="h-12 w-auto" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Welcome to MapOS</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        MapOS is the next-generation offline map editor.
        <br />
        Click through to get started.
      </p>
      <Button size="lg" className="mt-8 w-full" onClick={onNext}>
        Get started
        <CmdEnterHint tone="primary" />
      </Button>
    </div>
  );
}
