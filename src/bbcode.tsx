// A strict BBCode renderer for the discussion pages. Post bodies are stored as
// BBCode (phpBB's markup, so a future sync to a phpBB forum is a copy, not a
// conversion); this turns the handful of tags we support into HTML and leaves
// anything else as literal text. The text is HTML-escaped BEFORE any tag is
// turned into markup, and the only attribute that ever comes from the author
// is a URL, which must be http(s) — so nothing an author writes reaches the
// page as HTML.
//
// Supported: [b] [i] [u] [s] [code] [quote] [quote=name] [url] [url=href]
// [list] [list=1] [*]. Line breaks become <br>.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeHref = (raw: string): string | null => {
  const u = raw.trim().replace(/&quot;/g, "");
  return /^https?:\/\/[^\s<>"]+$/i.test(u) ? u : null;
};

export function bbcodeToHtml(src: string): string {
  let s = esc(src || "");
  // [code] first, and taken out of the way, so nothing inside it is parsed.
  const codes: string[] = [];
  s = s.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (_, c) => { codes.push(`<pre class="bb-code">${c.replace(/^\n+|\n+$/g, "")}</pre>`); return `\u0000${codes.length - 1}\u0000`; });
  // List items, while the [/list] that ends each one is still there to stop at.
  s = s.replace(/\[\*\]([\s\S]*?)(?=\[\*\]|\[\/list\])/g, "<li>$1</li>");
  // Simple paired tags. Run until nothing changes so nesting resolves.
  const pairs: [RegExp, string][] = [
    [/\[b\]([\s\S]*?)\[\/b\]/gi, "<strong>$1</strong>"],
    [/\[i\]([\s\S]*?)\[\/i\]/gi, "<em>$1</em>"],
    [/\[u\]([\s\S]*?)\[\/u\]/gi, "<u>$1</u>"],
    [/\[s\]([\s\S]*?)\[\/s\]/gi, "<s>$1</s>"],
    [/\[quote=(?:&quot;)?([^\]&]{1,80}?)(?:&quot;)?\]([\s\S]*?)\[\/quote\]/gi, '<blockquote class="bb-quote"><cite>$1 wrote:</cite>$2</blockquote>'],
    [/\[quote\]([\s\S]*?)\[\/quote\]/gi, '<blockquote class="bb-quote">$1</blockquote>'],
    [/\[list=1\]([\s\S]*?)\[\/list\]/gi, "<ol>$1</ol>"],
    [/\[list\]([\s\S]*?)\[\/list\]/gi, "<ul>$1</ul>"],
  ];
  for (let pass = 0; pass < 6; pass++) {
    const before = s;
    for (const [re, rep] of pairs) s = s.replace(re, rep);
    if (s === before) break;
  }
  // Links: the only author-supplied attribute, and only ever an http(s) URL.
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (m, href, text) => { const h = safeHref(href); return h ? `<a href="${h}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>` : m; });
  s = s.replace(/\[url\]([^\[]+)\[\/url\]/gi, (m, href) => { const h = safeHref(href); return h ? `<a href="${h}" rel="noopener noreferrer nofollow" target="_blank">${h}</a>` : m; });
  // Line breaks, except inside lists where they'd pad every item.
  s = s.replace(/\n/g, "<br>").replace(/<\/li><br>/g, "</li>").replace(/(<[ou]l>)<br>/g, "$1").replace(/<br>(<\/[ou]l>)/g, "$1");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}

export function BBCode({ src }: { src: string }) {
  return <div className="bb" dangerouslySetInnerHTML={{ __html: bbcodeToHtml(src) }} />;
}
