import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getWebEnv } from "@/lib/env";
import "./globals.css";

export const metadata: Metadata = {
  title: "CatalogForge",
  description: "CatalogForge supplier spreadsheet ingestion"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  getWebEnv();
  return <html lang="en"><body>{children}</body></html>;
}
