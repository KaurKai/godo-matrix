import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Provider-neutral preparation endpoint. No provider requests are sent until an
// adapter is implemented and credentials are installed as Edge Function secrets.
const env = (key: string) => (Deno.env.get(key) || "").trim();
const ORIGINS = new Set(["https://kaurkai.github.io", "https://godo.tr", "https://www.godo.tr"]);
type DocumentType = "e_invoice" | "e_archive_invoice" | "e_despatch";

function headers(origin: string) {
  return {
    ...(origin && ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}
function reply(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}
function adminKey() {
  if (env("SUPABASE_SERVICE_ROLE_KEY")) return env("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const keys = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    return String(keys.default || Object.values(keys)[0] || "");
  } catch { return ""; }
}
function tokenClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0))));
  } catch { return {}; }
}
function normalizeInvoiceNumber(value: unknown) {
  return String(value || "").trim().toLocaleUpperCase("tr-TR").replace(/[^A-Z0-9]/g, "");
}
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(x => x && typeof x === "object") as Record<string, unknown>[] : [];
}
function safeCompany(source: Record<string, unknown>) {
  const fields = ["name", "legalName", "taxOffice", "taxNo", "address", "phone", "email", "website"];
  return Object.fromEntries(fields.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}
function safeCustomer(source: Record<string, unknown>) {
  const fields = ["name", "taxOffice", "taxNo", "address", "contactName", "phone", "email"];
  return Object.fromEntries(fields.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}
function safeLines(source: unknown) {
  return asArray(source).map(line => ({
    product_code: String(line.code || ""),
    description: String(line.desc || ""),
    quantity: Number(line.qty || 0),
    unit_price: Number(line.unitPrice || line.unitCost || 0),
    currency: String(line.currency || ""),
    unit: String(line.unit || "C62"),
    tax_rate: Number(line.vatRate || 0),
    product_id: String(line.productId || ""),
  }));
}
function validDate(value: unknown) {
  const s = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function normalizedSnapshot(type: DocumentType, shipment: Record<string, unknown>, company: Record<string, unknown>) {
  const isInvoice = type !== "e_despatch";
  const invoiceNo = String(shipment.invoiceNo || "").trim();
  const date = String(isInvoice ? shipment.invoiceDate : shipment.date || "");
  const lines = safeLines(shipment.lines);
  if (!validDate(date)) throw new Error(isInvoice ? "Satış faturası tarihi eksik veya geçersiz." : "Sevk tarihi eksik veya geçersiz.");
  if (!lines.length || lines.some(x => !x.product_code || !x.description || !(x.quantity > 0) || x.unit_price < 0))
    throw new Error("Belge satırları eksik veya geçersiz.");
  const customer = safeCustomer(asObject(shipment.customer));
  if (!customer.name || !customer.taxNo || !customer.address) throw new Error("Alıcı adı, vergi numarası ve adresi tamamlanmalı.");
  if (!company.name && !company.legalName) throw new Error("Şirket unvanı tanımlı değil.");
  if (!company.taxNo || !company.address) throw new Error("Şirket vergi numarası ve adresi tamamlanmalı.");
  if (isInvoice && !invoiceNo) throw new Error("Önce satış faturası numarası girilmeli.");
  const vatRate = Number(shipment.vatRate || 0);
  if (isInvoice && (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100)) throw new Error("KDV oranı geçersiz.");
  const currency = String(shipment.currency || "EUR");
  const net = lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0);
  return {
    document_type: type,
    direction: "outbound",
    source: { kind: "shipment", id: String(shipment.id || ""), order_no: String(shipment.orderNo || "") },
    issuer: safeCompany(company),
    customer,
    issue_date: date,
    internal_invoice_number: isInvoice ? invoiceNo : null,
    internal_dispatch_number: String(shipment.irsaliyeNo || "") || null,
    currency,
    vat_rate: isInvoice ? vatRate : null,
    net_amount: Number(net.toFixed(2)),
    gross_amount: Number((net * (1 + (isInvoice ? vatRate : 0) / 100)).toFixed(2)),
    lines,
  };
}

async function saveEvent(admin: ReturnType<typeof createClient>, userId: string, documentId: string, eventKey: string, eventType: string, toStatus: string, eventData = {}) {
  const { error } = await admin.from("e_document_events").upsert({
    user_id: userId, document_id: documentId, event_key: eventKey, event_type: eventType,
    to_status: toStatus, event_data: eventData,
  }, { onConflict: "document_id,event_key", ignoreDuplicates: true });
  if (error) throw new Error("e-Belge olay kaydı oluşturulamadı.");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return reply({ ok: false, error: "Yalnızca POST desteklenir." }, 405, origin);
  try {
    const url = env("SUPABASE_URL"), key = adminKey();
    if (!url || !key) throw new Error("Supabase sunucu ayarları eksik.");
    const authorization = req.headers.get("authorization") || "";
    const jwt = authorization.replace(/^Bearer\s+/i, "");
    if (!jwt || jwt === authorization) return reply({ ok: false, error: "Matrix oturumu gerekli." }, 401, origin);
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const { data: identity, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !identity.user) return reply({ ok: false, error: "Matrix oturumu geçersiz veya süresi dolmuş." }, 401, origin);
    if (tokenClaims(jwt).aal !== "aal2") return reply({ ok: false, error: "e-Belge işlemi için iki adımlı doğrulama gerekli." }, 403, origin);

    const body = asObject(await req.json().catch(() => ({})));
    const action = String(body.action || "");
    if (action === "status") return reply({ ok: true, providerConfigured: false, providerAdapterReady: false, canSubmit: false }, 200, origin);
    if (action === "submit" || action === "refresh") {
      return reply({ ok: false, error: "Gönderim ve durum sorgulama, sağlayıcı seçilip API adaptörü doğrulanana kadar kapalı." }, 409, origin);
    }
    if (action !== "prepare") return reply({ ok: false, error: "action status, prepare, submit veya refresh olmalı." }, 400, origin);

    const type = String(body.documentType || "") as DocumentType;
    if (!["e_invoice", "e_archive_invoice", "e_despatch"].includes(type)) return reply({ ok: false, error: "Belge türü geçersiz." }, 400, origin);
    const sourceId = String(body.sourceId || "").trim();
    const idempotencyKey = String(body.idempotencyKey || "").trim();
    if (!sourceId || sourceId.length > 120) return reply({ ok: false, error: "sourceId gerekli." }, 400, origin);
    if (!idempotencyKey || idempotencyKey.length > 160) return reply({ ok: false, error: "idempotencyKey gerekli ve en fazla 160 karakter olmalı." }, 400, origin);

    const [shipmentRow, companyRow] = await Promise.all([
      admin.from("kv_store").select("value").eq("user_id", identity.user.id).eq("key", "godo:shipments").maybeSingle(),
      admin.from("kv_store").select("value").eq("user_id", identity.user.id).eq("key", "godo:company").maybeSingle(),
    ]);
    if (shipmentRow.error || companyRow.error) throw new Error("Matrix kayıtları okunamadı.");
    const shipments = asArray(JSON.parse(shipmentRow.data?.value || "[]"));
    const shipment = shipments.find(row => String(row.id || "") === sourceId);
    if (!shipment) return reply({ ok: false, error: "Sevkiyat bulunamadı." }, 404, origin);
    const company = asObject(JSON.parse(companyRow.data?.value || "{}"));
    const snapshot = normalizedSnapshot(type, shipment, company);

    if (type !== "e_despatch") {
      const keyNo = normalizeInvoiceNumber(shipment.invoiceNo);
      const conflict = shipments.filter(row => String(row.id || "") !== sourceId && normalizeInvoiceNumber(row.invoiceNo) === keyNo && keyNo);
      if (conflict.length) return reply({ ok: false, error: "Aynı satış fatura numarası başka sevkiyat kayıtlarında da var; önce fatura mutabakatı gerekli.", conflictCount: conflict.length }, 409, origin);
    }

    const { data: existing, error: existingError } = await admin.from("e_documents")
      .select("id,status,document_type,source_id,idempotency_key,created_at")
      .eq("user_id", identity.user.id).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw new Error("e-Belge kaydı okunamadı.");
    if (existing) return reply({ ok: true, idempotent: true, document: existing, canSubmit: false }, 200, origin);

    const { data: saved, error: saveError } = await admin.from("e_documents").insert({
      user_id: identity.user.id, document_type: type, direction: "outbound", source_kind: "shipment",
      source_id: sourceId, source_revision: 1, status: "draft", idempotency_key: idempotencyKey,
      document_number: type === "e_despatch" ? null : String(shipment.invoiceNo || ""),
      issue_date: snapshot.issue_date, currency: snapshot.currency, total_amount: snapshot.gross_amount,
      payload_snapshot: snapshot,
    }).select("id,status,document_type,source_id,idempotency_key,created_at").single();
    if (saveError || !saved) throw new Error("e-Belge taslağı kaydedilemedi.");
    await saveEvent(admin, identity.user.id, saved.id, `prepared:${idempotencyKey}`, "draft_prepared", "draft", { source_kind: "shipment" });
    return reply({ ok: true, idempotent: false, document: saved, canSubmit: false, providerConfigured: false }, 201, origin);
  } catch (error) {
    return reply({ ok: false, error: error instanceof Error ? error.message : "e-Belge hazırlığı başarısız." }, 400, req.headers.get("origin") || "");
  }
});
