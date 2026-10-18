-- Run this once in the Supabase SQL Editor for the project used by this app.
create table if not exists public.portfolio_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_data enable row level security;

create or replace function public.set_portfolio_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_portfolio_updated_at on public.portfolio_data;
create trigger set_portfolio_updated_at
  before update on public.portfolio_data
  for each row execute function public.set_portfolio_updated_at();

grant select, insert, update, delete on public.portfolio_data to authenticated;
revoke all on public.portfolio_data from anon;

drop policy if exists "Users can read their own portfolio" on public.portfolio_data;
create policy "Users can read their own portfolio"
  on public.portfolio_data for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own portfolio" on public.portfolio_data;
create policy "Users can create their own portfolio"
  on public.portfolio_data for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own portfolio" on public.portfolio_data;
create policy "Users can update their own portfolio"
  on public.portfolio_data for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own portfolio" on public.portfolio_data;
create policy "Users can delete their own portfolio"
  on public.portfolio_data for delete to authenticated
  using ((select auth.uid()) = user_id);
