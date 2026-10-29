// Builds framework.html: the task 2.3 submission (framework document, architecture,
// workflow, modules, interfaces, data flow, technology stack) from design.html.
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('design.html', 'utf8');
const head = src.slice(0, src.indexOf('<body>'));
const script = src.slice(src.indexOf('<script src="node_modules/mermaid'), src.indexOf('</body>'));
const sections = src.match(/<section class="section">[\s\S]*?<\/section>/g);

// 1. Sections to include, in order, matched by heading text or diagram id.
const want = [
  (s) => s.includes('<h1>2. Objectives</h1>'),
  (s) => s.includes('<h1>3. Scope and limitations</h1>'),
  (s) => s.includes('<h1>4. Conceptual framework</h1>'),
  (s) => s.includes('<h1>5. System architecture</h1>'),
  (s) => s.includes('5.1 Modules</h2>'),
  (s) => s.includes('5.2 Interfaces</h2>'),
  (s) => s.includes('5.3 Data flow</h2>'),
  (s) => /id="d-(online-a|online|walkin|arrival|block|catalog|accounts)"/.test(s),
  (s) => s.includes('<h1>15. Technology and environment</h1>'),
  (s) => s.includes('15.2 Hardware and network</h2>'),
];
const pick = sections.filter((s) => want.some((f) => f(s)));

// 2. Renumber chapters for this document: old -> new.
const map = { 2: 1, 3: 2, 4: 3, 5: 4, 8: 5, 15: 6 };
let body = pick.join('\n')
  .replace(/(<h1[^>]*>)(\d+)\. /g, (m, h, n) => `${h}${map[n] ?? n}. `)
  .replace(/(<h2[^>]*>)(\d+)\.(\d+) /g, (m, h, n, k) => `${h}${map[n] ?? n}.${k} `)
  .replace('<h1>5. Flowcharts</h1>', '<h1>5. Workflow (flowcharts)</h1>')
  .replace(' (see §12.3)', '');

// 3. Renumber figures sequentially in reading order.
let fig = 0;
const seen = new Map();
body = body.replace(/Figure (\d+[ab]?)\./g, (m, label) => {
  if (!seen.has(label)) seen.set(label, ++fig);
  return `Figure ${seen.get(label)}.`;
});

// 4. First page: title, problem summary and a checklist of what task 2.3 asks for.
const first = `<section>
<div style="background:#307082;color:#fff;padding:8mm 9mm;border-radius:3mm">
  <div style="font-size:9pt;letter-spacing:.4mm;text-transform:uppercase;color:#d6e6ea">Parallel and Distributed System · Task 2.3 submission</div>
  <div style="font-size:21pt;font-weight:700;margin:2mm 0 1mm">Initial System Framework</div>
  <div style="font-size:13pt;color:#e8f1f3">Biliran Resort &amp; Tour Booking System</div>
</div>
<div style="height:2.5mm;background:#EA9940;border-radius:1mm;margin:1.5mm 0 5mm"></div>
<table>
  <tr><td style="width:32%;color:#5B6B75">Instructor</td><td>Engr. Eunel O. Peñaranda</td></tr>
  <tr><td style="color:#5B6B75">Team</td><td>Member A — central node &amp; integration · Member B — island node · Member C — mobile app · Member D — consoles, reports &amp; testing</td></tr>
  <tr><td style="color:#5B6B75">Date</td><td>30 October 2026 · Design v2 (includes adviser revisions)</td></tr>
  <tr><td style="color:#5B6B75">Repository</td><td>github.com/Abylon10/BookingSystem</td></tr>
</table>
<h2>Problem in brief</h2>
<p>Resorts and tour operators on Biliran's islands sell the same rooms, tour seats and boat trips to online travellers and to walk-in guests at the front desk, so the last unit can be sold twice; and island links to the mainland are unreliable, so a central-only system would stop the desk. The system gives every island its own node that owns its inventory, connects the nodes to a central node by gRPC, searches and reports in parallel, and keeps each island working offline.</p>
<h2>Contents of this submission (as required by task 2.3)</h2>
<table>
  <thead><tr><th style="width:42%">Required item</th><th>Where</th></tr></thead>
  <tbody>
    <tr><td>Framework document</td><td>§1 Objectives · §2 Scope and limitations · §3 Conceptual framework (IPO)</td></tr>
    <tr><td>Architecture diagram</td><td>§4 System architecture (Figure 1)</td></tr>
    <tr><td>Workflow</td><td>§5 Flowcharts: online booking, walk-in, arrival confirmation, mark unavailable, catalog change, registration and accounts</td></tr>
    <tr><td>Module list</td><td>§4.1 Modules (M1–M11 with owners) · §4.2 Interfaces · §4.3 Data flow</td></tr>
    <tr><td>Technology stack</td><td>§6 Technology and environment</td></tr>
    <tr><td>Short review slides</td><td>§7 — 11 slides at the end of this file</td></tr>
  </tbody>
</table>
<p class="small muted">Full design (data model, concurrency analysis, requirements, risks, plan): docs/System-Design-and-Initial-Considerations.pdf in the repository.</p>
</section>`;

// 5. Divider before the appended slides.
const divider = `<section class="section"><div style="height:240mm;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center">
  <div style="font-size:11pt;letter-spacing:.4mm;text-transform:uppercase;color:#5B6B75">Section 7</div>
  <h1 style="border:none;font-size:26pt;margin:3mm 0">Short review slides</h1>
  <div style="height:2.5mm;width:60mm;background:#EA9940;border-radius:1mm;margin:2mm 0 5mm"></div>
  <p class="muted">11 slides follow (16:9 pages)</p></div></section>`;

const fixedScript = script.replace('const el = document.getElementById(id);', 'const el = document.getElementById(id);\n    if (!el) continue;');
const html = head
  .replace(/<title>[^<]*<\/title>/, '<title>Initial System Framework — Biliran Resort &amp; Tour Booking System</title>')
  .replace('Biliran Resort & Tour Booking System — Design v2', 'Initial System Framework — Biliran Resort & Tour Booking System')
  + '<body>\n' + first + '\n' + body + '\n' + divider + '\n' + fixedScript + '</body>\n</html>\n';
writeFileSync('framework.html', html);
console.log('sections:', pick.length, 'figures:', fig);
