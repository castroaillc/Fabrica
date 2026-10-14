import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@ibm/plex-sans/css/ibm-plex-sans-default.min.css";
import "@ibm/plex-mono/css/ibm-plex-mono-default.min.css";
import "./globals.scss";
import { ThemeProvider } from "@/components/theme-provider";
import { THEME_CLASS, themeInitScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Factory",
  description: "Factory web app",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The init script swaps the theme class before hydration, so the attribute mismatch is expected.
    <html lang="en" className={THEME_CLASS.light} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
