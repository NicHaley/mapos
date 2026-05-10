import { cn } from "@mapos/ui/lib/utils";

type PulseLoaderProps = React.ComponentProps<"output"> & {
  /** Tailwind text-* class controlling the dot color via `currentColor`. Defaults to `text-current`. */
  color?: string;
};

function PulseLoader({
  className,
  color = "text-current",
  "aria-label": ariaLabel = "Loading",
  ...props
}: PulseLoaderProps) {
  return (
    <output
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex size-3.5 shrink-0 items-center justify-center",
        color,
        className
      )}
      {...props}
    >
      <span className="absolute inline-flex size-2 animate-ping rounded-full bg-current opacity-75" />
      <span className="relative inline-flex size-1.5 rounded-full bg-current" />
    </output>
  );
}

export { PulseLoader };
