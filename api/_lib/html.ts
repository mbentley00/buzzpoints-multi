// HTML entities in packet text, decoded to the characters a reader sees.
// "&nbsp;" becomes an ordinary space, so "Dumas&nbsp;(\"doo-MAH\")" splits into the
// word "Dumas" plus its pronunciation guide instead of one word "Dumas&nbsp;".
const NAMED: Record<string, string> = {
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„",
  ndash: "–", mdash: "—", hellip: "…", middot: "·", bull: "•",
  laquo: "«", raquo: "»", deg: "°", times: "×", divide: "÷", minus: "−",
  copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", shy: "",
  zwj: "", zwnj: "", lrm: "", rlm: "",
};
const ACCENT: Record<string, string> = { acute: "́", grave: "̀", uml: "̈", circ: "̂", tilde: "̃", cedil: "̧", ring: "̊", caron: "̌" };

export function decodeEntities(s: string): string {
  return (s || "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const n = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return whole;
      return n === 0xa0 ? " " : String.fromCodePoint(n);
    }
    if (name in NAMED) return NAMED[name];
    const lower = name.toLowerCase();
    if (lower in NAMED) return NAMED[lower];
    const m = /^([a-z])(acute|grave|uml|circ|tilde|cedil|ring|caron)$/i.exec(name);
    if (m) return (m[1] + ACCENT[m[2].toLowerCase()]).normalize("NFC");
    if (/^szlig$/i.test(name)) return "ß";
    if (/^oslash$/.test(name)) return "ø";
    if (/^Oslash$/.test(name)) return "Ø";
    if (/^aelig$/.test(name)) return "æ";
    if (/^AElig$/.test(name)) return "Æ";
    return whole;
  }).replace(/ /g, " ");
}

// Tags out, entities decoded.
export const htmlToText = (s: string | undefined) => decodeEntities((s || "").replace(/<[^>]+>/g, ""));
