-- v2: islands own all bookings (online and walk-in). Central keeps this
-- read-only copy, fed by the islands' BOOKING_UPDATED outbox events, for the
-- dashboard, reports, and "my booking" while the owning island is offline.
create table booking_copies (
  reference      text primary key,            -- e.g. MRP-7F3K2 (prefix = owning island)
  island_id      text not null,
  source         text not null check (source in ('ONLINE', 'WALKIN')),
  package_id     text not null,
  package_name   text not null,
  day            date not null,
  nights         integer not null,
  guests         integer not null,
  guest_name     text not null,
  email          text not null default '',
  total_php      integer not null,
  status         text not null,               -- HELD, CONFIRMED, CHECKED_IN, CANCELLED, RELEASED, EXPIRED
  created_at     timestamptz not null,
  updated_at_ms  bigint not null,             -- island's change time; only newer snapshots apply
  received_at    timestamptz not null default now()
);
create index booking_copies_island_day_idx on booking_copies (island_id, day);

alter table booking_copies enable row level security;
-- No policies: only the central server (service role) reads and writes.

-- Insert or update a copy, but never let an older snapshot overwrite a newer
-- one (sync events can arrive more than once or out of order).
create or replace function upsert_booking_copy(p jsonb) returns void
language sql
set search_path = public
as $$
  insert into booking_copies (reference, island_id, source, package_id, package_name, day, nights, guests,
                              guest_name, email, total_php, status, created_at, updated_at_ms)
  values (p->>'reference', p->>'island_id', p->>'source', p->>'package_id', p->>'package_name',
          (p->>'day')::date, (p->>'nights')::int, (p->>'guests')::int, p->>'guest_name', coalesce(p->>'email', ''),
          (p->>'total_php')::int, p->>'status', (p->>'created_at')::timestamptz, (p->>'updated_at_ms')::bigint)
  on conflict (reference) do update set
    status = excluded.status, guests = excluded.guests, total_php = excluded.total_php,
    updated_at_ms = excluded.updated_at_ms, received_at = now()
  where booking_copies.updated_at_ms <= excluded.updated_at_ms;
$$;

revoke execute on function upsert_booking_copy from public, anon, authenticated;
