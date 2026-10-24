import {Suspense} from "react";
import {StorefrontChrome} from "../../features/storefront/chrome";
export const dynamic="force-dynamic";
export default function ShopLayout({children}:{children:React.ReactNode}) {return <Suspense fallback={<div className="min-h-screen bg-background text-foreground"/>}><StorefrontChrome>{children}</StorefrontChrome></Suspense>;}
