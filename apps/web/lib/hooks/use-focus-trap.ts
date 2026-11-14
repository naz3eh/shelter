"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

// Moves focus into `ref` while `active`, keeps Tab inside it, fires onEscape,
// and restores focus to the previously focused element on release.
export function useFocusTrap(
  active: boolean,
  ref: RefObject<HTMLElement | null>,
  options?: { onEscape?: () => void },
): void {
  const onEscape = options?.onEscape;

  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const items = focusables(root);
    (items[0] ?? root).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscape?.();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables(root);
      if (list.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !root.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !root.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, ref, onEscape]);
}
