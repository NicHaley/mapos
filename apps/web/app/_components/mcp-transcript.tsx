// The faux Claude Code window both demos drive. Shared because the frame, the
// chrome and the line styling are identical between them; only the placement
// and the script differ.

export type TermLine = {
  kind: "tool" | "result" | "done";
  text: string;
};

// Breakpoint at which the window stops sitting in page flow and floats over
// the app capture. Written out as whole class names so Tailwind sees them.
const FLOAT = {
  sm: { ghost: "sm:hidden", live: "sm:static" },
  lg: { ghost: "lg:hidden", live: "lg:static" }
} as const;

type BodyProps = {
  prompt: string;
  typed: number;
  lines: TermLine[];
  shown: number;
  className: string;
};

function Body({ prompt, typed, lines, shown, className }: BodyProps) {
  return (
    <div
      className={`flex flex-col gap-1 px-3.5 py-3 font-[family-name:var(--font-server-mono)] text-[11.5px] leading-relaxed ${className}`}
    >
      <div className="text-neutral-50">
        <span className="text-neutral-500">&gt; </span>
        {prompt.slice(0, typed)}
        {typed < prompt.length ? <span className="animate-pulse text-neutral-400">▍</span> : null}
      </div>
      {lines.slice(0, shown).map((line) => {
        if (line.kind === "tool") {
          return (
            <div className="text-neutral-300" key={line.text}>
              <span className="text-[#7A97FF]">● </span>
              {line.text}
            </div>
          );
        }
        if (line.kind === "result") {
          return (
            <div className="pl-4 text-neutral-500" key={line.text}>
              ⎿ {line.text}
            </div>
          );
        }
        return (
          <div className="text-neutral-50" key={line.text}>
            ✓ {line.text}
          </div>
        );
      })}
    </div>
  );
}

type McpTranscriptProps = {
  prompt: string;
  /** Characters of `prompt` typed so far. */
  typed: number;
  lines: TermLine[];
  /** How many of `lines` have arrived. */
  shown: number;
  /** Width at which the window floats over the capture instead of stacking. */
  floatAt: keyof typeof FLOAT;
  /** Placement for the frame, including the float itself. */
  className: string;
};

export function McpTranscript({
  prompt,
  typed,
  lines,
  shown,
  floatAt,
  className
}: McpTranscriptProps) {
  const float = FLOAT[floatAt];

  return (
    <div
      className={`overflow-hidden rounded-xs border border-neutral-800 bg-neutral-950/90 shadow-black/40 shadow-xl backdrop-blur ${className}`}
    >
      <div className="flex items-center gap-1.5 border-b border-neutral-800/80 px-3 py-2">
        <span className="size-2 rounded-full bg-neutral-700" />
        <span className="size-2 rounded-full bg-neutral-700" />
        <span className="size-2 rounded-full bg-neutral-700" />
        <span className="ml-1.5 font-[family-name:var(--font-server-mono)] text-[10px] text-neutral-500 uppercase tracking-[0.04em]">
          claude code · mapos
        </span>
      </div>
      {/* Stacked in page flow at narrow widths, where a transcript that grew
          line by line pushed everything below it down. The finished script
          reserves the final height and the live one overlays it; once the
          window floats, the ghost drops out and it grows as before. */}
      <div className="relative">
        <Body
          className={`invisible ${float.ghost}`}
          lines={lines}
          prompt={prompt}
          shown={lines.length}
          typed={prompt.length}
        />
        <Body
          className={`absolute inset-0 ${float.live}`}
          lines={lines}
          prompt={prompt}
          shown={shown}
          typed={typed}
        />
      </div>
    </div>
  );
}
