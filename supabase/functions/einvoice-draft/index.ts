import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Matrix'te hazırlanan satış faturasını Nilvera'da GİB'e gitmeyen bir taslak olarak açar,
// Nilvera'nın kendi görüntüsüyle önizletir ve yalnız kullanıcı onayıyla keser.
// Taslak kaydı (e_documents, status=draft) edocument-gateway "prepare" ile oluşturulur.
const env = (k: string) => (Deno.env.get(k) || "").trim();
const KEY = env("NILVERA_API_KEY");
const BASE = env("NILVERA_ENV").toLowerCase() === "test" ? "https://apitest.nilvera.com" : "https://api.nilvera.com";
const ORIGINS = new Set(["https://kaurkai.github.io", "https://godo.tr", "https://www.godo.tr"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const list = (p: any): any[] => Array.isArray(p) ? p : Array.isArray(p?.Content) ? p.Content : [];
const hdr = (o: string) => ({ ...(ORIGINS.has(o) ? { "Access-Control-Allow-Origin": o } : {}), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", Vary: "Origin", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
const reply = (b: unknown, o: string, s = 200) => new Response(JSON.stringify(b), { status: s, headers: hdr(o) });
function adminKey() { if (env("SUPABASE_SERVICE_ROLE_KEY")) return env("SUPABASE_SERVICE_ROLE_KEY"); try { const k = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}"); return String(k.default || Object.values(k)[0] || ""); } catch { return ""; } }
function claims(t: string): Record<string, unknown> { try { const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p + "=".repeat((4 - p.length % 4) % 4)), c => c.charCodeAt(0)))); } catch { return {}; } }

async function nilvera(path: string, method = "GET", body?: unknown, accept = "application/json") {
  if (!KEY) throw new Error("Nilvera API anahtarı sunucuda tanımlı değil.");
  const r = await fetch(BASE + path, { method, headers: { Authorization: "Bearer " + KEY, Accept: accept, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(25000) });
  const raw = await r.text();
  if (accept !== "application/json") { if (!r.ok) throw Object.assign(new Error("Nilvera HTTP " + r.status), { status: r.status }); return raw; }
  let parsed: any = null; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
  if (!r.ok) { const e: any = new Error(String(parsed?.Message || parsed?.message || "Nilvera HTTP " + r.status).replace(/Bearer\s+\S+/g, "").slice(0, 300)); e.status = r.status; if (Array.isArray(parsed?.Errors)) e.nilveraErrors = parsed.Errors.slice(0, 12); throw e; }
  return parsed;
}
const LABELS: Record<string, string> = { "CompanyInfo.City": "Şirket ili", "CompanyInfo.District": "Şirket ilçesi", "CustomerInfo.City": "Alıcı ili", "CustomerInfo.District": "Alıcı ilçesi", CustomerAlias: "Alıcı posta kutusu etiketi", "InvoiceInfo.InvoiceSerieOrNumber": "Fatura seri ön eki", "CustomerInfo.TaxOffice": "Alıcı vergi dairesi", "CustomerInfo.TaxNumber": "Alıcı VKN/TCKN", "CustomerInfo.Address": "Alıcı adresi", "CompanyInfo.TaxOffice": "Şirket vergi dairesi", "CompanyInfo.Address": "Şirket adresi" };
function errText(e: unknown) {
  const l = (e as any)?.nilveraErrors;
  if (Array.isArray(l) && l.length) return l.map((x: any) => { const f = String(x?.Description || "").replace(/^(EInvoice|ArchiveInvoice)\./, ""); return (LABELS[f] || f || "Alan") + ": " + String(x?.Detail || x?.Message || "geçersiz"); }).join(" · ").slice(0, 600);
  return e instanceof Error ? e.message : "Nilvera isteği başarısız.";
}

// ---- il / ilçe ----
const CITIES = ["Adana","Adıyaman","Afyonkarahisar","Ağrı","Aksaray","Amasya","Ankara","Antalya","Ardahan","Artvin","Aydın","Balıkesir","Bartın","Batman","Bayburt","Bilecik","Bingöl","Bitlis","Bolu","Burdur","Bursa","Çanakkale","Çankırı","Çorum","Denizli","Diyarbakır","Düzce","Edirne","Elazığ","Erzincan","Erzurum","Eskişehir","Gaziantep","Giresun","Gümüşhane","Hakkari","Hatay","Iğdır","Isparta","İstanbul","İzmir","Kahramanmaraş","Karabük","Karaman","Kars","Kastamonu","Kayseri","Kilis","Kırıkkale","Kırklareli","Kırşehir","Kocaeli","Konya","Kütahya","Malatya","Manisa","Mardin","Mersin","Muğla","Muş","Nevşehir","Niğde","Ordu","Osmaniye","Rize","Sakarya","Samsun","Şanlıurfa","Siirt","Sinop","Şırnak","Sivas","Tekirdağ","Tokat","Trabzon","Tunceli","Uşak","Van","Yalova","Yozgat","Zonguldak"];
const fold = (v: unknown) => String(v || "").toLocaleLowerCase("tr-TR").replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/i̇/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u").replace(/[^a-z0-9]/g, "");
const title = (v: string) => v.toLocaleLowerCase("tr-TR").replace(/(^|[\s-])(\S)/g, (_m, a, b) => a + b.toLocaleUpperCase("tr-TR"));
const city = (v: unknown) => { const f = fold(v); return f ? CITIES.find(c => fold(c) === f) || "" : ""; };
const L = "A-Za-zÇĞİÖŞÜçğıöşü";
function fromAddress(address: unknown) {
  const t = String(address || "").replace(/\s+/g, " ").trim(); if (!t) return { city: "", district: "" };
  const m = t.match(new RegExp(`([${L}.]+(?:\\s[${L}.]+)?)\\s*[\\/–—-]\\s*([${L}]+)\\s*\\.?$`));
  if (m) { const c = city(m[2]); if (c) return { city: c, district: title(m[1].split(" ").pop() || "") }; }
  const w = t.split(/[\s,\/–—-]+/).filter(Boolean);
  for (let i = w.length - 1; i >= 0; i--) { const c = city(w[i]); if (c) { const d = i > 0 ? w[i - 1] : ""; return { city: c, district: d.length >= 3 && new RegExp(`^[${L}]+$`).test(d) && !/^(no|kat|daire|mah|mahallesi|cad|caddesi|sok|sokak|osb|mosb)$/i.test(d) ? title(d) : "" }; } }
  return { city: "", district: "" };
}
function placed(p: Record<string, any>) { const a = fromAddress(p.address); return { ...p, address: String(p.address || "").replace(/\s*[\r\n]+\s*/g, " ").trim(), city: city(p.city) || String(p.city || "").trim() || a.city, district: String(p.district || "").trim() || a.district }; }

// ---- Nilvera modeli ----
const unit = (u: unknown) => ({ adet: "C62", ad: "C62", pcs: "C62", c62: "C62", saat: "HUR", gün: "DAY", gun: "DAY", metre: "MTR", m: "MTR", kg: "KGM", set: "SET", paket: "PK", kutu: "BX" } as Record<string, string>)[String(u || "").trim().toLocaleLowerCase("tr-TR")] || (String(u || "").length <= 3 && u ? String(u).toUpperCase() : "C62");
function payload(s: any) {
  const issue = new Date(String(s.issue_date) + "T12:00:00+03:00").toISOString(), archive = s.document_type === "e_archive_invoice";
  const party = (p: any) => ({ TaxNumber: String(p.taxNo || "").replace(/\D/g, ""), Name: String(p.legalName || p.name || ""), TaxOffice: String(p.taxOffice || ""), Address: String(p.address || ""), Country: "Türkiye", City: String(p.city || ""), District: String(p.district || ""), ...(p.phone ? { Phone: String(p.phone) } : {}), ...(p.email ? { Mail: String(p.email) } : {}) });
  const lines = (Array.isArray(s.lines) ? s.lines : []).map((l: any, i: number) => ({ Index: String(i + 1), SellerCode: l.product_code || null, Name: l.description, Description: l.description, Quantity: Number(l.quantity), UnitType: unit(l.unit), Price: Number(l.unit_price), AllowanceTotal: 0, KDVPercent: Number(l.tax_rate || 0), KDVTotal: Number((Number(l.quantity) * Number(l.unit_price) * Number(l.tax_rate || 0) / 100).toFixed(2)) }));
  const b = s.vat_buckets || {};
  const info: Record<string, unknown> = { UUID: crypto.randomUUID(), InvoiceType: String(s.invoice_type || "SATIS"), ...(Number(s.vat_rate) === 0 ? { TaxExemptionReasonInfo: { KDVExemptionReasonCode: String(s.vat_exemption_code || "") } } : {}), ...(archive ? {} : { InvoiceProfile: s.invoice_profile || "TEMELFATURA" }), InvoiceSerieOrNumber: String(s.invoice_serie), IssueDate: issue, CurrencyCode: "TRY", ExchangeRate: 1, ...(s.internal_dispatch_number ? { DespatchDocumentReference: [{ IssueDate: issue, Value: String(s.internal_dispatch_number) }] } : {}), ...(s.source?.order_no ? { OrderReference: { IssueDate: issue, Value: String(s.source.order_no) } } : {}), LineExtensionAmount: Number(s.net_amount || 0), PayableAmount: Number(s.gross_amount || 0), KdvTotal: Number(s.vat_amount || 0), GeneralKDV1Total: Number(b["1"] || 0), GeneralKDV8Total: Number(b["8"] || 0), GeneralKDV10Total: Number(b["10"] || 0), GeneralKDV18Total: Number(b["18"] || 0), GeneralKDV20Total: Number(b["20"] || 0) };
  const inv = { InvoiceInfo: info, CompanyInfo: party(s.issuer), CustomerInfo: party(s.customer), InvoiceLines: lines, Notes: [s.source?.order_no ? "Matrix sipariş: " + s.source.order_no : "GODO Matrix sevkiyat"] };
  return archive ? { ArchiveInvoice: inv } : { EInvoice: inv, CustomerAlias: s.customer_alias };
}
const base = (t: string) => t === "e_archive_invoice" ? "/earchive" : "/einvoice";
const dropDraft = async (t: string, u: string) => { try { await nilvera(base(t) + "/Draft", "DELETE", [u]); } catch { /* yoksay */ } };
const draftHtml = (t: string, u: string) => nilvera(base(t) + "/Draft/" + encodeURIComponent(u) + "/html", "GET", undefined, "text/html") as Promise<string>;
async function issuedNumber(t: string, u: string) {
  const path = t === "e_archive_invoice" ? "/earchive/Invoices" : "/einvoice/Sale";
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise(r => setTimeout(r, 1500 * i));
    try { const row = list(await nilvera(path + "?Page=1&PageSize=25")).find((x: any) => String(x?.UUID || "").toLowerCase() === u.toLowerCase()); const n = String(row?.InvoiceNumber || "").trim(); if (n.length > 3) return n; } catch { /* tekrar dene */ }
  }
  return "";
}
function financial(s: any) {
  const c = obj(s.currency_conversion);
  return { currency: "TRY", vatRate: Number(s.vat_rate || 0), netAmount: Number(s.net_amount || 0), vatAmount: Number(s.vat_amount || 0), totalAmount: Number(s.gross_amount || 0), sourceCurrency: String(c.source_currency || s.currency || "TRY"), sourceNetAmount: Number(c.source_net_amount || s.net_amount || 0), currencyConversion: { rate: Number(c.rate || 1), rateDate: String(c.rate_date || s.issue_date || ""), requestedRateDate: String(c.requested_rate_date || ""), source: String(c.rate_source || ""), field: String(c.rate_field || "") }, lines: (Array.isArray(s.lines) ? s.lines : []).map((l: any) => ({ quoteItemId: String(l.quote_item_id || ""), code: String(l.product_code || ""), desc: String(l.description || ""), qty: Number(l.quantity || 0), unitPrice: Number(l.unit_price || 0), currency: "TRY", vatRate: Number(l.tax_rate || 0) })) };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: hdr(origin) });
  if (req.method !== "POST") return reply({ ok: false, error: "Yalnızca POST." }, origin, 405);
  try {
    const auth = req.headers.get("authorization") || "", jwt = auth.replace(/^Bearer\s+/i, "");
    if (!jwt || jwt === auth) return reply({ ok: false, error: "Matrix oturumu gerekli." }, origin, 401);
    const admin = createClient(env("SUPABASE_URL"), adminKey(), { auth: { persistSession: false } });
    const { data: who, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !who.user) return reply({ ok: false, error: "Matrix oturumu geçersiz." }, origin, 401);
    if (claims(jwt).aal !== "aal2") return reply({ ok: false, error: "e-Belge işlemi için iki adımlı doğrulama gerekli." }, origin, 403);
    const uid = who.user.id, body = obj(await req.json().catch(() => ({}))), action = String(body.action || ""), id = String(body.documentId || "").trim();
    if (!UUID_RE.test(id)) return reply({ ok: false, error: "documentId gerekli." }, origin, 400);
    const event = (key: string, type: string, to: string) => admin.from("e_document_events").upsert({ user_id: uid, document_id: id, event_key: key, event_type: type, to_status: to, event_data: { provider: "nilvera" } }, { onConflict: "document_id,event_key", ignoreDuplicates: true });
    const { data: doc } = await admin.from("e_documents").select("id,status,direction,document_type,source_kind,source_id,payload_snapshot,provider_metadata").eq("user_id", uid).eq("id", id).maybeSingle();
    if (!doc || doc.direction !== "outbound" || doc.source_kind !== "shipment" || !["e_invoice", "e_archive_invoice"].includes(doc.document_type)) return reply({ ok: false, error: "Fatura taslağı bulunamadı." }, origin, 404);
    const type = String(doc.document_type), meta = obj(doc.provider_metadata), remote = String(meta.remoteDraftUuid || "");

    if (action === "discard") {
      if (doc.status !== "draft") return reply({ ok: true, discarded: false }, origin);
      if (remote) await dropDraft(type, remote);
      await admin.from("e_documents").delete().eq("user_id", uid).eq("id", id).eq("status", "draft");
      return reply({ ok: true, discarded: true }, origin);
    }
    if (action === "view") {
      if (doc.status !== "draft" || !remote) return reply({ ok: false, error: "Bu taslağın Nilvera önizlemesi yok." }, origin);
      try { return reply({ ok: true, html: await draftHtml(type, remote) }, origin); } catch (e) { return reply({ ok: false, error: "Nilvera taslağı açılamadı — " + errText(e) }, origin); }
    }

    if (action === "attach") {
      if (doc.status !== "draft") return reply({ ok: false, error: "Bu kayıt taslak durumunda değil." }, origin, 409);
      if (remote) { try { return reply({ ok: true, html: await draftHtml(type, remote), snapshot: doc.payload_snapshot, provider_metadata: meta }, origin); } catch { /* yeniden aç */ } }
      const snap = obj(doc.payload_snapshot);
      const [companyRow, customerRow, shipmentRow] = await Promise.all(["godo:company", "godo:customers", "godo:shipments"].map(k => admin.from("kv_store").select("value").eq("user_id", uid).eq("key", k).maybeSingle()));
      const company = obj(JSON.parse(companyRow.data?.value || "{}"));
      const shipment = (JSON.parse(shipmentRow.data?.value || "[]") as any[]).find(s => String(s?.id) === String(doc.source_id)) || {};
      const cari = (JSON.parse(customerRow.data?.value || "[]") as any[]).find(c => String(c?.id || "") === String(shipment?.customer?.customerId || "")) || {};
      const issuer = placed({ ...obj(snap.issuer), city: company.city || obj(snap.issuer).city, district: company.district || obj(snap.issuer).district });
      const customer = placed({ ...obj(snap.customer), city: cari.city || obj(snap.customer).city, district: cari.district || obj(snap.customer).district });
      const miss: string[] = [];
      if (!issuer.city) miss.push("şirket ili"); if (!issuer.district) miss.push("şirket ilçesi");
      if (!customer.city) miss.push("alıcı ili"); if (!customer.district) miss.push("alıcı ilçesi");
      const serie = String((type === "e_archive_invoice" ? company.eArchiveSerie : company.eInvoiceSerie) || (type === "e_invoice" ? "GEF" : "")).trim().toUpperCase();
      const fail = async (msg: string) => { await admin.from("e_documents").delete().eq("user_id", uid).eq("id", id).eq("status", "draft"); return reply({ ok: false, error: msg }, origin); };
      if (miss.length) return await fail("Fatura hazırlanamadı: " + miss.join(", ") + " bulunamadı. Ayarlar › Şirket Bilgileri’ne veya cari kartına il ve ilçe yazın.");
      if (!/^[A-Z0-9]{3}$/.test(serie)) return await fail((type === "e_archive_invoice" ? "e-Arşiv" : "e-Fatura") + " seri ön eki (3 karakter) Ayarlar › Şirket Bilgileri’nde tanımlı değil.");
      let created = "";
      try {
        const taxNo = String(customer.taxNo || "").replace(/\D/g, "");
        const aliases = list(await nilvera("/general/GlobalCompany/Check/TaxNumber/" + encodeURIComponent(taxNo) + "?globalUserType=Invoice")).map((x: any) => String(x?.Name || "").trim()).filter(Boolean);
        if (type === "e_invoice" && !aliases.length) return await fail("Alıcı e-Fatura mükellefi değil; e-Arşiv seçin.");
        if (type === "e_archive_invoice" && aliases.length) return await fail("Alıcı e-Fatura mükellefi; e-Fatura seçin.");
        const given = String(snap.customer_alias || "").trim();
        if (given && aliases.length && !aliases.includes(given)) return await fail("Girilen alıcı etiketi Nilvera kayıtlarında yok: " + given);
        const next = { ...snap, issuer, customer, invoice_serie: serie, customer_alias: type === "e_invoice" ? (given || aliases[0]) : null };
        const r = await nilvera(base(type) + "/Draft/Create", "POST", payload(next));
        created = String(r?.UUID || "").trim(); if (!UUID_RE.test(created)) throw new Error("Nilvera taslak kimliği dönmedi.");
        const m2 = { ...meta, remoteDraftUuid: created, remoteDraftCreatedAt: new Date().toISOString() };
        const { error } = await admin.from("e_documents").update({ payload_snapshot: next, provider_metadata: m2, provider_key: "nilvera" }).eq("user_id", uid).eq("id", id).eq("status", "draft");
        if (error) throw new Error("Nilvera taslağı Matrix kaydına bağlanamadı.");
        await event("remote-draft:" + created, "remote_draft_created", "draft");
        return reply({ ok: true, html: await draftHtml(type, created), snapshot: next, provider_metadata: m2 }, origin);
      } catch (e) {
        if (created) await dropDraft(type, created);
        return await fail("Nilvera faturayı kabul etmedi — " + errText(e));
      }
    }

    if (action === "send") {
      if (body.confirmSend !== true) return reply({ ok: false, error: "Kesim için açık onay gerekli." }, origin, 400);
      if (doc.status !== "draft" || !remote) return reply({ ok: false, error: "Bu taslak kesime uygun değil. Olası tekrar engellendi." }, origin, 409);
      const { data: claim } = await admin.from("e_documents").update({ status: "sending", last_error: null, provider_document_id: remote, ettn: remote }).eq("user_id", uid).eq("id", id).eq("status", "draft").select("id").maybeSingle();
      if (!claim) return reply({ ok: false, error: "Belge başka bir işlem tarafından alındı." }, origin, 409);
      await event("send-claim:" + remote, "send_confirmed", "sending");
      const snap = obj(doc.payload_snapshot);
      try {
        await nilvera(base(type) + "/Draft/ConfirmAndSend", "POST", type === "e_archive_invoice" ? [remote] : [{ UUID: remote, Alias: snap.customer_alias || null }]);
      } catch (e) {
        const st = Number((e as any)?.status || 0);
        if (st >= 400 && st < 500 && st !== 409) {
          await admin.from("e_documents").update({ status: "draft", provider_document_id: null, ettn: null, last_error: ("Nilvera kesmedi: " + errText(e)).slice(0, 500) }).eq("user_id", uid).eq("id", id).eq("status", "sending");
          await event("send-refused:" + Date.now(), "provider_send_refused", "draft");
          return reply({ ok: false, error: "Nilvera faturayı kesmedi, belge gönderilmedi — " + errText(e) }, origin);
        }
        await admin.from("e_documents").update({ last_error: "Kesim sonucu belirsiz; tekrar göndermeden önce Nilvera’dan eşitleyin." }).eq("user_id", uid).eq("id", id);
        await event("send-uncertain", "send_result_uncertain", "sending");
        return reply({ ok: false, uncertain: true, error: "Kesim sonucu belirsiz. Çift fatura riskine karşı tekrar gönderim kilitlendi; birkaç dakika sonra “Nilvera’dan eşitle”ye basın." }, origin, 202);
      }
      const number = await issuedNumber(type, remote), now = new Date().toISOString();
      const m2 = { ...meta, submittedAt: now, sourceSyncStatus: number ? "pending" : "awaiting_provider_number" };
      const { data: done } = await admin.from("e_documents").update({ status: "submitted", document_number: number || null, submitted_at: now, attempt_count: 1, last_error: null, provider_metadata: m2 }).eq("user_id", uid).eq("id", id).select("id,status,document_type,provider_document_id,document_number,submitted_at").single();
      await event("submitted:" + remote, "provider_submitted", "submitted");
      let synced = false;
      if (number) {
        const out = await admin.rpc("matrix_sync_shipment_edocument_fx", { p_user_id: uid, p_shipment_id: String(doc.source_id), p_document_type: type, p_document_number: number, p_issue_date: String(snap.issue_date), p_invoice_snapshot: financial(snap) });
        synced = !out.error && out.data?.updated === true;
        if (synced) await admin.from("e_documents").update({ provider_metadata: { ...m2, sourceSyncStatus: "synced", sourceSyncedAt: now } }).eq("user_id", uid).eq("id", id);
      }
      return reply({ ok: true, document: done, sourceSynced: synced }, origin);
    }
    return reply({ ok: false, error: "Bilinmeyen işlem." }, origin, 400);
  } catch (e) {
    return reply({ ok: false, error: e instanceof Error ? e.message : "Sunucu hatası." }, origin, 500);
  }
});
