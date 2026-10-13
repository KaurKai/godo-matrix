import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Read-only Gmail intake scanner. It never marks mail read, sends mail, or edits Gmail labels.
const env = (key: string) => (Deno.env.get(key) || "").trim();
const SENDER = env("GMAIL_SENDER").toLowerCase();
const ORIGINS = new Set(["https://kaurkai.github.io", "https://godo.tr", "https://www.godo.tr"]);
const KEY = "godo:gmail-intake";
const KEEP_DAYS = 90;
const MAX_ITEMS = 200;
const MAX_BODY_CHARS = 6000;

function headers(origin: string) {
  return { ...(origin && ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-godo-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json" };
}
function reply(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
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
const cleanHeader = (s: unknown) => String(s || "").replace(/[\r\n]/g, " ").trim();
const emailOf = (s: string) => (s.match(/<([^>]+)>/)?.[1] || s).trim().toLowerCase();
function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
const decode64 = (s: string) => {
  const binary = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
};
function htmlText(html: string) {
  return html.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?\s*>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/[\t\u00a0 ]+/g, " ").replace(/\n\s+/g, "\n").trim();
}
type Part = { mimeType?: string; body?: { data?: string }; filename?: string; parts?: Part[] };
function readParts(part: Part, out: { plain: string[]; html: string[]; files: string[] }) {
  if (part.filename) out.files.push(part.filename);
  if (part.body?.data) {
    const text = decode64(part.body.data);
    if (part.mimeType === "text/plain") out.plain.push(text);
    if (part.mimeType === "text/html") out.html.push(text);
  }
  for (const child of part.parts || []) readParts(child, out);
}
function isQuoteRequest(subject: string, body: string) {
  const text = (subject + "\n" + body).normalize("NFKC").toLocaleLowerCase("tr-TR");
  return /\b(teklif|fiyat|fiyatlandırma|teklif talebi|teklifinizi|quotation|quote request|request (?:for )?(?:a )?quote|please quote|pricing|price request|price quote|price|rfq)\b/i.test(text);
}
async function googleAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GMAIL_CLIENT_ID"), client_secret: env("GMAIL_CLIENT_SECRET"),
      refresh_token: env("GMAIL_REFRESH_TOKEN_READ"), grant_type: "refresh_token" }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("Gmail okuma yetkisi yenilenemedi: " + (data.error || res.status));
  return String(data.access_token);
}
async function gmailJson(token: string, url: string) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Gmail API isteği başarısız (" + res.status + "): " + (data.error?.message || "").slice(0, 240));
  return data;
}
function messageHeaders(msg: { payload?: { headers?: Array<{ name: string; value: string }> } }) {
  return Object.fromEntries((msg.payload?.headers || []).map((h) => [String(h.name).toLowerCase(), String(h.value)]));
}
async function scanInbox(token: string) {
  const profile = await gmailJson(token, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  if (String(profile.emailAddress || "").toLowerCase() !== SENDER) throw new Error("Gmail okuma hesabı GMAIL_SENDER adresiyle eşleşmiyor.");
  const query = new URLSearchParams({ q: "in:inbox newer_than:90d -from:me {teklif fiyat fiyatlandırma quotation quote pricing price rfq}", maxResults: "100" });
  const listing = await gmailJson(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages?" + query);
  const threadIds = [...new Set((listing.messages || []).map((m: { threadId?: string }) => m.threadId).filter(Boolean))].slice(0, 60) as string[];
  const found: Record<string, unknown>[] = [];
  for (const threadId of threadIds) {
    const thread = await gmailJson(token, "https://gmail.googleapis.com/gmail/v1/users/me/threads/" + encodeURIComponent(threadId) + "?format=full");
    const messages = thread.messages || [];
    if (!messages.length) continue;
    const mapped = messages.map((m: { id: string; internalDate?: string; payload?: Part; snippet?: string }) => {
      const h = messageHeaders(m);
      const parts = { plain: [] as string[], html: [] as string[], files: [] as string[] };
      if (m.payload) readParts(m.payload, parts);
      const body = (parts.plain.join("\n") || parts.html.map(htmlText).join("\n") || String(m.snippet || "")).slice(0, MAX_BODY_CHARS);
      return { id: m.id, date: Number(m.internalDate || 0), from: cleanHeader(h.from), fromEmail: emailOf(h.from || ""),
        to: cleanHeader(h.to), subject: cleanHeader(h.subject), messageId: cleanHeader(h["message-id"]), body,
        files: [...new Set(parts.files)].slice(0, 20) };
    }).sort((a: { date: number }, b: { date: number }) => a.date - b.date);
    const latest = mapped[mapped.length - 1];
    if (!latest || !latest.fromEmail || latest.fromEmail === SENDER || !latest.messageId) continue;
    const request = mapped.filter((m: { fromEmail: string }) => m.fromEmail !== SENDER).at(-1);
    if (!request || !isQuoteRequest(request.subject, request.body)) continue;
    found.push({ id: request.messageId, threadId, messageId: request.messageId, from: request.from, fromEmail: request.fromEmail,
      subject: request.subject, date: new Date(request.date || Date.now()).toISOString(), text: request.body,
      attachments: request.files, gmailUrl: "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(threadId),
      isQuoteRequest: true, status: "new" });
  }
  return found;
}
function mergeIntake(previous: Record<string, unknown>[], incoming: Record<string, unknown>[]) {
  const byMessage = new Map(previous.map((item) => [String(item.messageId || item.id), item]));
  for (const fresh of incoming) {
    const id = String(fresh.messageId || fresh.id);
    const old = byMessage.get(id);
    byMessage.set(id, old ? { ...fresh, ...old, text: fresh.text, subject: fresh.subject, from: fresh.from, fromEmail: fresh.fromEmail,
      messageId: fresh.messageId, date: fresh.date, attachments: fresh.attachments } : fresh);
  }
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  return [...byMessage.values()].filter((item) => Date.parse(String(item.date || "")) >= cutoff)
    .sort((a, b) => Date.parse(String(b.date || "")) - Date.parse(String(a.date || ""))).slice(0, MAX_ITEMS);
}
async function saveIntake(admin: ReturnType<typeof createClient>, userId: string, items: Record<string, unknown>[]) {
  const value = JSON.stringify({ checkedAt: new Date().toISOString(), items });
  const { error } = await admin.from("kv_store").upsert({ user_id: userId, key: KEY, value }, { onConflict: "user_id,key" });
  if (error) throw new Error("Gmail talepleri Matrix'e kaydedilemedi: " + error.message);
}
async function getIdentity(req: Request, admin: ReturnType<typeof createClient>) {
  const cronSecret = env("GMAIL_MONITOR_CRON_SECRET");
  const supplied = req.headers.get("x-godo-cron-secret") || "";
  if (cronSecret && supplied && constantTimeEqual(supplied, cronSecret)) {
    const { data: owners, error } = await admin.from("campaigns").select("user_id");
    const ownerIds = [...new Set((owners || []).map((row: { user_id?: string }) => row.user_id).filter(Boolean))] as string[];
    if (error || ownerIds.length !== 1) throw new Error("Düzenli Gmail kontrolü için tek Matrix kampanya hesabı belirlenemedi.");
    const { data, error: userError } = await admin.auth.admin.getUserById(ownerIds[0]);
    if (userError || !data.user) throw new Error("Düzenli tarama için Matrix kullanıcı hesabı doğrulanamadı.");
    return { userId: ownerIds[0], cron: true };
  }
  const authorization = req.headers.get("authorization") || "";
  const jwt = authorization.replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === authorization) throw new Error("Matrix oturumu doğrulanamadı.");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) throw new Error("Matrix oturumu geçersiz veya süresi dolmuş.");
  let claims: Record<string, unknown> = {};
  try { claims = decodeClaims(jwt); } catch { /* getUser verified the token */ }
  if (claims.aal !== "aal2") throw new Error("Gmail taleplerini okumak için iki adımlı doğrulama gerekli.");
  return { userId: data.user.id, cron: false };
}
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (origin && !ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== "POST") return reply({ ok: false, error: "Yalnızca POST desteklenir." }, 405, origin);
  try {
    if (!env("SUPABASE_URL") || !adminKey()) throw new Error("Supabase sunucu ayarları eksik.");
    if (!SENDER || !env("GMAIL_CLIENT_ID") || !env("GMAIL_CLIENT_SECRET") || !env("GMAIL_REFRESH_TOKEN_READ"))
      throw new Error("Gmail okuma ayarları eksik. GMAIL_REFRESH_TOKEN_READ secret gerekli.");
    const admin = createClient(env("SUPABASE_URL"), adminKey(), { auth: { persistSession: false } });
    const identity = await getIdentity(req, admin);
    const token = await googleAccessToken();
    const fresh = await scanInbox(token);
    const { data: row, error } = await admin.from("kv_store").select("value").eq("user_id", identity.userId).eq("key", KEY).maybeSingle();
    if (error) throw new Error("Gelen kutusu durumu okunamadı: " + error.message);
    const previous = row?.value ? (JSON.parse(row.value).items || []) as Record<string, unknown>[] : [];
    const items = mergeIntake(previous, fresh);
    await saveIntake(admin, identity.userId, items);
    return reply({ ok: true, checkedAt: new Date().toISOString(), found: fresh.length, items }, 200, origin);
  } catch (error) {
    return reply({ ok: false, error: error instanceof Error ? error.message : "Gmail kontrolü başarısız." }, 400, origin);
  }
});
