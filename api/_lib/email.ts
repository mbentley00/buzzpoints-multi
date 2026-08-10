// Transactional email via Resend. When RESEND_API_KEY is unset, sending is a
// no-op (the caller falls back to surfacing links/notices in-app).
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "Buzzpoints <noreply@buzzpoints.buzz>";

export const emailEnabled = () => !!RESEND_API_KEY;

// Base URL for links in emails. Prefer APP_URL; fall back to the prod host.
export const appUrl = () =>
  (process.env.APP_URL || "https://buzzpoints.buzz").replace(/\/+$/, "");

export async function sendEmail(opts: { to: string; subject: string; html: string; text?: string; replyTo?: string }): Promise<boolean> {
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

export const accessRequestBody = (requester: string, setName: string, url: string, affiliation?: string) =>
  wrap(`<p><strong>${esc(requester)}</strong> requested access to <strong>${esc(setName)}</strong>.</p>${affiliation ? `<p><strong>Affiliation:</strong> ${esc(affiliation)}</p>` : ""}<p>Review and approve or deny the request in the tournament's settings.</p>${btn(url, "Review request")}`);

export const accessGrantedBody = (setName: string, url: string) =>
  wrap(`<p>You've been granted access to <strong>${esc(setName)}</strong> on Buzzpoints.</p>${btn(url, "Open tournament")}`);

// Sent to the owner when a viewer submits a correction (edit) request.
export const correctionRequestBody = (requester: string, setName: string, summary: string, desc: string, url: string) =>
  wrap(`<p><strong>${esc(requester)}</strong> suggested an edit to <strong>${esc(setName)}</strong>.</p><p>${esc(summary)}</p>${desc ? `<p><strong>Note:</strong> ${esc(desc)}</p>` : ""}<p>Review and approve or reject it on the tournament's Requests page.</p>${btn(url, "Review edit")}`);

// Sent to moderators/admins when a first-time poster submits a tournament.
// `approveUrl` is a one-click approval link; `reviewUrl` opens the dashboard.
export const submissionPendingBody = (submitter: string, setName: string, reviewUrl: string, approveUrl: string) =>
  wrap(`<p><strong>${esc(submitter)}</strong> submitted their first tournament, <strong>${esc(setName)}</strong>, for review.</p><p>It won't be published until you approve it.</p>${btn(approveUrl, "Approve & publish")}<p style="font-size:13px;color:#555">Want to look first? <a href="${reviewUrl}">Review it in the dashboard</a>.</p>`);

// Sent to the submitter once their first tournament is approved.
export const submissionApprovedBody = (setName: string, url: string) =>
  wrap(`<p>Your tournament <strong>${esc(setName)}</strong> has been approved and is now live on Buzzpoints.</p><p>Future tournaments you post will publish immediately.</p>${btn(url, "Open tournament")}`);

// Site feedback from the "Send feedback" button. The message is user-written, so
// it's escaped and only newlines become markup.
export const feedbackBody = (from: string, page: string, message: string) =>
  wrap(
    `<p><strong>${esc(from)}</strong> sent feedback${page ? ` from <a href="${esc(page)}">${esc(page)}</a>` : ""}.</p>` +
    `<blockquote style="margin:0;padding:10px 14px;border-left:3px solid #cbd5e1;color:#333;white-space:pre-wrap">${esc(message)}</blockquote>`
  );

// Sent to the submitter if their first tournament is rejected.
export const submissionRejectedBody = (setName: string, reason: string) =>
  wrap(`<p>Your submission <strong>${esc(setName)}</strong> was not approved.</p>${reason ? `<p>Reason: ${esc(reason)}</p>` : ""}<p>You're welcome to fix any issues and submit again.</p>`);
