/**
 * Build the standalone 100M comparison page served from this folder.
 *
 *   node build-compare.mjs
 *
 * Three runs, three roles:
 *   W1   — latest (9/1, w:1)           → headline numbers
 *   MAJ  — same spec, w:majority (8/31) → stall baseline
 *   OLD  — pre-upgrade (8/26–28)       → magnitude reference only (broken index)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "compare-8c32g.html");

const W1 = JSON.parse(readFileSync(join(HERE, "reports/l0-bench-2026-09-01T14-02-56-975Z.json"), "utf8"));
const MAJ = JSON.parse(readFileSync(join(HERE, "reports/l0-bench-2026-08-31T07-18-23-351Z.json"), "utf8"));
const OLD = JSON.parse(readFileSync(join(HERE, "reports/l0-bench-100M-FULL-merged.json"), "utf8"));

const RTT_MS = 37;

const STALL_WINDOWS_MAJ = [
  { from: "15:39:39", to: "15:40:39", qps: 0, docs: 67_821_000, kind: "Complete stall" },
  { from: "15:43:39", to: "15:44:39", qps: 4_900, docs: 76_822_000, kind: "Severe slowdown" },
  { from: "15:46:39", to: "15:47:39", qps: 0, docs: 81_119_000, kind: "Complete stall" },
  { from: "15:47:39", to: "15:48:39", qps: 11_150, docs: 81_788_000, kind: "End of stall" },
  { from: "15:55:39", to: "15:56:39", qps: 0, docs: 97_079_000, kind: "Complete stall" },
];

const FLOW_MAJ = { isLaggedCount: 3, isLaggedTimeMicros: 54_999_988 };

function curve(report, maxPoints = 200) {
  const w = report.write100m;
  const base = w.docs - w.insert.docs;
  const s = w.insert.samples ?? [];
  const step = Math.max(1, Math.ceil(s.length / maxPoints));
  const out = [];
  for (let i = 0; i < s.length; i += step) {
    const x = s[i];
    out.push({ pct: ((base + x.docs) / w.docs) * 100, qps: x.intervalDocsPerSec, tMin: x.tMs / 60000, docs: base + x.docs });
  }
  return out;
}

const w1Curve = curve(W1);
const majCurve = curve(MAJ);
const oldCurve = curve(OLD);

const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const srv = (ms) => Math.max(0.1, ms - RTT_MS);

const W = 1000, H = 340, PAD = { l: 78, r: 20, t: 22, b: 46 };
const PW = W - PAD.l - PAD.r, PH = H - PAD.t - PAD.b;

function lineChart({ series, yMax, yTicks, xLabel, yLabel, xMax = 100, logY = false }) {
  const ys = (v) => {
    if (!logY) return PAD.t + PH - (v / yMax) * PH;
    const lv = Math.log10(Math.max(v, 100));
    const l0 = Math.log10(100), l1 = Math.log10(yMax);
    return PAD.t + PH - ((lv - l0) / (l1 - l0)) * PH;
  };
  const xs = (v) => PAD.l + (v / xMax) * PW;
  let g = "";
  for (const t of yTicks) {
    const y = ys(t);
    g += `<line x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${PAD.l + PW}" y2="${y.toFixed(1)}" class="grid"/>`;
    g += `<text x="${PAD.l - 10}" y="${(y + 4).toFixed(1)}" class="ax" text-anchor="end">${fmt(t)}</text>`;
  }
  for (let p = 0; p <= xMax; p += xMax / 10) {
    const x = xs(p);
    g += `<line x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + PH}" class="grid"/>`;
    g += `<text x="${x.toFixed(1)}" y="${PAD.t + PH + 20}" class="ax" text-anchor="middle">${fmt(p)}</text>`;
  }
  let paths = "";
  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${xs(p.x).toFixed(1)},${ys(p.y).toFixed(1)}`).join("");
    paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 1.6 : 2.2}"${s.dash ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round"/>`;
    if (s.dots) for (const p of s.points) {
      paths += `<circle cx="${xs(p.x).toFixed(1)}" cy="${ys(p.y).toFixed(1)}" r="2.6" fill="${s.color}"><title>${s.name} — ${p.t}</title></circle>`;
    }
  }
  const legend = series.map((s, i) => `<g transform="translate(${PAD.l + 12 + i * 280},${PAD.t + 6})">
    <rect width="26" height="3.5" y="5" rx="1.7" fill="${s.color}"${s.dash ? ' opacity="0.75"' : ""}/>
    <text x="34" y="11" class="lg">${s.name}</text></g>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart"><rect x="${PAD.l}" y="${PAD.t}" width="${PW}" height="${PH}" class="plot"/>
    ${g}${paths}${legend}
    <text x="${PAD.l + PW / 2}" y="${H - 8}" class="axl" text-anchor="middle">${xLabel}</text>
    <text x="16" y="${PAD.t + PH / 2}" class="axl" text-anchor="middle" transform="rotate(-90 16 ${PAD.t + PH / 2})">${yLabel}</text></svg>`;
}

function barChart(rows, { unit = "", color = "#3b82f6" } = {}) {
  const max = Math.max(...rows.map((r) => r.value));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row">
    <div class="bar-lab">${r.label}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${((r.value / max) * 100).toFixed(1)}%;background:${r.color || color}"></div></div>
    <div class="bar-val">${fmt(r.value, r.decimals ?? 0)}${unit}</div></div>`).join("")}</div>`;
}

function stackedLatencyChart(rows) {
  const max = Math.max(...rows.map((r) => r.total));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row">
    <div class="bar-lab">${r.label}</div>
    <div class="bar-track"><div class="bar-stack">
      <div class="seg rtt" style="width:${((RTT_MS / max) * 100).toFixed(1)}%"></div>
      <div class="seg srv" style="width:${(((r.total - RTT_MS) / max) * 100).toFixed(1)}%;background:${r.color}"></div>
    </div></div>
    <div class="bar-val">${fmt(srv(r.total), 1)} ms</div></div>`).join("")}
    <div class="bar-row" style="margin-top:14px"><div class="bar-lab"></div>
    <div class="bar-track" style="border:none;background:none;height:auto">
      <span class="lgd"><i style="background:#374151"></i>Cross-region RTT ${RTT_MS} ms</span>
      <span class="lgd"><i style="background:#3b82f6"></i>Server time</span></div>
    <div class="bar-val" style="color:var(--fg3);font-size:12px">Right = server</div></div></div>`;
}

const qpsOverlay = lineChart({
  series: [
    { name: "w:1 (9/1, 32 min)", color: "#22c55e", dots: true,
      points: w1Curve.map((p) => ({ x: p.pct, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
    { name: "w:majority (8/31, 39 min)", color: "#f59e0b",
      points: majCurve.map((p) => ({ x: p.pct, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
    { name: "Before upgrade (broken index)", color: "#ef4444", dash: true,
      points: oldCurve.map((p) => ({ x: p.pct, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
  ],
  yMax: 100000, yTicks: [100, 1000, 10000, 100000], logY: true,
  xLabel: "Write progress (% of 100M docs)", yLabel: "Instantaneous throughput docs/s (log scale)",
});

const qpsW1Linear = lineChart({
  series: [
    { name: "w:1 — instantaneous throughput", color: "#22c55e", dots: true,
      points: w1Curve.map((p) => ({ x: p.tMin, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
    { name: "w:majority — instantaneous throughput", color: "#f59e0b",
      points: majCurve.map((p) => ({ x: p.tMin, y: p.qps, t: `${p.tMin.toFixed(0)}min · ${fmt(p.qps)}/s` })) },
  ],
  yMax: 90000, yTicks: [0, 20000, 40000, 60000, 80000], xMax: 40,
  xLabel: "Elapsed (minutes)", yLabel: "Instantaneous throughput docs/s",
});

const w1i = W1.write100m.insert, maji = MAJ.write100m.insert, odi = OLD.write100m.insert;
const w1s = w1i.stalls ?? {}, majs = { zeroWindows: 3, slowBatches: "?", longestBatchMs: maji.batchLatency.maxMs };

const QUERY_LABEL = {
  searchL0Fts: "BM25 keyword search (hit)",
  searchL0FtsEmpty: "BM25 keyword search (no hit)",
  sessionReplay: "Session replay (paged by session)",
  queryL0ForL1: "L1 aggregation fetch (by session_key)",
  paginated: "Tenant-level paged list",
  countL0: "Tenant-level count",
};
const queryRows = Object.entries(W1.query ?? {}).map(([name, q]) => ({ name, q }));

const latRow = (L, tag) => `<tr><td>${tag}</td>
  <td class="num">${fmt(L.p50Ms)}</td><td class="num">${fmt(L.p90Ms)}</td><td class="num">${fmt(L.p95Ms)}</td>
  <td class="num">${fmt(L.p99Ms)}</td><td class="num">${fmt(L.p999Ms ?? 0)}</td><td class="num ${L.maxMs > 10000 ? "down" : ""}">${fmt(L.maxMs)}</td></tr>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>MongoDB L0 100M-Document Benchmark Report</title>
<style>
  :root{--bg:#0b0f17;--card:#121826;--card2:#0e1420;--line:#1f2937;--fg:#e5e7eb;--fg2:#9aa4b2;--fg3:#6b7280;
    --green:#22c55e;--red:#ef4444;--blue:#3b82f6;--amber:#f59e0b;--purple:#a855f7}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1120px;margin:0 auto;padding:44px 26px 80px}
  h1{font-size:30px;margin:0 0 8px} h2{font-size:20px;margin:52px 0 16px;padding-bottom:10px;border-bottom:1px solid var(--line)}
  h3{font-size:15px;margin:26px 0 10px;color:var(--fg2);font-weight:600}
  p{margin:12px 0} .sub{color:var(--fg2);font-size:14px;margin-bottom:20px}
  code{background:#1b2333;padding:2px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
  .pills{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 26px}
  .pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 13px;font-size:13px;color:var(--fg2)}
  .pill.on{border-color:#166534;background:#0d2016;color:#86efac}
  .pill.warn{border-color:#78350f;background:#1f1508;color:#fcd34d}
  .verdict{background:linear-gradient(180deg,#101a12,#0d1410);border:1px solid #1c3b25;border-left:3px solid var(--green);
    border-radius:10px;padding:20px 24px;margin:24px 0} .verdict b{color:#86efac}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:18px 0}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px}
  .stat .k{font-size:12.5px;color:var(--fg3)} .stat .v{font-size:27px;font-weight:650;margin:6px 0 2px}
  .stat .d{font-size:12.5px;color:var(--fg2)} .up{color:var(--green)} .down{color:var(--red)} .neutral{color:var(--fg)}
  table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}
  th,td{text-align:right;padding:10px 12px;border-bottom:1px solid var(--line)}
  th:first-child,td:first-child{text-align:left}
  th{color:var(--fg3);font-weight:600;font-size:12.5px;border-bottom:1px solid #2a3444}
  tbody tr:hover{background:#0f1521} .num{font-family:ui-monospace,Menlo,monospace;font-size:13.5px}
  .chart{width:100%;height:auto;background:var(--card2);border:1px solid var(--line);border-radius:10px;margin:16px 0}
  .plot{fill:#0a0f18;stroke:none} .grid{stroke:#1c2432;stroke-width:1}
  .ax{fill:#6b7280;font-size:11px;font-family:ui-monospace,Menlo,monospace} .axl{fill:#9aa4b2;font-size:12.5px} .lg{fill:#c7d0dc;font-size:12.5px}
  .bars{margin:14px 0} .bar-row{display:grid;grid-template-columns:230px 1fr 120px;align-items:center;gap:14px;margin:9px 0}
  .bar-lab{font-size:13.5px;color:var(--fg2)} .bar-track{background:#0d1420;border-radius:5px;height:22px;overflow:hidden;border:1px solid var(--line)}
  .bar-fill{height:100%;border-radius:4px} .bar-stack{display:flex;height:100%} .seg{height:100%} .seg.rtt{background:#374151}
  .bar-val{text-align:right;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--fg)}
  .note{background:var(--card2);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:8px;padding:15px 19px;margin:18px 0;font-size:14px;color:var(--fg2)}
  .note b{color:#fcd34d} .note.info{border-left-color:var(--blue)} .note.info b{color:#93c5fd}
  .note.ok{border-left-color:var(--green)} .note.ok b{color:#86efac}
  ul{margin:12px 0;padding-left:22px} li{margin:7px 0}
  .foot{margin-top:60px;padding-top:22px;border-top:1px solid var(--line);color:var(--fg3);font-size:12.5px}
  .lgd{display:inline-flex;align-items:center;gap:7px;margin-right:22px;font-size:12.5px;color:var(--fg2)}
  .lgd i{width:14px;height:10px;border-radius:2px;display:inline-block}
</style>
</head>
<body><div class="wrap">

<h1>MongoDB L0 100M-Document Benchmark Report</h1>
<p class="sub">
  Instance <code>28.79.181.33:7026</code> · 8C32G500G · cross-region RTT ${RTT_MS}ms<br/>
  Latest: <code>l0_bench_w1_r1_s100m</code>(9/1, w:1) · Compared against: <code>l0_bench_8c32g_r3_s100m</code>(8/31, w:majority)<br/>
  Both runs use batch=1000 and concurrency=8; the only variable is write concern.
</p>

<div class="pills">
  <span class="pill on">100M docs × 2 rounds completed</span>
  <span class="pill on">w:1 — 0 stall · 32 min</span>
  <span class="pill on">BM25 READY</span>
  <span class="pill warn">w:majority — 3 complete stalls</span>
</div>

<div class="verdict">
  <p><b>Conclusion: after switching to w:1, WriteStall is eliminated entirely. 100M docs were written in 32 minutes with 0 errors and a longest batch of 1.2 s.</b></p>
  <p style="color:var(--fg2)">
    The w:majority round (8/31) averaged ${fmt(maji.docsPerSec)} docs/s, with 3 complete stalls and a longest batch of ${fmt(maji.batchLatency.maxMs / 1000, 1)} s.
    The root cause is replication lag triggering flow-control throttling (<code>isLaggedCount=3</code>).
    After switching to w:1 (9/1), it averaged ${fmt(w1i.docsPerSec)} docs/s with <b>0 zero-throughput windows</b> and a longest batch of ${fmt(w1i.batchLatency.maxMs / 1000, 1)} s.
    Query performance is unaffected by write concern, so only the w:1 round is listed; all latencies have the ${RTT_MS}ms RTT subtracted to give server time.
  </p>
</div>

<h2>1. Write comparison: w:1 vs w:majority</h2>

<div class="grid2">
  <div class="stat"><div class="k">w:1 total time</div><div class="v up">${(w1i.wallMs / 60000).toFixed(1)} min</div>
    <div class="d">w:majority ${(maji.wallMs / 60000).toFixed(1)} min</div></div>
  <div class="stat"><div class="k">w:1 average throughput</div><div class="v up">${fmt(w1i.docsPerSec)} docs/s</div>
    <div class="d">w:majority ${fmt(maji.docsPerSec)} docs/s</div></div>
  <div class="stat"><div class="k">w:1 zero-throughput windows</div><div class="v up">${w1s.zeroWindows ?? 0}</div>
    <div class="d">w:majority ${majs.zeroWindows}</div></div>
  <div class="stat"><div class="k">w:1 longest batch</div><div class="v up">${fmt(w1i.batchLatency.maxMs / 1000, 1)} s</div>
    <div class="d">w:majority ${fmt(maji.batchLatency.maxMs / 1000, 1)} s</div></div>
</div>

<table>
  <thead><tr><th>Metric</th><th>w:1 (9/1)</th><th>w:majority (8/31)</th><th>Before upgrade (reference)</th></tr></thead>
  <tbody>
    <tr><td>Write concern</td><td class="num up">w:1</td><td class="num">w:majority</td><td class="num">w:majority</td></tr>
    <tr><td>Total time</td><td class="num up">${(w1i.wallMs / 60000).toFixed(1)} min</td><td class="num">${(maji.wallMs / 60000).toFixed(1)} min</td><td class="num">${(odi.wallMs / 3600000).toFixed(1)} h</td></tr>
    <tr><td>Average throughput</td><td class="num up">${fmt(w1i.docsPerSec)} /s</td><td class="num">${fmt(maji.docsPerSec)} /s</td><td class="num">${fmt(odi.docsPerSec)} /s</td></tr>
    <tr><td>Peak throughput</td><td class="num">${fmt(Math.max(...w1Curve.map((p) => p.qps)))} /s</td><td class="num">${fmt(Math.max(...majCurve.map((p) => p.qps)))} /s</td><td class="num">${fmt(Math.max(...oldCurve.map((p) => p.qps)))} /s</td></tr>
    <tr><td>Zero-throughput windows</td><td class="num up">${w1s.zeroWindows ?? 0}</td><td class="num down">${majs.zeroWindows}</td><td class="num">—</td></tr>
    <tr><td>Slow batches (>5s)</td><td class="num up">${w1s.slowBatches ?? 0}</td><td class="num down">Yes</td><td class="num">—</td></tr>
    <tr><td>Write errors</td><td class="num">${w1i.errors}</td><td class="num">${maji.errors}</td><td class="num">${odi.errors}</td></tr>
    <tr><td>BM25 index</td><td class="num up">READY</td><td class="num up">READY</td><td class="num down">Build failed</td></tr>
  </tbody>
</table>

<h3>Batch latency percentiles (batch=1000)</h3>
<table>
  <thead><tr><th>Run</th><th>p50</th><th>p90</th><th>p95</th><th>p99</th><th>p999</th><th>max</th></tr></thead>
  <tbody>
    ${latRow(w1i.batchLatency, "w:1 (9/1)")}
    ${latRow(maji.batchLatency, "w:majority (8/31)")}
  </tbody>
</table>
<p style="color:var(--fg2);font-size:13.5px">
  The w:majority p99 (${fmt(maji.batchLatency.p99Ms)}ms) looks better than w:1 (${fmt(w1i.batchLatency.p99Ms)}ms),
  but max reaches ${fmt(maji.batchLatency.maxMs / 1000, 0)} s. The extreme tail is "flattened" by the majority wait; the real problems are max and the zero-throughput windows.
  The w:1 p999 is only ${fmt(w1i.batchLatency.p999Ms)}ms, a clean distribution.
</p>

<h2>2. QPS curves</h2>
<p>The x-axis is write progress in percent. w:1 (green) declines smoothly throughout; w:majority (orange) drops to zero three times.</p>
${qpsOverlay}

<h3>By actual minutes (linear axis)</h3>
${qpsW1Linear}

<h3>w:1 average throughput by phase</h3>
${barChart([25, 50, 75, 100].map((hi, i) => {
  const lo = [0, 25, 50, 75][i];
  const seg = w1Curve.filter((p) => p.pct > lo && p.pct <= hi);
  return { label: `${lo}–${hi}%`, value: Math.round(seg.reduce((a, b) => a + b.qps, 0) / Math.max(1, seg.length)), color: ["#22c55e", "#4ade80", "#86efac", "#bbf7d0"][i] };
}), { unit: " docs/s" })}

<h2>3. WriteStall analysis for w:majority</h2>

<div class="note ok">
  <p style="margin:0"><b>w:1 is verified to eliminate this problem.</b> The analysis below covers the w:majority round to explain the root cause; zero-throughput windows in the w:1 round = ${w1s.zeroWindows ?? 0}。</p>
</div>

<h3>Exact time windows (2026-08-31, w:majority round)</h3>
<table>
  <thead><tr><th>Window</th><th>Instantaneous throughput</th><th>Cumulative docs</th><th>Verdict</th></tr></thead>
  <tbody>${STALL_WINDOWS_MAJ.map((s) => `<tr>
    <td class="num">${s.from} → ${s.to}</td>
    <td class="num ${s.qps === 0 ? "down" : ""}">${fmt(s.qps)} /s</td>
    <td class="num">${fmt(s.docs)}</td><td>${s.kind}</td></tr>`).join("")}
  </tbody>
</table>

<h3>Evidence: flow control triggered ${FLOW_MAJ.isLaggedCount} times</h3>
<p>On the PRIMARY, <code>serverStatus().flowControl.isLaggedCount = ${FLOW_MAJ.isLaggedCount}</code>, which matches the 3 complete stalls.
<code>w:1</code> does not wait for secondary acknowledgement, bypassing this throttling path.</p>

<h2>4. Query performance (w:1 round, 100M docs)</h2>
<div class="note info"><p style="margin:0">No comparison with the pre-upgrade run (index was broken). 200 serial requests on a single connection; latencies have the ${RTT_MS}ms RTT subtracted to give server time.</p></div>
<table>
  <thead><tr><th>Query</th><th>Measured p50</th><th>Server</th><th>Measured QPS</th><th>Same-DC theoretical QPS</th><th>Rows</th></tr></thead>
  <tbody>${queryRows.map(({ name, q }) => {
    const s = srv(q.latency.p50Ms);
    return `<tr><td>${QUERY_LABEL[name] ?? name}</td>
      <td class="num">${fmt(q.latency.p50Ms, 1)} ms</td><td class="num up">${fmt(s, 1)} ms</td>
      <td class="num">${fmt(q.qps, 1)}</td><td class="num up">${fmt(1000 / s, 0)}</td><td class="num">${fmt(q.lastHits)}</td></tr>`;
  }).join("")}
</tbody></table>
<h3>Latency breakdown</h3>
${stackedLatencyChart(queryRows.map(({ name, q }) => ({ label: QUERY_LABEL[name] ?? name, total: q.latency.p50Ms, color: name.startsWith("search") ? "#a855f7" : "#3b82f6" })))}

<h2>5. Conclusions</h2>
<ul>
  <li><b>w:1 verified.</b> 100M docs in 32 min, ${fmt(w1i.docsPerSec)} docs/s, 0 errors, 0 stalls, BM25 READY.</li>
  <li><b>The root cause of w:majority stalls is replication lag.</b> 3 flow-control triggers = 3 complete stalls; switching to w:1 eliminates the problem.</li>
  <li><b>The query bottleneck is the network.</b> After subtracting RTT, most queries take &lt;10ms on the server; running in the same DC or raising concurrency would help substantially.</li>
  <li><b>Production advice.</b> w:1 gives up cross-node durability guarantees; if the workload needs majority safety, throttle the write rate or improve secondary replication capacity.</li>
</ul>

<div class="foot">
  Report generated at ${new Date().toLocaleString("en-US")} ·
  w:1 data <code>l0-bench-2026-09-01T14-02-56-975Z.json</code> ·
  w:majority data <code>l0-bench-2026-08-31T07-18-23-351Z.json</code> ·
  Regenerate: <code>node build-compare.mjs</code>
</div>
</div></body></html>`;

writeFileSync(OUT, html);
console.log(`✓ ${OUT}`);
console.log(`  w:1  ${fmt(w1i.docsPerSec)}/s  stall=${w1s.zeroWindows ?? 0}  max=${fmt(w1i.batchLatency.maxMs)}ms`);
console.log(`  maj  ${fmt(maji.docsPerSec)}/s  stall=${majs.zeroWindows}  max=${fmt(maji.batchLatency.maxMs)}ms`);
