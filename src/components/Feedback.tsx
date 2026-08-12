import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth";

// "Send feedback" in the topbar: a small dialog that mails the site owner. Signed-in
// users are identified by their account; everyone else can leave an address to be
// replied to (or not — the message goes either way).
export function Feedback() {
  const { user } = useAuth();
  const loc = useLocation();
  // On a tournament page this button is one click from the buzz data, and people
  // reach for it to report a wrong buzz — which goes to the site owner, who can't
  // fix another person's tournament. Point them at that set's own Edit flow.
  const setSlug = loc.pathname.match(/^\/set\/([^/]+)/)?.[1] ?? null;
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function close() {
    setOpen(false);
    // Reset only after a successful send, so a failed attempt keeps what was typed.
    if (state === "sent") { setMessage(""); setState("idle"); setErr(null); }
  }

  // Signed-in senders are identified by their account; everyone else has to leave
  // an address, so a reply is always possible.
  const emailOk = !!user || /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email.trim());

  async function send() {
    if (!message.trim()) { setErr("Write a message first."); return; }
    if (!emailOk) { setErr("Add your email so I can reply."); return; }
    setState("sending"); setErr(null);
    try {
      const r = await fetch("/api/index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "feedback", message, email, page: window.location.href }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as any).error || `Failed (${r.status})`);
      setState("sent");
    } catch (e) {
      setState("idle");
      setErr(String((e as Error).message || e));
    }
  }

  return (
    <>
      <button className="nav-link btn-nav" onClick={() => setOpen(true)}>Feedback</button>
      {open && (
        <div className="modal-backdrop" onClick={close}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Send feedback" onClick={(e) => e.stopPropagation()}>
            {state === "sent" ? (
              <>
                <h2>Thanks!</h2>
                <p className="muted">Your feedback is on its way.</p>
                <div className="modal-actions"><button className="btn-primary btn-sm" onClick={close}>Close</button></div>
              </>
            ) : (
              <>
                <h2>Send feedback about the site</h2>
                <p className="muted">
                  This goes to whoever runs Buzzpoints — for bugs, confusing pages, and ideas for features. It's the
                  right place for “this chart is unreadable on mobile” or “I wish I could sort by…”.
                </p>
                <div className="caveat feedback-scope">
                  <strong>Not for fixing a tournament's data.</strong> A misattributed buzz, a wrong buzz position, or a
                  player's name spelled two ways is the tournament owner's to fix, and I can't change someone else's
                  tournament from here.{" "}
                  {setSlug ? (
                    <>
                      Use <strong>Edit</strong> next to the buzz on its tossup page, or{" "}
                      <Link className="link" to={`/set/${setSlug}/tossup`} onClick={() => setOpen(false)}>
                        open this tournament's tossups
                      </Link>{" "}
                      to find it.
                    </>
                  ) : (
                    <>Open the tossup in question and use the <strong>Edit</strong> link beside the buzz.</>
                  )}
                </div>
                <textarea
                  ref={box}
                  rows={6}
                  className="feedback-input"
                  value={message}
                  placeholder="What could work better on the site?"
                  maxLength={4000}
                  onChange={(e) => setMessage(e.target.value)}
                />
                {user ? (
                  <p className="muted" style={{ fontSize: 13 }}>Sent as {user}.</p>
                ) : (
                  <label className="field-inline"><span>Your email</span>
                    <input
                      type="email" value={email} placeholder="so I can reply" required
                      style={{ flex: 1 }} onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                )}
                {err && <span className="error-inline">{err}</span>}
                <div className="modal-actions">
                  <button className="btn-primary btn-sm" disabled={state === "sending" || !message.trim() || !emailOk} onClick={send}>
                    {state === "sending" ? "Sending…" : "Send"}
                  </button>
                  <button className="btn-link" onClick={close}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
