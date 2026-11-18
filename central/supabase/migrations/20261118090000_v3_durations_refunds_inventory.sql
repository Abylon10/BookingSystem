-- v3: bookings can span extra days or be build-your-own trips, and a
-- cancellation records a refund. Central also keeps a copy of every
-- island's inventory (per service per day) for the Inventory page.

alter table booking_copies
  add column if not exists end_day     date,
  add column if not exists days        integer not null default 1,
  add column if not exists extra_days  integer not null default 0,
  add column if not exists refund_php  integer not null default 0;

-- Same rule as before (an older snapshot never overwrites a newer one), now
-- with the new fields; package_name can change (custom trips are named by
-- their services).
create or replace function upsert_booking_copy(p jsonb) returns void
language sql
set search_path = public
as $$
  insert into booking_copies (reference, island_id, source, package_id, package_name, day, end_day, nights, days, extra_days,
                              guests, guest_name, email, total_php, refund_php, status, created_at, updated_at_ms)
  values (p->>'reference', p->>'island_id', p->>'source', p->>'package_id', p->>'package_name',
          (p->>'day')::date, nullif(p->>'end_day', '')::date, (p->>'nights')::int, coalesce((p->>'days')::int, 1),
          coalesce((p->>'extra_days')::int, 0), (p->>'guests')::int, p->>'guest_name', coalesce(p->>'email', ''),
          (p->>'total_php')::int, coalesce((p->>'refund_php')::int, 0), p->>'status',
          (p->>'created_at')::timestamptz, (p->>'updated_at_ms')::bigint)
  on conflict (reference) do update set
    status = excluded.status, guests = excluded.guests, total_php = excluded.total_php,
    refund_php = excluded.refund_php, end_day = excluded.end_day, days = excluded.days,
    extra_days = excluded.extra_days, package_name = excluded.package_name,
    updated_at_ms = excluded.updated_at_ms, received_at = now()
  where booking_copies.updated_at_ms <= excluded.updated_at_ms;
$$;
revoke execute on function upsert_booking_copy from public, anon, authenticated;

-- Central's copy of island inventory, refreshed whenever central reads an
-- island's inventory live; shown (marked stale) while that island is offline.
create table if not exists inventory_copies (
  island_id     text not null,
  service_id    text not null,
  day           date not null,
  service_name  text not null,
  kind          text not null,
  capacity      integer not null,
  booked        integer not null,
  blocked       integer not null default 0,
  off           boolean not null default false,
  price_php     integer not null default 0,
  synced_at     timestamptz not null default now(),
  primary key (island_id, service_id, day)
);
alter table inventory_copies enable row level security;
-- No policies: only the central server (service role) reads and writes.

create index if not exists booking_copies_email_idx on booking_copies (lower(email));
