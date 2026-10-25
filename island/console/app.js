const $ = (id) => document.getElementById(id);
const peso = (n) => `₱${Number(n).toLocaleString('en-PH')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

async function refresh() {
  const state = await api('/api/state');
  $('island-name').textContent = state.island.name;
  $('partition').checked = state.partitioned;
  $('sync-status').textContent = state.partitioned
    ? `Offline from central — ${state.outboxPending} event(s) waiting to sync`
    : `Connected — ${state.outboxPending} event(s) waiting to sync`;
  $('listings').innerHTML = state.listings.map((l) =>
    `<li><span>${esc(l.name)} <span class="price">${peso(l.price_php)}</span></span>
         <strong>${l.walkin_available ?? 0} left</strong></li>`).join('');
  if (!$('w-listing').options.length) {
    $('w-listing').innerHTML = state.listings.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
  }

  const bookings = await api('/api/bookings');
  $('bookings').innerHTML = bookings.map((b) => `<tr>
      <td>${esc(b.code)}</td><td>${esc(b.source)}</td><td>${esc(b.listing_id)}</td><td>${esc(b.day)}</td>
      <td>${esc(b.guest_name)}</td><td><span class="badge ${esc(b.status)}">${esc(b.status)}</span></td></tr>`).join('');
}

$('partition').addEventListener('change', async (e) => {
  await api('/api/partition', { on: e.target.checked });
  refresh();
});

$('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('verify-result');
  try {
    const input = $('code').value.trim();
    // A pasted QR payload contains a dot; a typed code does not.
    const v = await api('/api/verify', input.includes('.') ? { qr: input } : { code: input });
    if (v.result !== 'VALID') {
      out.innerHTML = `<div class="result bad"><strong>${esc(v.result)}</strong> ${esc(v.reason ?? '')}</div>`;
      return;
    }
    const b = v.booking;
    out.innerHTML = `<div class="result ok">
        <strong>${esc(b.guest_name)}</strong> — ${esc(b.id_type)} ending <strong>${esc(b.id_last4)}</strong><br>
        ${esc(b.listing_id)} · ${esc(b.day)} · qty ${b.qty} · ${esc(b.source)}<br><br>
        <button class="confirm" id="confirm-btn">ID matches — Check in</button></div>`;
    $('confirm-btn').onclick = async () => {
      const r = await api('/api/redeem', { bookingId: b.id });
      out.innerHTML = `<div class="result ${r.ok ? 'ok' : 'bad'}"><strong>${esc(r.result)}</strong></div>`;
      refresh();
    };
  } catch (err) {
    out.innerHTML = `<div class="result bad">${esc(err.message)}</div>`;
  }
});

$('walkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('walkin-result');
  try {
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

$('w-day').value = new Date().toISOString().slice(0, 10);
refresh();
setInterval(refresh, 3000);
