select vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'godo_campaign_cron_secret', 'GODO Matrix kampanya zamanlayıcısı için yalnızca sunucudan kullanılan gizli anahtar');

create or replace function public.verify_campaign_cron_secret(p_candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select length(coalesce(p_candidate, '')) >= 64
     and exists (
       select 1
       from vault.decrypted_secrets s
       where s.name = 'godo_campaign_cron_secret'
         and s.decrypted_secret = p_candidate
     );
$$;

revoke all on function public.verify_campaign_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_campaign_cron_secret(text) to service_role;

select cron.alter_job(
  jobid,
  schedule := '*/10 6-14 * * 1-5',
  command := $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'godo_project_url') || '/functions/v1/campaign-send',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'godo_publishable_key'),
        'x-campaign-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'godo_campaign_cron_secret')
      ),
      body := '{"action":"process"}'::jsonb
    ) as request_id;
  $job$,
  active := false
)
from cron.job
where jobname = 'godo-campaign-send';
