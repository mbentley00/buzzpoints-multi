// POST /api/auth { action: "signup"|"login"|"logout"|"verify"|"resend-verification", ... }
// GET  /api/auth  -> current user
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  loadUsers, saveUsers, hashPassword, verifyPassword, signToken, signPurpose, readPurpose, readPurposeNext,
  safeNext, setSessionCookie, clearSessionCookie, currentUser, normEmail, isAdminEmail, isVerified, roleOf, User,
} from "./_lib/auth.js";
import { sendEmail, appUrl, verifyEmailBody } from "./_lib/email.js";

const VERIFY_TTL = 60 * 60 * 24; // 24h
const verifyUrl = (email: string, next?: string) =>
  `${appUrl()}/verify?token=${encodeURIComponent(signPurpose(email, "verify", VERIFY_TTL, next))}`;

// `next` is where the person was headed before signing up — normally the invite
// link they clicked. Carrying it through verification is what stops a
// link-holder from landing on the tournament list, hitting the private wall, and
// filing an access request for a set they were already invited to.
async function sendVerification(email: string, name: string, next?: string) {
  const url = verifyUrl(email, next);
  const delivered = await sendEmail({ to: email, subject: "Verify your Buzzpoints email", html: verifyEmailBody(name, url) });
  // Surface the link in-app whenever delivery didn't actually happen (no provider
  // configured, or the provider rejected the recipient e.g. an unverified domain).
  return { delivered, devUrl: delivered ? undefined : url };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const email = currentUser(req);
    if (!email) return res.status(200).json({ email: null });
    const users = await loadUsers();
    const u = users[email];
    const role = roleOf(email, users);
    return res.status(200).json({ email, name: u?.name ?? null, institution: u?.institution ?? null, isAdmin: role === "admin", role });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { action } = (req.body || {}) as { action?: string };
  if (action === "logout") {
    clearSessionCookie(res);
    return res.status(200).json({ email: null });
  }

  try {
    const users = await loadUsers();

    if (action === "verify") {
      const token = String((req.body || {}).token || "");
      const email = readPurpose(token, "verify");
      if (!email) return res.status(400).json({ error: "This verification link is invalid or expired." });
      const u = users[email];
      if (!u) return res.status(404).json({ error: "Account not found." });
      if (u.verified === false) { u.verified = true; await saveUsers(users); }
      setSessionCookie(res, signToken(email)); // verifying logs them in
      return res.status(200).json({ email, name: u.name ?? null, isAdmin: isAdminEmail(email), role: roleOf(email, users), next: readPurposeNext(token, "verify") ?? null });
    }

    const email = normEmail((req.body || {}).email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });

    if (action === "resend-verification") {
      const u = users[email];
      // Always respond ok (avoid revealing which emails exist).
      if (u && u.verified === false) { const { devUrl } = await sendVerification(email, u.name, safeNext((req.body || {}).next)); return res.status(200).json({ ok: true, devUrl }); }
      return res.status(200).json({ ok: true });
    }

    const password = String((req.body || {}).password || "");
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    if (action === "signup") {
      const name = String((req.body || {}).name || "").trim();
      const institution = String((req.body || {}).institution || "").trim();
      if (name.length < 2) return res.status(400).json({ error: "Enter your real name." });
      if (users[email]) return res.status(409).json({ error: "An account with that email already exists." });
      const u: User = {
        email, name, pwHash: hashPassword(password), createdAt: new Date().toISOString(), verified: false,
        ...(institution ? { institution } : {}),
      };
      users[email] = u;
      await saveUsers(users);
      const { delivered, devUrl } = await sendVerification(email, name, safeNext((req.body || {}).next));
      // No session yet — the user must verify first.
      return res.status(200).json({ needsVerification: true, email, delivered, devUrl });
    }

    if (action === "login") {
      const u = users[email];
      if (!u || !verifyPassword(password, u.pwHash))
        return res.status(401).json({ error: "Incorrect email or password." });
      if (!isVerified(u)) {
        const { devUrl } = await sendVerification(email, u.name, safeNext((req.body || {}).next));
        return res.status(403).json({ error: "Please verify your email first — we've re-sent the link.", needsVerification: true, devUrl });
      }
      setSessionCookie(res, signToken(email));
      return res.status(200).json({ email, name: u.name ?? null, institution: u.institution ?? null, isAdmin: isAdminEmail(email), role: roleOf(email, users) });
    }
    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
}
