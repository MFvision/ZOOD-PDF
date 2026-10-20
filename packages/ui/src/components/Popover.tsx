import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  /** The control that opened it: the popover hangs from it and grows out of it. */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Accessible name of the popover. */
  label: string;
  className?: string;
  children: ReactNode;
}

const GAP = 8;
const MARGIN = 8;

interface Placement {
  top: number;
  left: number;
  origin: string;
  /** The height there is room for on the side it opens to. */
  room: number;
}

/** Below the anchor, centred on it, kept inside the window; above it when there is no room below. */
function place(anchor: DOMRect, box: { width: number; height: number }): Placement {
  const width = box.width;
  const height = box.height;
  let left = anchor.left + anchor.width / 2 - width / 2;
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN));
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - height;
  const fitsBelow = below + height <= window.innerHeight - MARGIN || above < MARGIN;
  const top = fitsBelow ? below : above;
  // The point of the anchor, in the popover's own coordinates: it grows from there.
  const x = Math.round(anchor.left + anchor.width / 2 - left);
  const room = fitsBelow ? window.innerHeight - MARGIN - below : anchor.top - GAP - MARGIN;
  return { top: fitsBelow ? top : Math.max(MARGIN, top), left, origin: `${x}px ${fitsBelow ? '0' : '100%'}`, room };
}

/**
 * A popover anchored to the control that opened it (Apple's popovers): it
 * scales out of its trigger and back into it, closes on Escape or a press
 * outside, and hands focus back to the trigger.
 *
 * It stays mounted a moment after `open` goes false so it can leave the way
 * it came; nothing in it can be pressed while it does.
 */
export function Popover({ anchor, open, onClose, label, className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [placement, setPlacement] = useState<Placement | null>(null);

  if (open && !mounted) setMounted(true);

  // Leaving: keep it for the length of the exit, then unmount.
  useEffect(() => {
    if (open || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), 170);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    // Its layout size, not its box on screen: it opens scaled down, and a
    // box measured mid-animation placed it too far along — on a phone the
    // tool gallery ran off the edge of the screen.
    const measure = () => {
      if (ref.current) setPlacement(place(anchor.getBoundingClientRect(), { width: ref.current.offsetWidth, height: ref.current.offsetHeight }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, anchor, mounted]);

  // Focus goes in on open, and back to the trigger on close. Only once it is
  // placed: until then it is `visibility: hidden`, which takes no focus — the
  // focus stayed on the trigger, and the arrow keys moved along the toolbar.
  const placed = placement !== null;
  useEffect(() => {
    if (!open || !placed) return;
    const first = ref.current?.querySelector<HTMLElement>(
      '[aria-checked="true"], [aria-pressed="true"], button:not(:disabled), input, [tabindex="0"]',
    );
    first?.focus({ preventScroll: true });
    const popover = ref.current;
    return () => {
      if (anchor && popover?.contains(document.activeElement)) anchor.focus({ preventScroll: true });
    };
  }, [open, anchor, placed]);

  // A press anywhere else closes it (the trigger toggles it itself).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, anchor, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor?.focus({ preventScroll: true });
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={className ? `popover ${className}` : 'popover'}
      data-leaving={open ? undefined : ''}
      style={{
        top: placement?.top ?? -9999,
        left: placement?.left ?? -9999,
        ['--popover-origin' as string]: placement?.origin,
        // In a window too short for it, it scrolls rather than run off the edge.
        maxBlockSize: placement ? Math.max(120, placement.room) : undefined,
        visibility: placement ? undefined : 'hidden',
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
