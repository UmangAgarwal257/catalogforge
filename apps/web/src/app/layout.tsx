import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getWebEnv } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "CatalogForge",
  description: "CatalogForge supplier spreadsheet ingestion"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  getWebEnv();
  return <html lang="en"><body><div className="border-b bg-muted px-4 py-2 text-center text-sm"><Link href="/products" className="underline underline-offset-4">Open merchant product review</Link></div>{children}</body></html>;
}
