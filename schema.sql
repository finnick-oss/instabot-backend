-- InstaBot multi-account schema. Run once in Supabase → SQL Editor.
-- Safe to re-run (everything is IF NOT EXISTS).

-- One row per connected Instagram professional account
create table if not exists accounts (
  ig_account_id text primary key,
  username      text,
  name          text,
  avatar        text,
  page_id       text not null,
  page_name     text,
  page_token    text not null,
  fb_user_id    text,
  connected_at  timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists accounts_fb_user_idx on accounts (fb_user_id);

-- Dashboard login sessions (only the sha256 of the token is stored)
create table if not exists sessions (
  token_hash    text primary key,
  ig_account_id text not null references accounts (ig_account_id) on delete cascade,
  created_at    timestamptz default now(),
  expires_at    timestamptz not null
);

-- Short-lived OAuth state values (CSRF protection for the login redirect)
create table if not exists oauth_states (
  state      text primary key,
  return_to  text not null,
  created_at timestamptz default now()
);

-- Automations belong to an account
create table if not exists automations (
  id            text primary key,
  ig_account_id text not null references accounts (ig_account_id) on delete cascade,
  data          jsonb not null default '{}'::jsonb,
  active        boolean not null default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists automations_account_idx on automations (ig_account_id);

-- One row per processed comment / postback. The unique key de-duplicates webhook retries.
create table if not exists interactions (
  id            bigserial primary key,
  ig_account_id text not null references accounts (ig_account_id) on delete cascade,
  automation_id text,
  comment_id    text,
  commenter_id  text,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz default now(),
  unique (ig_account_id, comment_id)
);
create index if not exists interactions_account_idx on interactions (ig_account_id, created_at desc);
create index if not exists interactions_commenter_idx on interactions (ig_account_id, commenter_id);
