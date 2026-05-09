import { Button } from "@mapos/ui/components/button";
import maposLogo from "../../assets/mapos.svg";

export function WelcomeStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center text-center">
      <img src={maposLogo} alt="" aria-hidden className="h-12 w-auto" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Welcome to MapOS</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        MapOS turns your folders into a map. Files stay on your machine — places, photos,
        and notes are yours, side by side with the world.
      </p>
      <Button size="lg" className="mt-8 w-full" onClick={onNext}>
        Get started
      </Button>
    </div>
  );
}
