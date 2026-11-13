"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/**
 * Shared by the file table and grid: render only what's near the viewport of `scrollRef`,
 * however many objects a folder holds. `anchorRef` is the list's first element, so content
 * above the list inside the same scroller (headers, padding) is accounted for.
 */
export function useVirtualList({
  count,
  scrollRef,
  anchorRef,
  estimateSize,
  getItemKey,
  focusIndex,
  focusSelector,
}: {
  count: number;
  scrollRef: RefObject<HTMLElement | null>;
  anchorRef: RefObject<HTMLElement | null>;
  estimateSize: number;
  getItemKey: (index: number) => string;
  /** The item the keyboard selection is on, kept in view (and focused once it renders). */
  focusIndex: number;
  focusSelector: string | null;
}) {
  // useVirtualizer hands back functions the React Compiler can't memoize safely; opt out
  // here so turning the compiler on later can't freeze scrolling.
  "use no memo";
  // Where the list starts within the scroller's content.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor) return;
    const measure = () =>
      setScrollMargin(anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollRef, anchorRef]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 10,
    scrollMargin,
    getItemKey,
  });

  const items = virtualizer.getVirtualItems();
  const paddingTop = items.length ? items[0].start - scrollMargin : 0;
  const paddingBottom = items.length ? virtualizer.getTotalSize() - (items[items.length - 1].end - scrollMargin) : 0;

  // Arrow keys can select something that isn't rendered yet: scroll to it, then hand it
  // focus — unless focus has gone somewhere else meanwhile (a dialog, the search box).
  useEffect(() => {
    if (focusIndex < 0 || !focusSelector) return;
    if (scrollRef.current?.querySelector(focusSelector)) return;
    virtualizer.scrollToIndex(focusIndex, { align: "auto" });
    const frame = requestAnimationFrame(() => {
      const target = scrollRef.current?.querySelector<HTMLElement>(focusSelector);
      const active = document.activeElement;
      if (target && (!active || active === document.body || active.hasAttribute("data-node-id"))) {
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
    // Only a change of target should scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIndex, focusSelector]);

  return { virtualizer, items, paddingTop, paddingBottom };
}
