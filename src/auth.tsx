import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { refreshIndex } from "./data";

export interface SignupResult { needsVerification?: boolean; delivered?: boolean; devUrl?: string; email?: string }

export type Role = "user" | "moderator" | "admin";

interface AuthState {
  user: string | null; // email — the identity used for ownership checks
  name: string | null;
  isAdmin: boolean;
  role: Role;
  isModerator: boolean; // moderator OR admin
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name: string, institution?: string) => Promise<SignupResult>;
  verify: (token: string) => Promise<void>;
  resendVerification: (email: string) => Promise<{ devUrl?: string }>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

type AuthResp = { email?: string | null; name?: string | null; isAdmin?: boolean; role?: Role; error?: string; needsVerification?: boolean; devUrl?: string };
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
  const [role, setRole] = useState<Role>("user");
  const [loading, setLoading] = useState(true);

  const apply = (d: AuthResp) => {
    setUser(d.email ?? null);
    setName(d.name ?? null);
    setRole(d.role ?? (d.isAdmin ? "admin" : "user"));
    refreshIndex(); // visible list + ownership depend on the session
  };

  useEffect(() => {
    fetch("/api/auth")
      .then((r) => r.json())
      .then((d) => { setUser(d.email ?? null); setName(d.name ?? null); setRole(d.role ?? (d.isAdmin ? "admin" : "user")); })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const value: AuthState = {
    user,
    name,
    isAdmin: role === "admin",
    role,
    isModerator: role !== "user",
    loading,
    login: async (e, p) => { const { ok, data } = await call({ action: "login", email: e, password: p }); if (!ok) fail(data); apply(data); },
    signup: async (e, p, n, inst) => { const { ok, data } = await call({ action: "signup", email: e, password: p, name: n, institution: inst }); if (!ok) fail(data); return data as SignupResult; },
    verify: async (token) => { const { ok, data } = await call({ action: "verify", token }); if (!ok) fail(data); apply(data); },
    resendVerification: async (e) => { const { ok, data } = await call({ action: "resend-verification", email: e }); if (!ok) fail(data); return { devUrl: data.devUrl }; },
    logout: async () => { await call({ action: "logout" }); apply({ email: null, name: null, isAdmin: false }); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
