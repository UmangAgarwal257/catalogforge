"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ThemeToggle } from "../review/theme-toggle";
import { LanguageSwitcher } from "./language-switcher";
import { storefrontCopy, storefrontLocale } from "./copy";

export function StorefrontChrome({ children }: { children: React.ReactNode }) {
  const locale = storefrontLocale(useSearchParams().get("lang"));
  const text = storefrontCopy(locale);
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b"><nav aria-label={locale === "de" ? "Shop-Navigation" : locale === "fr" ? "Navigation de la boutique" : "Store navigation"} className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 sm:px-8">
      <Link href={`/shop?lang=${locale}`} className="text-xl font-semibold tracking-tight">CatalogForge<span className="ml-2 text-xs font-normal text-muted-foreground">{text.shop}</span></Link>
      <div className="flex flex-wrap items-center gap-3"><LanguageSwitcher/><ThemeToggle/></div>
    </nav></header>
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">{children}</main>
    <footer className="mx-auto max-w-6xl border-t px-4 py-8 text-sm text-muted-foreground sm:px-8">{text.footer}</footer>
  </div>;
}
