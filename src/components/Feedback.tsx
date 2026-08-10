import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth";

// "Send feedback" in the topbar: a small dialog that mails the site owner. Signed-in
// users are identified by their account; everyone else can leave an address to be
// replied to (or not — the message goes either way).
export function Feedback() {
  const { user } = useAuth();
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

  async function send() {
    if (!message.trim()) { setErr("Write a message first."); return; }
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
                <h2>Send feedback</h2>
                <p className="muted">Found a bug, or something looks wrong in a tournament? Tell me about it.</p>
                <textarea
                  ref={box}
                  rows={6}
                  className="feedback-input"
                  value={message}
                  placeholder="What's on your mind?"
                  maxLength={4000}
                  onChange={(e) => setMessage(e.target.value)}
                />
                {user ? (
                  <p className="muted" style={{ fontSize: 13 }}>Sent as {user}.</p>
                ) : (
                  <label className="field-inline"><span>Your email</span>
                    <input
                      type="email" value={email} placeholder="optional, so I can reply"
                      style={{ flex: 1 }} onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                )}
                {err && <span className="error-inline">{err}</span>}
                <div className="modal-actions">
                  <button className="btn-primary btn-sm" disabled={state === "sending" || !message.trim()} onClick={send}>
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
