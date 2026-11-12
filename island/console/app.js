/**
 * island/console/app.js
 *
 * Front desk console (v2): sign in, then Arrivals / Walk-in / Availability /
 * Bookings / Staff. Talks only to its own island over HTTP, so it keeps
 * working when the island is cut off from central.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const peso = (n) => `₱${Number(n).toLocaleString('en-PH')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });

let token = null;
try { token = localStorage.getItem('desk-token'); } catch { /* storage blocked */ }
let me = null;
let packages = [];

// Calls the island API with the session token; 401 shows the sign-in screen.
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (res.status === 401 && !path.startsWith('/api/login')) { showAuth(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// ---------------------------------------------------------------------------
// Sign-in and first-run setup
// ---------------------------------------------------------------------------

let setupMode = false;
async function showAuth() {
  const s = await (await fetch('/api/session')).json();
  setupMode = s.needsSetup;
  $('auth-island').textContent = s.island.name;
  $('auth-hint').textContent = setupMode ? 'First run: create the node admin account for this island' : 'Front desk sign in';
  $('auth-btn').textContent = setupMode ? 'Create node admin' : 'Sign in';
  $('auth').classList.remove('hidden');
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const res = await fetch(setupMode ? '/api/setup' : '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('auth-user').value, password: $('auth-pass').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('auth-error').textContent = data.error; return; }
  saveSession(data);
  $('auth-pass').value = '';
  $('auth').classList.add('hidden');
  start();
});

function saveSession(s) {
  token = s.token;
  me = { user: s.user, role: s.role };
  try { localStorage.setItem('desk-token', token); localStorage.setItem('desk-me', JSON.stringify(me)); } catch { /* ignore */ }
}
$('logout').addEventListener('click', () => {
  token = null;
  try { localStorage.removeItem('desk-token'); } catch { /* ignore */ }
  showAuth();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== b.dataset.tab));
    refreshTab(b.dataset.tab);
  });
}
const currentTab = () => document.querySelector('#tabs button.active').dataset.tab;
function refreshTab(tab) {
  ({ arrivals: loadArrivals, walkin: updateTotal, availability: loadAvailability, bookings: loadBookings, staff: loadStaff }[tab] ?? (() => {}))();
}

// ---------------------------------------------------------------------------
// Header: link status and partition switch (refreshed every 3 s)
// ---------------------------------------------------------------------------

async function loadHeader() {
  const s = await api(`/api/state?day=${$('w-day').value || todayStr()}&guests=${$('w-guests').value || 1}`);
  $('island-name').textContent = s.island.name;
  document.title = `${s.island.name} · Front desk`;
  $('partition').checked = s.partitioned;
  const link = { lan: 'LAN', connected: 'cloud link', polling: 'cloud, HTTPS polling', connecting: 'reconnecting…' }[s.centralLink] ?? '';
  $('sync-status').textContent = s.partitioned
    ? `Offline from central — ${s.outboxPending} change(s) waiting to sync`
    : `Connected (${link}) — ${s.outboxPending} change(s) waiting to sync`;
  packages = s.packages;
  if (!$('w-package').options.length) {
    $('w-package').innerHTML = s.packages.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    $('b-service').innerHTML = s.inventory.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');
  }
  updateTotal();
}
$('partition').addEventListener('change', async (e) => { await api('/api/partition', { on: e.target.checked }); loadHeader(); });

// ---------------------------------------------------------------------------
// Arrivals: search + confirm arrival after the ID check
// ---------------------------------------------------------------------------

function bookingItem(b) {
  const canCheckIn = b.status === 'CONFIRMED';
  return `<div class="item">
    <div>
      <b>${esc(b.guest_name)}</b> · <span class="muted">${esc(b.reference)}</span>
      <span class="badge ${esc(b.source)}">${b.source === 'ONLINE' ? 'Online' : 'Walk-in'}</span>
      <span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span>
      <div class="meta">${esc(b.package_name)} · ${fmtDay(b.day)} · ${b.guests} guest(s) · ${peso(b.total_php)}</div>
      ${canCheckIn ? `<div class="idcheck">Check ID: <b>${esc(b.guest_name)}</b> · ${esc(b.id_type)} ending <b>${esc(b.id_last4)}</b></div>` : ''}
    </div>
    <div>${canCheckIn ? `<button class="ok" data-checkin="${esc(b.reference)}">ID matches — Check in</button>` : ''}</div>
  </div>`;
}
async function loadArrivals(q) {
  const query = q ?? $('find-q').value.trim();
  const list = query ? await api(`/api/bookings?q=${encodeURIComponent(query)}`) : await api(`/api/bookings?day=${$('arr-day').value}`);
  $('arr-list').innerHTML = list.map(bookingItem).join('')
    || `<p class="muted">${query ? 'No booking matches that reference or name on this island.' : `No arrivals on ${fmtDay($('arr-day').value)}.`}</p>`;
}
$('find-form').addEventListener('submit', (e) => { e.preventDefault(); loadArrivals(); });
$('arr-day').addEventListener('change', () => { $('find-q').value = ''; loadArrivals(''); });
$('arr-list').addEventListener('click', async (e) => {
  const ref = e.target.dataset?.checkin;
  if (!ref) return;
  try { await api(`/api/bookings/${ref}/checkin`, {}); } catch (err) { alert(err.message); }
  loadArrivals();
});

// ---------------------------------------------------------------------------
// Walk-in booking
// ---------------------------------------------------------------------------

function updateTotal() {
  const p = packages.find((x) => x.id === $('w-package').value);
  if (!p) return;
  const g = Number($('w-guests').value) || 1;
  $('w-guests').max = p.max_guests;
  const total = p.pricing === 'per_guest' ? p.price_php * g : p.price_php;
  $('w-total').textContent = `${peso(total)} · ${p.available ? `${p.spots} left` : 'sold out'} · up to ${p.max_guests} guests`;
}
['w-package', 'w-guests', 'w-day'].forEach((id) => $(id).addEventListener('change', () => loadHeader()));

$('walkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('walkin-result');
  try {
    const b = await api('/api/walkin', {
      requestId: crypto.randomUUID(), packageId: $('w-package').value, day: $('w-day').value,
      guests: Number($('w-guests').value), guestName: $('w-name').value, phone: $('w-phone').value,
      email: $('w-email').value, idType: $('w-idtype').value, idLast4: $('w-last4').value,
    });
    out.innerHTML = `<div class="result ok">Booked <b>${esc(b.reference)}</b> for ${esc(b.guest_name)} — ${peso(b.total_php)} collected.</div>`;
    $('walkin-form').reset();
    $('w-day').value = todayStr();
    loadHeader();
  } catch (err) {
    out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`;
  }
});

// ---------------------------------------------------------------------------
// Availability + mark unavailable
// ---------------------------------------------------------------------------

async function loadAvailability() {
  const s = await api(`/api/state?day=${$('av-day').value}&guests=${$('av-guests').value || 1}`);
  $('av-packages').innerHTML = s.packages.map((p) => `<div class="item"><div><b>${esc(p.name)}</b>
      <div class="meta">${p.nights ? `${p.nights} night(s)` : 'Day trip'} · up to ${p.max_guests} · ${peso(p.total_php)} for ${s.guests}</div></div>
      <div>${p.available ? `<span class="badge">${p.spots} left</span>` : '<span class="badge sold">Sold out</span>'}</div></div>`).join('');
  $('av-services').innerHTML = s.inventory.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.capacity ?? '—'}</td><td>${i.booked ?? '—'}</td>
      <td>${i.blocked ?? '—'}</td><td><b>${i.free ?? '—'}</b></td>
      <td>${i.blocked ? `<button class="link" data-unblock="${esc(i.id)}">Make available</button>` : ''}</td></tr>`).join('');
}
['av-day', 'av-guests'].forEach((id) => $(id).addEventListener('change', loadAvailability));
$('av-services').addEventListener('click', async (e) => {
  const id = e.target.dataset?.unblock;
  if (!id) return;
  await api('/api/blocks/release', { serviceId: id, day: $('av-day').value, units: 0 });
  loadAvailability();
});
$('block-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('block-result');
  try {
    await api('/api/blocks', { serviceId: $('b-service').value, day: $('b-day').value, days: Number($('b-days').value), units: Number($('b-units').value), reason: $('b-reason').value });
    out.innerHTML = '<div class="result ok">Marked unavailable. Online and walk-in sales now skip those units.</div>';
    $('av-day').value = $('b-day').value;
    loadAvailability();
  } catch (err) {
    out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`;
  }
});

// ---------------------------------------------------------------------------
// Bookings list
// ---------------------------------------------------------------------------

async function loadBookings() {
  const list = await api('/api/bookings');
  $('bk-list').innerHTML = list.map((b) => `<tr><td><b>${esc(b.reference)}</b></td>
    <td><span class="badge ${esc(b.source)}">${b.source === 'ONLINE' ? 'Online' : 'Walk-in'}</span></td>
    <td>${esc(b.package_name)}</td><td>${esc(b.day)}</td><td>${b.guests}</td><td>${esc(b.guest_name)}</td><td>${peso(b.total_php)}</td>
    <td><span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></td>
    <td>${['CONFIRMED', 'HELD'].includes(b.status) ? `<button class="danger" data-cancel="${esc(b.reference)}">Cancel</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="9" class="muted">No bookings yet</td></tr>';
}
$('bk-list').addEventListener('click', async (e) => {
  const ref = e.target.dataset?.cancel;
  if (!ref || !confirm(`Cancel ${ref}? Its units go back on sale.`)) return;
  try { await api(`/api/bookings/${ref}/cancel`, {}); } catch (err) { alert(err.message); }
  loadBookings();
});

// ---------------------------------------------------------------------------
// Staff (node admin)
// ---------------------------------------------------------------------------

async function loadStaff() {
  const list = await api('/api/staff');
  $('staff-list').innerHTML = list.map((u) => `<tr><td>${esc(u.username)}</td><td>${u.role === 'node_admin' ? 'Node admin' : 'Receptionist'}</td>
    <td>${u.active ? 'Active' : 'Disabled'}</td>
    <td>${u.role === 'receptionist' ? `<button class="link" data-user="${esc(u.username)}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}</td></tr>`).join('');
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
    $('staff-result').textContent = `Added ${$('s-user').value}.`;
    $('staff-form').reset();
    loadStaff();
  } catch (err) {
    $('staff-result').textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function start() {
  try { me = JSON.parse(localStorage.getItem('desk-me') || 'null'); } catch { /* ignore */ }
  $('who').textContent = me ? `${me.user} · ${me.role === 'node_admin' ? 'Node admin' : 'Receptionist'}` : '';
  $('tab-staff').classList.toggle('hidden', me?.role !== 'node_admin');
  loadHeader().then(() => refreshTab(currentTab())).catch(() => {});
}
for (const id of ['arr-day', 'w-day', 'av-day', 'b-day']) $(id).value = todayStr();
if (token) start(); else showAuth();
setInterval(() => { if (token && !document.hidden) loadHeader().catch(() => {}); }, 3000);
