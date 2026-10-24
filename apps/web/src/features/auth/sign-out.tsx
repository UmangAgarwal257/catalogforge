"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "../../lib/supabase/browser";

export function SignOut() {
  const router = useRouter();
  const [error, setError] = useState("");
  async function signOut() {
    setError("");
    try {
      const { error: result } = await createSupabaseBrowserClient().auth.signOut();
      if (result) throw result;
      router.replace("/login");
      router.refresh();
    } catch {
      setError("Sign-out failed. Check your connection and retry.");
    }
  }
  return <div className="flex items-center gap-2"><button type="button" onClick={signOut} className="min-h-11 rounded-md border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Sign out</button>{error&&<span role="alert" className="sr-only">{error}</span>}</div>;
}
