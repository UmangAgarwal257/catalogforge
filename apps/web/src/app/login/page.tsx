import { Suspense } from "react";
import { LoginForm } from "../../features/auth/login-form";

export const dynamic = "force-dynamic";
export default function LoginPage() {
  return <Suspense fallback={<main className="min-h-screen bg-background"/>}><LoginForm/></Suspense>;
}
