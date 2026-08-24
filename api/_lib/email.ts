// Transactional email over SMTP, with Resend kept as a fallback. When neither is
// configured, sending is a no-op (the caller falls back to surfacing links and
// notices in-app).
import nodemailer, { type Transporter } from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
// Must be the authenticated mailbox: the mail server rejects (or spam-flags) a
// From it doesn't own.
const EMAIL_FROM = process.env.EMAIL_FROM || "Buzzpoints <buzzpoints@doc-ent.com>";

const smtpConfigured = () => !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
export const emailEnabled = () => smtpConfigured() || !!RESEND_API_KEY;

// One pooled transport per warm instance. The publish-reminder cron sends a batch
// back to back, and a fresh TLS handshake per message would dominate its runtime.
let tx: Transporter | null = null;
const transport = (): Transporter =>
  (tx ??= nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    // 465 is implicit TLS; 587 negotiates STARTTLS after connecting.
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    pool: true,
    maxConnections: 1,
  }));

// Base URL for links in emails and for the invite/approval links built server-side.
// Prefer APP_URL; fall back to the prod host (www is primary — the apex 308s to it,
// and an invite link that redirects is one more thing to go wrong in a mail client).
export const appUrl = () =>
  (process.env.APP_URL || "https://www.quizbowlbuzzpoints.com").replace(/\/+$/, "");

export async function sendEmail(opts: { to: string; subject: string; html: string; text?: string; replyTo?: string }): Promise<boolean> {
  if (smtpConfigured()) {
    try {
      await transport().sendMail({
        from: EMAIL_FROM, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text,
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      });
      return true;
    } catch (e) {
      console.warn("[email] smtp send failed", (e as Error).message);
      // A pooled connection that went bad stays bad; drop it so the next send
      // reconnects instead of failing the same way.
      tx = null;
      // Fall through to Resend when it's still configured, so a mail-server blip
      // doesn't silently swallow an invite or a password reset.
      if (!RESEND_API_KEY) return false;
    }
  }
  if (!RESEND_API_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      }),
    });
    if (!r.ok) { console.warn("[email] resend failed", r.status, await r.text().catch(() => "")); return false; }
    return true;
  } catch (e) {
    console.warn("[email] send error", (e as Error).message);
    return false;
  }
}

const esc = (s: string) => (s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
const wrap = (body: string) =>
  `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;color:#1c2530;line-height:1.5;max-width:520px">${body}<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"><p style="font-size:12px;color:#888">Buzzpoints</p></div>`;
const btn = (href: string, label: string) =>
  `<p><a href="${href}" style="display:inline-block;background:#4b8bf5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${label}</a></p><p style="font-size:12px;color:#888">Or paste this link: ${href}</p>`;

export const verifyEmailBody = (name: string, url: string) =>
  wrap(`<p>Hi ${esc(name)},</p><p>Confirm your email to finish creating your Buzzpoints account.</p>${btn(url, "Verify email")}<p style="font-size:12px;color:#888">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`);

export const resetPasswordBody = (name: string, url: string) =>
  wrap(`<p>Hi ${esc(name)},</p><p>Use this link to choose a new Buzzpoints password.</p>${btn(url, "Reset password")}<p style="font-size:12px;color:#888">The link expires in an hour and works once. If you didn't ask to reset your password, ignore this email — your current one still works.</p>`);

// Whoever is being asked to approve something about a tournament should be able
// to see, without opening it, who can currently read it — the same three words
// the Settings dropdown uses, with what each one actually means. Approving an
// edit, an access request, or a whole submission all read differently depending
// on whether the thing is public.
const VIS_MEANING: Record<string, string> = {
  public: "anyone can find it in the tournament list and read the questions",
  listed: "shown in the tournament list, but opening it needs an invite",
  private: "hidden from the list; only the owner, invitees and admins can open it",
};
export const VIS_LABEL: Record<string, string> = { public: "Public", listed: "Listed", private: "Private" };
// `lead` carries the tense: an existing tournament "is currently", a queued
// submission "would be created as". Absent/unknown visibility renders nothing
// rather than guessing at one.
const visLine = (visibility: string | undefined | null, lead: string) => {
  const v = String(visibility || "");
  if (!VIS_MEANING[v]) return "";
  return `<p style="font-size:13px;color:#555">${lead} <strong>${VIS_LABEL[v]}</strong> — ${VIS_MEANING[v]}.</p>`;
};

export const accessRequestBody = (requester: string, setName: string, url: string, affiliation?: string, visibility?: string) =>
  wrap(`<p><strong>${esc(requester)}</strong> requested access to <strong>${esc(setName)}</strong>.</p>${affiliation ? `<p><strong>Affiliation:</strong> ${esc(affiliation)}</p>` : ""}${visLine(visibility, "This tournament is currently")}<p>Review and approve or deny the request in the tournament's settings.</p>${btn(url, "Review request")}`);

export const accessGrantedBody = (setName: string, url: string) =>
  wrap(`<p>You've been granted access to <strong>${esc(setName)}</strong> on Buzzpoints.</p>${btn(url, "Open tournament")}`);

// Sent when the creator adds someone as a co-owner of their tournament.
export const coOwnerBody = (setName: string, url: string) =>
  wrap(`<p>You've been added as a co-owner of <strong>${esc(setName)}</strong> on Buzzpoints.</p><p>You can now upload files, fix buzzes, approve edit requests, and change the tournament's settings — everything except deleting it or changing who co-owns it, which stay with the tournament's owner.</p>${btn(url, "Open tournament")}`);

// Sent once, six months after a tournament was uploaded, if it still isn't
// public — a nudge, not a deadline, so it says plainly that doing nothing is fine.
export const publishReminderBody = (setName: string, uploaded: string, url: string) =>
  wrap(
    `<p>You uploaded <strong>${esc(setName)}</strong> to Buzzpoints in ${esc(uploaded)}, and it's still not public.</p>` +
    `<p>Six months on, most tournaments have finished their mirrors and there's no longer a reason to hold the questions back. Making it public puts it in the tournament list and lets anyone read the questions and study the buzz data — which is where most of Buzzpoints' value comes from.</p>` +
    `<p>If it still needs to stay private, no action is needed. This is the only reminder you'll get for this tournament.</p>` +
    btn(url, "Review visibility")
  );

// Sent to the owner when a viewer submits a correction (edit) request.
export const correctionRequestBody = (requester: string, setName: string, summary: string, desc: string, url: string, visibility?: string) =>
  wrap(`<p><strong>${esc(requester)}</strong> suggested an edit to <strong>${esc(setName)}</strong>.</p><p>${esc(summary)}</p>${desc ? `<p><strong>Note:</strong> ${esc(desc)}</p>` : ""}${visLine(visibility, "This tournament is currently")}<p>Review and approve or reject it on the tournament's Requests page.</p>${btn(url, "Review edit")}`);

// Sent to moderators/admins when a first-time poster submits a tournament.
// `approveUrl` is a one-click approval link; `reviewUrl` opens the dashboard.
// The submission isn't a set yet, so its visibility is the one the submitter
// ASKED for — worth stating next to a button labelled "publish", which for a
// private submission publishes it to nobody.
export const submissionPendingBody = (submitter: string, setName: string, reviewUrl: string, approveUrl: string, visibility?: string) =>
  wrap(`<p><strong>${esc(submitter)}</strong> submitted their first tournament, <strong>${esc(setName)}</strong>, for review.</p><p>It won't be published until you approve it.</p>${visLine(visibility, "They asked for it to be")}${btn(approveUrl, "Approve & publish")}<p style="font-size:13px;color:#555">Want to look first? <a href="${reviewUrl}">Review it in the dashboard</a>.</p>`);

// Sent to the submitter once their first tournament is approved.
export const submissionApprovedBody = (setName: string, url: string) =>
  wrap(`<p>Your tournament <strong>${esc(setName)}</strong> has been approved and is now live on Buzzpoints.</p><p>Future tournaments you post will publish immediately.</p>${btn(url, "Open tournament")}`);

// Sent to moderators/admins when the owner of a fresh upload asks to make it
// public (uploads younger than three months need approval; imports don't).
export const publishRequestBody = (requester: string, setName: string, uploaded: string, reviewUrl: string) =>
  wrap(`<p><strong>${esc(requester)}</strong> wants to make <strong>${esc(setName)}</strong> public.</p><p>The tournament was uploaded ${esc(uploaded)} — less than three months ago, so going public needs a moderator's approval. Until someone approves it, it stays as it is.</p>${btn(reviewUrl, "Review in the dashboard")}`);

// Sent to the owners once a moderator approves the request.
export const publishApprovedBody = (setName: string, url: string) =>
  wrap(`<p>Your request to make <strong>${esc(setName)}</strong> public has been approved. It's now open to everyone.</p>${btn(url, "Open tournament")}`);

// Sent to the requester when a moderator declines the request. The set itself
// is untouched — only the switch to public didn't happen.
export const publishRejectedBody = (setName: string, reason: string) =>
  wrap(`<p>Your request to make <strong>${esc(setName)}</strong> public wasn't approved.</p>${reason ? `<p><strong>Reason:</strong> ${esc(reason)}</p>` : ""}<p>The tournament itself is unchanged — its visibility stays as it was. You can ask again once it's three months old, or reply to the moderators if you think this was a mistake.</p>`);

// A feature request / site bug report from the "Feature Requests" button. The
// message is user-written, so it's escaped and only newlines become markup.
export const feedbackBody = (from: string, page: string, message: string) =>
  wrap(
    `<p><strong>${esc(from)}</strong> sent a feature request${page ? ` from <a href="${esc(page)}">${esc(page)}</a>` : ""}.</p>` +
    `<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #cbd5e1;color:#333;white-space:pre-wrap">${esc(message)}</blockquote>`
  );

// Sent to the submitter if their first tournament is rejected.
export const submissionRejectedBody = (setName: string, reason: string) =>
  wrap(`<p>Your submission <strong>${esc(setName)}</strong> was not approved.</p>${reason ? `<p>Reason: ${esc(reason)}</p>` : ""}<p>You're welcome to fix any issues and submit again.</p>`);
