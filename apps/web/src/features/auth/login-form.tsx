"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { control, panel } from "../review/common";
import { createSupabaseBrowserClient } from "../../lib/supabase/browser";

function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

export function LoginForm() {
  const router = useRouter(), params = useSearchParams();
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: result } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (result) throw result;
      router.replace(safeNext(params.get("next")));
      router.refresh();
    } catch {
      setError("Sign-in failed. Check your credentials or contact your store administrator.");
    } finally { setBusy(false); }
  }
  return <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-12"><section className={`${panel} w-full space-y-6`}><header><p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">CatalogForge</p><h1 className="mt-2 text-2xl font-semibold">Merchant sign in</h1><p className="mt-2 text-sm text-muted-foreground">Sign in with the account assigned to your store.</p></header><form className="space-y-4" onSubmit={submit}><label className="block text-sm">Email<input className={`${control} mt-1`} autoComplete="username" type="email" required value={email} onChange={event=>setEmail(event.target.value)}/></label><label className="block text-sm">Password<input className={`${control} mt-1`} autoComplete="current-password" type="password" required value={password} onChange={event=>setPassword(event.target.value)}/></label>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}<button className="min-h-11 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60" disabled={busy}>{busy?"Signing in…":"Sign in"}</button></form><p className="text-xs text-muted-foreground">Accounts are provisioned by the store administrator. Public storefront pages do not require sign-in.</p></section></main>;
}
