# Teklif PDF arşivi ve Gmail taslağı

## Akış

- Teklif önizlemesindeki mevcut müşteri çıktısı HTML'i, aynı Matrix şablonundan A4 PDF'e dönüştürülür.
- PDF, kullanıcıya ait `campaign-files` özel bucket'ına teklif kimliği ve içerik özeti içeren sürümlü bir yolla yüklenir. Aynı içerik tekrar istendiğinde arşivdeki PDF yeniden kullanılır; teklif veya çıktı değişince yeni bir PDF sürümü oluşur.
- Teklif PDF'si oluşturulup kaydedilmeden Gmail taslağı açılamaz. `quote-mail-draft` Edge Function oturumu ve MFA düzeyini doğrular, kullanıcının teklif/PDF kayıtlarını okur, depodaki PDF'nin SHA-256 özetini kontrol eder ve Gmail'de ekli bir taslak oluşturur. Uygun bir yakın tarihli teklif yazışması varsa taslak aynı konuşmaya yanıt olarak eklenir.
- Edge Function hiçbir zaman e-postayı göndermez. Kullanıcı taslağı Gmail'de inceleyip kendisi gönderir.

## Dağıtım ön koşulları

Bu PR üretim verisine veya Supabase projesine uygulanmaz. Birleştirme ve dağıtım öncesinde:

1. Supabase Edge Function secrets'ına teklif taslağına özel `GMAIL_COMPOSE_CLIENT_ID`, `GMAIL_COMPOSE_CLIENT_SECRET` ve `GMAIL_REFRESH_TOKEN_COMPOSE` eklenmeli. Bu üç değer ayrı bir Google OAuth istemcisinden ve GMAIL_SENDER ile aynı hesapta, `https://www.googleapis.com/auth/gmail.compose` kapsamıyla alınmalı.
2. Mevcut `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN_READ` ve `GMAIL_SENDER` secret'ları olduğu gibi korunmalı. Teklif taslağı için ayrı istemci kullanılması, mevcut Gmail işlevlerinin kimlik bilgilerine dokunmaz.
3. `quote-mail-draft` Edge Function deploy edilmeli; uygulama HTML'i GitHub Pages dağıtımıyla yayınlanmalı.

Secret değerleri bu depoya eklenmemelidir.

## PDF davranışı ve sınırlar

- Renderer, mevcut `#printArea` içeriğini kullanır; liste fiyatı ve iç alış alanları müşteri çıktısına eklenmez.
- A4 ve mevcut şablon sınıfları korunur; ürün satırlarında sayfa içi bölünmeyi engelleyen CSS sayfa kırılımları kullanılır. Satır sayısına sabit bir limit konmaz; 1 ve 100 satırlı teklifler aynı akıştan geçer.
- Depodaki mevcut bucket yalnızca PDF kabul eder ve dosya başına 10 MiB sınırı uygular. Uygulama da bu sınırdan önce durur.
- `html2pdf.js` 0.14.0, MIT lisansıyla kendinden barındırılır. Renderer HTML görünümünü raster PDF'e dönüştürdüğü için çıktıdaki metin seçilebilir/searchable olmaz; yayın öncesi temsilî kısa ve 100 satırlı tekliflerin görsel QA'sı yapılmalıdır.
