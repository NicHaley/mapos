"use client";

import { useMeasure } from "@renderer/hooks/use-measure";
import { cn } from "@renderer/lib/utils";
import { useCallback, useEffect } from "react";

interface AutoSizeTextAreaProps {
  value: string;
  className?: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  onTab?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  "aria-label"?: string;
}

export function AutoSizeTextArea({
  value,
  onChange,
  onEnter,
  onTab,
  onBlur,
  className,
  placeholder = "Untitled",
  autoFocus = false,
  disabled = false,
  readOnly = false,
  "aria-label": ariaLabel
}: AutoSizeTextAreaProps) {
  const { ref, bounds } = useMeasure<HTMLTextAreaElement>();

  const updateHeight = useCallback(() => {
    if (ref.current) {
      ref.current.style.height = "0px";
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [ref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    updateHeight();
  }, [updateHeight, bounds, value]);

  return (
    <textarea
      aria-label={ariaLabel}
      className={cn(
        className,
        "w-full resize-none border-0 border-transparent bg-transparent p-0 outline-none focus:border-transparent focus:ring-0"
      )}
      disabled={disabled}
      readOnly={readOnly}
      onBlur={onBlur}
      onChange={(e) => {
        onChange(e.target.value);
        updateHeight();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter?.();
        } else if (e.key === "Tab" && onTab) {
          e.preventDefault();
          onTab();
        }
      }}
      placeholder={placeholder}
      ref={ref}
      spellCheck={false}
      rows={1}
      value={value}
      // biome-ignore lint/a11y/noAutofocus: <explanation>
      autoFocus={autoFocus}
    />
  );
}
