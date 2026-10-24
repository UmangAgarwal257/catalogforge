"use client";
export default function ErrorPage({reset}:{reset:()=>void}){return <section className="rounded-xl border p-8" role="alert"><h1 className="text-xl font-semibold">The catalog is temporarily unavailable</h1><p className="mt-3 text-sm">Please try again shortly.</p><button className="mt-5 min-h-11 rounded-lg border px-4" onClick={reset}>Try again</button></section>;}
