// MODAQ-style question text: keep the packet's own formatting (bold power,
// italic titles, underlines) and grey out pronunciation guides, without letting
// any of it disturb the buzz numbering.
//
// The aggregator stores two views of a tossup: `questionHtml` (the packet's
// markup) and `words` (the flat token list the scorekeeper's word indices point
// at). This module walks the HTML and hands each token back the index it has in
// `words`, so a formatted render and a buzz chip can never drift apart. If the
// two can't be lined up — a reworded mirror, or markup we didn't expect — the
// caller falls back to the plain word list.

import { Fragment, ReactNode } from "react";

export interface QSeg { text: string; b?: boolean; i?: boolean; u?: boolean; pg?: boolean }
export interface QToken {
  segs: QSeg[];
  index: number | null; // position in `words`, or null for a token the scorekeeper never counted
  spaceAfter: boolean;
}

// What's on the page but never read aloud: pronunciation guides and the power
// mark. The aggregator numbers only the spoken words (keep in sync with
// `tokenize` in api/_lib/aggregate.ts), so these carry no buzz index. Guides also
// go grey; the mark stays in the question's own formatting.
const PG_ANY = /\([“"][^)]*\)/g;
const UNSPOKEN = [PG_ANY, /\(\*\)/g];

interface Fmt { b: boolean; i: boolean; u: boolean }
interface Span extends Fmt { start: number; end: number }
interface Range { start: number; end: number }

// Flatten the markup into plain text plus the formatting spans over it. Tags are
// dropped without inserting whitespace, matching the aggregator's stripHtml, so
// the text here is character-for-character what the word list was built from.
function flatten(html: string): { text: string; spans: Span[] } {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const spans: Span[] = [];
  let text = "";
  const walk = (node: Node, f: Fmt) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const t = child.nodeValue || "";
        if (!t) return;
        spans.push({ start: text.length, end: text.length + t.length, ...f });
        text += t;
      } else if (child.nodeType === 1) {
        const tag = (child as Element).tagName.toLowerCase();
        walk(child, {
          b: f.b || tag === "b" || tag === "strong",
          i: f.i || tag === "i" || tag === "em",
          u: f.u || tag === "u",
        });
      }
    });
  };
  walk(doc.body, { b: false, i: false, u: false });
  return { text, spans };
}

function matchRanges(text: string, re: RegExp): Range[] {
  const out: Range[] = [];
  for (const m of text.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length });
  return out;
}

// The token's text with the unspoken marks taken back out — this is what the
// aggregator counted as a word (empty if the token is only marks).
function spokenText(text: string, start: number, end: number, unspoken: Range[]): string {
  let out = "";
  for (let i = start; i < end; i++) if (!unspoken.some((r) => r.start <= i && i < r.end)) out += text[i];
  return out.trim();
}

function segsOf(text: string, start: number, end: number, spans: Span[], grey: Uint8Array): QSeg[] {
  const out: QSeg[] = [];
  for (const sp of spans) {
    const s = Math.max(sp.start, start), e = Math.min(sp.end, end);
    if (s >= e) continue;
    // Split the slice wherever it crosses into or out of a pronunciation guide.
    let p = s;
    while (p < e) {
      const g = grey[p];
      let q = p + 1;
      while (q < e && grey[q] === g) q++;
      out.push({ text: text.slice(p, q), b: sp.b, i: sp.i, u: sp.u, pg: !!g });
      p = q;
    }
  }
  return out;
}

/** Tokens for `html` carrying the buzz index each one has in `words`, or null if
 *  the two don't line up (the caller should fall back to `plainTokens`). */
export function tokenizeQuestion(html: string, words: string[]): QToken[] | null {
  if (!html) return null;
  const { text, spans } = flatten(html);
  const unspoken = UNSPOKEN.flatMap((re) => matchRanges(text, re));
  const grey = new Uint8Array(text.length);
  for (const r of matchRanges(text, PG_ANY)) for (let i = r.start; i < r.end; i++) grey[i] = 1;

  const toks: QToken[] = [];
  let n = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index!, end = start + m[0].length;
    const word = spokenText(text, start, end, unspoken);
    let index: number | null = null;
    if (word) {
      if (words[n] !== word) return null;
      index = n++;
    }
    toks.push({
      segs: segsOf(text, start, end, spans, grey),
      index,
      spaceAfter: /\s/.test(text[end] ?? ""),
    });
  }
  return n === words.length ? toks : null;
}

/** Unformatted fallback: one token per aggregated word. */
export const plainTokens = (words: string[]): QToken[] =>
  words.map((w, i) => ({ segs: [{ text: w }], index: i, spaceAfter: true }));

export function Segs({ segs }: { segs: QSeg[] }) {
  return (
    <>
      {segs.map((s, i) => {
        let el: ReactNode = s.text;
        if (s.b) el = <b>{el}</b>;
        if (s.i) el = <i>{el}</i>;
        if (s.u) el = <u>{el}</u>;
        if (s.pg) el = <span className="q-pg">{el}</span>;
        return <Fragment key={i}>{el}</Fragment>;
      })}
    </>
  );
}
