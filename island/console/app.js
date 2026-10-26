/**
 * island/console/app.js
 *
 * Front desk console, served by the island node and opened in the laptop's
 * browser. Talks only to its own island over HTTP (same origin), so it keeps
 * working when the island is cut off from central.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Shorthand for document.getElementById.
const $ = (id) => document.getElementById(id);

// Formats a number as Philippine pesos, e.g. 2800 -> "₱2,800".
const peso = (n) => `₱${Number(n).toLocaleString('en-PH')}`;

// Escapes text before putting it into innerHTML, so a guest name like
// "<script>" is shown as text instead of running as code.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Calls the island API. GET when no body is given, POST with JSON otherwise.
// Throws with the server's error message when the response is not 2xx.
async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// ---------------------------------------------------------------------------
// Dashboard refresh (runs on load and every 3 seconds)
// ---------------------------------------------------------------------------

async function refresh() {
  // Header, partition switch and sync status.
  const state = await api('/api/state');
  $('island-name').textContent = state.island.name;
  $('partition').checked = state.partitioned;
  $('sync-status').textContent = state.partitioned
    ? `Offline from central — ${state.outboxPending} event(s) waiting to sync`
    : `Connected — ${state.outboxPending} event(s) waiting to sync`;

  // Walk-in units left today per listing.
  $('listings').innerHTML = state.listings.map((l) =>
    `<li><span>${esc(l.name)} <span class="price">${peso(l.price_php)}</span></span>
         <strong>${l.walkin_available ?? 0} left</strong></li>`).join('');

  // Fill the listing dropdown of the walk-in form once (not on every refresh,
  // otherwise the staff member's selection would keep resetting).
  if (!$('w-listing').options.length) {
    $('w-listing').innerHTML = state.listings.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  }

  // Recent bookings table.
  const bookings = await api('/api/bookings');
  $('bookings').innerHTML = bookings.map((b) => `<tr>
      <td>${esc(b.code)}</td><td>${esc(b.source)}</td><td>${esc(b.listing_id)}</td><td>${esc(b.day)}</td>
      <td>${esc(b.guest_name)}</td><td><span class="badge ${esc(b.status)}">${esc(b.status)}</span></td></tr>`).join('');
}

// ---------------------------------------------------------------------------
// "Disconnect from Central" switch
// ---------------------------------------------------------------------------

$('partition').addEventListener('change', async (e) => {
  await api('/api/partition', { on: e.target.checked });
  refresh();
});

// ---------------------------------------------------------------------------
// Check-in: verify the code/QR, show the guest, then confirm after the ID check
// ---------------------------------------------------------------------------

$('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('verify-result');
  try {
    // A pasted QR payload always contains a "." (body.signature); a typed
    // BK-XXXX-YYYY code never does. Send whichever one this is.
    const input = $('code').value.trim();
    const v = await api('/api/verify', input.includes('.') ? { qr: input } : { code: input });

    // Not usable (invalid, unknown, cancelled, already checked in): show why.
    if (v.result !== 'VALID') {
      out.innerHTML = `<div class="result bad"><strong>${esc(v.result)}</strong> ${esc(v.reason ?? '')}</div>`;
      return;
    }

    // Valid: show name + ID hint so staff can compare with the physical ID.
    const b = v.booking;
    out.innerHTML = `<div class="result ok">
        <strong>${esc(b.guest_name)}</strong> — ${esc(b.id_type)} ending <strong>${esc(b.id_last4)}</strong><br>
        ${esc(b.listing_id)} · ${esc(b.day)} · qty ${b.qty} · ${esc(b.source)}<br><br>
        <button class="confirm" id="confirm-btn">ID matches — Check in</button></div>`;

    // Confirm button: redeem the booking (the server guarantees "once only").
    $('confirm-btn').onclick = async () => {
      const r = await api('/api/redeem', { bookingId: b.id });
      out.innerHTML = `<div class="result ${r.ok ? 'ok' : 'bad'}"><strong>${esc(r.result)}</strong></div>`;
      refresh();
    };
  } catch (err) {
    out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`;
  }
});

// ---------------------------------------------------------------------------
// Walk-in booking form
// ---------------------------------------------------------------------------

$('walkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('walkin-result');
  try {
    // A new random requestId per submit; the server uses it to ignore repeats.
    const { booking } = await api('/api/walkin', {
      requestId: crypto.randomUUID(),
      listingId: $('w-listing').value,
      day: $('w-day').value,
      nights: Number($('w-nights').value),
      qty: Number($('w-qty').value),
      guestName: $('w-name').value,
      idType: $('w-idtype').value,
      idLast4: $('w-last4').value,
    });
    out.innerHTML = `<div class="result ok">Booked <strong>${esc(booking.code)}</strong> — ${peso(booking.total_php)}</div>`;
    refresh();
  } catch (err) {
    out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`;
  }
});

// ---------------------------------------------------------------------------
// Start: default the date picker to today, load data, keep it fresh
// ---------------------------------------------------------------------------

$('w-day').value = new Date().toISOString().slice(0, 10);
refresh();
setInterval(refresh, 3000);
