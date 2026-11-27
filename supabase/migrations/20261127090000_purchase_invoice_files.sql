-- Tedarikçi (alış) fatura belgeleri: özel bucket, kullanıcı klasörü + MFA şartı (campaign-files ile aynı desen)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-invoices', 'purchase-invoices', false, 15728640, array['application/pdf','image/jpeg','image/png','image/webp','application/xml','text/xml'])
on conflict (id) do nothing;

create policy purchase_invoices_select on storage.objects for select to authenticated
  using (bucket_id = 'purchase-invoices' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.mfa_ok()));
create policy purchase_invoices_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'purchase-invoices' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.mfa_ok()));
create policy purchase_invoices_update on storage.objects for update to authenticated
  using (bucket_id = 'purchase-invoices' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.mfa_ok()))
  with check (bucket_id = 'purchase-invoices' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.mfa_ok()));
create policy purchase_invoices_delete on storage.objects for delete to authenticated
  using (bucket_id = 'purchase-invoices' and (storage.foldername(name))[1] = (select auth.uid())::text and (select private.mfa_ok()));
