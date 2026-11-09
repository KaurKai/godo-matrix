# GODO Matrix e-Fatura / e-İrsaliye entegrasyon hazırlığı

## Şu anki durum

`edocument-gateway` Edge Function Matrix kullanıcısının MFA'lı oturumunu doğrular, satış sevkiyatını sunucu tarafından Matrix KV kaydından alır, temel alanları kontrol eder ve değiştirilemez bir kaynak görüntüsüyle `e_documents` taslağı oluşturur. İşlem anahtarı tekrar gönderimleri yinelenen taslak haline getirmez. Sağlayıcı adaptörü ve gizli API bilgileri henüz kurulmadığı için gerçek belge gönderimi ve durum sorgulaması kapalıdır.

Kullanıcı tarafından iletilen fatura/irsaliye gövdesine güvenilmez; tutar, alıcı, kalemler ve şirket bilgileri Edge Function tarafından Matrix'in oturum sahibine ait `kv_store` kayıtlarından okunur. İstemci `e_documents` ve olay tablosuna doğrudan yazamaz. Okuma MFA ve RLS ile sınırlıdır. API parolası/tokens yalnız Supabase Edge Function Secrets içinde tutulmalıdır; tarayıcı koduna, `kv_store` JSON'una veya loglara yazılmamalıdır.

## Sağlayıcı API'si alınca netleştirilecekler

1. Sağlayıcının GİB yetkisi; e-Fatura, e-Arşiv Fatura ve e-İrsaliye hizmet kapsamı.
2. Test/canlı ortam adresleri, kimlik doğrulama, IP/sertifika gereksinimleri, kota ve zaman aşımı.
3. Taslak doğrulama, belge gönderme, durum sorgulama, gelen belge/yanıt alma ve imza/mali mühür sorumluluğu.
4. ETTN, belge numarası/seri tahsisi, idempotency desteği ve aynı isteğin güvenli tekrarı.
5. İmzalı webhook/callback doğrulaması; başarısız/tekrarlı callback idempotency'si.
6. GİB yanıtları, uygulama yanıtları, ret kodları, e-İrsaliye yanıtları ve yasal sürelerin hangi API durumlarına bağlandığı.
7. UBL-TR sürümü, zorunlu alanlar, birim/vergi kod tabloları, PDF/HTML görseli ve orijinal XML indirme/saklama.
8. Saklama/yedekleme, veri lokasyonu, alt işleyenler, SLA, kesinti prosedürü, veri dışa aktarma ve sözleşme bitişi.

## Uygulanacak akış

`draft → queued → sending → submitted → accepted / rejected` (ayrıca `failed` / `cancelled`). Her geçiş olay tablosuna ek satır yazar. Gönderimden önce aynı belge sürümü + idempotency anahtarı denetlenir; timeout sonrasında tekrar gönderimden önce sağlayıcı durum sorgusu yapılır. Ham API secret saklanmaz; sağlayıcı cevabındaki sırlar ve kişisel gereksiz alanlar `provider_metadata` içine yazılmadan önce ayıklanır.

e-Fatura ve e-Arşiv seçimi yalnız numara biçiminden çıkarılmamalı; sağlayıcının alıcı kayıt sorgusu ve GİB kuralları üzerinden belirlenmelidir. Hata/ret durumunda kaynak Matrix faturası değiştirilmez; yeni belge sürümü veya düzeltme belgesi ayrı süreç olarak ele alınır.

## Sağlayıcı adaptör sınırı

```ts
interface EDocumentProvider {
  validate(snapshot: unknown): Promise<{ valid: boolean; errors: string[] }>;
  submit(input: { idempotencyKey: string; documentType: string; snapshot: unknown }): Promise<{
    providerDocumentId: string;
    ettn?: string;
    documentNumber?: string;
    state: "submitted" | "accepted" | "rejected";
    safeMetadata?: Record<string, unknown>;
  }>;
  getStatus(providerDocumentId: string): Promise<{ state: string; safeMetadata?: Record<string, unknown> }>;
}
```

Üretim gönderim kodu bu arayüze bağlanacak; sağlayıcı seçilene kadar `submit` devre dışıdır.

## GİB teknik dayanakları

- [e-Fatura Uygulaması Entegrasyon Kılavuzu v1.9](https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-FaturaUygulamasiEntegrasyonKilavuzu-v1.9.pdf): UBL/şema ve veri kuralları, uygulama yanıtı süreleri, loglama, güvenli saklama ve iş sürekliliği sorumlulukları.
- [e-Fatura Uygulaması Özel Entegrasyon Kılavuzu v1.12](https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Fatura_Uygulamasi_Ozel_Entegrasyon_Kilavuzu_v1.12.pdf): özel entegratör ve e-İrsaliye test/hesap akışları.

Bu hazırlık GİB entegrasyon izni veya mevzuat uygunluğu anlamına gelmez. Sağlayıcı sözleşmesi, gerçek API teknik kılavuzu ve mali müşavir onayı gelince belge şeması ve zorunlu alanlar o sürümlere göre uyarlanmalıdır.
