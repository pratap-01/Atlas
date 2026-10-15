-- Atlas Money: one end-to-end encrypted "vault" row per user.
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.

create table if not exists public.vaults (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  ciphertext text        not null,          -- AES-256-GCM, encrypted in the browser
  iv         text        not null,
  version    bigint      not null default 1, -- optimistic locking for multi-device sync
  updated_at timestamptz not null default now()
);

-- Row-level security: a signed-in user can only ever see or change their own row.
alter table public.vaults enable row level security;

drop policy if exists "vault: read own"   on public.vaults;
drop policy if exists "vault: insert own" on public.vaults;
drop policy if exists "vault: update own" on public.vaults;
drop policy if exists "vault: delete own" on public.vaults;

create policy "vault: read own"   on public.vaults for select to authenticated using (auth.uid() = user_id);
create policy "vault: insert own" on public.vaults for insert to authenticated with check (auth.uid() = user_id);
create policy "vault: update own" on public.vaults for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "vault: delete own" on public.vaults for delete to authenticated using (auth.uid() = user_id);

-- Signed-out visitors get nothing at all.
revoke all on public.vaults from anon;
grant select, insert, update, delete on public.vaults to authenticated;
