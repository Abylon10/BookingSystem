-- Islands registered by the central admin after the three built-in ones
-- (config/seed.json). id is the node's name (npm run island -- <id>),
-- prefix starts its booking references (e.g. PAL-7F3K2).
create table if not exists registered_islands (
  id          text primary key check (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  name        text not null,
  prefix      text not null unique check (prefix ~ '^[A-Z]{3}$'),
  created_at  timestamptz not null default now()
);
alter table registered_islands enable row level security;
-- No policies: only the central server (service role) reads and writes.
