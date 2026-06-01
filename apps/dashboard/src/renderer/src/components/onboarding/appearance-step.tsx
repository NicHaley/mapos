import { Button } from "@mapos/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from "@mapos/ui/components/item";
import { cn } from "@mapos/ui/lib/utils";
import { ArrowLeftIcon, ArrowRightIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";
import { type Theme, applyTheme, readStoredTheme } from "../../lib/theme";
import { useCmdEnter } from "../../lib/use-cmd-enter";
import { CmdEnterHint } from "./cmd-enter-hint";

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <SunIcon className="size-4" /> },
  { value: "system", label: "System", icon: <MonitorIcon className="size-4" /> },
  { value: "dark", label: "Dark", icon: <MoonIcon className="size-4" /> }
];

export function AppearanceStep({
  onBack,
  onNext
}: {
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  function handleTheme(t: Theme): void {
    setTheme(t);
    applyTheme(t);
  }

  useCmdEnter(onNext);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-semibold tracking-tight">Make it yours</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose how MapOS looks. System follows your operating system — you can change this any
        time in Settings.
      </p>

      <ItemGroup className="mt-6">
        <Item variant="outline">
          <ItemContent>
            <ItemTitle>Theme</ItemTitle>
            <ItemDescription>Light, dark, or match your system.</ItemDescription>
          </ItemContent>
          <ItemActions>
            <div className="flex gap-1.5">
              {THEME_OPTIONS.map(({ value, label, icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleTheme(value)}
                  className={cn(
                    "flex w-20 cursor-pointer flex-col items-center gap-1.5 rounded-lg border px-3 py-2.5 text-xs transition-colors",
                    theme === value
                      ? "border-foreground/40 bg-accent font-medium text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
          </ItemActions>
        </Item>
      </ItemGroup>

      <div className="mt-8 flex items-center justify-between">
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
