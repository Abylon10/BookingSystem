/**
 * central/dashboard/app.js
 *
 * Central admin dashboard. After sign-in, the sidebar switches between pages
 * (address #dashboard, #islands, #bookings, #inventory, #accounts).
 * Only the page on screen loads its data, and it refreshes every 10 s.
 *   Dashboard : GET /api/admin/summary + records + accounts (summaries)
 *   Islands   : summary (nodes, charts) + GET/POST /api/admin/islands (register)
 *   Bookings  : GET /api/admin/bookings?island&status&q
 *   Inventory : GET /api/admin/records?from&to (revenue, walk-in vs online,
 *               package/service usage) + reports (7-day trend, benchmark)
 *   Accounts  : GET/POST /api/admin/accounts
 * The sun/moon button switches day and night (saved in this browser).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH')}`;
const ISLAND_COLORS = { biliran: '#6CA3A2', maripipi: '#EA9940', higatangan: '#4fbf8f' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDay = (d) => new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' });

// "3 min ago" style relative time.
function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------------------------------------------------------------------------
// Icons: small stroke icons injected into every <i data-icon="...">
// ---------------------------------------------------------------------------

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  island: '<path d="M3 18c3-2 6-2 9 0s6 2 9 0"/><path d="M7 15l3-6 3 3 2-3 3 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  pulse: '<path d="M3 12h4l3 7 4-14 3 7h4"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 0 0-4V5H3z"/><path d="M13 5v14" stroke-dasharray="2 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v12"/>',
  pie: '<path d="M12 3v9h9"/><circle cx="12" cy="12" r="9"/>',
  bars: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 13l4-4"/>',
  boxes: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.6 2.6 3 5.2"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M9 21l3-7 3 3v4M8 11l3-3 3 2 3 1"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
};
function paintIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]:not([data-done])')) {
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[el.dataset.icon] ?? ''}</svg>`;
    el.dataset.done = '1';
  }
}

// ---------------------------------------------------------------------------
// Session: token kept in this browser only
// ---------------------------------------------------------------------------

let token = null;
try { token = localStorage.getItem('central-token'); } catch { /* storage blocked */ }

function saveToken(t) {
  token = t;
  try { t ? localStorage.setItem('central-token', t) : localStorage.removeItem('central-token'); } catch { /* ignore */ }
}

// Calls an admin endpoint (GET, or POST with a body); 401 shows the login.
async function admin(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function showLogin(message = '') {
  $('login').classList.remove('hidden');
  $('login-error').textContent = message;
  $('password').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const res = await fetch('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('password').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('login-error').textContent = data.error ?? 'Sign-in failed'; return; }
  saveToken(data.token);
  $('password').value = '';
  $('login').classList.add('hidden');
  refresh();
});
$('logout').addEventListener('click', () => { saveToken(null); showLogin(); });

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const PAGES = ['dashboard', 'islands', 'bookings', 'inventory', 'accounts'];
// Old #reports links open the merged Inventory & reports page.
const page = () => { const h = location.hash.slice(1); return h === 'reports' ? 'inventory' : PAGES.includes(h) ? h : 'dashboard'; };

// Shows the page named in the address and loads its data.
function showPage() {
  const p = page();
  for (const name of PAGES) $(`page-${name}`).classList.toggle('hidden', name !== p);
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === p));
  window.scrollTo(0, 0);
  refresh();
}
window.addEventListener('hashchange', showPage);

// ---------------------------------------------------------------------------
// Charts (Chart.js), created once and updated on every refresh
// ---------------------------------------------------------------------------

const charts = {};
const trendChart = (el) => new Chart(el, {
  type: 'line',
  data: { labels: [], datasets: [
    { label: 'Online', data: [], borderColor: '#6CA3A2', backgroundColor: 'rgba(108,163,162,.15)', fill: true, tension: .35, pointRadius: 3 },
    { label: 'Walk-in', data: [], borderColor: '#EA9940', backgroundColor: 'rgba(234,153,64,.1)', fill: true, tension: .35, pointRadius: 3 },
  ] },
  options: { maintainAspectRatio: false, plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10 } } },
    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
});
if (window.Chart) {
  Chart.defaults.color = '#93a8b3';
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  Chart.defaults.borderColor = 'rgba(108,163,162,.15)';
  charts.island = new Chart($('c-island'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 0 }] },
    options: { cutout: '68%', maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  charts.trend = trendChart($('c-trend'));
  charts.trendMini = trendChart($('c-trend-mini'));
  charts.listing = new Chart($('c-listing'), {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Bookings', data: [], backgroundColor: [], borderRadius: 8, maxBarThickness: 46 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { autoSkip: false, maxRotation: 0 } } } },
  });
  // Revenue per island, walk-in vs online (stacked bars).
  charts.revIsland = new Chart($('c-rev-island'), {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Online', data: [], backgroundColor: '#6CA3A2', borderRadius: 6, maxBarThickness: 46 },
      { label: 'Walk-in', data: [], backgroundColor: '#EA9940', borderRadius: 6, maxBarThickness: 46 },
    ] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10 } } },
      scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => peso(v) } } } },
  });
  // Revenue per trip day, all islands, walk-in vs online.
  charts.revDay = new Chart($('c-rev-day'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'Online', data: [], borderColor: '#6CA3A2', backgroundColor: 'rgba(108,163,162,.15)', fill: true, tension: .3, pointRadius: 2 },
      { label: 'Walk-in', data: [], borderColor: '#EA9940', backgroundColor: 'rgba(234,153,64,.1)', fill: true, tension: .3, pointRadius: 2 },
    ] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10 } } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => peso(v) } } } },
  });
  charts.bench = new Chart($('c-bench'), {
    type: 'bar',
    data: { labels: [], datasets: [
      { type: 'bar', label: 'Measured speedup', data: [], backgroundColor: '#6CA3A2', borderRadius: 8, maxBarThickness: 54 },
      { type: 'line', label: 'Ideal (= threads)', data: [], borderColor: '#EA9940', borderDash: [6, 4], pointRadius: 3, fill: false },
    ] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10 } } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'speedup ×' } } } },
  });
}
function setTrend(chart, daily) {
  if (!chart) return;
  chart.data.labels = daily.map((d) => fmtDay(d.day));
  chart.data.datasets[0].data = daily.map((d) => d.online);
  chart.data.datasets[1].data = daily.map((d) => d.walkin);
  chart.update('none');
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

// Ticker across the top (every page).
function renderTicker(s) {
  const k = s.kpis;
  const linked = s.islands.filter((i) => i.status === 'online');
  $('ticker').innerHTML = [
    `<span>Islands online <b>${k.islandsOnline}/${k.islandsTotal}</b><em class="pill ${k.islandsOnline === k.islandsTotal ? 'ok' : k.islandsOnline ? 'warn' : 'bad'}">${linked.map((i) => cap(i.id)).join(', ') || 'none'}</em></span>`,
    `<span>Database <b>${s.supabase ? 'connected' : 'not configured'}</b></span>`,
    `<span>Last sync <b>${ago(s.lastSyncAt)}</b></span>`,
    `<span>Search across islands <b>${s.fanoutMs} ms</b></span>`,
  ].join('');
}

// Island status cards (Dashboard and Islands pages).
function islandCards(islands) {
  return islands.map((i) => {
    const on = i.status === 'online';
    const how = on ? ({ link: 'Cloud link', poll: 'Cloud (HTTPS polling)', grpc: 'LAN (gRPC)' }[i.via] ?? i.via) : esc((i.error ?? 'unreachable').slice(0, 60));
    return `<div class="island-card">
      <span class="dot ${on ? 'on' : 'off'}"></span>
      <div><b>${esc(i.name ?? i.id)}</b><div class="meta">${on ? 'Online' : 'Offline'} · ${how}</div></div>
      <div class="ms">${on ? `${i.ms}<small>ms</small>` : '<small>—</small>'}</div></div>`;
  }).join('');
}

// Why an island can't answer account requests: offline, or linked but
// running an older version (needs git pull + restart on its laptop).
const notReady = (i) => (i.outdated
  ? '<em class="warn-text">linked, but running an older version: git pull, npm install and restart it</em>'
  : 'offline: accounts can be managed when it reconnects');

// Utilisation bar row.
const utilRow = (label, pct, note = '') => `<div class="util"><div class="util-top"><b>${esc(label)}</b><span>${pct}%</span></div>
  <div class="util-bar"><i style="width:${Math.min(100, pct)}%"></i></div>${note ? `<small>${note}</small>` : ''}</div>`;

// ---------------------------------------------------------------------------
// Page: Dashboard (summary of the other pages)
// ---------------------------------------------------------------------------

async function loadDashboard() {
  const [s, inv, acc] = await Promise.all([
    admin('/api/admin/summary'),
    admin(`/api/admin/records?to=${addDays(todayStr(), 30)}&from=${addDays(todayStr(), -29)}`).catch(() => null),
    admin('/api/admin/accounts').catch(() => null),
  ]);
  renderTicker(s);
  const k = s.kpis;
  $('k-islands').textContent = `${k.islandsOnline} / ${k.islandsTotal}`;
  $('k-islands-sub').textContent = k.islandsOnline === k.islandsTotal ? 'All island nodes reachable' : 'Some islands offline';
  $('k-bookings').textContent = k.bookingsToday;
  $('k-bookings-sub').textContent = `${k.onlineToday} online · ${k.walkinToday} walk-in`;
  $('k-checkins').textContent = k.checkedInToday;
  $('k-revenue').textContent = peso(k.revenueTodayPhp ?? 0);
  $('k-revenue-sub').textContent = `all bookings ${peso(k.revenuePhp)} · refunds ${peso(s.refundsPhp)}`;
  $('sum-islands').innerHTML = islandCards(s.islands);

  // Revenue summary per island (last 30 days), bar = share of the total.
  if (inv) {
    const all = Math.max(1, inv.islands.reduce((n, i) => n + i.revenue, 0));
    $('sum-inventory').innerHTML = inv.islands.map((i) => `<div class="util"><div class="util-top"><b>${esc(i.name)}</b><span>${peso(i.revenue)}</span></div>
      <div class="util-bar"><i style="width:${Math.round((i.revenue / all) * 100)}%"></i></div>
      <small>${i.online.bookings} online · ${i.walkin.bookings} walk-in${i.live ? '' : ' · from central copy'}</small></div>`).join('');
  } else $('sum-inventory').innerHTML = '<p class="empty">Records not available.</p>';

  // Accounts summary: admins and receptionists per island.
  $('sum-accounts').innerHTML = acc
    ? acc.islands.map((i) => {
      const admins = i.staff.filter((u) => u.role === 'node_admin').length;
      const desk = i.staff.filter((u) => u.role === 'receptionist').length;
      return `<div class="acc-sum"><span class="dot ${i.online ? 'on' : 'off'}"></span><b>${esc(i.name)}</b>
        <span>${i.online ? `${admins} admin · ${desk} receptionist${desk === 1 ? '' : 's'}${admins ? '' : ' · <em class="warn-text">needs an admin</em>'}` : i.outdated ? '<em class="warn-text">needs an update (git pull)</em>' : 'offline'}</span></div>`;
    }).join('')
    : '<p class="empty">Accounts not available.</p>';

  // Activity feed and arrivals.
  const feedIcon = { WALKIN_BOOKED: ['f-walkin', 'walk'], ONLINE_BOOKED: ['f-online', 'phone'], REDEEMED: ['f-checkin', 'check'], CANCELLED: ['f-cancel', 'x'] };
  $('feed').innerHTML = s.activity.slice(0, 7).map((a) => {
    const [cls, icon] = feedIcon[a.kind] ?? ['f-online', 'pulse'];
    const [title, ...rest] = a.text.split(' · ');
    const detail = [rest.join(' · '), cap(a.island)].filter(Boolean).join(' · ');
    return `<li><span class="ficon ${cls}"><i data-icon="${icon}"></i></span>
      <div><b>${esc(title)}</b><small>${esc(detail)}</small></div><time>${ago(a.at)}</time></li>`;
  }).join('') || '<li class="empty">No activity yet.</li>';
  $('arrival-list').innerHTML = s.arrivals.map((a) => {
    const d = new Date(`${a.day}T00:00:00`);
    return `<li><div class="cal"><b>${d.getDate()}</b><small>${d.toLocaleString('en', { month: 'short' })}</small></div>
      <div><div class="who">${esc(a.guest)}</div><div class="what">${esc(a.listing)} · ${a.qty} · ${esc(a.code)}</div></div></li>`;
  }).join('') || '<li class="empty">No upcoming arrivals</li>';
  setTrend(charts.trendMini, s.daily);
}

// ---------------------------------------------------------------------------
// Page: Islands
// ---------------------------------------------------------------------------

async function loadIslands() {
  const [s, reg] = await Promise.all([admin('/api/admin/summary'), admin('/api/admin/islands')]);
  // All islands (built-in and registered) with their link state.
  $('isl-list').innerHTML = reg.islands.map((i) => `<tr><td><b>${esc(i.name)}</b></td><td>${esc(i.id)}</td><td>${esc(i.prefix)}</td>
    <td>${i.builtIn ? '<span class="tag on">Built-in</span>' : '<span class="tag walk">Registered</span>'}</td>
    <td><span class="dot ${i.linked ? 'on' : 'off'}" style="display:inline-block"></span> ${i.linked ? 'Linked' : 'Not linked'}</td></tr>`).join('');
  fillIslandSelect(reg.islands);
  renderTicker(s);
  $('island-cards').innerHTML = islandCards(s.islands);
  $('islands-note').textContent = `checked ${new Date(s.generatedAt).toLocaleTimeString()}`;
  const ids = Object.keys(s.byIsland);
  const totals = ids.map((id) => s.byIsland[id].online + s.byIsland[id].walkin);
  $('donut-total').textContent = totals.reduce((a, b) => a + b, 0);
  if (charts.island) {
    charts.island.data.labels = ids.map(cap);
    charts.island.data.datasets[0].data = totals;
    charts.island.data.datasets[0].backgroundColor = ids.map((id) => ISLAND_COLORS[id] ?? '#307082');
    charts.island.update('none');
  }
  $('island-legend').innerHTML = ids.map((id, n) => `<li><span><i style="background:${ISLAND_COLORS[id] ?? '#307082'}"></i>${esc(id)}</span>
    <span>${s.byIsland[id].online} online · ${s.byIsland[id].walkin} walk-in · <b>${totals[n]}</b></span></li>`).join('')
    || '<li class="empty">No bookings yet</li>';
  if (charts.listing) {
    charts.listing.data.labels = s.byListing.map((l) => (l.name.length > 22 ? `${l.name.slice(0, 21)}…` : l.name));
    charts.listing.data.datasets[0].data = s.byListing.map((l) => l.count);
    charts.listing.data.datasets[0].backgroundColor = s.byListing.map((l) => ISLAND_COLORS[l.id.split('-')[0]] ?? '#307082');
    charts.listing.update('none');
  }
}

// Speed test: sequential vs parallel island search, from the browser.
$('a-speed').addEventListener('click', async () => {
  const out = $('speed-result');
  out.textContent = 'Running 5 sequential + 5 parallel searches…';
  const avg = async (mode) => {
    let total = 0;
    for (let n = 0; n < 5; n++) total += (await (await fetch(`/api/packages?mode=${mode}`)).json()).fanoutMs;
    return Math.round(total / 5);
  };
  const seq = await avg('sequential');
  const par = await avg('parallel');
  out.innerHTML = `Sequential <b>${seq} ms</b> · Parallel <b>${par} ms</b> · Speedup <b>${(seq / Math.max(par, 1)).toFixed(2)}×</b>`;
});

// ---------------------------------------------------------------------------
// Page: Bookings
// ---------------------------------------------------------------------------

async function loadBookings() {
  const q = new URLSearchParams({ q: $('bk-q').value.trim(), island: $('bk-island').value, status: $('bk-status').value });
  const { bookings } = await admin(`/api/admin/bookings?${q}`);
  $('bk-count').textContent = `${bookings.length} booking(s)`;
  $('bk-list').innerHTML = bookings.map((b) => `<tr>
    <td class="ref">${esc(b.reference)}</td><td>${esc(cap(b.island_id))}</td>
    <td><span class="tag ${b.source === 'ONLINE' ? 'on' : 'walk'}">${b.source === 'ONLINE' ? 'Online' : 'Walk-in'}</span></td>
    <td>${esc(b.package_name)}${b.extra_days ? `<small> · +${b.extra_days} day(s)</small>` : ''}</td>
    <td>${fmtDay(b.day)}${b.end_day && b.end_day !== b.day ? ` – ${fmtDay(b.end_day)}` : ''}</td>
    <td>${b.guests}</td><td>${esc(b.guest_name)}</td><td>${peso(b.total_php)}</td><td>${b.refund_php ? peso(b.refund_php) : '—'}</td>
    <td><span class="status s-${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></td></tr>`).join('')
    || '<tr><td colspan="10" class="empty">No bookings match.</td></tr>';
}
$('bk-filter').addEventListener('submit', (e) => { e.preventDefault(); loadBookings(); });

// ---------------------------------------------------------------------------
// Page: Inventory & reports (records per island)
// ---------------------------------------------------------------------------

// YYYY-MM-DD + n days (local dates).
function addDays(day, n) { const d = new Date(`${day}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

// Walk-in vs online split bar.
const splitBar = (online, walkin) => {
  const all = Math.max(1, online + walkin);
  return `<div class="split"><i class="s-on" style="width:${(online / all) * 100}%"></i><i class="s-walk" style="width:${(walkin / all) * 100}%"></i></div>`;
};

async function loadInventory() {
  const [r, s] = await Promise.all([
    admin(`/api/admin/records?from=${$('rec-from').value}&to=${$('rec-to').value}`),
    admin('/api/admin/summary'),
  ]);
  renderTicker(s);
  setTrend(charts.trend, s.daily);
  const sum = (f) => r.islands.reduce((n, i) => n + f(i), 0);

  // Totals across all islands.
  $('r-revenue').textContent = peso(sum((i) => i.revenue));
  $('r-net').textContent = `net ${peso(sum((i) => i.net))} incl. ${peso(sum((i) => i.kept))} kept from cancellations`;
  $('r-online').textContent = sum((i) => i.online.bookings);
  $('r-online-sub').textContent = `${peso(sum((i) => i.online.revenue))} · ${sum((i) => i.online.guests)} guests`;
  $('r-walkin').textContent = sum((i) => i.walkin.bookings);
  $('r-walkin-sub').textContent = `${peso(sum((i) => i.walkin.revenue))} · ${sum((i) => i.walkin.guests)} guests`;
  $('r-refunds').textContent = peso(sum((i) => i.refunds));
  $('r-refunds-sub').textContent = `${sum((i) => i.cancelled)} cancellation(s)`;

  // One card per island: money and the walk-in / online split.
  $('rec-islands').innerHTML = r.islands.map((i) => `
    <div class="panel glass inv-card" style="--c:${ISLAND_COLORS[i.id] ?? '#307082'}">
      <div class="inv-head"><b>${esc(i.name)}</b>
        <span class="pill ${i.live ? 'ok' : 'bad'}">${i.live ? 'Live' : 'Offline · central copy'}</span></div>
      <div class="inv-big"><b>${peso(i.revenue)}</b><span>revenue<br>net ${peso(i.net)}</span></div>
      ${splitBar(i.online.revenue, i.walkin.revenue)}
      <div class="split-legend"><span><i class="s-on"></i>Online ${i.online.bookings} · ${peso(i.online.revenue)}</span><span><i class="s-walk"></i>Walk-in ${i.walkin.bookings} · ${peso(i.walkin.revenue)}</span></div>
      <dl class="stats">
        <div><dt>Paid bookings</dt><dd>${i.bookings}</dd></div>
        <div><dt>Checked in</dt><dd>${i.checkedIn}</dd></div>
        <div><dt>Cancelled</dt><dd>${i.cancelled}</dd></div>
        <div><dt>Refunds</dt><dd>${peso(i.refunds)}</dd></div>
      </dl>
    </div>`).join('');

  // Charts: revenue per island (stacked) and per day.
  if (charts.revIsland) {
    charts.revIsland.data.labels = r.islands.map((i) => i.name.replace(' Island', ''));
    charts.revIsland.data.datasets[0].data = r.islands.map((i) => i.online.revenue);
    charts.revIsland.data.datasets[1].data = r.islands.map((i) => i.walkin.revenue);
    charts.revIsland.update('none');
  }
  if (charts.revDay) {
    const byDay = new Map();
    for (const i of r.islands) for (const d of i.daily) {
      const x = byDay.get(d.day) ?? { online: 0, walkin: 0 };
      x.online += d.online; x.walkin += d.walkin; byDay.set(d.day, x);
    }
    const days = [...byDay.keys()].sort();
    charts.revDay.data.labels = days.map(fmtDay);
    charts.revDay.data.datasets[0].data = days.map((d) => byDay.get(d).online);
    charts.revDay.data.datasets[1].data = days.map((d) => byDay.get(d).walkin);
    charts.revDay.update('none');
  }

  // Per island: packages and services usage.
  $('rec-detail').innerHTML = r.islands.map((i) => `
    <div class="panel glass">
      <div class="panel-head"><h3><i data-icon="island"></i>${esc(i.name)}</h3><span class="chip">${fmtDay(r.from)} – ${fmtDay(r.to)}</span></div>
      <div class="two-col tight">
        <div><p class="sub-title">Packages</p>
          <div class="table-wrap"><table class="data"><thead><tr><th>Package</th><th>Bookings</th><th>Online / walk-in</th><th>Guests</th><th>Revenue</th></tr></thead><tbody>
          ${i.packages.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.bookings}</td><td>${p.online} / ${p.walkin}</td><td>${p.guests}</td><td>${peso(p.revenue)}</td></tr>`).join('')
            || '<tr><td colspan="5" class="empty">No paid bookings in this period</td></tr>'}
          </tbody></table></div></div>
        <div><p class="sub-title">Services used</p>
          <div class="table-wrap"><table class="data"><thead><tr><th>Service</th><th>Times booked</th><th>Online / walk-in</th><th>Units used</th><th>Direct revenue</th></tr></thead><tbody>
          ${i.live ? (i.services.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.bookings}</td><td>${x.online} / ${x.walkin}</td><td>${x.units}</td><td>${x.direct_revenue ? peso(x.direct_revenue) : '—'}</td></tr>`).join('')
            || '<tr><td colspan="5" class="empty">No services</td></tr>') : '<tr><td colspan="5" class="empty">Service usage needs the island online</td></tr>'}
          </tbody></table></div>
          <p class="small muted">Units used = units × days (a 2-night room = 2). Direct revenue = build-your-own trips; package revenue is in the table on the left.</p></div>
      </div>
    </div>`).join('');
}
['rec-from', 'rec-to'].forEach((id) => $(id).addEventListener('change', () => loadInventory().then(paintIcons).catch(showError)));

// ---------------------------------------------------------------------------
// Page: Accounts (island admins)
// ---------------------------------------------------------------------------

async function loadAccounts() {
  const r = await admin('/api/admin/accounts');
  // Island picker in the create form (keep the current choice).
  const chosen = $('acc-island').value;
  $('acc-island').innerHTML = r.islands.map((i) => `<option value="${esc(i.id)}" ${i.online ? '' : 'disabled'}>${esc(i.name)}${i.online ? '' : i.outdated ? ' (needs update)' : ' (offline)'}</option>`).join('');
  if (chosen) $('acc-island').value = chosen;
  $('acc-list').innerHTML = r.islands.map((i) => `
    <div class="acc-island">
      <div class="acc-head"><span class="dot ${i.online ? 'on' : i.outdated ? 'warn' : 'off'}"></span><b>${esc(i.name)}</b>
        <span class="muted small">${i.online ? `${i.staff.length} account(s)` : notReady(i)}</span></div>
      ${i.staff.length ? `<table class="data"><tbody>${i.staff.map((u) => `<tr>
        <td>${esc(u.username)}</td><td>${u.role === 'node_admin' ? '<span class="tag on">Island admin</span>' : '<span class="tag walk">Receptionist</span>'}</td>
        <td>${u.active ? 'Active' : '<span class="muted">Disabled</span>'}</td>
        <td><button class="btn ghost small" data-island="${esc(i.id)}" data-user="${esc(u.username)}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</tbody></table>`
        : i.online ? '<p class="empty">No accounts yet: create the island admin.</p>' : ''}
    </div>`).join('');
}
$('acc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('acc-result');
  try {
    const made = await admin('/api/admin/accounts', {
      islandId: $('acc-island').value, username: $('acc-user').value, password: $('acc-pass').value, role: $('acc-role').value,
    });
    out.innerHTML = `<span class="ok-text">Created ${made.role === 'node_admin' ? 'island admin' : 'receptionist'} <b>${esc(made.username)}</b>. They sign in on the island's console.</span>`;
    $('acc-user').value = '';
    $('acc-pass').value = '';
    loadAccounts();
  } catch (err) {
    out.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
});
$('acc-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-user]');
  if (!b) return;
  try {
    await admin('/api/admin/accounts/active', { islandId: b.dataset.island, username: b.dataset.user, active: b.dataset.active === '1' });
  } catch (err) { alert(err.message); }
  loadAccounts();
});
$('acc-refresh').addEventListener('click', () => loadAccounts().catch(showError));

// ---------------------------------------------------------------------------
// Reports (on the Inventory page): parallel benchmark
// ---------------------------------------------------------------------------

$('bench-run').addEventListener('click', async () => {
  const btn = $('bench-run');
  btn.disabled = true;
  btn.textContent = 'Running…';
  $('bench-note').textContent = 'Running the report with 1, 2, 4 and 8 threads (3 runs each)…';
  try {
    const r = await admin(`/api/admin/report-bench?records=${$('bench-records').value}`);
    if (charts.bench) {
      charts.bench.data.labels = r.rows.map((x) => `${x.threads} thread${x.threads > 1 ? 's' : ''}`);
      charts.bench.data.datasets[0].data = r.rows.map((x) => x.speedup);
      charts.bench.data.datasets[1].data = r.rows.map((x) => x.threads);
      charts.bench.update();
    }
    $('bench-table').innerHTML = '<tr><th>Threads</th><th>Time</th><th>Speedup</th><th>Efficiency</th></tr>' +
      r.rows.map((x) => `<tr><td>${x.threads}</td><td>${x.ms} ms</td><td>${x.speedup}×</td><td>${Math.round(x.efficiency * 100)}%</td></tr>`).join('');
    const best = r.rows.reduce((a, b) => (b.speedup > a.speedup ? b : a));
    $('bench-note').textContent = `${r.records.toLocaleString()} records on ${r.cores} CPU core(s): best ${best.speedup}× with ${best.threads} threads. ` +
      "Totals identical for every thread count. Speedup is limited by the number of cores (Amdahl's law).";
  } catch (err) {
    $('bench-note').textContent = `Benchmark failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run benchmark';
  }
});

// ---------------------------------------------------------------------------
// Island list in the Bookings filter, and registering a new island
// ---------------------------------------------------------------------------

function fillIslandSelect(list) {
  const chosen = $('bk-island').value;
  $('bk-island').innerHTML = '<option value="">All islands</option>' + list.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
  $('bk-island').value = chosen;
}
$('isl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('isl-result');
  try {
    const made = await admin('/api/admin/islands', { id: $('isl-id').value, name: $('isl-name').value, prefix: $('isl-prefix').value });
    out.innerHTML = `<span class="ok-text">Registered <b>${esc(made.name)}</b>. On its laptop run <code>npm run island -- ${esc(made.id)}</code>.</span>`;
    $('isl-form').reset();
    loadIslands().then(paintIcons);
  } catch (err) {
    out.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
});

// ---------------------------------------------------------------------------
// Day / night
// ---------------------------------------------------------------------------

// Applies a theme to the page and to the charts, and remembers it.
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('central-theme', theme); } catch { /* ignore */ }
  const btn = $('theme-btn');
  btn.innerHTML = `<i data-icon="${theme === 'dark' ? 'sun' : 'moon'}"></i>`;
  btn.title = theme === 'dark' ? 'Switch to day' : 'Switch to night';
  paintIcons(btn);
  if (window.Chart) {
    Chart.defaults.color = theme === 'dark' ? '#93a8b3' : '#4f6470';
    Chart.defaults.borderColor = theme === 'dark' ? 'rgba(108,163,162,.15)' : 'rgba(18,33,46,.1)';
    for (const c of Object.values(charts)) c.update('none');
  }
}
$('theme-btn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

// ---------------------------------------------------------------------------
// Refresh loop: only the page on screen
// ---------------------------------------------------------------------------

const loaders = { dashboard: loadDashboard, islands: loadIslands, bookings: loadBookings, inventory: loadInventory, accounts: loadAccounts };
function showError(err) {
  if (err.message !== 'signed out') $('ticker').textContent = `Could not load data: ${err.message}`;
}
async function refresh() {
  if (!token) return showLogin();
  try {
    await loaders[page()]();
    paintIcons();
  } catch (err) { showError(err); }
}

// Clock and greeting.
function tick() {
  const now = new Date();
  $('date').textContent = now.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const h = now.getHours();
  $('hello').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
$('host').textContent = location.host;
$('rec-to').value = addDays(todayStr(), 30); // trips booked ahead count too
$('rec-from').value = addDays(todayStr(), -29);
admin('/api/admin/islands').then((r) => fillIslandSelect(r.islands)).catch(() => {});
tick();
setInterval(tick, 60_000);
paintIcons();
setTheme(document.documentElement.dataset.theme || 'dark');
showPage();
// Pages with forms (Bookings filters, Accounts) are not auto-refreshed while typing.
setInterval(() => { if (!document.hidden && !['bookings', 'accounts', 'islands'].includes(page())) refresh(); }, 10_000);
