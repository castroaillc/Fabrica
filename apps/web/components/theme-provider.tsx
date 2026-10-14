"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { THEME_CLASS, THEME_STORAGE_KEY, type ResolvedTheme, type ThemePreference } from "@/lib/theme";

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") setPreferenceState(stored);
    } catch {
      // Storage unavailable; stay on "system".
    }
  }, []);

  useEffect(() => {
    const apply = () => {
      const next = preference === "system" ? systemTheme() : preference;
      const root = document.documentElement;
      root.classList.remove(THEME_CLASS.light, THEME_CLASS.dark);
      root.classList.add(THEME_CLASS[next]);
      root.dataset.theme = next;
      setResolved(next);
    };
    apply();
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preference]);

  const setPreference = (next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore; the choice still applies for this session.
    }
  };

  return <ThemeContext value={{ preference, resolved, setPreference }}>{children}</ThemeContext>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
