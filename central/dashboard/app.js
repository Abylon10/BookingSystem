/**
 * central/dashboard/app.js
 *
 * Central admin dashboard: signs in, then loads GET /api/admin/summary every
 * 10 seconds and renders KPIs, island nodes, charts, activity and arrivals.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ISLAND_COLORS = { biliran: '#6CA3A2', maripipi: '#EA9940', higatangan: '#4fbf8f' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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
  seat: '<path d="M6 12V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6"/><path d="M4 12h16v4H4zM6 16v4M18 16v4"/>',
  pie: '<path d="M12 3v9h9"/><circle cx="12" cy="12" r="9"/>',
  bars: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 13l4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M9 21l3-7 3 3v4M8 11l3-3 3 2 3 1"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
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

// Calls an admin endpoint; a 401 shows the login screen again.
async function adminGet(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { showLogin(); throw new Error('signed out'); }
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json();
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
// Charts (Chart.js), created once and updated on every refresh
// ---------------------------------------------------------------------------

const charts = {};
if (window.Chart) {
  Chart.defaults.color = '#93a8b3';
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  Chart.defaults.borderColor = 'rgba(108,163,162,.15)';

  charts.island = new Chart($('c-island'), {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 0 }] },
    options: { cutout: '68%', maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
  charts.trend = new Chart($('c-trend'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'Online', data: [], borderColor: '#6CA3A2', backgroundColor: 'rgba(108,163,162,.15)', fill: true, tension: .35, pointRadius: 3 },
      { label: 'Walk-in', data: [], borderColor: '#EA9940', backgroundColor: 'rgba(234,153,64,.1)', fill: true, tension: .35, pointRadius: 3 },
    ] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10 } } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  charts.listing = new Chart($('c-listing'), {
    type: 'bar',
    data: { labels: [], datasets: [{ label: 'Bookings', data: [], backgroundColor: [], borderRadius: 8, maxBarThickness: 46 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { ticks: { autoSkip: false, maxRotation: 0 } } } },
  });
}

// ---------------------------------------------------------------------------
// Render one summary
// ---------------------------------------------------------------------------

function render(s) {
  const k = s.kpis;

  // Ticker
  const linked = s.islands.filter((i) => i.status === 'online');
  $('ticker').innerHTML = [
    `<span>Islands online <b>${k.islandsOnline}/${k.islandsTotal}</b><em class="pill ${k.islandsOnline === k.islandsTotal ? 'ok' : k.islandsOnline ? 'warn' : 'bad'}">${linked.map((i) => cap(i.id)).join(', ') || 'none'}</em></span>`,
    `<span>Database <b>${s.supabase ? 'connected' : 'not configured'}</b></span>`,
    `<span>Last sync <b>${ago(s.lastSyncAt)}</b></span>`,
    `<span>Search across islands <b>${s.fanoutMs} ms</b></span>`,
  ].join('');

  // Greeting card
  $('fanout').textContent = `${s.fanoutMs} ms`;
  $('lastsync').textContent = ago(s.lastSyncAt);

  // KPIs
  $('k-islands').textContent = `${k.islandsOnline} / ${k.islandsTotal}`;
  $('k-islands-sub').textContent = k.islandsOnline === k.islandsTotal ? 'All island nodes reachable' : 'Some islands offline';
  $('k-bookings').textContent = k.bookingsToday;
  $('k-bookings-sub').textContent = `${k.onlineToday} online · ${k.walkinToday} walk-in`;
  $('k-checkins').textContent = k.checkedInToday;
  $('k-seats').textContent = k.onlineSeatsToday;

  // Island nodes
  $('island-cards').innerHTML = s.islands.map((i) => {
    const on = i.status === 'online';
    const how = on ? (i.via === 'link' ? 'Cloud link' : 'LAN (gRPC)') : esc((i.error ?? 'unreachable').slice(0, 60));
    return `<div class="island-card">
      <span class="dot ${on ? 'on' : 'off'}"></span>
      <div><b>${esc(i.id)}</b><div class="meta">${on ? 'Online' : 'Offline'} · ${how}</div></div>
      <div class="ms">${on ? `${i.ms}<small>ms</small>` : '<small>—</small>'}</div></div>`;
  }).join('');
  $('islands-note').textContent = `checked ${new Date(s.generatedAt).toLocaleTimeString()}`;

  // Donut: bookings by island
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

  // Activity feed
  const feedIcon = { WALKIN_BOOKED: ['f-walkin', 'walk'], ONLINE_BOOKED: ['f-online', 'phone'], REDEEMED: ['f-checkin', 'check'], CANCELLED: ['f-cancel', 'x'] };
  $('feed').innerHTML = s.activity.map((a) => {
    const [cls, icon] = feedIcon[a.kind] ?? ['f-online', 'pulse'];
    // "Walk-in BK-XXXX · Listing name" -> title on line 1, listing + island on line 2
    const [title, ...rest] = a.text.split(' · ');
    const detail = [rest.join(' · '), cap(a.island)].filter(Boolean).join(' · ');
    return `<li><span class="ficon ${cls}"><i data-icon="${icon}"></i></span>
      <div><b>${esc(title)}</b><small>${esc(detail)}</small></div><time>${ago(a.at)}</time></li>`;
  }).join('') || '<li class="empty">No activity yet. Walk-ins and check-ins from islands appear here.</li>';

  // Arrivals
  $('arrival-list').innerHTML = s.arrivals.map((a) => {
    const d = new Date(`${a.day}T00:00:00`);
    return `<li><div class="cal"><b>${d.getDate()}</b><small>${d.toLocaleString('en', { month: 'short' })}</small></div>
      <div><div class="who">${esc(a.guest)}</div><div class="what">${esc(a.listing)} · ${a.qty} · ${esc(a.code)}</div></div></li>`;
  }).join('') || '<li class="empty">No upcoming online bookings</li>';

  // Trend: last 7 days
  if (charts.trend) {
    charts.trend.data.labels = s.daily.map((d) => new Date(`${d.day}T00:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' }));
    charts.trend.data.datasets[0].data = s.daily.map((d) => d.online);
    charts.trend.data.datasets[1].data = s.daily.map((d) => d.walkin);
    charts.trend.update('none');
  }

  // Bars: bookings per listing, colored by island
  if (charts.listing) {
    charts.listing.data.labels = s.byListing.map((l) => l.name.length > 22 ? `${l.name.slice(0, 21)}…` : l.name);
    charts.listing.data.datasets[0].data = s.byListing.map((l) => l.count);
    charts.listing.data.datasets[0].backgroundColor = s.byListing.map((l) => ISLAND_COLORS[l.id.split('-')[0]] ?? '#307082');
    charts.listing.update('none');
  }

  paintIcons();
}

// ---------------------------------------------------------------------------
// Refresh loop
// ---------------------------------------------------------------------------

async function refresh() {
  if (!token) return showLogin();
  try {
    render(await adminGet('/api/admin/summary'));
  } catch (err) {
    if (err.message !== 'signed out') $('ticker').textContent = `Could not load data: ${err.message}`;
  }
}

// Speed test: same comparison as loadtest/search.ts, from the browser.
$('a-speed').addEventListener('click', async () => {
  const out = $('speed-result');
  out.textContent = 'Running 5 sequential + 5 parallel searches…';
  const avg = async (mode) => {
    let total = 0;
    for (let n = 0; n < 5; n++) total += (await (await fetch(`/api/listings?mode=${mode}`)).json()).fanoutMs;
    return Math.round(total / 5);
  };
  const seq = await avg('sequential');
  const par = await avg('parallel');
  out.innerHTML = `Sequential <b>${seq} ms</b> · Parallel <b>${par} ms</b> · Speedup <b>${(seq / Math.max(par, 1)).toFixed(2)}×</b>`;
});
$('a-refresh').addEventListener('click', refresh);

// Sidebar: highlight the clicked section.
for (const a of document.querySelectorAll('.sidebar nav:first-of-type a')) {
  a.addEventListener('click', () => {
    document.querySelectorAll('.sidebar nav:first-of-type a').forEach((x) => x.classList.remove('active'));
    a.classList.add('active');
  });
}

// Clock and greeting.
function tick() {
  const now = new Date();
  $('date').textContent = now.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const h = now.getHours();
  $('hello').textContent = h < 12 ? 'Good morning,' : h < 18 ? 'Good afternoon,' : 'Good evening,';
}
$('host').textContent = location.host;
tick();
setInterval(tick, 60_000);
paintIcons();
refresh();
setInterval(refresh, 10_000);
