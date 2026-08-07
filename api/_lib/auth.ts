// Minimal auth: scrypt password hashing, HMAC-signed session tokens stored in an
// HttpOnly cookie, and a users.json user store in the private Blob store.
import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import { readBlobJson } from "./blob.js";

const SECRET = process.env.SESSION_SECRET || "dev-insecure-secret";
const COOKIE = "bp_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Platform admins, configured via the ADMIN_EMAILS env var (comma-separated).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
export const isAdminEmail = (email: string | null | undefined): boolean =>
  !!email && ADMIN_EMAILS.includes(email.toLowerCase());

// Platform roles. Regular users have no `role`. Moderators can delete/hide
// tournaments, delete accounts, and act on the first-post review queue; admins
// can additionally manage roles and the content blocklist. Accounts listed in
// ADMIN_EMAILS are always admins regardless of their stored role.
export type Role = "user" | "moderator" | "admin";

export interface User {
  email: string;
  name: string;
  institution?: string;
  pwHash: string;
  createdAt: string;
  verified?: boolean; // undefined => grandfathered (treated as verified)
  role?: Exclude<Role, "user">; // absent => regular user
}
export type UserStore = Record<string, User>;

// Effective role given an already-loaded user store (no I/O).
export function roleOf(email: string | null | undefined, users: UserStore): Role {
  if (!email) return "user";
  if (isAdminEmail(email)) return "admin";
  const r = users[normEmail(email)]?.role;
  return r === "admin" || r === "moderator" ? r : "user";
}
// Effective role, loading the user store as needed.
export async function getRole(email: string | null | undefined): Promise<Role> {
  if (!email) return "user";
  if (isAdminEmail(email)) return "admin";
  return roleOf(email, await loadUsers());
}
// Moderators and admins may moderate; admins additionally manage roles/blocklist.
export const canModerate = async (email: string | null | undefined) => (await getRole(email)) !== "user";
export const isAdminRole = async (email: string | null | undefined) => (await getRole(email)) === "admin";

// All addresses that should be notified of moderation events: env admins plus
// any account whose stored role is moderator/admin. Deduplicated, lowercased.
export async function moderatorEmails(): Promise<string[]> {
  const users = await loadUsers();
  const set = new Set<string>(ADMIN_EMAILS);
  for (const u of Object.values(users))
    if (u.role === "moderator" || u.role === "admin") set.add(normEmail(u.email));
  return [...set];
}

// A user is allowed in unless explicitly unverified (existing accounts have no
// `verified` field and stay valid).
export const isVerified = (u: User | undefined) => !!u && u.verified !== false;

const b64 = (b: Buffer | string) =>
  Buffer.from(b).toString("base64url");

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  const a = Buffer.from(hashHex, "hex");
  return a.length === hash.length && crypto.timingSafeEqual(a, hash);
}

export function signToken(email: string): string {
  const payload = b64(JSON.stringify({ email, exp: Date.now() + MAX_AGE * 1000 }));
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
export function verifyToken(token: string | undefined): string | null {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return null;
  try {
    const { email, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!email || typeof exp !== "number" || exp < Date.now()) return null;
    return email as string;
  } catch {
    return null;
  }
}

// A post-action destination that's safe to redirect to: a path on this site
// only. Anything absolute, protocol-relative ("//evil.com") or backslash-tricked
// is rejected, so a `next` carried through an email can't become an open
// redirect.
export function safeNext(v: unknown): string | undefined {
  const s = String(v ?? "");
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || s.length > 300) return undefined;
  return s;
}

// Short-lived HMAC token for a one-off purpose (e.g. email verification),
// independent of the login session. `next` rides along inside the SIGNED
// payload so a verification link can return the user to whatever they were
// doing when they signed up (typically redeeming an invite link) — and so it
// can't be swapped for another destination in transit.
export function signPurpose(email: string, purpose: string, ttlSec: number, next?: string): string {
  const body: Record<string, unknown> = { email, p: purpose, exp: Date.now() + ttlSec * 1000 };
  const n = safeNext(next);
  if (n) body.n = n;
  const payload = b64(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function openPurpose(token: string | undefined, purpose: string): { email: string; next?: string } | null {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { email, p, exp, n } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!email || p !== purpose || typeof exp !== "number" || exp < Date.now()) return null;
    return { email: email as string, next: safeNext(n) };
  } catch {
    return null;
  }
}
export function readPurpose(token: string | undefined, purpose: string): string | null {
  return openPurpose(token, purpose)?.email ?? null;
}
export function readPurposeNext(token: string | undefined, purpose: string): string | undefined {
  return openPurpose(token, purpose)?.next;
}

export function setSessionCookie(res: VercelResponse, token: string) {
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${MAX_AGE}`);
}
export function clearSessionCookie(res: VercelResponse) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0`);
}
export function currentUser(req: VercelRequest): string | null {
  const raw = (req.cookies && req.cookies[COOKIE]) || parseCookie(req.headers.cookie, COOKIE);
  return verifyToken(raw);
}
function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function loadUsers(): Promise<UserStore> {
  return (await readBlobJson<UserStore>("users.json", false)) || {};
}
export async function saveUsers(users: UserStore) {
  await put("users.json", JSON.stringify(users), {
    access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true,
  });
}
export const normEmail = (e: string) => (e || "").trim().toLowerCase();
