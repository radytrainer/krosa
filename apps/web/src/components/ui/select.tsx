'use client';

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cn } from 'cn';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';

/**
 * A styled Base UI select, for options that need more than plain text (icons). Prefer
 * `NativeSelect` (components/app/form) for text-only choices. The trigger is a `combobox` button:
 * give it the Field's `id` so the `<label htmlFor>` names it.
 */
function Select<Value>({ ...props }: SelectPrimitive.Root.Props<Value>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex min-h-8 w-full min-w-0 cursor-default items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2 py-1 text-left text-sm outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive data-popup-open:border-ring dark:bg-input/30',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="shrink-0 text-muted-foreground">
        <ChevronDownIcon className="size-4" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn('min-w-0 flex-1 data-placeholder:text-muted-foreground', className)}
      {...props}
    />
  );
}

/** Popup below the trigger, never wider than the screen, scrolling when long. */
function SelectContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, 'sideOffset'>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        alignItemWithTrigger={false}
        collisionPadding={16}
        className="isolate z-50 outline-none"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'max-h-(--available-height) max-w-(--available-width) min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List className="max-h-(--available-height) overflow-y-auto p-1">
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/**
 * One option: a check mark when selected, then `children`. `label` is the text used for
 * type-to-select (and must be given when children hold more than the name).
 */
function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-8 cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-7 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="absolute left-2 inline-flex">
        <CheckIcon className="size-4" aria-hidden />
      </SelectPrimitive.ItemIndicator>
      {children}
    </SelectPrimitive.Item>
  );
}

const SelectItemText = SelectPrimitive.ItemText;

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectItemText };
