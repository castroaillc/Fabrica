"use client";

import { HeaderGlobalAction } from "@carbon/react";
import { Asleep, Screen, Sun } from "@carbon/react/icons";
import type { ThemePreference } from "@/lib/theme";
import { useTheme } from "./theme-provider";

const ORDER: ThemePreference[] = ["light", "dark", "system"];
const LABEL: Record<ThemePreference, string> = { light: "Light", dark: "Dark", system: "System" };
const ICON = { light: Sun, dark: Asleep, system: Screen } as const;

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]!;
  const Icon = ICON[preference];

  return (
    <HeaderGlobalAction
      aria-label={`Theme: ${LABEL[preference]}. Switch to ${LABEL[next]}`}
      tooltipAlignment="end"
      onClick={() => setPreference(next)}
    >
      <Icon size={20} />
    </HeaderGlobalAction>
  );
}
