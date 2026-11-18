/**
 * island/console/desk.js
 *
 * The receptionist's page (desk.html). Same island server and the same
 * rules as the admin console: receptionists can check guests in, take
 * walk-ins, switch services on/off and view bookings; cancelling with a
 * refund and managing packages/staff stay with the island admin (the
 * server refuses those for receptionists anyway).
 *
 * Talks only to its own island over HTTP, so it keeps working while the
 * island is cut off from central.
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
const fmtRange = (b) => (b.end_day && b.end_day !== b.day ? `${fmtDay(b.day)} – ${fmtDay(b.end_day)}` : fmtDay(b.day));
const initials = (name) => String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || '?';

// No session -> sign-in page.
let token = null;
let me = null;
try { token = localStorage.getItem('desk-token'); me = JSON.parse(localStorage.getItem('desk-me') || 'null'); } catch { /* storage blocked */ }
if (!token || !me) location.replace('login.html');

// Calls the island API with the session token; 401 -> sign in again.
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
// Tabs
// ---------------------------------------------------------------------------

const loaders = { arrivals: () => loadArrivals(), walkin: () => loadWalkin(), services: () => loadServices(), bookings: () => loadBookings() };
function showTab(tab) {
  if (!loaders[tab]) tab = 'arrivals';
  document.querySelectorAll('#desk-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== tab));
  history.replaceState(null, '', `#${tab}`);
  loaders[tab]().catch((err) => console.warn(err));
}
const currentTab = () => document.querySelector('#desk-tabs button.active')?.dataset.tab ?? 'arrivals';
for (const b of document.querySelectorAll('#desk-tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------------------------------------------------------------------------
// Header + today's numbers (refreshed every 5 s)
// ---------------------------------------------------------------------------

let state = null;
async function loadState(day = todayStr(), guests = 1, extraDays = 0) {
  state = await api(`/api/state?day=${day}&guests=${guests}&extraDays=${extraDays}`);
  $('island-name').textContent = state.island.name;
  document.title = `${state.island.name} · Front desk`;
  const link = { lan: 'LAN', connected: 'cloud link', polling: 'cloud, HTTPS polling', connecting: 'reconnecting…' }[state.centralLink] ?? '';
  const online = !state.partitioned && state.centralLink !== 'connecting';
  $('sync-status').className = `sync ${online ? 'on' : 'off'}`;
  $('sync-status').innerHTML = `<span class="dot"></span>${esc(state.partitioned ? 'Offline from central (bookings still work here)' : `Central: ${link}`)}${state.outboxPending ? ` · ${state.outboxPending} to sync` : ''}`;
  return state;
}
async function loadKpis() {
  const o = await api(`/api/overview?day=${todayStr()}`);
  $('k-left').textContent = Math.max(0, o.arrivals - o.checkedIn);
  $('k-in').textContent = o.checkedIn;
  $('k-walk').textContent = o.walkins;
  $('k-online').textContent = o.online;
  $('k-off').textContent = o.servicesOff;
}

// ---------------------------------------------------------------------------
// Online / Walk-in checkboxes
// ---------------------------------------------------------------------------

const ticked = (id) => new Set([...document.querySelectorAll(`#${id} input:checked`)].map((c) => c.value));
const bySource = (rows, id) => { const on = ticked(id); return rows.filter((b) => on.has(b.source)); };
const countText = (rows) => `${rows.length} booking(s) · ${rows.filter((b) => b.source === 'ONLINE').length} online · ${rows.filter((b) => b.source === 'WALKIN').length} walk-in`;

// ---------------------------------------------------------------------------
// Arrivals: cards with the ID to check and a big Check in button
// ---------------------------------------------------------------------------

let query = '';
let arrRows = [];

function card(b) {
  const canCheckIn = b.status === 'CONFIRMED';
  return `<article class="arr-card ${b.status === 'CHECKED_IN' ? 'done' : ''}">
    <div class="arr-head">
      <span class="avatar">${esc(initials(b.guest_name))}</span>
      <div><b>${esc(b.guest_name)}</b><span class="ref">${esc(b.reference)}</span></div>
      <span class="badge ${esc(b.source)}">${b.source === 'ONLINE' ? 'Online' : 'Walk-in'}</span>
    </div>
    <p class="arr-what">${esc(b.package_name)}</p>
    <p class="arr-meta">${fmtRange(b)} · ${b.guests} guest(s)</p>
    <div class="idbox">Check ID: <b>${esc(b.id_type)}</b> ending <b>${esc(b.id_last4)}</b></div>
    <div class="arr-foot">
      <span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span>
      ${canCheckIn ? `<button class="ok big-btn" data-checkin="${esc(b.reference)}">ID matches — Check in</button>`
        : `<button class="ghost" data-details="${esc(b.reference)}">Details</button>`}
    </div>
  </article>`;
}

async function loadArrivals() {
  const day = $('arr-day').value;
  arrRows = query ? await api(`/api/bookings?q=${encodeURIComponent(query)}`) : await api(`/api/bookings?day=${day}`);
  const shown = bySource(arrRows, 'arr-src');
  $('arr-title').innerHTML = `${query ? `Search: “${esc(query)}”` : day === todayStr() ? "Today's arrivals" : `Arrivals · ${fmtDay(day)}`} · ${countText(shown)}`
    + (query ? ' · <button class="link" id="clear">Show the day’s arrivals</button>' : '');
  $('arr-cards').innerHTML = shown.map(card).join('')
    || `<p class="desk-empty">${query ? 'No booking matches that reference or name on this island.' : `No arrivals on ${fmtDay(day)}.`}</p>`;
}
$('find').addEventListener('submit', (e) => { e.preventDefault(); query = $('q').value.trim(); loadArrivals(); });
$('arr-day').addEventListener('change', () => { query = ''; $('q').value = ''; loadArrivals(); });
$('arr-src').addEventListener('change', () => loadArrivals());
$('arrivals').addEventListener('click', (e) => {
  const d = e.target.closest('button')?.dataset ?? {};
  if (e.target.id === 'clear') { query = ''; $('q').value = ''; loadArrivals(); }
  if (d.checkin) checkIn(d.checkin);
  if (d.details) openDetails(arrRows.find((b) => b.reference === d.details));
});

async function checkIn(ref) {
  try { await api(`/api/bookings/${ref}/checkin`, {}); } catch (err) { alert(err.message); }
  closeModal();
  loadArrivals();
  loadKpis().catch(() => {});
}

// ---------------------------------------------------------------------------
// Details dialog (view only for receptionists)
// ---------------------------------------------------------------------------

function openDetails(b) {
  if (!b) return;
  $('m-title').textContent = b.reference;
  $('m-body').innerHTML = `
    <div class="idbox">Check the guest's ID: <b>${esc(b.guest_name)}</b> · ${esc(b.id_type)} ending <b>${esc(b.id_last4)}</b></div>
    <dl class="dl">
      <dt>Status</dt><dd><span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></dd>
      <dt>Booking</dt><dd>${esc(b.package_name)}</dd>
      <dt>Dates</dt><dd>${fmtRange(b)} · ${b.days} day(s)</dd>
      <dt>Services</dt><dd>${(b.services ?? []).map((s) => `${esc(s.name)} × ${s.qty}`).join('<br>')}</dd>
      <dt>Guests</dt><dd>${b.guests}</dd>
      <dt>Booked</dt><dd>${b.source === 'ONLINE' ? 'Online (app)' : 'Walk-in (desk)'}</dd>
      <dt>Paid</dt><dd>${peso(b.total_php)}${b.refund_php ? ` · refunded ${peso(b.refund_php)}` : ''}</dd>
      ${b.phone ? `<dt>Phone</dt><dd>${esc(b.phone)}</dd>` : ''}
    </dl>`;
  $('m-actions').innerHTML = b.status === 'CONFIRMED' ? `<button class="ok" data-checkin="${esc(b.reference)}">ID matches — Check in</button>` : '';
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }
$('m-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') return closeModal();
  const ref = e.target.closest('button')?.dataset.checkin;
  if (ref) checkIn(ref);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------------------------------------------------------------------------
// Walk-in: package (+ extra days) or build your own, with a live price
// ---------------------------------------------------------------------------

let walkMode = 'package';

async function loadWalkin() {
  const st = await loadState($('w-day').value, Number($('w-guests').value) || 1, Number($('w-extra').value) || 0);
  const chosen = $('w-package').value;
  $('w-package').innerHTML = st.packages.map((p) =>
    `<option value="${esc(p.id)}" ${p.available ? '' : 'disabled'}>${esc(p.name)}${p.available ? '' : ` — ${esc(p.reason)}`}</option>`).join('');
  if (chosen && st.packages.some((p) => p.id === chosen && p.available)) $('w-package').value = chosen;
  const picked = Object.fromEntries([...document.querySelectorAll('#w-services input[type=number]')].map((i) => [i.dataset.svc, i.value]));
  const tickedSvc = new Set([...document.querySelectorAll('#w-services input[type=checkbox]:checked')].map((i) => i.dataset.svc));
  $('w-services').innerHTML = st.services.map((s) => `
    <label class="svc ${s.available ? '' : 'svc-off'}">
      <input type="checkbox" data-svc="${esc(s.id)}" ${s.available ? '' : 'disabled'} ${tickedSvc.has(s.id) && s.available ? 'checked' : ''}>
      <span><b>${esc(s.name)}</b><small>${peso(s.price_php)} per ${esc(s.unit)} per day${s.available ? '' : ` · ${esc(s.reason)}`}</small></span>
      <input type="number" min="1" value="${esc(picked[s.id] ?? (s.unit === 'room' ? 1 : $('w-guests').value))}" data-svc="${esc(s.id)}" title="Quantity">
    </label>`).join('');
  quote();
}
function walkinRequest() {
  const base = { day: $('w-day').value, guests: Number($('w-guests').value) || 1 };
  if (walkMode === 'package') return { ...base, packageId: $('w-package').value, extraDays: Number($('w-extra').value) || 0 };
  const items = [...document.querySelectorAll('#w-services input[type=checkbox]:checked')].map((c) => ({
    serviceId: c.dataset.svc, qty: Number(document.querySelector(`#w-services input[type=number][data-svc="${c.dataset.svc}"]`).value) || 1,
  }));
  return { ...base, items, days: Number($('w-days').value) || 1 };
}
async function quote() {
  $('w-note').textContent = '';
  const req = walkinRequest();
  if (walkMode === 'custom' && !req.items.length) { $('w-total').textContent = 'Tick the services to include'; return; }
  if (walkMode === 'package' && !req.packageId) { $('w-total').textContent = 'No package available on this date'; return; }
  try {
    const q = await api('/api/quote', req);
    $('w-total').textContent = `${peso(q.total_php)} · ${fmtRange({ day: req.day, end_day: q.end_day })} · ${q.days} day(s)`;
    if (q.unavailable_services.length) $('w-note').textContent = `${q.unavailable_services.map((s) => s.name).join(', ')} unavailable`;
  } catch (err) { $('w-total').textContent = ''; $('w-note').textContent = err.message; }
}
$('w-mode').addEventListener('click', (e) => {
  const mode = e.target.dataset.mode;
  if (!mode) return;
  walkMode = mode;
  document.querySelectorAll('#w-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.querySelectorAll('.w-package').forEach((el) => el.classList.toggle('hidden', mode !== 'package'));
  document.querySelectorAll('.w-custom').forEach((el) => el.classList.toggle('hidden', mode !== 'custom'));
  quote();
});
['w-day', 'w-guests', 'w-extra', 'w-days'].forEach((id) => $(id).addEventListener('change', loadWalkin));
$('w-package').addEventListener('change', quote);
$('w-services').addEventListener('change', quote);
$('walkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('walkin-result');
  try {
    const b = await api('/api/walkin', {
      ...walkinRequest(), requestId: crypto.randomUUID(), guestName: $('w-name').value, phone: $('w-phone').value,
      idType: $('w-idtype').value, idLast4: $('w-last4').value,
    });
    out.innerHTML = `<div class="result ok">Booked <b>${esc(b.reference)}</b> for ${esc(b.guest_name)}: ${esc(b.package_name)}, ${fmtRange(b)}. Collect <b>${peso(b.total_php)}</b>.</div>`;
    ['w-name', 'w-phone', 'w-last4'].forEach((id) => { $(id).value = ''; });
    loadWalkin();
    loadKpis().catch(() => {});
  } catch (err) { out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`; }
});

// ---------------------------------------------------------------------------
// Services on/off and how the packages look on that date
// ---------------------------------------------------------------------------

async function loadServices() {
  const day = $('sv-day').value;
  const st = await loadState(day, 1);
  const inv = Object.fromEntries(st.inventory.map((i) => [i.id, i]));
  const offIds = new Set(st.services.filter((s) => s.reason?.startsWith('Unavailable')).map((s) => s.id));
  $('sv-list').innerHTML = st.services.map((s) => {
    const off = offIds.has(s.id);
    const i = inv[s.id] ?? {};
    return `<div class="switch-row ${off ? 'is-off' : ''}">
      <div><b>${esc(s.name)}</b><span>${esc(s.kind)} · ${i.booked ?? 0} of ${i.capacity ?? 0} booked</span></div>
      <label class="switch"><input type="checkbox" data-svc="${esc(s.id)}" ${off ? '' : 'checked'}><span></span></label>
      <em>${off ? 'Unavailable' : 'Available'}</em>
    </div>`;
  }).join('');
  $('sv-packages').innerHTML = st.packages.map((p) => `
    <div class="pkg ${p.available ? '' : 'pkg-off'}">
      <div class="pkg-top"><b>${esc(p.name)}</b><span class="price">${peso(p.price_php)}${p.pricing === 'per_guest' ? ' /guest' : ''}</span></div>
      <ul>${p.items.map((it) => `<li class="${offIds.has(it.service_id) ? 'svc-x' : ''}">${esc(it.name)}${offIds.has(it.service_id) ? ' <em>unavailable</em>' : ''}</li>`).join('')}</ul>
      ${p.available ? '<span class="state ok">Available</span>' : `<span class="state bad">${esc(p.reason)}</span>`}
    </div>`).join('');
}
$('sv-day').addEventListener('change', loadServices);
$('sv-list').addEventListener('change', async (e) => {
  const id = e.target.dataset.svc;
  if (!id) return;
  const out = $('sv-result');
  try {
    const r = await api('/api/checklist', { serviceId: id, day: $('sv-day').value, off: !e.target.checked });
    out.innerHTML = r.off && r.affected.length
      ? `<div class="result bad">${esc(r.service)} is off. Already booked that day: ${r.affected.map((a) => `${esc(a.reference)} (${esc(a.guest_name)})`).join(', ')}, please contact them.</div>`
      : `<div class="result ok">${esc(r.service)} is ${r.off ? 'off' : 'on'} for ${fmtDay($('sv-day').value)}.</div>`;
  } catch (err) { out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`; }
  loadServices();
  loadKpis().catch(() => {});
});

// ---------------------------------------------------------------------------
// Bookings (view only)
// ---------------------------------------------------------------------------

let bkRows = [];
async function loadBookings() {
  bkRows = await api('/api/bookings');
  const shown = bySource(bkRows, 'bk-src');
  $('bk-count').textContent = `${countText(shown)} · newest first. Ask an island admin to cancel or refund.`;
  $('bk-list').innerHTML = shown.map((b) => `<tr class="click" data-ref="${esc(b.reference)}"><td class="ref">${esc(b.reference)}</td>
    <td><span class="badge ${esc(b.source)}">${b.source === 'ONLINE' ? 'Online' : 'Walk-in'}</span></td>
    <td>${esc(b.package_name)}</td><td>${fmtRange(b)}</td><td>${b.guests}</td><td>${esc(b.guest_name)}</td><td>${peso(b.total_php)}</td>
    <td><span class="badge ${esc(b.status)}">${esc(b.status.replace('_', ' '))}</span></td></tr>`).join('')
    || '<tr><td colspan="8" class="muted">No bookings yet</td></tr>';
}
$('bk-src').addEventListener('change', () => loadBookings());
$('bk-list').addEventListener('click', (e) => {
  const ref = e.target.closest('tr')?.dataset.ref;
  if (ref) openDetails(bkRows.find((b) => b.reference === ref));
});

// ---------------------------------------------------------------------------
// Day / night
// ---------------------------------------------------------------------------

function showTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme-btn').textContent = dark ? '☀' : '☾';
  $('theme-btn').title = dark ? 'Switch to day' : 'Switch to night';
}
$('theme-btn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('desk-theme', next); } catch { /* ignore */ }
  showTheme();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('avatar').textContent = me ? me.user.slice(0, 2) : '?';
$('avatar').title = me ? `${me.user} · ${me.role === 'node_admin' ? 'Island admin' : 'Receptionist'}` : '';
$('admin-link').classList.toggle('hidden', me?.role !== 'node_admin'); // admins can switch back
$('today').textContent = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' });
for (const id of ['arr-day', 'w-day', 'sv-day']) $(id).value = todayStr();
showTheme();
loadState().catch(() => {});
loadKpis().catch(() => {});
showTab((location.hash || '#arrivals').slice(1));

// Every 5 s: link status and today's numbers; the arrivals list too, so
// online bookings arriving from central appear without a refresh.
setInterval(() => {
  if (document.hidden) return;
  loadState().catch(() => {});
  loadKpis().catch(() => {});
  if (currentTab() === 'arrivals' && !query) loadArrivals().catch(() => {});
}, 5000);
