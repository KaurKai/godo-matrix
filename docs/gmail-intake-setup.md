# Gmail teklif talepleri: devreye alma notları

Akış, `gmail-check` ile gelen kutusunu salt okunur biçimde tarar ve teklif talebi olabilecek e-postaları Matrix `kv_store` içinde saklar. Matrix açıkken **Gmail Talepleri** ekranı eşleşmeleri inceler. Tek bir kayıtlı cari e-posta adresi, mevcut katalog ürünü ve açıkça yazılmış adetler kesin eşleşirse bir teklif taslağı oluşturur, aynı Matrix şablonundan GitHub Actions üzerindeki Chromium ile vektör metinli PDF üretir ve kaynak Gmail yazışmasında yanıt taslağı açar. Bu taslak gönderilmez; Gmail'de son inceleme ve gönderim kullanıcıya kalır. Belirsiz talepler elle tamamlanır.

## Mevcut canlı kurulum gözlemi (13 Ekim 2026)

- Godo Matrix Supabase projesinde `pg_cron`, `pg_net` ve Vault etkin.
- `cron.job` içinde yedekleme ve kampanya gönderimi var; Gmail kontrolü için iş yok.
- Canlı `gmail-check` işlevi etkin sürümde 404 döndüren geçici stub. Bu klasördeki güncel işlev kaynakları canlıya dağıtılmış değil.
- Canlı proje Edge Function listesinde `quote-mail-draft` görünmüyor. Gmail taslağı ve Chromium PDF için gerekli Edge Function'ların dağıtılması gerekir.
- `campaigns` tablosunda tek Matrix hesabına ait imza kaydı mevcut; Gmail taslağı bu imzayı kullanır.

## Dağıtımdan önce gerekenler

1. Önce bu değişiklikleri GitHub'da PR olarak birleştir. GitHub, `workflow_dispatch` ile renderer'ı çağırabilmek için `.github/workflows/quote-pdf-render.yml` dosyasının varsayılan dalda bulunmasını ister.
2. Supabase Edge Function Secrets'ta Gmail ayarlarını doğrula: `GMAIL_SENDER`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN_READ`, `GMAIL_REFRESH_TOKEN_COMPOSE`, `GMAIL_COMPOSE_CLIENT_ID`, `GMAIL_COMPOSE_CLIENT_SECRET`. Okuma token'ı `gmail.readonly`; taslak token'ı `gmail.compose` kapsamını içermeli. Gmail hesapları `GMAIL_SENDER` ile eşleşmeli.
3. Supabase Function Secrets'a `GODO_RENDER_SECRET`, `GITHUB_ACTIONS_TOKEN`, `GITHUB_REPOSITORY=KaurKai/godo-matrix` ve `GITHUB_REF=main` ekle. `GITHUB_ACTIONS_TOKEN`, bu depoda yalnızca Actions çalıştırma ve kaynak kodunu okuma yetkili fine-grained token olmalı. `GODO_RENDER_SECRET` güçlü rastgele bir sırdır; aynı değeri GitHub Actions secret olarak da ekle.
4. GitHub deposunda Actions'ı etkinleştir. Repository **Settings → Secrets and variables → Actions** altında `GODO_SUPABASE_URL`, `GODO_SUPABASE_PUBLISHABLE_KEY` ve `GODO_RENDER_SECRET` secret'larını ekle. PDF içeriği GitHub event girdisine konmaz; event yalnızca teklif UUID'si ve içerik özeti olan iş kimliğini taşır. Runner HTML'yi Supabase'den alır, PDF'i geri yükler ve geçici dosyalarını işi bitince siler.
5. Supabase'e `gmail-check`, `quote-pdf-render` ve `quote-mail-draft` Edge Function'larını dağıt. `supabase/config.toml` içindeki `gmail-check` ve `quote-pdf-render` Gateway JWT ayarları kapalıdır; bu iki işlev yine de kendi içinde Matrix JWT/MFA veya ayrı paylaşılan sırla çağrıyı doğrular. Güncel Supabase yönergesi bu tür uçlarda Gateway JWT doğrulamasının işlev başına yapılandırılmasını önerir.
6. Supabase Dashboard **Integrations → Vault** ekranından şu adlarla secret ekle: `godo_project_url`, `godo_publishable_key`, `godo_gmail_monitor_cron_secret`. Sonuncusu için uzun-rastgele değer üret; aynı değeri Edge Function Secrets'ta `GMAIL_MONITOR_CRON_SECRET` olarak kaydet. Gizli değeri sohbete, repoya veya SQL'e yapıştırma.
7. Aşağıdaki SQL'i Supabase SQL Editor'da bir defa çalıştır. Bu SQL Vault değerlerini okur ve `godo-gmail-intake-15m` cron işini oluşturur/değiştirir; gizli değer sorguda yer almaz.

```sql
do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname = 'godo-gmail-intake-15m';
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'godo-gmail-intake-15m',
    '*/15 * * * *',
    $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'godo_project_url') || '/functions/v1/gmail-check',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'godo_publishable_key'),
          'x-godo-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'godo_gmail_monitor_cron_secret')
        ),
        body := '{"action":"scan"}'::jsonb,
        timeout_milliseconds := 120000
      );
    $job$
  );
end $$;
```

## Sınırlamalar ve güvenlik

- Tarama gelen kutusundaki son 90 günlük en fazla 100 ileti/60 yazışmayı inceler; her yazışmanın son gelen iletisini değerlendirir. Tespit, Türkçe/İngilizce teklif anahtar sözcükleriyle yapılır; bu dil modeli tabanlı semantik analiz değildir.
- E-posta gövdesindeki ürün kodu ve adetler katalogla kesin eşleşmelidir. Adet açıkça bulunmazsa teklif kaleminde boş kalır; otomatik taslak üretilmez. E-posta eklerinin adları gösterilir ama eklerin içeriği henüz okunmaz. Fiyat yalnızca katalog kartındaki alış/satış ve iskonto değerlerinden gelir.
- Her 15 dakikadaki Supabase işi e-postaları tarayıp kuyruğa yazar. Teklif/PDF/Gmail taslak adımı Matrix uygulaması açık olduğunda işler; uygulama kapalıysa talepler birikir ve Matrix yeniden açılınca değerlendirilir. Belirsiz taleplerde kullanıcı **Teklif Taslağı Aç** ile devam eder. Otomatik işleyici her taramada en fazla bir kesin eşleşme işler.
- E-posta metni inceleme kuyruğunda Supabase `kv_store`'da saklanır; kuyruktan 90 günden eski girdiler kaldırılır. Teklife aktarılan kaynak kaydı yalnızca Gmail dizi/ileti kimliği, gönderen, konu, tarih ve ek adlarını tutar. Gmail'de okundu/etiket durumu değiştirilmez.
- Chromium PDF'i Matrix'in o anki teklif şablonu/HTML/CSS çıktısından üretilir; raster ekran görüntüsü değildir. Önbellek anahtarı renderer sürümünü içerir, bu nedenle eski bulanık raster PDF yeni PDF yerine kullanılmaz. PDF Supabase `campaign-files` özel deposuna yüklenir, hash'i doğrulanır ve Gmail taslağına eklenir.
- GitHub Actions runner, teklif HTML'sini yalnızca render sırasında işler. Kaynak HTML Supabase `kv_store`'da kısa ömürlü iş kaydıdır; başarı/hata halinde temizlenir. Runner çalışmazsa kayıt 30 dakika sonra sonraki PDF işinde temizlenir. PDF ise Matrix'in mevcut özel dosya deposunda kalır.
- Gmail yanıt taslağında kaynak `threadId` ve `Message-ID` sunucu tarafında doğrulanır; kullanıcı düzenleyip göndermeden e-posta yollanmaz.
- Zamanlayıcı ve işlev yalnızca yerel dosyalara hazırlandı. Bu kurulum notundaki Vault/cron adımları canlı veritabanına uygulanmadı.
