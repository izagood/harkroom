create table account (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  display_name text not null,
  kind text not null check (kind in ('human','agent')),
  is_admin boolean not null default false,
  password_hash text,
  created_at timestamptz not null default now()
);

create table session (
  token_hash text primary key,
  account_id uuid not null references account(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table pat (
  token_hash text primary key,
  account_id uuid not null references account(id),
  label text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table invite (
  token_hash text primary key,
  created_by uuid not null references account(id),
  used_by uuid references account(id),
  created_at timestamptz not null default now()
);

create table account_key (
  key_id text primary key,
  account_id uuid not null references account(id),
  public_key_pem text not null,
  created_at timestamptz not null default now()
);

create table channel (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  topic text not null default '',
  kind text not null check (kind in ('standard','dm')),
  repo text,
  created_at timestamptz not null default now()
);

create table channel_member (
  channel_id uuid not null references channel(id),
  account_id uuid not null references account(id),
  primary key (channel_id, account_id)
);

create table message (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  channel_id uuid not null references channel(id),
  thread_root_id uuid references message(id),
  author_id uuid not null references account(id),
  body text not null,
  kind text not null check (kind in ('user','system')),
  meta jsonb not null default '{}',
  signature text,
  search tsvector generated always as (to_tsvector('simple', body)) stored,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index message_channel_seq on message (channel_id, seq);
create index message_search_idx on message using gin (search);
create unique index message_avcs_oid
  on message ((meta->>'repo'), (meta->>'oid'))
  where kind = 'system' and meta ? 'oid';

create table work_thread (
  repo text not null,
  intent_oid text not null,
  thread_root_message_id uuid not null references message(id),
  primary key (repo, intent_oid)
);

create table inbox (
  id bigint generated always as identity primary key,
  account_id uuid not null references account(id),
  message_id uuid not null references message(id),
  reason text not null check (reason in ('mention','thread_reply','dm')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index inbox_account_idx on inbox (account_id, id);

create table projection_cursor (
  repo text primary key,
  last_log_index bigint not null
);

create table active_lease (
  repo text not null,
  path text not null,
  actor_key_id text not null,
  expires_at timestamptz not null,
  primary key (repo, path, actor_key_id)
);

create table idempotency_key (
  key text primary key,
  message_id uuid not null references message(id),
  created_at timestamptz not null default now()
);
