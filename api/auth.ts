// POST /api/auth { action: "signup"|"login"|"logout"|"verify"|"resend-verification"
//                          |"forgot-password"|"reset-password", ... }
// GET  /api/auth  -> current user
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  loadUsers, saveUsers, hashPassword, verifyPassword, signToken, signPurpose, readPurpose, readPurposeNext,
  resetPurpose, peekPurposeEmail, safeNext, setSessionCookie, clearSessionCookie, currentUser, normEmail,
  isAdminEmail, isVerified, roleOf, User, UserStore,
} from "./_lib/auth.js";
import { sendEmail, appUrl, verifyEmailBody, resetPasswordBody } from "./_lib/email.js";

const VERIFY_TTL = 60 * 60 * 24; // 24h
const RESET_TTL = 60 * 60; // 1h — short, since the link sets a password
const verifyUrl = (email: string, next?: string) =>
  `${appUrl()}/verify?token=${encodeURIComponent(signPurpose(email, "verify", VERIFY_TTL, next))}`;
const resetUrl = (u: User, next?: string) =>
  `${appUrl()}/reset?token=${encodeURIComponent(signPurpose(u.email, resetPurpose(u), RESET_TTL, next))}`;

// A reset token names its account but is signed against that account's password
// hash at the time it was issued, so it only opens while it's still the newest
// unused link for that account.
function openReset(token: string, users: UserStore): User | null {
  const email = peekPurposeEmail(token);
  const u = email ? users[email] : undefined;
  return u && readPurpose(token, resetPurpose(u)) === u.email ? u : null;
}

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

    // Like "verify", this identifies its account from the token, not a form field.
    if (action === "reset-password") {
      const token = String((req.body || {}).token || "");
      const u = openReset(token, users);
      if (!u) return res.status(400).json({ error: "This reset link is invalid, expired, or has already been used." });
      const pw = String((req.body || {}).password || "");
      if (pw.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
      const next = readPurposeNext(token, resetPurpose(u)) ?? null;
      u.pwHash = hashPassword(pw);
      // Reaching the link proves they hold the address, which is what verification
      // was waiting on — so an unverified account is confirmed by resetting.
      u.verified = true;
      await saveUsers(users);
      setSessionCookie(res, signToken(u.email)); // resetting logs them in
      return res.status(200).json({ email: u.email, name: u.name ?? null, institution: u.institution ?? null, isAdmin: isAdminEmail(u.email), role: roleOf(u.email, users), next });
    }

    const email = normEmail((req.body || {}).email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });

    if (action === "forgot-password") {
      const u = users[email];
      // Always respond ok, so this can't be used to find out who has an account.
      if (u) {
        const url = resetUrl(u, safeNext((req.body || {}).next));
        const delivered = await sendEmail({ to: email, subject: "Reset your Buzzpoints password", html: resetPasswordBody(u.name, url) });
        return res.status(200).json({ ok: true, ...(delivered ? {} : { devUrl: url }) });
      }
      return res.status(200).json({ ok: true });
    }

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

    // ---- profile: the signed-in account's name and affiliation ----
    if (action === "profile") {
      const me = currentUser(req);
      if (!me || !users[me]) return res.status(401).json({ error: "Log in." });
      const body = (req.body || {}) as { name?: unknown; institution?: unknown };
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (name.length < 2) return res.status(400).json({ error: "Enter your name." });
      const institution = String(body.institution ?? "").trim().slice(0, 120);
      users[me].name = name;
      if (institution) users[me].institution = institution; else delete users[me].institution;
      await saveUsers(users);
      return res.status(200).json({ email: me, name, institution: institution || null, isAdmin: isAdminEmail(me), role: roleOf(me, users) });
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
