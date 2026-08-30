import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { refreshIndex } from "./data";

export interface SignupResult { needsVerification?: boolean; delivered?: boolean; devUrl?: string; email?: string }

export type Role = "user" | "moderator" | "admin";

interface AuthState {
  user: string | null; // email — the identity used for ownership checks
  name: string | null;
  institution: string | null;
  isAdmin: boolean;
  role: Role;
  isModerator: boolean; // moderator OR admin
  loading: boolean;
  login: (email: string, password: string, next?: string) => Promise<void>;
  signup: (email: string, password: string, name: string, institution?: string, next?: string) => Promise<SignupResult>;
  // Resolves to where the verification link said to go (the invite link they
  // clicked before signing up), or null.
  verify: (token: string) => Promise<string | null>;
  resendVerification: (email: string, next?: string) => Promise<{ devUrl?: string }>;
  // Mails a reset link. Resolves the same way whether or not the address has an
  // account, so the form can't be used to enumerate users.
  forgotPassword: (email: string, next?: string) => Promise<{ devUrl?: string }>;
  // Sets the new password and signs in; resolves to where the link said to go.
  resetPassword: (token: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  // Change the name shown on posts and corrections, and the affiliation.
  updateProfile: (name: string, institution: string) => Promise<void>;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

type AuthResp = { email?: string | null; name?: string | null; institution?: string | null; isAdmin?: boolean; role?: Role; error?: string; needsVerification?: boolean; devUrl?: string; next?: string | null };
async function call(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: AuthResp }> {
  const r = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}
function fail(data: AuthResp): never {
  const e = new Error(data.error || "Request failed") as Error & { needsVerification?: boolean; devUrl?: string };
  e.needsVerification = data.needsVerification;
  e.devUrl = data.devUrl;
  throw e;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [institution, setInstitution] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("user");
  const [loading, setLoading] = useState(true);

  const apply = (d: AuthResp) => {
    setUser(d.email ?? null);
    setName(d.name ?? null);
    setInstitution(d.institution ?? null);
    setRole(d.role ?? (d.isAdmin ? "admin" : "user"));
    refreshIndex(); // visible list + ownership depend on the session
  };

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => { setUser(d.email ?? null); setName(d.name ?? null); setInstitution(d.institution ?? null); setRole(d.role ?? (d.isAdmin ? "admin" : "user")); })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const value: AuthState = {
    user,
    name,
    institution,
    isAdmin: role === "admin",
    role,
    isModerator: role !== "user",
    loading,
    login: async (e, p, next) => { const { ok, data } = await call({ action: "login", email: e, password: p, next }); if (!ok) fail(data); apply(data); },
    signup: async (e, p, n, inst, next) => { const { ok, data } = await call({ action: "signup", email: e, password: p, name: n, institution: inst, next }); if (!ok) fail(data); return data as SignupResult; },
    verify: async (token) => { const { ok, data } = await call({ action: "verify", token }); if (!ok) fail(data); apply(data); return data.next ?? null; },
    resendVerification: async (e, next) => { const { ok, data } = await call({ action: "resend-verification", email: e, next }); if (!ok) fail(data); return { devUrl: data.devUrl }; },
    forgotPassword: async (e, next) => { const { ok, data } = await call({ action: "forgot-password", email: e, next }); if (!ok) fail(data); return { devUrl: data.devUrl }; },
    resetPassword: async (token, p) => { const { ok, data } = await call({ action: "reset-password", token, password: p }); if (!ok) fail(data); apply(data); return data.next ?? null; },
    logout: async () => { await call({ action: "logout" }); apply({ email: null, name: null, isAdmin: false }); },
    updateProfile: async (n, inst) => { const { ok, data } = await call({ action: "profile", name: n, institution: inst }); if (!ok) fail(data); setName(data.name ?? null); setInstitution(data.institution ?? null); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
