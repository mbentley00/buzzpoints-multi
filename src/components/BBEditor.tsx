import { useRef, useState } from "react";
import { BBCode } from "../bbcode";

// A BBCode editor with a phpBB-style toolbar: each button wraps the selection
// in its tag (or drops in an empty pair with the caret between). Nothing here
// changes what's stored — the textarea's text is the post, BBCode and all.

const TAGS: { key: string; label: string; title: string; open: string; close: string; style?: React.CSSProperties }[] = [
  { key: "b", label: "B", title: "Bold: [b]text[/b]", open: "[b]", close: "[/b]", style: { fontWeight: 700 } },
  { key: "i", label: "i", title: "Italic: [i]text[/i]", open: "[i]", close: "[/i]", style: { fontStyle: "italic" } },
  { key: "u", label: "u", title: "Underline: [u]text[/u]", open: "[u]", close: "[/u]", style: { textDecoration: "underline" } },
  { key: "s", label: "S", title: "Strike: [s]text[/s]", open: "[s]", close: "[/s]", style: { textDecoration: "line-through" } },
  { key: "quote", label: "Quote", title: "Quote: [quote]text[/quote]", open: "[quote]", close: "[/quote]" },
  { key: "code", label: "Code", title: "Code: [code]text[/code]", open: "[code]", close: "[/code]" },
  { key: "list", label: "List", title: "List: [list][*]item[/list]", open: "[list]\n[*]", close: "\n[/list]" },
  { key: "url", label: "URL", title: "Link: [url=https://…]text[/url]", open: "[url=https://]", close: "[/url]" },
];

export function BBEditor({ value, onChange, placeholder, rows = 6, maxLength = 8000, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; maxLength?: number; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  const wrap = (open: string, close: string) => {
    const el = ref.current;
    if (!el) { onChange(value + open + close); return; }
    const start = el.selectionStart ?? value.length, end = el.selectionEnd ?? start;
    const sel = value.slice(start, end);
    let o = open, c = close;
    // A selected address becomes the link itself.
    const isUrl = open.startsWith("[url=");
    if (isUrl && /^https?:\/\/\S+$/i.test(sel)) { o = "[url]"; c = "[/url]"; }
    const next = value.slice(0, start) + o + sel + c + value.slice(end);
    // Where the caret lands: on the address of an empty link tag (selected, so
    // typing replaces the placeholder), after a wrapped selection, or between an
    // empty pair.
    let selFrom: number, selTo: number;
    if (o.startsWith("[url=")) { selFrom = start + "[url=".length; selTo = start + o.length - 1; }
    else if (sel) { selFrom = selTo = start + o.length + sel.length + c.length; }
    else { selFrom = selTo = start + o.length; }
    onChange(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(selFrom, selTo); });
  };

  return (
    <div className="bb-editor">
      <div className="bb-toolbar" role="toolbar" aria-label="Formatting">
        {TAGS.map((t) => (
          <button key={t.key} type="button" className="bb-tool" title={t.title} style={t.style} disabled={preview} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap(t.open, t.close)}>
            {t.label}
          </button>
        ))}
        <span className="bb-toolbar-gap" />
        <button type="button" className={"bb-tool" + (preview ? " on" : "")} onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</button>
      </div>
      {preview
        ? <div className="forum-preview"><BBCode src={value} /></div>
        : <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} maxLength={maxLength} autoFocus={autoFocus} />}
    </div>
  );
}
