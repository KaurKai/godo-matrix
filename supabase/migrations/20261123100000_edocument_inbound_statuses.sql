alter table public.e_documents drop constraint if exists e_documents_status_check;
alter table public.e_documents add constraint e_documents_status_check check (
  status = any (array['draft','queued','sending','submitted','received','awaiting_response','responded','accepted','rejected','cancelled','failed']::text[])
);
alter table public.e_documents drop constraint if exists e_documents_source_kind_check;
alter table public.e_documents add constraint e_documents_source_kind_check check (
  source_kind = any (array['shipment','purchase_invoice','nilvera_inbox']::text[])
);
