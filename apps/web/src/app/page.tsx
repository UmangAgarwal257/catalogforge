import Link from "next/link";
import { ImportDashboard } from "../features/imports/dashboard";

export default function Home() { return <><nav className="flex flex-wrap justify-center gap-6 border-b bg-muted px-4 py-3 text-sm"><Link href="/products" className="underline underline-offset-4">Open merchant product review</Link><Link href="/shop" className="underline underline-offset-4">View storefront</Link></nav><ImportDashboard /></>; }
