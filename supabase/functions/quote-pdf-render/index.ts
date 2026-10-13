import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (key: string) => (Deno.env.get(key) || "").trim();
const ORIGINS = new Set(["https://kaurkai.github.io", "https://godo.tr", "https://www.godo.tr"]);
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function cors(origin: string) {
  return { ...(ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-godo-render-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json" };
}
function respond(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}
function adminKey() {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const keys = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}"); return keys.default || Object.values(keys)[0] || ""; }
  catch { return ""; }
}
function decodeClaims(jwt: string) {
  const part = jwt.split(".")[1];
  if (!part) return {};
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
}
function jobKey(jobId: string) { return "godo:quotePdfJob:" + jobId; }
function validJobId(value: unknown) { return /^[0-9a-f-]{36}_[0-9a-f]{64}$/i.test(String(value || "")); }
function constantTimeEqual(left: string, right: string) {
  const a = encoder.encode(left), b = encoder.encode(right);
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function getJob(admin: ReturnType<typeof createClient>, id: string) {
  const { data, error } = await admin.from("kv_store").select("user_id,value").eq("key", jobKey(id)).maybeSingle();
  if (error || !data?.value) throw new Error("PDF render işi bulunamadı.");
  return { userId: String(data.user_id), row: JSON.parse(data.value) as Record<string, unknown> };
}
async function putJob(admin: ReturnType<typeof createClient>, userId: string, id: string, job: Record<string, unknown>) {
  const { error } = await admin.from("kv_store").upsert({ user_id: userId, key: jobKey(id), value: JSON.stringify(job) }, { onConflict: "user_id,key" });
  if (error) throw new Error("PDF render işi kaydedilemedi: " + error.message);
}
async function expireOldJobs(admin: ReturnType<typeof createClient>, userId: string) {
  const { data } = await admin.from("kv_store").select("key,value").eq("user_id", userId).like("key", "godo:quotePdfJob:%").limit(100);
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const row of data || []) {
    try {
      const job = JSON.parse(row.value);
      if (["pending", "rendering"].includes(String(job.status)) && Date.parse(job.createdAt || "") < cutoff) {
        await admin.from("kv_store").upsert({ user_id: userId, key: row.key, value: JSON.stringify({ ...job, html: undefined, status: "failed", error: "PDF işi 30 dakika içinde tamamlanmadı; geçici içerik temizlendi." }) }, { onConflict: "user_id,key" });
      }
    } catch { /* Leave malformed rows untouched for inspection. */ }
  }
}
async function createJob(admin: ReturnType<typeof createClient>, body: Record<string, unknown>, userId: string) {
  const quoteId = String(body.quoteId || ""), contentHash = String(body.contentHash || ""), html = String(body.html || "");
  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !/^[0-9a-f]{64}$/i.test(contentHash)) throw new Error("Teklif veya içerik sürüm bilgisi geçersiz.");
  if (!html.startsWith("<!doctype html>") || encoder.encode(html).length > MAX_HTML_BYTES) throw new Error("PDF için oluşturulan teklif belgesi geçersiz veya çok büyük.");
  const { data: quoteRow, error: quoteError } = await admin.from("kv_store").select("value").eq("user_id", userId).eq("key", "godo:quote:" + quoteId).maybeSingle();
  if (quoteError || !quoteRow?.value) throw new Error("Teklif bulunamadı veya erişilemiyor.");
  const quote = JSON.parse(quoteRow.value);
  if (quote.id !== quoteId || !quote.quoteNo || !quote.customer) throw new Error("Teklif kaydı eksik.");

  await expireOldJobs(admin, userId);
  const id = quoteId + "_" + contentHash;
  const key = jobKey(id);
  const { data: previous } = await admin.from("kv_store").select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  if (previous?.value) {
    const old = JSON.parse(previous.value);
    if (old.status === "complete") return { ok: true, jobId: id, status: "complete", fileName: old.fileName };
    if (["pending", "rendering"].includes(String(old.status)) && Date.now() - Date.parse(old.createdAt || "") < 10 * 60 * 1000) return { ok: true, jobId: id, status: old.status };
  }

  const ghToken = env("GITHUB_ACTIONS_TOKEN"), repository = env("GITHUB_REPOSITORY"), ref = env("GITHUB_REF") || "main";
  if (!ghToken || !env("GODO_RENDER_SECRET") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9_./-]+$/.test(ref)) {
    throw new Error("GitHub PDF renderer ayarları eksik veya geçersiz.");
  }
  const job = { status: "pending", quoteId, contentHash, fileName: String(quote.quoteNo) + ".pdf", html,
    createdAt: new Date().toISOString(), error: "" };
  await putJob(admin, userId, id, job);
  const dispatch = await fetch("https://api.github.com/repos/" + repository + "/actions/workflows/quote-pdf-render.yml/dispatches", {
    method: "POST", headers: { Authorization: "Bearer " + ghToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ ref, inputs: { job_id: id } }),
  });
  if (!dispatch.ok) {
    const detail = await dispatch.text().catch(() => "");
    await putJob(admin, userId, id, { ...job, html: undefined, status: "failed", error: "GitHub Actions başlatılamadı (" + dispatch.status + ").", updatedAt: new Date().toISOString() });
    throw new Error("GitHub PDF üretim işi başlatılamadı (" + dispatch.status + "): " + detail.slice(0, 180));
  }
  return { ok: true, jobId: id, status: "pending" };
}
async function getStatus(admin: ReturnType<typeof createClient>, userId: string, id: string) {
  if (!validJobId(id)) throw new Error("PDF işi kimliği geçersiz.");
  const { data, error } = await admin.from("kv_store").select("value").eq("user_id", userId).eq("key", jobKey(id)).maybeSingle();
  if (error || !data?.value) throw new Error("PDF işi bulunamadı.");
  const job = JSON.parse(data.value);
  return { ok: true, jobId: id, status: job.status, fileName: job.fileName, error: job.error || "" };
}
async function pullJob(admin: ReturnType<typeof createClient>, id: string) {
  if (!validJobId(id)) throw new Error("PDF işi kimliği geçersiz.");
  const { userId, row } = await getJob(admin, id);
  if (row.status !== "pending" || !row.html) throw new Error("PDF işi beklemede değil veya içeriği yok.");
  await putJob(admin, userId, id, { ...row, status: "rendering", startedAt: new Date().toISOString() });
  return { ok: true, html: row.html, fileName: row.fileName };
}
async function failJob(admin: ReturnType<typeof createClient>, id: string, message: string) {
  if (!validJobId(id)) throw new Error("PDF işi kimliği geçersiz.");
  const { userId, row } = await getJob(admin, id);
  if (["complete", "failed"].includes(String(row.status))) return { ok: true, status: row.status };
  await putJob(admin, userId, id, { ...row, html: undefined, status: "failed", error: message.slice(0, 240), updatedAt: new Date().toISOString() });
  return { ok: true, status: "failed" };
}
async function completeJob(req: Request, admin: ReturnType<typeof createClient>, id: string) {
  if (!validJobId(id)) throw new Error("PDF işi kimliği geçersiz.");
  const type = req.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/pdf")) throw new Error("Renderer yalnızca PDF kabul eder.");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > MAX_PDF_BYTES || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Chromium çıktısı geçerli PDF değil veya boyut sınırını aşıyor.");
  const { userId, row } = await getJob(admin, id);
  if (row.status !== "rendering") throw new Error("PDF işi şu anda tamamlanamaz.");
  const { data: quoteRow, error: quoteError } = await admin.from("kv_store").select("value").eq("user_id", userId).eq("key", "godo:quote:" + row.quoteId).maybeSingle();
  if (quoteError || !quoteRow?.value) throw new Error("PDF teklifi artık bulunamıyor.");
  const quote = JSON.parse(quoteRow.value);
  const safeNo = String(quote.quoteNo || "teklif").replace(/[^A-Za-z0-9._-]/g, "-");
  const path = userId + "/quotes/" + row.quoteId + "/" + safeNo + "-" + String(row.contentHash).slice(0, 20) + ".pdf";
  const { error: uploadError } = await admin.storage.from("campaign-files").upload(path, new Blob([bytes], { type: "application/pdf" }), { upsert: true, contentType: "application/pdf" });
  if (uploadError) throw new Error("PDF özel Supabase deposuna yüklenemedi: " + uploadError.message);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((x) => x.toString(16).padStart(2, "0")).join("");
  const metadata = { quoteId: row.quoteId, quoteNo: quote.quoteNo, version: quote.version || 1, contentHash: row.contentHash,
    fileSha256: sha, fileName: row.fileName, storagePath: path, size: bytes.length, createdAt: new Date().toISOString(), renderer: "chromium-print-to-pdf" };
  const { error: metadataError } = await admin.from("kv_store").upsert({ user_id: userId, key: "godo:quotePdf:" + row.quoteId + ":" + row.contentHash, value: JSON.stringify(metadata) }, { onConflict: "user_id,key" });
  if (metadataError) throw new Error("PDF yüklendi fakat arşiv kaydı oluşturulamadı: " + metadataError.message);
  await putJob(admin, userId, id, { ...row, html: undefined, status: "complete", fileName: row.fileName, storagePath: path, updatedAt: new Date().toISOString(), error: "" });
  return { ok: true, fileName: row.fileName, size: bytes.length };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return respond({ ok: false, error: "Yalnızca POST desteklenir." }, 405, origin);
  try {
    if (!env("SUPABASE_URL") || !adminKey()) throw new Error("Supabase sunucu ayarları eksik.");
    const admin = createClient(env("SUPABASE_URL"), adminKey(), { auth: { persistSession: false } });
    const secret = env("GODO_RENDER_SECRET"), supplied = req.headers.get("x-godo-render-secret") || "";
    if (supplied && secret && constantTimeEqual(supplied, secret)) {
      const url = new URL(req.url), action = url.searchParams.get("action");
      if (action === "pull") {
        const body = await req.json().catch(() => ({}));
        return respond(await pullJob(admin, String(body.jobId || "")), 200, origin);
      }
      if (action === "complete") return respond(await completeJob(req, admin, url.searchParams.get("jobId") || ""), 200, origin);
      if (action === "fail") {
        const body = await req.json().catch(() => ({}));
        return respond(await failJob(admin, String(body.jobId || ""), String(body.error || "Chromium PDF üretimi başarısız.")), 200, origin);
      }
      return respond({ ok: false, error: "Renderer işlemi geçersiz." }, 400, origin);
    }
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return respond({ ok: false, error: "Matrix oturumu doğrulanamadı." }, 401, origin);
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return respond({ ok: false, error: "Matrix oturumu geçersiz." }, 401, origin);
    let claims: Record<string, unknown> = {};
    try { claims = decodeClaims(token); } catch { /* admin.auth.getUser validated signature */ }
    if (claims.aal !== "aal2") return respond({ ok: false, error: "PDF işlemi için iki adımlı doğrulama gerekli." }, 403, origin);
    const body = await req.json().catch(() => ({}));
    if (body.action === "create") return respond(await createJob(admin, body, data.user.id), 200, origin);
    if (body.action === "status") return respond(await getStatus(admin, data.user.id, String(body.jobId || "")), 200, origin);
    return respond({ ok: false, error: "İşlem türü geçersiz." }, 400, origin);
  } catch (error) {
    return respond({ ok: false, error: error instanceof Error ? error.message : "PDF üretimi başarısız." }, 400, origin);
  }
});
