import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Nilvera belge eşitleme ve görüntüleme (salt okunur).
//  sync_outbound : Nilvera'da kesilmiş giden e-Fatura / e-Arşiv faturalarını Matrix'e kaydeder (portaldan kesilenler dahil)
//  view          : gelen ya da giden belgenin Nilvera HTML görüntüsü
//  pdf           : gelen ya da giden belgenin PDF'i (base64)
// Hiçbir işlem Nilvera'da belge oluşturmaz, yanıt vermez ya da okundu işaretlemez.
const env = (k: string) => (Deno.env.get(k) || "").trim();
const NILVERA_API_KEY = env("NILVERA_API_KEY");
const NILVERA_ENV = env("NILVERA_ENV").toLowerCase() === "test" ? "test" : "live";
const NILVERA_BASE_URL = NILVERA_ENV === "live" ? "https://api.nilvera.com" : "https://apitest.nilvera.com";
const ORIGINS = new Set(["https://kaurkai.github.io", "https://godo.tr", "https://www.godo.tr"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 8_000_000;

function headers(origin: string) {
  return {
    ...(origin && ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}
const reply = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), { status, headers: headers(origin) });
function adminKey() {
  if (env("SUPABASE_SERVICE_ROLE_KEY")) return env("SUPABASE_SERVICE_ROLE_KEY");
  try { const k = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}"); return String(k.default || Object.values(k)[0] || ""); } catch { return ""; }
}
function tokenClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1]; if (!part) return {};
    const n = part.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(n + "=".repeat((4 - n.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
  } catch { return {}; }
}
const asObject = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const str = (v: unknown, n = 240) => String(v ?? "").trim().slice(0, n);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const day = (v: unknown) => { const d = String(v || "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null; };

async function nilvera(path: string, accept = "application/json") {
  if (!NILVERA_API_KEY) throw Object.assign(new Error("Nilvera API anahtarı sunucuda tanımlı değil."), { status: 0 });
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) throw new Error("Nilvera API yolu geçersiz.");
  const r = await fetch(NILVERA_BASE_URL + path, { headers: { Authorization: "Bearer " + NILVERA_API_KEY, Accept: accept }, redirect: "error", signal: AbortSignal.timeout(25000) });
  const declared = Number(r.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw new Error("Belge 8 MB sınırını aşıyor.");
  const text = await r.text();
  if (text.length > MAX_BYTES * 1.4) throw new Error("Belge 8 MB sınırını aşıyor.");
  if (!r.ok) {
    const safe = text.replace(/Bearer\s+\S+/gi, "Bearer [gizli]").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 200);
    throw Object.assign(new Error(safe || "Nilvera HTTP " + r.status), { status: r.status });
  }
  return text;
}
function providerError(e: unknown) {
  const s = Number((e as any)?.status || 0);
  if (s === 401) return "Nilvera API anahtarı isteği reddetti.";
  if (s === 403) return "Nilvera API anahtarında bu belge için görüntüleme izni yok.";
  if (s === 404) return "Belge Nilvera'da bulunamadı.";
  if ((e as any)?.name === "TimeoutError") return "Nilvera yanıtı zaman aşımına uğradı.";
  return (e as Error)?.message || "Nilvera isteği tamamlanamadı.";
}
function docPath(doc: Record<string, any>, kind: "html" | "pdf") {
  const uuid = str(doc.provider_document_id, 64);
  if (!UUID_RE.test(uuid)) throw new Error("Belge kimliği geçersiz.");
  const u = encodeURIComponent(uuid), inbound = doc.direction === "inbound";
  if (doc.document_type === "e_despatch") return (inbound ? "/edespatch/Purchase/" : "/edespatch/Sale/") + u + "/" + kind;
  if (doc.document_type === "e_archive_invoice") { if (inbound) throw new Error("Gelen e-Arşiv belgesi desteklenmez."); return "/earchive/Invoices/" + u + "/" + kind; }
  return (inbound ? "/einvoice/Purchase/" : "/einvoice/Sale/") + u + "/" + kind;
}
// Giden fatura durumu: GİB iletimi (StatusCode) + ticari faturada alıcı yanıtı (AnswerCode)
function outboundStatus(row: Record<string, any>, type: string) {
  const st = str(row.StatusCode, 40).toLowerCase(), ans = str(row.AnswerCode, 40).toLowerCase();
  if (/error|fail|reject|cancel/.test(st)) return "failed";
  if (type === "e_invoice") {
    if (ans === "rejected") return "rejected";
    if (["approved", "acceptall", "documentanswered", "documentansweredautomatically"].includes(ans)) return "accepted";
    if (ans === "waitingforapproval") return "submitted";
  }
  return st === "succeed" ? "accepted" : "submitted";
}

async function syncOutbound(admin: ReturnType<typeof createClient>, userId: string) {
  let created = 0, updated = 0, unchanged = 0, linked = 0;
  const errors: { documentType: string; message: string }[] = [], portal: any[] = [];
  for (const spec of [{ type: "e_invoice", path: "/einvoice/Sale" }, { type: "e_archive_invoice", path: "/earchive/Invoices" }]) {
    try {
      for (let page = 1; page <= 20; page++) {
        const parsed = JSON.parse(await nilvera(spec.path + "?Page=" + page + "&PageSize=100"));
        const rows: Record<string, any>[] = Array.isArray(parsed?.Content) ? parsed.Content : [];
        for (const row of rows) {
          const uuid = str(row.UUID, 64); if (!UUID_RE.test(uuid)) continue;
          // Matrix'ten gönderilmiş belge zaten kayıtlıysa ona dokunma (kendi durum sorgusu var)
          const { data: own } = await admin.from("e_documents").select("id,source_kind").eq("user_id", userId).eq("provider_key", "nilvera").ilike("provider_document_id", uuid).maybeSingle();
          if (own && own.source_kind !== "nilvera_portal") { linked++; continue; }
          const status = outboundStatus(row, spec.type), currency = str(row.CurrencyCode, 8) || "TRY";
          const meta = {
            platform: str(row.Platform, 40), profile: str(row.InvoiceProfile, 40), invoiceType: str(row.InvoiceType, 40),
            providerStatusCode: str(row.StatusCode, 40), statusDetail: str(row.StatusDetail), answerCode: str(row.AnswerCode, 40),
            receiverName: str(row.ReceiverName, 200), receiverTaxNumber: str(row.ReceiverTaxNumber, 20), receiverAlias: str(row.ReceiverAlias),
            envelopeId: str(row.EnvelopeUUID, 64), createdDate: str(row.CreatedDate, 40),
          };
          const snapshot = {
            direction: "outbound", document_type: spec.type, origin: "nilvera_portal",
            customer: { name: meta.receiverName, taxNo: meta.receiverTaxNumber },
            issue_date: day(row.IssueDate), currency,
            net_amount: num(row.TaxExclusiveAmount), vat_amount: num(row.TaxTotalAmount), gross_amount: num(row.PayableAmount),
            exchange_rate: currency === "TRY" ? 1 : num(row.ExchangeRate),
            gross_amount_try: currency === "TRY" ? num(row.PayableAmount) : (num(row.PayableAmount) !== null && num(row.ExchangeRate) ? Math.round(num(row.PayableAmount)! * num(row.ExchangeRate)! * 100) / 100 : null),
          };
          const fields = { status, document_number: str(row.InvoiceNumber, 40) || null, issue_date: day(row.IssueDate), currency, total_amount: num(row.PayableAmount), payload_snapshot: snapshot, provider_metadata: meta, ettn: uuid };
          if (own) {
            const { data: cur } = await admin.from("e_documents").select("status").eq("id", own.id).single();
            const { error } = await admin.from("e_documents").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", own.id);
            if (error) throw new Error("db");
            if (cur?.status !== status) {
              await admin.from("e_document_events").insert({ user_id: userId, document_id: own.id, event_key: "portal-sync:" + status + ":" + meta.answerCode, event_type: "provider_status_synced", from_status: cur?.status || null, to_status: status, event_data: { provider: "nilvera" } });
              updated++;
            } else unchanged++;
            portal.push({ id: own.id, ...fields });
          } else {
            const { data: saved, error } = await admin.from("e_documents").insert({ user_id: userId, document_type: spec.type, direction: "outbound", source_kind: "nilvera_portal", source_id: uuid, source_revision: 1, provider_key: "nilvera", provider_document_id: uuid, idempotency_key: "nilvera:out:" + spec.type + ":" + uuid, ...fields }).select("id").single();
            if (error || !saved) { if (error?.code === "23505") { unchanged++; continue; } throw new Error("db"); }
            await admin.from("e_document_events").insert({ user_id: userId, document_id: saved.id, event_key: "portal-found:" + uuid, event_type: "portal_document_found", from_status: null, to_status: status, event_data: { provider: "nilvera" } });
            created++; portal.push({ id: saved.id, ...fields });
          }
        }
        if (rows.length < 100) break;
      }
    } catch (e) { errors.push({ documentType: spec.type, message: providerError(e) }); }
  }
  // Mükerrer fatura riski: portaldan kesilmiş faturanın alıcısına Matrix'te bekleyen bir taslak varsa bildir
  const { data: drafts } = await admin.from("e_documents").select("id,source_id,total_amount,currency,payload_snapshot").eq("user_id", userId).eq("direction", "outbound").eq("status", "draft");
  const warnings: any[] = [];
  for (const d of drafts || []) {
    const vkn = str(asObject(asObject(d.payload_snapshot).customer).taxNo, 20).replace(/\D/g, "");
    const hit = portal.find((p) => str(p.payload_snapshot?.customer?.taxNo, 20).replace(/\D/g, "") === vkn && vkn);
    if (hit) warnings.push({ draftId: d.id, shipmentId: d.source_id, customer: hit.payload_snapshot.customer.name, invoiceNumber: hit.document_number });
  }
  return { created, updated, unchanged, linked, errors, warnings };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return reply({ ok: false, error: "Yalnızca POST desteklenir." }, 405, origin);
  try {
    const url = env("SUPABASE_URL"), key = adminKey();
    if (!url || !key) throw new Error("Supabase sunucu ayarları eksik.");
    const authorization = req.headers.get("authorization") || "", jwt = authorization.replace(/^Bearer\s+/i, "");
    if (!jwt || jwt === authorization) return reply({ ok: false, error: "Matrix oturumu gerekli." }, 401, origin);
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const { data: identity, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !identity.user) return reply({ ok: false, error: "Matrix oturumu geçersiz veya süresi dolmuş." }, 401, origin);
    if (tokenClaims(jwt).aal !== "aal2") return reply({ ok: false, error: "e-Belge işlemi için iki adımlı doğrulama gerekli." }, 403, origin);
    if (!NILVERA_API_KEY) return reply({ ok: false, error: "Nilvera API anahtarı sunucuda tanımlı değil." }, 409, origin);
    const userId = identity.user.id;
    const body = asObject(await req.json().catch(() => ({}))), action = str(body.action, 40);

    if (action === "sync_outbound") return reply({ ok: true, ...(await syncOutbound(admin, userId)) }, 200, origin);

    if (action === "view" || action === "pdf") {
      const id = str(body.documentId, 64); if (!id) return reply({ ok: false, error: "documentId gerekli." }, 400, origin);
      const { data: doc } = await admin.from("e_documents").select("id,direction,document_type,provider_document_id,document_number,status,payload_snapshot,provider_metadata").eq("user_id", userId).eq("id", id).maybeSingle();
      if (!doc || !doc.provider_document_id) return reply({ ok: false, error: "Bu kayıt için Nilvera belgesi yok (henüz gönderilmemiş olabilir)." }, 404, origin);
      let path: string; try { path = docPath(doc, action); } catch (e) { return reply({ ok: false, error: (e as Error).message }, 400, origin); }
      try {
        if (action === "view") {
          const html = await nilvera(path, "text/html,application/xhtml+xml");
          if (!/<(?:!doctype\s+html|html|table|div)\b/i.test(html)) return reply({ ok: false, error: "Nilvera görüntülenebilir belge döndürmedi." }, 200, origin);
          return reply({ ok: true, html }, 200, origin);
        }
        let b64 = (await nilvera(path, "application/json")).trim();
        if (b64.startsWith('"')) { try { b64 = JSON.parse(b64); } catch { /* */ } }
        if (!/^JVBER/.test(b64)) return reply({ ok: false, error: "Nilvera PDF döndürmedi." }, 200, origin);
        const name = (str(doc.document_number, 40) || str(doc.provider_document_id, 36)).replace(/[^\w.-]+/g, "_") + ".pdf";
        return reply({ ok: true, base64: b64, filename: name }, 200, origin);
      } catch (e) { return reply({ ok: false, error: providerError(e) }, 200, origin); }
    }
    return reply({ ok: false, error: "Bilinmeyen işlem." }, 400, origin);
  } catch (e) {
    return reply({ ok: false, error: (e as Error)?.message || "Sunucu hatası." }, 500, origin);
  }
});
