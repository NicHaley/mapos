"use client";

import { useState } from "react";
import { PixelCheck, PixelCopy } from "./pixel-icons";

const INSTALL_COMMAND = "npx skills add NicHaley/mapos-skills";

const SKILLS = ["mapos-trip-planner", "mapos-curate-collection", "mapos-spatial-analysis"];

export function SkillsSection() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/insecure context); the command is selectable.
    }
  };

  return (
    <section className="bg-neutral-950 px-[clamp(20px,4vw,56px)] pt-20">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-12">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <h2 className="m-0 font-[family-name:var(--font-handjet)] text-[28px] font-normal text-neutral-50 sm:text-[clamp(28px,3.4vw,40px)]">
            markdown, skills up
          </h2>
          <p className="m-0 max-w-[560px] text-lg text-neutral-400">
            Trip planning, collections, spatial analysis. Use them as they are, or write your own.
            They're just Markdown.
          </p>
        </div>

        <div className="mx-auto w-full max-w-[560px] overflow-hidden rounded-xs border border-neutral-800 bg-neutral-950/90">
          <div className="flex items-center gap-1.5 border-b border-neutral-800/80 px-3 py-2">
            <span className="size-2 rounded-full bg-neutral-700" />
            <span className="size-2 rounded-full bg-neutral-700" />
            <span className="size-2 rounded-full bg-neutral-700" />
            <span className="ml-1.5 font-[family-name:var(--font-server-mono)] text-[10px] uppercase tracking-[0.04em] text-neutral-500">
              install
            </span>
          </div>
          <div className="flex flex-col gap-1 px-4 py-4 font-[family-name:var(--font-server-mono)] text-[12.5px] leading-relaxed">
            <div className="flex items-center justify-between gap-3">
              <span className="text-neutral-50">
                <span className="text-neutral-500">$ </span>
                {INSTALL_COMMAND}
              </span>
              <button
                aria-label="Copy install command"
                className="cursor-pointer rounded-xs border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
                onClick={copy}
                type="button"
              >
                {copied ? (
                  <PixelCheck aria-hidden="true" size={14} />
                ) : (
                  <PixelCopy aria-hidden="true" size={14} />
                )}
              </button>
            </div>
            {SKILLS.map((skill) => (
              <div className="text-neutral-400" key={skill}>
                <span className="text-neutral-500">✓ </span>
                installed {skill}
              </div>
            ))}
            <div className="text-neutral-500">{SKILLS.length} skills ready in Claude Code</div>
          </div>
        </div>
      </div>
    </section>
  );
}
