/**
 * island/console/app.js
 *
 * Island console after sign-in. Talks only to its own island over HTTP, so it
 * keeps working when the island is cut off from central.
 *
 * Roles (authorization): the session from login.html says "receptionist" or
 * "node_admin". Admin-only parts of the page (class "admin-only") are hidden
 * for receptionists, and the server refuses admin routes with 403 anyway.
 *
 * Pages: Dashboard, Check-in, Walk-in, Services on/off, Bookings, and for
 * admins Packages & services and Staff accounts.
 */

// ---------------------------------------------------------------------------
// Helpers and session
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Local date as YYYY-MM-DD (the islands' date format).
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
// "Fri, Nov 20" or "Fri, Nov 20 – Sun, Nov 22".
const fmtRange = (b) => (b.end_day && b.end_day !== b.day ? `${fmtDay(b.day)} – ${fmtDay(b.end_day)}` : fmtDay(b.day));
const initials = (name) => String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || '?';

// No token -> back to the sign-in page (authentication happens there).
let token = null;
let me = null;
try { token = localStorage.getItem('desk-token'); me = JSON.parse(localStorage.getItem('desk-me') || 'null'); } catch { /* storage blocked */ }
if (!token || !me) location.replace('login.html');
const isAdmin = me?.role === 'node_admin';

// Calls the island API with the session token. 401 = session over -> sign in again.
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function signOut() {
  try { localStorage.removeItem('desk-token'); localStorage.removeItem('desk-me'); } catch { /* ignore */ }
  location.replace('login.html');
}
$('logout').addEventListener('click', signOut);

// ---------------------------------------------------------------------------
// Pages (sidebar)
// ---------------------------------------------------------------------------

const loaders = {
  dashboard: () => loadDashboard(),
  checkin: () => loadArrivals(),
  walkin: () => loadWalkin(),
  checklist: () => loadChecklist(),
  bookings: () => loadBookings(),
  catalog: () => loadCatalog(),
  staff: () => loadStaff(),
};

// Shows one page: highlights its sidebar button and reloads its data.
function showTab(tab) {
  if (!isAdmin && ['catalog', 'staff'].includes(tab)) tab = 'dashboard';
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== tab));
  history.replaceState(null, '', `#${tab}`);
  loaders[tab]?.().catch((err) => console.warn(err));
}
const currentTab = () => document.querySelector('#tabs button.active')?.dataset.tab ?? 'dashboard';
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
// "Open check-in →" style links on the dashboard.
document.addEventListener('click', (e) => { const go = e.target.closest('[data-go]')?.dataset.go; if (go) showTab(go); });

// ---------------------------------------------------------------------------
// Top bar: link status (every 3 s), partition switch, search
// ---------------------------------------------------------------------------

let state = null; // last /api/state (packages, services, link)

async function loadState(day = todayStr(), guests = 1, extraDays = 0) {
  state = await api(`/api/state?day=${day}&guests=${guests}&extraDays=${extraDays}`);
  $('island-name').textContent = state.island.name;
  document.title = `${state.island.name} · ${isAdmin ? 'Admin' : 'Front desk'}`;
  $('partition').checked = state.partitioned;
  // Green dot = linked to central; red = cut off (desk still works, changes queue up).
  const link = { lan: 'LAN', connected: 'cloud link', polling: 'cloud, HTTPS polling', connecting: 'reconnecting…' }[state.centralLink] ?? '';
  const online = !state.partitioned && state.centralLink !== 'connecting';
  const waiting = state.outboxPending ? ` · ${state.outboxPending} change(s) waiting to sync` : ' · all synced';
  $('sync-status').className = `sync ${online ? 'on' : 'off'}`;
  $('sync-status').innerHTML = `<span class="dot"></span>${esc(state.partitioned ? 'Offline from central' : `Central: ${link}`)}${esc(waiting)}`;
  return state;
}
$('partition').addEventListener('change', async (e) => { await api('/api/partition', { on: e.target.checked }); loadState(); });

// Top-bar search always shows its results on the Check-in page.
let arrQuery = '';
$('top-search').addEventListener('submit', (e) => {
  e.preventDefault();
  arrQuery = $('top-q').value.trim();
  showTab('checkin');
});

// ---------------------------------------------------------------------------
// Online / Walk-in checkboxes (Check-in and Bookings pages)
// ---------------------------------------------------------------------------

// Sources ticked in a checkbox group, e.g. {ONLINE, WALKIN}.
const ticked = (id) => new Set([...document.querySelectorAll(`#${id} input:checked`)].map((c) => c.value));
// Keeps only the bookings whose source is ticked.
const bySource = (rows, id) => { const on = ticked(id); return rows.filter((b) => on.has(b.source)); };
// "3 booking(s) · 2 online · 1 walk-in"
const countText = (rows) => `${rows.length} booking(s) · ${rows.filter((b) => b.source === 'ONLINE').length} online · ${rows.filter((b) => b.source === 'WALKIN').length} walk-in`;

// ---------------------------------------------------------------------------
// Dashboard (summary)
// ---------------------------------------------------------------------------

// 7-bar mini chart; the last bar (the chosen date) is highlighted.
function bars(el, values, tone) {
  const max = Math.max(1, ...values);
  el.className = `bars ${tone ?? ''}`;
  el.innerHTML = values.map((v, i) => `<i class="${i === values.length - 1 ? 'now' : ''}" style="height:${Math.round((v / max) * 100)}%" title="${v}"></i>`).join('');
}

async function loadDashboard() {
  const day = $('dash-day').value;
  const [o, arrivals, recent, st] = await Promise.all([
    api(`/api/overview?day=${day}`), api(`/api/bookings?day=${day}`), api('/api/bookings'), loadState(day),
  ]);
  const isToday = day === todayStr();
  // KPI cards
  $('k-arr').textContent = o.arrivals;
  $('k-arr-sub').textContent = isToday ? 'expected today' : `expected ${fmtDay(day)}`;
  bars($('k-arr-bars'), o.trend.map((t) => t.arrivals));
  $('k-in').textContent = o.checkedIn;
  $('k-in-ratio').textContent = `${o.checkedIn}/${o.arrivals}`;
  $('k-in-ring').style.setProperty('--p', o.arrivals ? Math.round((o.checkedIn / o.arrivals) * 100) : 0);
  $('k-walk').textContent = o.walkins;
  $('k-walk-sub').textContent = `online ${o.online}`;
  bars($('k-walk-bars'), o.trend.map((t) => t.walkins), 'accent');
  $('k-rev').textContent = peso(o.revenue);
  $('k-rev-sub').textContent = `online ${peso(o.revenueOnline)} · walk-in ${peso(o.revenueWalkin)}`;
  bars($('k-rev-bars'), o.trend.map((t) => t.revenue), 'ink');
  // Sidebar counters (today only)
  if (isToday) {
    $('n-arrivals').textContent = o.arrivals - o.checkedIn || '';
    $('n-off').textContent = o.servicesOff || '';
  }
  // Next to check in
  const waiting = arrivals.filter((b) => b.status === 'CONFIRMED');
  $('dash-arrivals').innerHTML = waiting.slice(0, 6).map((b) => `
    <div class="mini"><span class="avatar">${esc(initials(b.guest_name))}</span>
      <div><b>${esc(b.guest_name)}</b><span>${esc(b.reference)} · ${esc(b.package_name)} · ${b.guests} guest(s)</span></div>
      <button class="pill" data-details="${esc(b.reference)}">Check ID</button></div>`).join('')
    || `<p class="muted">${arrivals.length ? 'Everyone has checked in.' : 'No arrivals on this date.'}</p>`;
  dashRows = arrivals;
  // Services switched off on this date
  const off = st.services.filter((s) => s.reason?.startsWith('Unavailable'));
  $('dash-off').innerHTML = off.map((s) => `<div class="mini off"><span class="dot-off"></span><div><b>${esc(s.name)}</b><span>Off on ${fmtDay(day)}: packages that need it can't be sold</span></div></div>`).join('')
    || '<p class="muted">All services are on.</p>';
  // Latest bookings
  $('dash-recent').innerHTML = recent.slice(0, 6).map((b) => `
    <div class="mini"><span class="badge ${esc(b.source)}">${b.source === 'ONLINE' ? 'Online' : 'Walk-in'}</span>
      <div><b>${esc(b.guest_name)} · ${esc(b.reference)}</b><span>${esc(b.package_name)} · ${fmtRange(b)} · ${peso(b.total_php)}</span></div>
      <span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></div>`).join('')
    || '<p class="muted">No bookings yet.</p>';
}
let dashRows = [];
$('dash-day').addEventListener('change', loadDashboard);
$('dash-arrivals').addEventListener('click', (e) => {
  const ref = e.target.closest('button')?.dataset.details;
  if (ref) openDetails(dashRows.find((b) => b.reference === ref));
});

// ---------------------------------------------------------------------------
// Check-in (the day's arrivals, or a search)
// ---------------------------------------------------------------------------

let arrRows = [];

// One table row with ✓ check in, ✕ cancel (admin), and "View details".
function arrivalRow(b) {
  const canCheckIn = b.status === 'CONFIRMED';
  const canCancel = isAdmin && ['CONFIRMED', 'HELD'].includes(b.status);
  return `<tr>
    <td><div class="guest"><span class="avatar">${esc(initials(b.guest_name))}</span>${esc(b.guest_name)}</div></td>
    <td class="ref">${esc(b.reference)}</td>
    <td>${esc(b.package_name)}</td>
    <td>${fmtRange(b)}${b.extra_days ? `<div class="small">+${b.extra_days} extra day(s)</div>` : ''}</td>
    <td>${b.guests}</td>
    <td class="idhint">${esc(b.id_type)} ·· <b>${esc(b.id_last4)}</b></td>
    <td><span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></td>
    <td><div class="actions">
      <button class="act in" data-checkin="${esc(b.reference)}" title="ID matches — check in" ${canCheckIn ? '' : 'disabled'}>✓</button>
      ${isAdmin ? `<button class="act x" data-cancel="${esc(b.reference)}" title="Cancel and refund" ${canCancel ? '' : 'disabled'}>✕</button>` : ''}
    </div></td>
    <td><button class="pill" data-details="${esc(b.reference)}">View details</button></td>
  </tr>`;
}

async function loadArrivals() {
  const day = $('arr-day').value;
  arrRows = arrQuery ? await api(`/api/bookings?q=${encodeURIComponent(arrQuery)}`) : await api(`/api/bookings?day=${day}`);
  $('arr-title').textContent = arrQuery ? `Search: “${arrQuery}”` : day === todayStr() ? "Today's arrivals" : `Arrivals · ${fmtDay(day)}`;
  const shownArr = bySource(arrRows, 'arr-src');
  $('arr-count').textContent = countText(shownArr);
  $('arr-clear').classList.toggle('hidden', !arrQuery);
  $('arr-list').innerHTML = shownArr.map(arrivalRow).join('')
    || `<tr><td colspan="9" class="muted">${arrQuery ? 'No booking matches that reference or name on this island.' : `No arrivals on ${fmtDay(day)}.`}</td></tr>`;
}
$('arr-src').addEventListener('change', () => loadArrivals());
$('bk-src').addEventListener('change', () => loadBookings());
$('arr-day').addEventListener('change', () => { arrQuery = ''; $('top-q').value = ''; loadArrivals(); });
$('arr-clear').addEventListener('click', () => { arrQuery = ''; $('top-q').value = ''; loadArrivals(); });
$('arr-list').addEventListener('click', (e) => {
  const d = e.target.closest('button')?.dataset ?? {};
  if (d.checkin) checkIn(d.checkin);
  else if (d.cancel) cancelBooking(d.cancel);
  else if (d.details) openDetails(arrRows.find((b) => b.reference === d.details));
});

// Check-in after the ID check (any staff).
async function checkIn(ref) {
  try { await api(`/api/bookings/${ref}/checkin`, {}); } catch (err) { alert(err.message); }
  closeModal();
  loaders[currentTab()]?.();
}

// Cancel with refund (admin): shows the refund first, then asks to confirm.
async function cancelBooking(ref) {
  try {
    const r = await api(`/api/bookings/${ref}/refund`);
    openModal(`Cancel ${ref}?`, `
      <p>The units go back on sale.</p>
      <div class="idbox">Refund to the guest: <b>${peso(r.refund_php)}</b> of ${peso(r.total_php)} paid
        <div class="small muted">Full refund before the trip date, half on the trip date, nothing for an unpaid hold.</div></div>`,
    `<button class="ghost" data-close>Keep booking</button><button class="danger-solid" data-confirm-cancel="${esc(ref)}">Cancel and refund ${peso(r.refund_php)}</button>`);
  } catch (err) { alert(err.message); }
}

// ---------------------------------------------------------------------------
// Modal dialog (details, refunds, editors)
// ---------------------------------------------------------------------------

function openModal(title, body, actions = '') {
  $('m-title').textContent = title;
  $('m-body').innerHTML = body;
  $('m-actions').innerHTML = actions;
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }
$('m-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', async (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) return closeModal();
  const d = e.target.closest('button')?.dataset ?? {};
  if (d.checkin) checkIn(d.checkin);
  if (d.cancel) cancelBooking(d.cancel);
  if (d.confirmCancel) {
    try {
      const b = await api(`/api/bookings/${d.confirmCancel}/cancel`, {});
      closeModal();
      alert(`Cancelled ${b.reference}. Refund ${peso(b.refund_php)}.`);
      loaders[currentTab()]?.();
    } catch (err) { alert(err.message); }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Booking details: everything about the booking plus the ID to compare.
function openDetails(b) {
  if (!b) return;
  openModal(b.reference, `
    <div class="idbox">Check the guest's ID: <b>${esc(b.guest_name)}</b> · ${esc(b.id_type)} ending <b>${esc(b.id_last4)}</b></div>
    <dl class="dl">
      <dt>Status</dt><dd><span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></dd>
      <dt>Booking</dt><dd>${esc(b.package_name)}</dd>
      <dt>Dates</dt><dd>${fmtRange(b)} · ${b.days} day(s)${b.extra_days ? ` (+${b.extra_days} extra)` : ''}</dd>
      <dt>Services</dt><dd>${(b.services ?? []).map((s) => `${esc(s.name)} × ${s.qty}`).join('<br>')}</dd>
      <dt>Guests</dt><dd>${b.guests}</dd>
      <dt>Booked</dt><dd>${b.source === 'ONLINE' ? 'Online (app)' : `Walk-in (desk)`}</dd>
      <dt>Paid</dt><dd>${peso(b.total_php)}${b.refund_php ? ` · refunded ${peso(b.refund_php)}` : ''}</dd>
      ${b.phone ? `<dt>Phone</dt><dd>${esc(b.phone)}</dd>` : ''}
      ${b.email ? `<dt>E-mail</dt><dd>${esc(b.email)}</dd>` : ''}
    </dl>`,
  `${isAdmin && ['CONFIRMED', 'HELD'].includes(b.status) ? `<button class="danger" data-cancel="${esc(b.reference)}">Cancel and refund</button>` : ''}
   ${b.status === 'CONFIRMED' ? `<button class="ok" data-checkin="${esc(b.reference)}">ID matches — Check in</button>` : ''}`);
}

// ---------------------------------------------------------------------------
// Walk-in: package (+ extra days) or build-your-own, with a live price
// ---------------------------------------------------------------------------

let walkMode = 'package';

async function loadWalkin() {
  const st = await loadState($('w-day').value, Number($('w-guests').value) || 1, Number($('w-extra').value) || 0);
  // Package list (unavailable ones are marked and disabled).
  const chosen = $('w-package').value;
  $('w-package').innerHTML = st.packages.map((p) =>
    `<option value="${esc(p.id)}" ${p.available ? '' : 'disabled'}>${esc(p.name)}${p.available ? '' : ` — ${esc(p.reason)}`}</option>`).join('');
  if (chosen && st.packages.some((p) => p.id === chosen && p.available)) $('w-package').value = chosen;
  // Services checklist with quantities for build-your-own.
  const picked = Object.fromEntries([...document.querySelectorAll('#w-services input[type=number]')].map((i) => [i.dataset.svc, i.value]));
  const ticked = new Set([...document.querySelectorAll('#w-services input[type=checkbox]:checked')].map((i) => i.dataset.svc));
  $('w-services').innerHTML = st.services.map((s) => `
    <label class="svc ${s.available ? '' : 'svc-off'}">
      <input type="checkbox" data-svc="${esc(s.id)}" ${s.available ? '' : 'disabled'} ${ticked.has(s.id) && s.available ? 'checked' : ''}>
      <span><b>${esc(s.name)}</b><small>${peso(s.price_php)} per ${esc(s.unit)} per day${s.available ? '' : ` · ${esc(s.reason)}`}</small></span>
      <input type="number" min="1" value="${esc(picked[s.id] ?? (s.unit === 'room' ? 1 : $('w-guests').value))}" data-svc="${esc(s.id)}" title="Quantity">
    </label>`).join('');
  quoteWalkin();
}

// The request built from the form (shared by the price quote and booking).
function walkinRequest() {
  const base = { day: $('w-day').value, guests: Number($('w-guests').value) || 1 };
  if (walkMode === 'package') return { ...base, packageId: $('w-package').value, extraDays: Number($('w-extra').value) || 0 };
  const items = [...document.querySelectorAll('#w-services input[type=checkbox]:checked')].map((c) => ({
    serviceId: c.dataset.svc, qty: Number(document.querySelector(`#w-services input[type=number][data-svc="${c.dataset.svc}"]`).value) || 1,
  }));
  return { ...base, items, days: Number($('w-days').value) || 1 };
}

// Live price, dates and any problem, before booking.
async function quoteWalkin() {
  $('w-note').textContent = '';
  const req = walkinRequest();
  if (walkMode === 'custom' && !req.items.length) { $('w-total').textContent = 'Tick the services to include'; return; }
  if (walkMode === 'package' && !req.packageId) { $('w-total').textContent = 'No package available on this date'; return; }
  try {
    const q = await api('/api/quote', req);
    $('w-total').textContent = `${peso(q.total_php)} · ${fmtRange({ day: req.day, end_day: q.end_day })} · ${q.days} day(s)`;
    if (q.unavailable_services.length) $('w-note').textContent = `${q.unavailable_services.map((s) => s.name).join(', ')} unavailable`;
  } catch (err) {
    $('w-total').textContent = '';
    $('w-note').textContent = err.message;
  }
}

// Package / Build your own switch.
$('w-mode').addEventListener('click', (e) => {
  const mode = e.target.dataset.mode;
  if (!mode) return;
  walkMode = mode;
  document.querySelectorAll('#w-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.querySelectorAll('.w-package').forEach((el) => el.classList.toggle('hidden', mode !== 'package'));
  document.querySelectorAll('.w-custom').forEach((el) => el.classList.toggle('hidden', mode !== 'custom'));
  quoteWalkin();
});
['w-day', 'w-guests', 'w-extra', 'w-days'].forEach((id) => $(id).addEventListener('change', loadWalkin));
$('w-package').addEventListener('change', quoteWalkin);
$('w-services').addEventListener('change', quoteWalkin);

$('walkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('walkin-result');
  try {
    const b = await api('/api/walkin', {
      ...walkinRequest(), requestId: crypto.randomUUID(), guestName: $('w-name').value, phone: $('w-phone').value,
      email: $('w-email').value, idType: $('w-idtype').value, idLast4: $('w-last4').value,
    });
    out.innerHTML = `<div class="result ok">Booked <b>${esc(b.reference)}</b> for ${esc(b.guest_name)}: ${esc(b.package_name)}, ${fmtRange(b)}. Collect <b>${peso(b.total_php)}</b>.</div>`;
    ['w-name', 'w-phone', 'w-email', 'w-last4'].forEach((id) => { $(id).value = ''; });
    loadWalkin();
  } catch (err) {
    out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`;
  }
});

// ---------------------------------------------------------------------------
// Services on/off checklist, and how packages look on that date
// ---------------------------------------------------------------------------

async function loadChecklist() {
  const day = $('cl-day').value;
  const st = await loadState(day, 1);
  const inv = Object.fromEntries(st.inventory.map((i) => [i.id, i]));
  // One switch per service: on = available, off = unavailable that day.
  $('cl-services').innerHTML = st.services.map((s) => {
    const off = s.reason?.startsWith('Unavailable');
    const i = inv[s.id] ?? {};
    return `<div class="switch-row ${off ? 'is-off' : ''}">
      <div><b>${esc(s.name)}</b><span>${esc(s.kind)} · ${i.booked ?? 0} of ${i.capacity ?? 0} booked</span></div>
      <label class="switch" title="${off ? 'Off: switch on to sell it again' : 'On: switch off if it cannot run'}">
        <input type="checkbox" data-svc="${esc(s.id)}" ${off ? '' : 'checked'}><span></span>
      </label>
      <em>${off ? 'Unavailable' : 'Available'}</em>
    </div>`;
  }).join('');
  // Packages: each service listed; a switched-off one is shaded with a red note.
  const offIds = new Set(st.services.filter((s) => s.reason?.startsWith('Unavailable')).map((s) => s.id));
  $('cl-packages').innerHTML = st.packages.map((p) => `
    <div class="pkg ${p.available ? '' : 'pkg-off'}">
      <div class="pkg-top"><b>${esc(p.name)}</b><span class="price">${peso(p.price_php)}${p.pricing === 'per_guest' ? ' /guest' : ''}</span></div>
      <ul>${p.items.map((it) => `<li class="${offIds.has(it.service_id) ? 'svc-x' : ''}">${esc(it.name)}${offIds.has(it.service_id) ? ' <em>unavailable</em>' : ''}</li>`).join('')}</ul>
      ${p.available ? '<span class="state ok">Available</span>' : `<span class="state bad">${esc(p.reason)}</span>`}
    </div>`).join('');
}
$('cl-day').addEventListener('change', loadChecklist);
$('cl-services').addEventListener('change', async (e) => {
  const id = e.target.dataset.svc;
  if (!id) return;
  const out = $('cl-result');
  try {
    const r = await api('/api/checklist', { serviceId: id, day: $('cl-day').value, off: !e.target.checked });
    out.innerHTML = r.off && r.affected.length
      ? `<div class="result bad">${esc(r.service)} is off. Already booked that day: ${r.affected.map((a) => `${esc(a.reference)} (${esc(a.guest_name)})`).join(', ')}, please contact them.</div>`
      : `<div class="result ok">${esc(r.service)} is ${r.off ? 'off' : 'on'} for ${fmtDay($('cl-day').value)}.</div>`;
  } catch (err) {
    out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`;
  }
  loadChecklist();
});

// ---------------------------------------------------------------------------
// Bookings list (admins can cancel with refund)
// ---------------------------------------------------------------------------

let bkRows = [];
async function loadBookings() {
  bkRows = await api('/api/bookings');
  const shownBk = bySource(bkRows, 'bk-src');
  $('bk-count').textContent = countText(shownBk);
  $('bk-list').innerHTML = shownBk.map((b) => `<tr class="click" data-ref="${esc(b.reference)}"><td class="ref">${esc(b.reference)}</td>
    <td><span class="badge ${esc(b.source)}">${b.source === 'ONLINE' ? 'Online' : 'Walk-in'}</span></td>
    <td>${esc(b.package_name)}</td><td>${fmtRange(b)}</td><td>${b.guests}</td><td>${esc(b.guest_name)}</td><td>${peso(b.total_php)}</td>
    <td>${b.refund_php ? peso(b.refund_php) : '—'}</td>
    <td><span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></td>
    <td class="admin-only">${['CONFIRMED', 'HELD'].includes(b.status) ? `<button class="danger" data-cancel="${esc(b.reference)}">Cancel</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="10" class="muted">No bookings yet</td></tr>';
}
$('bk-list').addEventListener('click', (e) => {
  const cancel = e.target.closest('button')?.dataset.cancel;
  if (cancel) return cancelBooking(cancel);
  const ref = e.target.closest('tr')?.dataset.ref;
  if (ref) openDetails(bkRows.find((b) => b.reference === ref));
});

// ---------------------------------------------------------------------------
// Admin: packages and services (create / edit with prices)
// ---------------------------------------------------------------------------

let catalog = { services: [], packages: [] };
const KINDS = ['room', 'tour', 'boat', 'transfer', 'meal'];
const UNITS = ['person', 'room', 'trip'];
const opts = (list, value) => list.map((v) => `<option ${v === value ? 'selected' : ''}>${v}</option>`).join('');

async function loadCatalog() {
  catalog = await api('/api/admin/catalog');
  $('svc-list').innerHTML = catalog.services.map((s) => `<tr>
    <td><b>${esc(s.name)}</b><div class="small muted">${esc(s.id)}</div></td><td>${esc(s.kind)}</td><td>${s.capacity}</td>
    <td>${peso(s.price_php)} / ${esc(s.unit)}</td><td>${s.active ? '<span class="badge CONFIRMED">Active</span>' : '<span class="badge EXPIRED">Retired</span>'}</td>
    <td><button class="link" data-edit-svc="${esc(s.id)}">Edit</button></td></tr>`).join('');
  $('pkg-list').innerHTML = catalog.packages.map((p) => `<tr>
    <td><b>${esc(p.name)}</b><div class="small muted">${esc(p.location)}</div></td>
    <td>${p.nights ? `${p.nights} night(s)` : 'Day trip'}</td><td>${peso(p.price_php)} ${p.pricing === 'per_guest' ? '/ guest' : '/ package'}</td>
    <td>${peso(p.extra_day_php)}</td><td>${p.max_guests}</td>
    <td class="wrap">${p.items.map((i) => `${esc(i.name)} × ${i.qty}${i.per_guest ? '/guest' : ''}`).join(', ')}</td>
    <td>${p.active ? '<span class="badge CONFIRMED">On sale</span>' : '<span class="badge EXPIRED">Hidden</span>'}</td>
    <td><button class="link" data-edit-pkg="${esc(p.id)}">Edit</button></td></tr>`).join('');
}

// Service editor (new or existing).
function editService(s = {}) {
  openModal(s.id ? `Edit ${s.name}` : 'Add service', `
    <form id="svc-form" class="grid2">
      <label class="span2">Name<input name="name" value="${esc(s.name ?? '')}" required></label>
      <label>Kind<select name="kind">${opts(KINDS, s.kind ?? 'tour')}</select></label>
      <label>Capacity per day<input name="capacity" type="number" min="0" value="${s.capacity ?? 10}" required></label>
      <label>Price per day (₱)<input name="pricePhp" type="number" min="0" value="${s.price_php ?? 0}" required></label>
      <label>Price is per<select name="unit">${opts(UNITS, s.unit ?? 'person')}</select></label>
      <label class="check span2"><input name="active" type="checkbox" ${s.active === 0 ? '' : 'checked'}> Active (can be booked)</label>
      <p class="error span2" id="svc-error"></p>
    </form>`,
  `<button class="ghost" data-close>Cancel</button><button id="svc-save">Save service</button>`);
  $('svc-save').onclick = async () => {
    const f = new FormData($('svc-form'));
    try {
      await api('/api/admin/services', {
        id: s.id, name: f.get('name'), kind: f.get('kind'), capacity: Number(f.get('capacity')),
        pricePhp: Number(f.get('pricePhp')), unit: f.get('unit'), active: f.get('active') === 'on',
      });
      closeModal();
      loadCatalog();
    } catch (err) { $('svc-error').textContent = err.message; }
  };
}

// Package editor: details, price, extra-day fee, and a services checklist.
function editPackage(p = {}) {
  const items = Object.fromEntries((p.items ?? []).map((i) => [i.service_id, i]));
  openModal(p.id ? `Edit ${p.name}` : 'Add package', `
    <form id="pkg-form" class="grid2">
      <label class="span2">Name<input name="name" value="${esc(p.name ?? '')}" required></label>
      <label>Location<input name="location" value="${esc(p.location ?? '')}"></label>
      <label>Nights (0 = day trip, up to 12 h)<input name="nights" type="number" min="0" max="14" value="${p.nights ?? 0}"></label>
      <label>Price (₱)<input name="pricePhp" type="number" min="0" value="${p.price_php ?? 0}"></label>
      <label>Price is<select name="pricing"><option value="per_guest" ${p.pricing !== 'per_package' ? 'selected' : ''}>per guest</option><option value="per_package" ${p.pricing === 'per_package' ? 'selected' : ''}>per package</option></select></label>
      <label>Extra-day fee (₱)<input name="extraDayPhp" type="number" min="0" value="${p.extra_day_php ?? 0}"></label>
      <label>Max guests<input name="maxGuests" type="number" min="1" value="${p.max_guests ?? 2}"></label>
      <label class="span2">Description<textarea name="description" rows="2">${esc(p.description ?? '')}</textarea></label>
      <div class="span2"><p class="label">Included services</p>
        ${catalog.services.filter((s) => s.active).map((s) => `
          <div class="item-row">
            <label class="check"><input type="checkbox" data-item="${esc(s.id)}" ${items[s.id] ? 'checked' : ''}> ${esc(s.name)}</label>
            <input type="number" min="1" value="${items[s.id]?.qty ?? 1}" data-qty="${esc(s.id)}" title="Quantity">
            <label class="check small"><input type="checkbox" data-pg="${esc(s.id)}" ${items[s.id] ? (items[s.id].per_guest ? 'checked' : '') : (s.kind === 'room' ? '' : 'checked')}> per guest</label>
          </div>`).join('')}
      </div>
      <label class="check span2"><input name="active" type="checkbox" ${p.active === 0 ? '' : 'checked'}> On sale</label>
      <p class="error span2" id="pkg-error"></p>
    </form>`,
  `<button class="ghost" data-close>Cancel</button><button id="pkg-save">Save package</button>`);
  $('pkg-save').onclick = async () => {
    const f = new FormData($('pkg-form'));
    const chosen = [...document.querySelectorAll('#pkg-form [data-item]:checked')].map((c) => ({
      serviceId: c.dataset.item,
      qty: Number(document.querySelector(`#pkg-form [data-qty="${c.dataset.item}"]`).value) || 1,
      perGuest: document.querySelector(`#pkg-form [data-pg="${c.dataset.item}"]`).checked,
    }));
    try {
      await api('/api/admin/packages', {
        id: p.id, name: f.get('name'), location: f.get('location'), description: f.get('description'),
        pricePhp: Number(f.get('pricePhp')), pricing: f.get('pricing'), nights: Number(f.get('nights')),
        maxGuests: Number(f.get('maxGuests')), extraDayPhp: Number(f.get('extraDayPhp')), active: f.get('active') === 'on', items: chosen,
      });
      closeModal();
      loadCatalog();
    } catch (err) { $('pkg-error').textContent = err.message; }
  };
}
$('add-service').addEventListener('click', () => editService());
$('add-package').addEventListener('click', () => editPackage());
$('svc-list').addEventListener('click', (e) => { const id = e.target.dataset.editSvc; if (id) editService(catalog.services.find((s) => s.id === id)); });
$('pkg-list').addEventListener('click', (e) => { const id = e.target.dataset.editPkg; if (id) editPackage(catalog.packages.find((p) => p.id === id)); });

// ---------------------------------------------------------------------------
// Admin: staff accounts
// ---------------------------------------------------------------------------

async function loadStaff() {
  const list = await api('/api/staff');
  $('staff-list').innerHTML = list.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.role === 'node_admin' ? 'Island admin' : 'Receptionist'}</td>
    <td>${u.active ? 'Active' : 'Disabled'}</td>
    <td>${u.role === 'receptionist' ? `<button class="link" data-user="${esc(u.username)}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>` : '<span class="small muted">managed by central</span>'}</td></tr>`).join('');
}
$('staff-list').addEventListener('click', async (e) => {
  const u = e.target.dataset?.user;
  if (!u) return;
  await api(`/api/staff/${u}/active`, { active: e.target.dataset.active === '1' });
  loadStaff();
});
$('staff-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/staff', { username: $('s-user').value, password: $('s-pass').value });
    $('staff-result').textContent = `Added receptionist ${$('s-user').value}.`;
    $('staff-form').reset();
    loadStaff();
  } catch (err) {
    $('staff-result').textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Role: label, avatar, and hide admin-only parts for receptionists.
$('who').textContent = me ? `${me.user} · ${isAdmin ? 'Island admin' : 'Receptionist'}` : '';
$('avatar').textContent = me ? me.user.slice(0, 2) : '?';
$('role-tag').textContent = isAdmin ? 'Island admin' : 'Front desk';
document.body.classList.toggle('is-admin', isAdmin);
if (!isAdmin) $('bk-hint').textContent = 'Online and walk-in bookings on this island. Ask an island admin to cancel or refund.';
for (const id of ['dash-day', 'arr-day', 'w-day', 'cl-day']) $(id).value = todayStr();
loadState().catch(() => {}); // island name + link status straight away, whatever the page
showTab((location.hash || '#dashboard').slice(1));

// Every 3 s: link status, and the dashboard numbers while it is open
// (online bookings arrive from central without anyone touching this screen).
setInterval(() => {
  if (document.hidden) return;
  if (currentTab() === 'dashboard') loadDashboard().catch(() => {});
  else loadState($('dash-day').value).catch(() => {});
}, 3000);
