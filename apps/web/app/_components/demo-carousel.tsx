"use client";

import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem
} from "@mapos/ui/components/carousel";
import { cn } from "@mapos/ui/lib/utils";
import BackgroundVideo from "next-video/background-video";
import type { Asset } from "next-video/dist/assets.js";
import { useCallback, useEffect, useState } from "react";
import { FaPause, FaPlay } from "react-icons/fa6";

// Demo videos are next-video assets: drop an MP4 into apps/web/videos, run
// `npx next-video sync` to upload it to R2, then import it and set it on the
// slide, e.g.:
//   import agentDemo from "../../videos/agent.mp4";
//   { id: "agent", ..., video: agentDemo }
// (Use the relative form — "/videos/..." resolves against the monorepo root
// under Turbopack.) Slides without a video render a "coming soon" tile.

type DemoSlide = {
  id: string;
  tag: string;
  title: string;
  video?: Asset;
};

const SLIDES: DemoSlide[] = [
  { id: "agent", tag: "AI agent", title: "Chat with your map" },
  { id: "vault", tag: "Vault", title: "Places as Markdown files" },
  { id: "offline", tag: "Offline", title: "Maps and routing, no internet" }
];

const SLIDE_DURATION_MS = 8000;
const TICK_MS = 50;

export function DemoCarousel() {
  const [api, setApi] = useState<CarouselApi | undefined>(undefined);
  const [current, setCurrent] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    if (!api || !isPlaying) return;
    const interval = setInterval(() => {
      setProgress((prev) => prev + (100 * TICK_MS) / SLIDE_DURATION_MS);
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [api, isPlaying]);

  useEffect(() => {
    if (!api || progress < 100) return;
    api.scrollNext();
    setProgress(0);
  }, [api, progress]);

  useEffect(() => {
    if (!api) return;
    const onSelect = () => {
      setCurrent(api.selectedScrollSnap());
      setProgress(0);
    };
    onSelect();
    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
    };
  }, [api]);

  const onPillClick = useCallback(
    (index: number) => {
      api?.scrollTo(index);
      setProgress(0);
    },
    [api]
  );

  return (
    <div className="relative w-full">
      <Carousel className="w-full" opts={{ loop: true, align: "center" }} setApi={setApi}>
        <CarouselContent>
          {SLIDES.map((slide) => {
            return (
              <CarouselItem key={slide.id}>
                <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50">
                  {slide.video ? (
                    <BackgroundVideo className="absolute inset-0 h-full w-full" src={slide.video} />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex flex-col items-center gap-3.5">
                        <div className="flex size-14 items-center justify-center rounded-full border border-neutral-700 bg-neutral-950/60">
                          <svg
                            aria-hidden="true"
                            className="ml-0.5 text-neutral-300"
                            fill="currentColor"
                            height="16"
                            viewBox="0 0 16 16"
                            width="16"
                          >
                            <path d="M4 2.5v11l9-5.5z" />
                          </svg>
                        </div>
                        <span className="font-[family-name:var(--font-jetbrains-mono)] text-xs tracking-[0.01em] text-neutral-500">
                          Demo video coming soon
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/60 to-transparent" />
                  <div className="absolute inset-x-0 top-0 flex flex-col items-start gap-1 p-5 text-left">
                    <span className="inline-flex rounded-md bg-neutral-50 px-2 py-0.5 text-xs font-medium text-neutral-950">
                      {slide.tag}
                    </span>
                    <span className="text-lg font-medium text-neutral-50">{slide.title}</span>
                  </div>
                </div>
              </CarouselItem>
            );
          })}
        </CarouselContent>
      </Carousel>

      <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
        <div className="flex items-center justify-center gap-3 rounded-full border border-neutral-800 bg-neutral-900/80 px-4 py-2 backdrop-blur-md">
          {SLIDES.map((slide, i) => (
            <button
              aria-label={`Go to slide ${i + 1}`}
              className={cn(
                "relative h-2 cursor-pointer rounded-full bg-neutral-600 transition-all",
                current === i ? "w-12" : "w-2"
              )}
              key={slide.id}
              onClick={() => onPillClick(i)}
              type="button"
            >
              {current === i ? (
                <div className="absolute inset-0 overflow-hidden rounded-full">
                  <div
                    className="h-full rounded-full bg-neutral-50"
                    style={{ width: `${progress}%`, transition: "width 50ms linear" }}
                  />
                </div>
              ) : null}
            </button>
          ))}
        </div>
        <button
          aria-label={isPlaying ? "Pause" : "Play"}
          className="cursor-pointer rounded-full border border-neutral-800 bg-neutral-900/80 p-2.5 text-neutral-50 backdrop-blur-md"
          onClick={() => setIsPlaying(!isPlaying)}
          type="button"
        >
          {isPlaying ? <FaPause className="size-3" /> : <FaPlay className="size-3" />}
        </button>
      </div>
    </div>
  );
}
