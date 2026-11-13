"use client";

import { useMemo } from "react";

// Minimal message merge for beUI components. English-only today: instance
// `labels` override the component defaults. Kept hook-shaped so a real
// LocaleProvider can slot in later without touching call sites.
export function useMessages<T extends Record<string, string>>(
  _namespace: string,
  defaults: T,
  overrides?: Partial<T>,
): (key: keyof T & string) => string {
  const merged = useMemo(() => ({ ...defaults, ...overrides }), [defaults, overrides]);
  return (key) => merged[key] ?? defaults[key] ?? key;
}
