export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "factory-theme";

// Carbon zone classes: White for light, Gray 100 for dark.
export const THEME_CLASS: Record<ResolvedTheme, string> = {
  light: "cds--white",
  dark: "cds--g100",
};

// Runs in <head> before first paint so the saved theme is applied without a flash.
export const themeInitScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})||"system";var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;e.classList.remove(${JSON.stringify(
  THEME_CLASS.light,
)},${JSON.stringify(THEME_CLASS.dark)});e.classList.add(d?${JSON.stringify(THEME_CLASS.dark)}:${JSON.stringify(
  THEME_CLASS.light,
)});e.dataset.theme=d?"dark":"light";}catch(_){}})();`;
