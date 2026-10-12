import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (name: string) => (Deno.env.get(name) || "").trim();
const SENDER = env("GMAIL_SENDER").toLowerCase();
const ORIGINS = new Set(["https://kaurkai.github.io", "https://godo.tr", "https://www.godo.tr"]);
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function response(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}
function adminKey() {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}
function decodeClaims(jwt: string) {
  const part = jwt.split(".")[1];
  if (!part) return {};
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
}
function base64(bytes: Uint8Array) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
const base64Utf8 = (value: string) => base64(encoder.encode(value));
const wrap76 = (value: string) => value.replace(/.{1,76}/g, "$&\r\n");
const encodedHeader = (value: string) => /^[\x20-\x7e]*$/.test(value) ? value : "=?UTF-8?B?" + base64Utf8(value) + "?=";
const cleanHeader = (value: string) => String(value || "").replace(/[\r\n]/g, " ").trim();
const escapeHtml = (value: string) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (bytes: Uint8Array) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
const emailFromHeader = (value: string) => {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
};

async function refreshGoogleToken(refreshToken: string) {
  if (!refreshToken) throw new Error("Gmail taslak yetkisi yapılandırılmamış. GMAIL_REFRESH_TOKEN_COMPOSE secret gerekli.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GMAIL_CLIENT_ID"),
      client_secret: env("GMAIL_CLIENT_SECRET"),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("Gmail yetkisi alınamadı: " + (data.error || res.status));
  return data.access_token as string;
}

async function assertGmailAccount(token: string) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: "Bearer " + token },
  });
  const profile = await res.json().catch(() => ({}));
  if (!res.ok || String(profile.emailAddress || "").toLowerCase() !== SENDER) {
    throw new Error("Gmail OAuth hesabı GMAIL_SENDER adresiyle eşleşmiyor.");
  }
  return profile;
}

async function findReplyThread(to: string, sender: string, quoteNo: string) {
  if (!env("GMAIL_REFRESH_TOKEN_READ")) return null;
  const readToken = await refreshGoogleToken(env("GMAIL_REFRESH_TOKEN_READ"));
  await assertGmailAccount(readToken);
  const query = new URLSearchParams({ q: "from:" + to + " to:" + sender + " newer_than:365d", maxResults: "20" });
  const listRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?" + query, {
    headers: { Authorization: "Bearer " + readToken },
  });
  if (!listRes.ok) return null;
  const list = await listRes.json().catch(() => ({}));
  const threadIds = [...new Set((list.messages || []).map((m: { threadId?: string }) => m.threadId).filter(Boolean))].slice(0, 10) as string[];
  const matches: Array<{ threadId: string; subject: string; messageId: string; date: number }> = [];
  for (const threadId of threadIds) {
    const threadRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/" + encodeURIComponent(threadId) +
      "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID",
      { headers: { Authorization: "Bearer " + readToken } },
    );
    if (!threadRes.ok) continue;
    const thread = await threadRes.json().catch(() => ({}));
    const messages = thread.messages || [];
    const headersOf = (message: { payload?: { headers?: Array<{ name: string; value: string }> } }) =>
      Object.fromEntries((message.payload?.headers || []).map((h) => [String(h.name).toLowerCase(), String(h.value)]));
    const all = messages.map((m: { internalDate?: string }) => ({ m, h: headersOf(m) }));
    const subject = all.length ? cleanHeader(all[0].h.subject || "") : "";
    if (!/teklif|quotation|quote/i.test(subject) && !subject.includes(quoteNo)) continue;
    const incoming = all.filter((entry: { h: Record<string, string> }) => emailFromHeader(entry.h.from || "") === to);
    if (!incoming.length) continue;
    const last = incoming.sort((a: { m: { internalDate?: string } }, b: { m: { internalDate?: string } }) =>
      Number(a.m.internalDate || 0) - Number(b.m.internalDate || 0))[incoming.length - 1];
    const messageId = cleanHeader(last.h["message-id"] || "");
    if (!messageId) continue;
    matches.push({ threadId, subject, messageId, date: Number(last.m.internalDate || 0) });
  }
  matches.sort((a, b) => b.date - a.date);
  return matches[0] || null;
}

function buildMime(args: {
  to: string; subject: string; text: string; html: string; fileName: string; bytes: Uint8Array;
  thread?: { messageId: string } | null;
}) {
  const mixed = "godo-mixed-" + crypto.randomUUID();
  const alternative = "godo-alt-" + crypto.randomUUID();
  const headers = [
    "From: " + encodedHeader("Furkan Özbent") + " <" + SENDER + ">",
    "To: " + args.to,
    "Subject: " + encodedHeader(args.subject),
    "MIME-Version: 1.0",
    ...(args.thread ? ["In-Reply-To: " + args.thread.messageId, "References: " + args.thread.messageId] : []),
    'Content-Type: multipart/mixed; boundary="' + mixed + '"',
  ];
  const body = [
    "--" + mixed,
    'Content-Type: multipart/alternative; boundary="' + alternative + '"',
    "",
    "--" + alternative,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(args.text)),
    "--" + alternative,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(args.html)),
    "--" + alternative + "--",
    "",
    "--" + mixed,
    "Content-Type: application/pdf; name=\"" + args.fileName + "\"",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename=\"" + args.fileName + "\"",
    "",
    wrap76(base64(args.bytes)),
    "--" + mixed + "--",
    "",
  ].join("\r\n");
  const raw = headers.join("\r\n") + "\r\n\r\n" + body;
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createDraft(body: Record<string, unknown>, userId: string) {
  const quoteId = String(body.quoteId || "");
  const documentHash = String(body.documentHash || "");
  if (!/^[0-9a-f-]{36}$/i.test(quoteId) || !/^[0-9a-f]{64}$/i.test(documentHash)) {
    throw new Error("Teklif veya PDF sürüm bilgisi geçersiz.");
  }

  const admin = createClient(env("SUPABASE_URL"), adminKey(), { auth: { persistSession: false } });
  const quoteKey = "godo:quote:" + quoteId;
  const metaKey = "godo:quotePdf:" + quoteId + ":" + documentHash;
  const [{ data: quoteRow, error: quoteError }, { data: metaRow, error: metaError }] = await Promise.all([
    admin.from("kv_store").select("value").eq("user_id", userId).eq("key", quoteKey).maybeSingle(),
    admin.from("kv_store").select("value").eq("user_id", userId).eq("key", metaKey).maybeSingle(),
  ]);
  if (quoteError || !quoteRow) throw new Error("Teklif bulunamadı veya erişilemiyor.");
  if (metaError || !metaRow) throw new Error("Bu teklif sürümünün PDF arşivi bulunamadı. Önce PDF’yi arşivle.");
  const quote = JSON.parse(quoteRow.value);
  const meta = JSON.parse(metaRow.value);
  if (!quote.quoteNo || !quote.customer) throw new Error("Teklif kaydı eksik.");
  const to = String(quote.customer.contactEmail || (String(quote.customer.contactPhone || "").includes("@") ? quote.customer.contactPhone : "")).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("Teklifte geçerli bir müşteri e-posta adresi kayıtlı değil.");
  if (!meta.storagePath || !meta.storagePath.startsWith(userId + "/quotes/" + quoteId + "/") ||
      meta.contentHash !== documentHash || !meta.fileSha256 || meta.fileName !== String(quote.quoteNo) + ".pdf") {
    throw new Error("PDF arşiv kaydı teklif ile eşleşmiyor.");
  }

  const { data: file, error: fileError } = await admin.storage.from("campaign-files").download(meta.storagePath);
  if (fileError || !file) throw new Error("Arşivlenmiş PDF okunamadı.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length < 1000 || bytes.length > MAX_PDF_BYTES) throw new Error("PDF boyutu geçersiz.");
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Arşiv dosyası PDF olarak doğrulanamadı.");
  const actualSha = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (actualSha !== meta.fileSha256) throw new Error("PDF bütünlük kontrolü başarısız.");

  const thread = await findReplyThread(to, SENDER, String(quote.quoteNo));
  const subject = thread ? (thread.subject.toLowerCase().startsWith("re:") ? thread.subject : "Re: " + thread.subject)
    : "Teklif " + String(quote.quoteNo);
  const customerName = cleanHeader(quote.customer.contactName || quote.customer.name || "Mustafa Bey");
  const greeting = customerName === "Mustafa Bey" ? "Merhaba Mustafa Bey," : "Merhaba " + customerName + ",";
  const text = greeting + "\n\nTalebiniz için teşekkür ederiz. " + quote.quoteNo +
    " numaralı teklifimizi ekte bilgilerinize sunarız.\n\nSorularınız için bize ulaşabilirsiniz.\n\nİyi çalışmalar dileriz.";
  const html = "<div style=\"font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#222\"><p>" +
    escapeHtml(greeting) + "</p><p>Talebiniz için teşekkür ederiz. " + escapeHtml(quote.quoteNo) +
    " numaralı teklifimizi ekte bilgilerinize sunarız.</p><p>Sorularınız için bize ulaşabilirsiniz.</p><p>İyi çalışmalar dileriz.</p></div>";
  const fileName = String(meta.fileName).replace(/[^A-Za-z0-9._-]/g, "-");
  const raw = buildMime({ to, subject, text, html, fileName, bytes, thread });
  const token = await refreshGoogleToken(env("GMAIL_REFRESH_TOKEN_COMPOSE"));
  await assertGmailAccount(token);
  const draftRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw, ...(thread ? { threadId: thread.threadId } : {}) } }),
  });
  const draft = await draftRes.json().catch(() => ({}));
  if (!draftRes.ok || !draft.id) throw new Error("Gmail taslağı oluşturulamadı: " + (draft.error?.message || draftRes.status));
  return {
    ok: true,
    draftId: draft.id,
    gmailUrl: "https://mail.google.com/mail/u/0/#drafts/" + encodeURIComponent(draft.id),
    fileName: meta.fileName,
    size: bytes.length,
    threadMatched: !!thread,
    subject,
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (!ORIGINS.has(origin)) return new Response("Origin not allowed", { status: 403 });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return response({ ok: false, error: "Yalnızca POST desteklenir." }, 405, origin);
  const authorization = req.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token || token === authorization) return response({ ok: false, error: "Oturum doğrulanamadı." }, 401, origin);

  try {
    const serviceKey = adminKey();
    if (!serviceKey || !env("SUPABASE_URL")) throw new Error("Supabase sunucu ayarları eksik.");
    const admin = createClient(env("SUPABASE_URL"), serviceKey, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return response({ ok: false, error: "Matrix oturumu geçersiz veya süresi dolmuş." }, 401, origin);
    let claims: Record<string, unknown> = {};
    try { claims = decodeClaims(token); } catch { /* token signature was verified above */ }
    if (claims.aal !== "aal2") return response({ ok: false, error: "PDF ve Gmail işlemleri için doğrulanmış MFA oturumu gerekli." }, 403, origin);
    if (!SENDER || !env("GMAIL_CLIENT_ID") || !env("GMAIL_CLIENT_SECRET")) {
      throw new Error("Gmail sunucu ayarları eksik.");
    }
    const body = await req.json().catch(() => ({}));
    const result = await createDraft(body, data.user.id);
    return response(result, 200, origin);
  } catch (error) {
    return response({ ok: false, error: error instanceof Error ? error.message : "Gmail taslağı oluşturulamadı." }, 400, origin);
  }
});
