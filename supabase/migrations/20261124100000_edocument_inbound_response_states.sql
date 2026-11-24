alter table public.e_documents drop constraint if exists e_documents_status_check;
alter table public.e_documents add constraint e_documents_status_check check (
  status = any (array['draft','queued','sending','submitted','received','awaiting_response','responding','response_uncertain','responded','accepted','rejected','cancelled','failed']::text[])
);
