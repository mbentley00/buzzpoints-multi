import { useMemo, useRef, useState } from "react";
import { TossupDetail, Buzz } from "../types";

// Cumulative buzzes as the question is read: how fast a tossup gets picked off,
// and how much of that is right rather than early-and-wrong. The grey envelope is
// every buzz; the green area inside it is the correct ones, so the gap between
// them is the negs. Restores the curve the old Buzzpoints site drew.
//
// Colours are the validated pair for this chart (see the palette check in
// dataviz): a neutral #8a929c against #2f8a55 clears CVD and normal-vision
// separation against BOTH the light and dark surfaces, so one pair serves both. The neutral reads grey on purpose — it's
// context for the green, not a competing series.
const TOTAL = "#8a929c";
const CORRECT = "#2f8a55";
const AVG = "#e08a1e"; // same marker colour the question text uses for average buzz

const W = 720, H = 250;
const M = { top: 14, right: 16, bottom: 34, left: 40 };
const PW = W - M.left - M.right, PH = H - M.top - M.bottom;

// A "nice" axis step so the y ticks land on round numbers.
function niceStep(max: number, target = 4): number {
  const raw = Math.max(1, max / target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
}

export function BuzzCurve({ d }: { d: TossupDetail }) {
  const svg = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    // One slot per word plus the ■END■ slot, matching how buzzes are numbered.
    const n = d.words.length + 1;
    const total = new Array(n + 1).fill(0);
    const correct = new Array(n + 1).fill(0);
    // An imprecise buzz is only known to be after power, so count it where the
    // question text shows it rather than where it was recorded.
    const at = (b: Buzz) =>
      b.imprecise && d.powerIndex !== null ? Math.min(d.powerIndex + 1, d.words.length) : b.wordIndex;
    for (const b of d.buzzes) {
      const i = at(b);
      if (i === null) continue;
      const k = Math.max(0, Math.min(n, i));
      total[k]++;
      if (b.value > 0) correct[k]++;
    }
    let t = 0, c = 0;
    const cumT: number[] = [], cumC: number[] = [];
    for (let i = 0; i <= n; i++) { t += total[i]; c += correct[i]; cumT.push(t); cumC.push(c); }
    return { n, cumT, cumC, max: Math.max(1, t) };
  }, [d]);

  const { n, cumT, cumC, max } = model;
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const x = (i: number) => M.left + (i / n) * PW;
  const y = (v: number) => M.top + PH - (v / yMax) * PH;

  // Cumulative counts only change at a buzz, so the honest mark is a step.
  const stepPath = (cum: number[]) => {
    let p = `M ${x(0)} ${y(cum[0])}`;
    for (let i = 1; i <= n; i++) p += ` L ${x(i)} ${y(cum[i - 1])} L ${x(i)} ${y(cum[i])}`;
    return p;
  };
  const areaPath = (cum: number[]) => `${stepPath(cum)} L ${x(n)} ${y(0)} L ${x(0)} ${y(0)} Z`;

  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += step) yTicks.push(v);
  const xStep = niceStep(n, 6);
  const xTicks: number[] = [];
  for (let v = 0; v <= n; v += xStep) xTicks.push(v);

  const avgIdx = d.avgBuzzPct === null ? null : (d.avgBuzzPct / 100) * d.words.length;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - M.left) / PW) * n);
    setHover(i >= 0 && i <= n ? i : null);
  };

  return (
    <figure className="buzzcurve">
      <figcaption>
        Cumulative buzzes as the question is read — the gap between the two is interrupted wrong buzzes.
      </figcaption>
      <svg
        ref={svg} viewBox={`0 0 ${W} ${H}`} className="buzzcurve-svg" role="img"
        aria-label={`Cumulative buzzes by word position: ${cumT[n]} in total, ${cumC[n]} correct`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + PW} y1={y(v)} y2={y(v)} className="bc-grid" />
            <text x={M.left - 8} y={y(v) + 4} className="bc-tick" textAnchor="end">{v}</text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text key={v} x={x(v)} y={M.top + PH + 20} className="bc-tick" textAnchor="middle">{v}</text>
        ))}

        <path d={areaPath(cumT)} fill={TOTAL} fillOpacity={0.22} />
        <path d={stepPath(cumT)} fill="none" stroke={TOTAL} strokeWidth={2} />
        {/* A 2px surface ring keeps the green edge legible where it rides on the grey fill. */}
        <path d={areaPath(cumC)} fill={CORRECT} fillOpacity={0.32} />
        <path d={stepPath(cumC)} fill="none" stroke="var(--surface)" strokeWidth={4} />
        <path d={stepPath(cumC)} fill="none" stroke={CORRECT} strokeWidth={2} />

        {avgIdx !== null && (
          <g>
            <line x1={x(avgIdx)} x2={x(avgIdx)} y1={M.top} y2={M.top + PH} stroke={AVG} strokeWidth={2} strokeDasharray="4 4" />
            <text x={x(avgIdx)} y={M.top - 3} className="bc-tick" textAnchor="middle" fill={AVG}>avg</text>
          </g>
        )}

        {/* Direct labels on the two end points rather than a number on every step. */}
        <text x={x(n) - 2} y={y(cumT[n]) - 6} className="bc-label" textAnchor="end">{cumT[n]} total</text>
        <text x={x(n) - 2} y={y(cumC[n]) + 14} className="bc-label" textAnchor="end">{cumC[n]} correct</text>

        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + PH} className="bc-crosshair" />
            <circle cx={x(hover)} cy={y(cumT[hover])} r={4} fill={TOTAL} stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(hover)} cy={y(cumC[hover])} r={4} fill={CORRECT} stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        <line x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH} className="bc-axis" />
      </svg>

      <div className="buzzcurve-foot">
        <span className="bc-legend"><i style={{ background: TOTAL }} /> Total</span>
        <span className="bc-legend"><i style={{ background: CORRECT }} /> Correct</span>
        <span className="bc-legend"><i className="bc-dash" style={{ background: AVG }} /> Average correct buzz</span>
        <span className="muted">
          {hover === null
            ? "Word position →"
            : `Word ${hover + 1}${hover < d.words.length ? ` “${d.words[hover]}”` : " (END)"} · ${cumT[hover]} buzzed, ${cumC[hover]} correct`}
        </span>
      </div>
    </figure>
  );
}
