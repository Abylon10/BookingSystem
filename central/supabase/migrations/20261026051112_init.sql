-- Central (mainland) storage: catalog copy, ONLINE pool, online bookings, events synced from islands.
-- The app never talks to Supabase directly; only the central server does, with the service-role key.

create table listings (
  id          text primary key,
  island_id   text not null,
  kind        text not null check (kind in ('resort', 'tour')),
  name        text not null,
  location    text not null,
  description text not null,
  price_php   integer not null check (price_php >= 0),
  facilities  text[] not null default '{}',
  image       text
);

-- The online allotment. Central is the only writer.
create table online_inventory (
  listing_id text not null references listings (id),
  day        date not null,
  available  integer not null check (available >= 0),
  primary key (listing_id, day)
);

create table bookings (
  id           uuid primary key,
  request_id   text not null unique,          -- idempotency key from the app
  listing_id   text not null references listings (id),
  day          date not null,                 -- check-in / tour date
  nights       integer not null default 1 check (nights >= 1),
  qty          integer not null check (qty >= 1),
  guest_name   text not null,
  guest_email  text not null,
  id_type      text not null,
  id_last4     char(4) not null,              -- never store the full ID number
  total_php    integer not null,
  code         text not null unique,          -- BK-XXXX-YYYY
  status       text not null default 'CONFIRMED'
               check (status in ('CONFIRMED', 'REDEEMED', 'CANCELLED', 'NO_SHOW')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index bookings_guest_email_idx on bookings (guest_email);

-- Island outbox events land here; event_id makes re-delivery harmless.
create table island_events (
  event_id    text primary key,
  island_id   text not null,
  type        text not null,
  booking_id  text,
  payload     jsonb not null default '{}',
  created_at  timestamptz not null,
  received_at timestamptz not null default now()
);

alter table listings enable row level security;
alter table online_inventory enable row level security;
alter table bookings enable row level security;
alter table island_events enable row level security;
-- No policies: only the service role (central server) can read/write.

-- Atomic, idempotent online booking. Decrements every night in one transaction;
-- if any night lacks capacity the whole call fails and nothing changes.
create or replace function book_online(
  p_booking_id  uuid,
  p_request_id  text,
  p_listing_id  text,
  p_day         date,
  p_nights      integer,
  p_qty         integer,
  p_guest_name  text,
  p_guest_email text,
  p_id_type     text,
  p_id_last4    text,
  p_code        text
) returns bookings
language plpgsql
set search_path = public
as $$
declare
  existing bookings;
  price    integer;
  d        integer;
  result   bookings;
begin
  -- 1. Idempotency: the app retried a request we already handled
  --    (e.g. its connection dropped before the reply). Return the same booking.
  select * into existing from bookings where request_id = p_request_id;
  if found then
    return existing;
  end if;

  -- 2. The listing must exist; its price is needed for the total.
  select price_php into price from listings where id = p_listing_id;
  if not found then
    raise exception 'UNKNOWN_LISTING';
  end if;

  -- 3. Take p_qty units for every night. "and available >= p_qty" makes check
  --    and decrement one atomic step: Postgres locks the row, so concurrent
  --    buyers of the last room queue up and only the first one finds a match.
  --    Raising an exception rolls back the nights already taken in this call.
  for d in 0 .. p_nights - 1 loop
    update online_inventory
       set available = available - p_qty
     where listing_id = p_listing_id
       and day = p_day + d
       and available >= p_qty;
    if not found then
      raise exception 'SOLD_OUT';
    end if;
  end loop;

  -- 4. Units reserved: record the booking (status defaults to CONFIRMED,
  --    payment is mocked) and return it to the central server.
  insert into bookings (id, request_id, listing_id, day, nights, qty, guest_name, guest_email,
                        id_type, id_last4, total_php, code)
  values (p_booking_id, p_request_id, p_listing_id, p_day, p_nights, p_qty, p_guest_name,
          p_guest_email, p_id_type, p_id_last4, price * p_qty * p_nights, p_code)
  returning * into result;
  return result;
end;
$$;

-- Saga compensation: cancel and give the units back to the online pool.
create or replace function cancel_online(p_booking_id uuid) returns bookings
language plpgsql
set search_path = public
as $$
declare
  b bookings;
  d integer;
begin
  -- 1. Flip CONFIRMED -> CANCELLED atomically. A booking that is already
  --    cancelled or already checked in matches nothing, so it cannot be
  --    cancelled (or refunded) twice.
  update bookings set status = 'CANCELLED', updated_at = now()
   where id = p_booking_id and status = 'CONFIRMED'
  returning * into b;
  if not found then
    raise exception 'NOT_CANCELLABLE';
  end if;

  -- 2. Give the units back to the online pool for every night of the stay.
  for d in 0 .. b.nights - 1 loop
    update online_inventory set available = available + b.qty
     where listing_id = b.listing_id and day = b.day + d;
  end loop;
  return b;
end;
$$;

-- Only the central server (service role) may call these functions; the public
-- anon key cannot book or cancel by talking to Supabase directly.
revoke execute on function book_online from public, anon, authenticated;
revoke execute on function cancel_online from public, anon, authenticated;
