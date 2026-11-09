-- Provider-neutral e-Fatura / e-İrsaliye persistence foundation.
-- This migration is prepared locally and is not applied to the live project.
create table if not exists public.e_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_type text not null check (document_type in ('e_invoice','e_archive_invoice','e_despatch')),
  direction text not null default 'outbound' check (direction in ('outbound','inbound')),
  source_kind text not null check (source_kind in ('shipment','purchase_invoice')),
  source_id text not null,
  source_revision integer not null default 1 check (source_revision > 0),
  status text not null default 'draft' check (status in ('draft','queued','sending','submitted','accepted','rejected','cancelled','failed')),
  provider_key text,
  provider_document_id text,
  ettn text,
  document_number text,
  issue_date date,
  currency text,
  total_amount numeric(18,2) check (total_amount is null or total_amount >= 0),
  idempotency_key text not null,
  payload_snapshot jsonb not null default '{}'::jsonb,
  provider_metadata jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  submitted_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint e_documents_user_idempotency_key unique (user_id, idempotency_key)
);

create index if not exists e_documents_user_created_idx
  on public.e_documents (user_id, created_at desc);
create index if not exists e_documents_source_idx
  on public.e_documents (user_id, source_kind, source_id, source_revision);
create unique index if not exists e_documents_provider_id_idx
  on public.e_documents (user_id, provider_key, provider_document_id)
  where provider_document_id is not null;
create unique index if not exists e_documents_ettn_idx
  on public.e_documents (user_id, ettn)
  where ettn is not null;

create table if not exists public.e_document_events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  document_id uuid not null references public.e_documents(id) on delete cascade,
  event_key text not null,
  event_type text not null,
  from_status text,
  to_status text,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint e_document_events_document_event_key unique (document_id, event_key)
);

create index if not exists e_document_events_user_created_idx
  on public.e_document_events (user_id, created_at desc);
create index if not exists e_document_events_document_created_idx
  on public.e_document_events (document_id, created_at desc);

alter table public.e_documents enable row level security;
alter table public.e_document_events enable row level security;

drop policy if exists e_documents_read_own_mfa on public.e_documents;
create policy e_documents_read_own_mfa on public.e_documents
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.mfa_ok()));

drop policy if exists e_document_events_read_own_mfa on public.e_document_events;
create policy e_document_events_read_own_mfa on public.e_document_events
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.mfa_ok()));

revoke all on public.e_documents from anon, authenticated;
revoke all on public.e_document_events from anon, authenticated;
grant select on public.e_documents, public.e_document_events to authenticated;
grant usage, select on sequence public.e_document_events_id_seq to service_role;
grant select, insert, update, delete on public.e_documents, public.e_document_events to service_role;

create or replace function private.prevent_e_document_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Permit retention cleanup caused by an account/document cascade while
  -- keeping direct event edits and deletes prohibited.
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'e-Belge olay kayıtları değiştirilemez veya silinemez.' using errcode = '42501';
end;
$$;

drop trigger if exists e_document_events_append_only on public.e_document_events;
create trigger e_document_events_append_only
  before update or delete on public.e_document_events
  for each row execute function private.prevent_e_document_event_mutation();
