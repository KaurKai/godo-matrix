create or replace function public.matrix_sync_shipment_edocument_fx(
  p_user_id uuid,
  p_shipment_id text,
  p_document_type text,
  p_document_number text,
  p_issue_date date,
  p_invoice_snapshot jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_value text;
  v_shipments jsonb;
  v_index integer;
  v_shipment jsonb;
  v_field text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_document_type not in ('e_invoice', 'e_archive_invoice', 'e_despatch') then
    raise exception 'invalid document type' using errcode = '22023';
  end if;
  if nullif(trim(p_document_number), '') is null or p_issue_date is null then
    raise exception 'document number and issue date required' using errcode = '22023';
  end if;
  if p_document_type <> 'e_despatch'
     and (jsonb_typeof(p_invoice_snapshot) <> 'object'
          or p_invoice_snapshot ->> 'currency' <> 'TRY') then
    raise exception 'TRY invoice snapshot required' using errcode = '22023';
  end if;

  select value into v_value
  from public.kv_store
  where user_id = p_user_id and key = 'godo:shipments'
  for update;
  if v_value is null then
    return jsonb_build_object('updated', false, 'reason', 'shipments_not_found');
  end if;

  v_shipments := v_value::jsonb;
  select (ordinality - 1)::integer, value
    into v_index, v_shipment
  from jsonb_array_elements(v_shipments) with ordinality
  where value ->> 'id' = p_shipment_id
  limit 1;
  if v_index is null then
    return jsonb_build_object('updated', false, 'reason', 'shipment_not_found');
  end if;

  if p_document_type = 'e_despatch' then
    v_field := 'officialIrsaliyeNo';
    if nullif(v_shipment ->> v_field, '') is not null
       and v_shipment ->> v_field <> p_document_number then
      return jsonb_build_object('updated', false, 'reason', 'existing_official_despatch_number');
    end if;
  else
    v_field := 'invoiceNo';
    if nullif(v_shipment ->> v_field, '') is not null
       and v_shipment ->> v_field <> p_document_number then
      return jsonb_build_object('updated', false, 'reason', 'existing_invoice_number');
    end if;
    if nullif(v_shipment ->> 'invoiceDate', '') is not null
       and v_shipment ->> 'invoiceDate' <> p_issue_date::text then
      return jsonb_build_object('updated', false, 'reason', 'existing_invoice_date');
    end if;
    if v_shipment ? 'invoiceSnapshot'
       and v_shipment -> 'invoiceSnapshot' is distinct from p_invoice_snapshot then
      return jsonb_build_object('updated', false, 'reason', 'existing_invoice_snapshot');
    end if;
  end if;

  v_shipment := jsonb_set(v_shipment, array[v_field], to_jsonb(p_document_number), true);
  if p_document_type = 'e_despatch' then
    v_shipment := jsonb_set(v_shipment, '{officialIrsaliyeDate}', to_jsonb(p_issue_date::text), true);
  else
    v_shipment := jsonb_set(v_shipment, '{invoiceDate}', to_jsonb(p_issue_date::text), true);
    v_shipment := jsonb_set(v_shipment, '{invoiceSnapshot}', p_invoice_snapshot, true);
  end if;
  v_shipments := jsonb_set(v_shipments, array[v_index::text], v_shipment, false);

  update public.kv_store
  set value = v_shipments::text, updated_at = now()
  where user_id = p_user_id and key = 'godo:shipments';

  return jsonb_build_object('updated', true, 'shipment_id', p_shipment_id, 'document_type', p_document_type);
end;
$$;

revoke all on function public.matrix_sync_shipment_edocument_fx(uuid, text, text, text, date, jsonb) from public, anon, authenticated;
grant execute on function public.matrix_sync_shipment_edocument_fx(uuid, text, text, text, date, jsonb) to service_role;
