import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type * as React from "react";

import { cn } from "@mapos/ui/lib/utils";

function Combobox<Value, Multiple extends boolean | undefined = false>(
  props: ComboboxPrimitive.Root.Props<Value, Multiple>
): React.JSX.Element {
  return <ComboboxPrimitive.Root {...props} />;
}

function ComboboxInput({
  className,
  ...props
}: ComboboxPrimitive.Input.Props): React.JSX.Element {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-white px-2.5 py-1 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        className
      )}
      {...props}
    />
  );
}

function ComboboxContent({
  className,
  sideOffset = 4,
  align = "start",
  side = "bottom",
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "align" | "side" | "sideOffset">): React.JSX.Element {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50 outline-none"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "relative z-50 max-h-[min(24rem,var(--available-height))] w-(--anchor-width) origin-(--transform-origin) overflow-y-auto overflow-x-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({
  className,
  ...props
}: ComboboxPrimitive.List.Props): React.JSX.Element {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

function ComboboxItem({
  className,
  ...props
}: ComboboxPrimitive.Item.Props): React.JSX.Element {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden transition-colors data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-hover data-highlighted:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  );
}

function ComboboxEmpty({
  className,
  ...props
}: ComboboxPrimitive.Empty.Props): React.JSX.Element {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("py-6 text-center text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList
};
