"use client";

import { Header, HeaderGlobalBar, HeaderName, SkipToContent } from "@carbon/react";
import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

export function SiteHeader() {
  return (
    <Header aria-label="Factory">
      <SkipToContent />
      <HeaderName as={Link} href="/" prefix="">
        Factory
      </HeaderName>
      <HeaderGlobalBar>
        <ThemeToggle />
      </HeaderGlobalBar>
    </Header>
  );
}
