# GODO Matrix — Nilvera e-Belge bağlantısı

## Canlı durum

- Matrix'te **Finans → e-Belgeler** ekranı kullanılabilir.
- `edocument-gateway` Supabase Edge Function **ACTIVE v7** durumundadır ve JWT doğrulaması açıktır. Canlı ortam varsayılandır; yalnızca sunucu sırrı `NILVERA_ENV=test` olarak ayarlanırsa test adresine geçer.
- API anahtarı tarayıcıya gönderilmez. Tek anahtar `NILVERA_API_KEY` adıyla Supabase Edge Function Secrets içinde tutulur. Matrix ekranındaki “Güvenli anahtar ayarını aç” bağlantısı bu ayar sayfasını açar.
- Ekrandaki **API bağlantısını test et** düğmesi salt okunur erişim/izin kontrolü yapar. Hukuki belge göndermez. API anahtarı yanıtı, belge içeriği veya Authorization değeri loglara yazılmaz.
- Bu kurulumda Nilvera'ya canlı e-Fatura/e-Arşiv/e-İrsaliye gönderilmedi; gelen belgeler de kabul veya reddedilmedi. İlk gerçek gönderim/yanıt, kullanıcı ilgili belgeyi açıp onay verdiğinde yapılır.

### Gelen kutusu senkronizasyonunda kısmi sonuçlar

E-Fatura ve e-İrsaliye gelen kutuları ayrı API izinleriyle çağrılır. Bir uçtan alınan belgeler kaydedildikten sonra diğer uç hata verirse, başarılı kayıtlar korunur ve ekranda gösterilir; başarısız belge türü/izin kontrolü ayrıca bildirilir. Hata sonrasında da Matrix kayıt listesi yenilenir. Tekrar yenileme Nilvera UUID'sine göre tekilleştirilir.

## Kullanılabilir akışlar

### Giden belgeler

1. Matrix'ten satış sevkiyatı seçilir.
2. Gönderim önizlemesi Matrix'teki firma, kalem, miktar, tutar ve tarih verilerinden hazırlanır; zorunlu alanlar ve alıcı VKN/TCKN kontrol edilir.
3. e-Fatura / e-Arşiv seçimi Nilvera'nın alıcı mükellef sorgusuyla doğrulanır. Yanlış belge türü varsa gönderim durur.
4. e-İrsaliye için araç/plaka, taşıyıcı ve sürücü gibi Matrix'te bulunmayan zorunlu bilgiler gönderim öncesi kullanıcıdan istenir.
5. Kullanıcı belgeyi gözden geçirip açıkça gönderimi onaylar. İstemci isteği tek başına yeterli değildir; sunucu da `confirmSend=true` kontrolü yapar.
6. Sağlayıcı gönderimi kesinleştirdikten sonra resmi numara Matrix sevkiyatına yazılır. Mevcut Matrix stok düşümü bu resmi sevkiyat alanından tetiklenir.
7. Sağlayıcı belgeyi kabul etti ama Matrix eşitlemesi başarısız olduysa “Matrix sevkiyatını eşitle” işlemi aynı belgeyi tekrar göndermeden kaynak kaydını tamamlar.

Belge türleri: e-Fatura, e-Arşiv Fatura ve e-İrsaliye. Gönderim tekrarını engelleyen idempotency kontrolü vardır; aynı sevkiyat/belge için ikinci resmi belge oluşturulmasına karşı ayrıca mevcut numara kontrol edilir.

### Gelen belgeler

- Kullanıcı **Gelen kutusunu yenile** diyerek gelen e-Fatura ve e-İrsaliye kayıtlarının metadata bilgisini çeker.
- Nilvera UUID'siyle yinelenen kayıtlar tekilleştirilir. Listeleme, belgenin okunma durumunu değiştirmez ve XML/PDF ekini indirmez.
- Gelen e-Fatura ve e-İrsaliye için kullanıcı açıkça kabul veya ret seçer. Ret için gerekçe istenir. Sonucu belirsiz bir yanıt isteği `response_uncertain` olarak tutulur; kullanıcıyı ikinci kez yanıt göndermeye teşvik etmek yerine liste yenilenerek Nilvera durumuyla uzlaştırılır.

## API anahtarını ekleme ve ilk kontrol

1. Supabase'in Edge Function Secrets sayfasında `NILVERA_API_KEY` sırrını ekleyin veya güncelleyin: [Güvenli anahtar ayarını aç](https://supabase.com/dashboard/project/laopdoxuxvcwgcjghdim/functions/secrets).
2. Nilvera'dan verilen anahtarın canlı hesap için olduğundan emin olun. `NILVERA_ENV` tanımlı değilse Matrix canlı API adresini kullanır.
3. Matrix'te Finans → e-Belgeler sayfasını yenileyin.
4. “API bağlantısını test et” düğmesine basın. Bu kontrol bağlantı ve gelen belge izinlerini doğrular. Gönderim izni, Nilvera güvenli bir salt-okunur sorguyla kanıtlamadığı için ilk gerçek gönderimde doğrulanır.
5. Önce belge önizlemesini inceleyin. Ancak doğru alıcı, ürünler, miktar, vergi ve teslimat bilgileri doğrulandıktan sonra gerçek belge için gönderim onayı verin.

**Önemli:** API anahtarını sohbet mesajına, Matrix formuna, ekran görüntüsüne veya tarayıcı geliştirici konsoluna yapıştırmayın. Anahtar burada veya kaynak kodda saklanmaz. Daha önce anahtarı tarayıcıya/sohbete yapıştırdıysanız Nilvera'dan yenilemek uygun olur.

## Güvenli tekrar ve hata davranışı

- Gönderim önizlemesi değiştirilemez Matrix kaynak görüntüsünden oluşur; kullanıcıdan gelen belge JSON'u doğruluk kaynağı kabul edilmez.
- Yinelenen gönderimi önleyen idempotency anahtarı kullanılır.
- Sağlayıcı zaman aşımında aynı belge otomatik yeniden gönderilmez. Önce durum sorgusu/uzlaştırma gerekir.
- Sağlayıcı sonucu kesinleşmeden Matrix'e resmi irsaliye numarası yazılmaz; bu nedenle belirsiz gönderim stok hareketini erkenden tetiklemez.
- Kaynak eşitlemesi başarısız olursa, mevcut sağlayıcı belgesi yeniden gönderilmeden kaynak eşitlemesi denenir.
- Gelen yanıtın sonucu belirsizse ikinci kabul/ret isteği otomatik atılmaz.
- Edge Function, Matrix MFA oturumunu doğrular; `e_documents` ve olay kayıtları tarayıcıdan doğrudan yazılamaz.

## Henüz kapsam dışı olanlar

- Gelen e-belgelerin orijinal XML/PDF dosyasını çekme, güvenli saklama ve indirme.
- Gelen faturaları tedarikçi, SAS/satın alma kaydı ve stok/muhasebe fişiyle otomatik eşleştirme.
- Webhook veya zamanlanmış otomatik gelen kutusu/status sorgusu. Şu an kullanıcı ekrandan yenileme/sorgulama başlatır.
- API anahtarı eklendikten sonra otomatik belge gönderimi. Yasal belge gönderimi her belge için önizleme ve kullanıcı onayı ister.

Bu kapsamlar eklenmeden sistemin muhasebe fişlerini, alış stok hareketlerini veya gelen belge eklerini otomatik tamamladığı söylenmemelidir.

## Nilvera API kaynakları

- [Nilvera geliştirici portalı](https://developer.nilvera.com/)
- [e-Fatura taslağı oluşturma](https://developer.nilvera.com/en/api/e-invoice-api/draft-invoices/create-draft)
- [e-Fatura taslağını onaylama ve gönderme](https://developer.nilvera.com/en/api/e-invoice-api/draft-invoices/approve-and-send-the-draft)
- [e-Arşiv taslağı oluşturma](https://developer.nilvera.com/en/api/e-archive-invoice-api/draft-invoices/creates-draft)
- [e-Arşiv taslağını onaylama ve gönderme](https://developer.nilvera.com/en/api/e-archive-invoice-api/draft-invoices/approves-and-sends-the-draft)
- [e-İrsaliye taslağı oluşturma](https://developer.nilvera.com/api/e-irsaliye-api/taslak-irsaliyeler/taslak-olusturur)
- [e-İrsaliye taslağını onaylama ve gönderme](https://developer.nilvera.com/api/e-irsaliye-api/taslak-irsaliyeler/taslagi-onaylayip-gonderir)
- [Gelen e-Fatura yanıtı](https://developer.nilvera.com/en/api/e-invoice-api/purchase-invoices/respond-to-the-invoice)
- [Gelen e-İrsaliye yanıtı](https://developer.nilvera.com/api/e-irsaliye-api/gelen-irsaliyeler/irsaliyeye-yanit-olusturur)
- [VKN mükellef sorgusu](https://developer.nilvera.com/api/genel-api/mukellef-islemleri/vkn-ile-sorgular)
