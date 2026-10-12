import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Godo Matrix kampanya gönderim motoru.
//  action "test":    seçilen adımı örnek kişiyle YALNIZCA Furkan'ın kendi adreslerine gönderir.
//  action "process": yalnızca kuyruktaki ONAYLI işleri gönderir (hafta içi 09:00-18:00, aralıklı, günlük sınırla).
// Gizli değerler Supabase Secrets'tan okunur; hiçbiri yanıt olarak döndürülmez.

const env = (k) => (Deno.env.get(k) || "").trim();
const SENDER = env("GMAIL_SENDER");
const FROM_NAME = "Furkan Özbent";
const OPTOUT = 'Bu konuda yeniden iletişime geçmemizi istemezseniz bu e-postayı "istemiyorum" diye yanıtlamanız yeterli.';
const SAMPLE = { name: "Cafer Usta", company: "Ustaoğlu Holding", greeting: "Merhaba Cafer Bey" };
const MAX_PER_RUN = 4;

// ---------- yardımcılar (Matrix'teki önizlemeyle aynı kurallar) ----------
const enc = new TextEncoder();
export function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
const b64utf8 = (s) => b64(enc.encode(s));
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");
const hdr = (s) => /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + b64utf8(s) + "?=";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function fillText(text, c) {
  const first = String(c?.name || "").trim().split(/\s+/)[0] || "";
  return String(text || "").replace(/\{Selamlama\}/g, c?.greeting || ("Merhaba " + first).trim()).replace(/\{Ad\}/g, first).replace(/\{Firma\}/g, c?.company || "");
}
// Paragraflar <p>; "•", "-" ya da "*" ile başlayan ardışık satırlar asılı girintili madde listesi (<ul>)
const BULLET = /^\s*[•\-*]\s+/;
const textToHtml = (t) => String(t || "").split(/\n{2,}/).map((block) => {
  const out = []; let para = [], items = [];
  const flushP = () => { if (para.length) { out.push(`<p style="margin:0 0 14px 0;">${para.map(esc).join("<br>")}</p>`); para = []; } };
  const flushL = () => { if (items.length) { out.push(`<ul style="margin:0 0 14px 0;padding-left:24px;">${items.map((x) => `<li style="margin:0 0 6px 0;padding-left:4px;">${esc(x)}</li>`).join("")}</ul>`); items = []; } };
  for (const line of block.split("\n")) {
    if (BULLET.test(line)) { flushP(); items.push(line.replace(BULLET, "")); } else { flushL(); para.push(line); }
  }
  flushP(); flushL();
  return out.join("");
}).join("");
export function emailHtml(campaign, step, c) {
  return `<div style="font-family:Arial, Helvetica, sans-serif;font-size:14px;line-height:1.6;color:#12151a;">${textToHtml(fillText(step.body, c))}</div>`
    + (campaign.signature_html ? `<div style="margin-top:18px;">${campaign.signature_html}</div>` : "")
    + (step.optout ? `<p style="font-family:Arial, Helvetica, sans-serif;font-size:11px;color:#9aa2b0;margin:22px 0 0 0;">${esc(OPTOUT)}</p>` : "");
}
const sigText = (h) => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(tr|div|p)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&middot;/g, "·").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
export function emailText(campaign, step, c) {
  return fillText(step.body, c) + (campaign.signature_html ? "\n\n" + sigText(campaign.signature_html) : "") + (step.optout ? "\n\n" + OPTOUT : "");
}
export function buildMime({ to, subject, html, text, attachment, inReplyTo, references }) {
  const mixed = "mx_" + crypto.randomUUID().replace(/-/g, ""), alt = "al_" + crypto.randomUUID().replace(/-/g, "");
  const msgId = `<${crypto.randomUUID()}@godo.tr>`;
  const head = [
    `From: ${hdr(FROM_NAME)} <${SENDER}>`, `To: ${to}`, `Subject: ${hdr(subject)}`, `Message-ID: ${msgId}`, "MIME-Version: 1.0",
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : []),
  ];
  const altPart = [
    `--${alt}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(b64utf8(text)),
    `--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(b64utf8(html)),
    `--${alt}--`, "",
  ].join("\r\n");
  let body;
  if (attachment) {
    head.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    body = [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", altPart,
      `--${mixed}`, `Content-Type: application/pdf; name="${hdr(attachment.name)}"`, `Content-Disposition: attachment; filename="${hdr(attachment.name)}"`, "Content-Transfer-Encoding: base64", "", wrap76(b64(attachment.bytes)),
      `--${mixed}--`, ""].join("\r\n");
  } else {
    head.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    body = altPart;
  }
  return { raw: head.join("\r\n") + "\r\n\r\n" + body, msgId };
}
const b64url = (ascii) => btoa(ascii).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------- Google ----------
async function accessToken(rt) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GMAIL_CLIENT_ID"), client_secret: env("GMAIL_CLIENT_SECRET"), refresh_token: rt, grant_type: "refresh_token" }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("Google yetkisi alınamadı: " + (j.error || r.status));
  return j.access_token;
}
async function gmailSend(raw, threadId) {
  const tok = await accessToken(env("GMAIL_REFRESH_TOKEN_SEND"));
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify(threadId ? { raw: b64url(raw), threadId } : { raw: b64url(raw) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gmail gönderim hatası: " + (j.error?.message || r.status));
  return { id: j.id, threadId: j.threadId };
}
async function rfcIdOf(gmailId) {
  try {
    const tok = await accessToken(env("GMAIL_REFRESH_TOKEN_READ"));
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailId}?format=metadata&metadataHeaders=Message-ID`, { headers: { Authorization: "Bearer " + tok } });
    const j = await r.json();
    const h = (j.payload?.headers || []).find((x) => String(x.name).toLowerCase() === "message-id");
    return h ? h.value : null;
  } catch (_e) { return null; }
}

// Dizide bizden başka birinden mesaj var mı? (yalnızca başlıklar okunur: kimden, konu)
async function threadState(threadId) {
  if (!threadId) return { reply: false, bounce: false };
  const tok = await accessToken(env("GMAIL_REFRESH_TOKEN_READ"));
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) throw new Error("Dizi okunamadı: " + r.status);
  const j = await r.json();
  let reply = false, bounce = false, from = "", snippet = "";
  for (const m of j.messages || []) {
    const h = Object.fromEntries((m.payload?.headers || []).map((x) => [String(x.name).toLowerCase(), String(x.value)]));
    const f = (h.from || "").toLowerCase();
    if (!f || f.includes(SENDER.toLowerCase())) continue;
    if (/mailer-daemon|postmaster|mail delivery/.test(f) || /undeliver|delivery status|teslim edilemedi|failure notice/i.test(h.subject || "")) { bounce = true; snippet = h.subject || ""; continue; }
    reply = true; from = h.from || ""; snippet = (m.snippet || "").slice(0, 300);
  }
  return { reply, bounce, from, snippet };
}

// ---------- veri ----------
function adminKey() {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const m = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}"); return m.default || Object.values(m)[0] || ""; } catch (_e) { return ""; }
}
const SB = () => createClient(env("SUPABASE_URL"), adminKey(), { auth: { persistSession: false } });
async function attachmentOf(sb, campaign) {
  if (!campaign.attachment_path) throw new Error("Kampanyada PDF eki yok");
  const { data, error } = await sb.storage.from("campaign-files").download(campaign.attachment_path);
  if (error) throw new Error("PDF okunamadı: " + error.message);
  return { name: campaign.attachment_name || "GODO_Kurumsal_Profil.pdf", bytes: new Uint8Array(await data.arrayBuffer()) };
}
function trParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday: p.weekday };
}
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

async function actionTest(body) {
  const sb = SB();
  const to = String(body.to || "").trim().toLowerCase();
  const { data: allow, error: allowErr } = await sb.from("allowed_signups").select("email");
  if (allowErr) return json({ ok: false, error: "İzin listesi okunamadı: " + allowErr.message }, 500);
  const allowed = new Set([SENDER.toLowerCase(), ...(allow || []).map((a) => a.email.toLowerCase())]);
  if (!allowed.has(to)) return json({ ok: false, error: "Test maili yalnızca kendi adreslerine gönderilebilir" }, 403);
  const { data: campaign, error } = await sb.from("campaigns").select("*").eq("id", body.campaign_id).single();
  if (error || !campaign) return json({ ok: false, error: "Kampanya bulunamadı" }, 404);
  const idx = Number(body.step_index || 0), step = (campaign.steps || [])[idx];
  if (!step) return json({ ok: false, error: "Adım yok" }, 400);
  const subject = "[TEST] " + (idx === 0 ? step.subject : "Re: " + (campaign.steps[0]?.subject || ""));
  const attachment = step.attach ? await attachmentOf(sb, campaign) : null;
  const { raw } = buildMime({ to, subject, html: emailHtml(campaign, step, SAMPLE), text: emailText(campaign, step, SAMPLE), attachment });
  const sent = await gmailSend(raw, null);
  return json({ ok: true, gmail_id: sent.id, thread_id: sent.threadId, rfc_id: await rfcIdOf(sent.id), attachment_bytes: attachment?.bytes.length || 0, raw_bytes: raw.length });
}

async function actionProcess(body) {
  const now = trParts();
  const workday = !["Sat", "Sun"].includes(now.weekday);
  if (!body.ignore_hours && !(workday && now.hour >= 9 && now.hour < 18)) return json({ ok: true, skipped: "mesai dışı", tr: now });
  const sb = SB();
  const { data: jobs } = await sb.from("outreach_queue").select("*").eq("status", "bekliyor").order("approved_at").limit(MAX_PER_RUN);
  const results = [];
  for (const [i, job] of (jobs || []).entries()) {
    const { data: claimed } = await sb.from("outreach_queue").update({ status: "gonderiliyor", attempts: job.attempts + 1 }).eq("id", job.id).eq("status", "bekliyor").select("id");
    if (!claimed || !claimed.length) continue;                                  // başka bir çalıştırma aldı
    const fail = async (msg, status = "hata") => { await sb.from("outreach_queue").update({ status, error: String(msg).slice(0, 500) }).eq("id", job.id); results.push({ job: job.id, status, error: msg }); };
    try {
      const { data: o } = await sb.from("outreach").select("*").eq("id", job.outreach_id).single();
      if (!o || o.status !== "aktif") { await fail("Kişi aktif değil (" + (o?.status || "yok") + ")", "iptal"); continue; }
      if (job.step_to_send !== o.step + 1) { await fail("Adım uyuşmuyor (beklenen " + (o.step + 1) + ")", "iptal"); continue; }
      const { data: campaign } = await sb.from("campaigns").select("*").eq("id", o.campaign_id).single();
      if (!campaign) { await fail("Kampanya yok", "iptal"); continue; }
      if (campaign.status !== "aktif") { await sb.from("outreach_queue").update({ status: "bekliyor" }).eq("id", job.id); results.push({ job: job.id, status: "bekletildi", error: "kampanya aktif değil" }); continue; }
      const idx = job.step_to_send - 1, step = (campaign.steps || [])[idx];
      if (!step) { await fail("Kampanyada bu adım yok", "iptal"); continue; }
      if (idx > 0 && o.next_due_at && o.next_due_at > now.date) { await sb.from("outreach_queue").update({ status: "bekliyor" }).eq("id", job.id); results.push({ job: job.id, status: "bekletildi", error: "vadesi " + o.next_due_at }); continue; }
      if (idx === 0) {
        const { count } = await sb.from("outreach_queue").select("id, outreach!inner(campaign_id)", { count: "exact", head: true })
          .eq("status", "gonderildi").eq("step_to_send", 1).eq("outreach.campaign_id", campaign.id).gte("sent_at", now.date + "T00:00:00+03:00");
        if ((count || 0) >= campaign.daily_limit) { await sb.from("outreach_queue").update({ status: "bekliyor" }).eq("id", job.id); results.push({ job: job.id, status: "bekletildi", error: "günlük sınır doldu" }); continue; }
      }
      if (idx > 0) {
        const st = await threadState(o.thread_id);
        if (st.reply) { await sb.rpc("engine_record_reply", { p_id: o.id, p_note: (st.from ? st.from + ": " : "") + st.snippet }); results.push({ job: job.id, status: "iptal", error: "cevap geldi, hatırlatma gönderilmedi" }); continue; }
        if (st.bounce) { await sb.rpc("engine_record_bounce", { p_id: o.id, p_note: "Mail geri döndü: " + st.snippet }); results.push({ job: job.id, status: "iptal", error: "mail geri döndü" }); continue; }
      }
      const subject = idx === 0 ? step.subject : "Re: " + (campaign.steps[0]?.subject || "");
      const attachment = step.attach ? await attachmentOf(sb, campaign) : null;
      const contact = { name: o.name, company: o.company, greeting: o.greeting };
      const { raw } = buildMime({ to: o.email, subject, html: emailHtml(campaign, step, contact), text: emailText(campaign, step, contact), attachment,
        inReplyTo: idx > 0 ? (o.rfc_last_id || o.rfc_first_id) : null, references: idx > 0 ? [o.rfc_first_id, o.rfc_last_id].filter((x, k, a) => x && a.indexOf(x) === k).join(" ") : null });
      const sent = await gmailSend(raw, idx > 0 ? o.thread_id : null);
      const rfc = await rfcIdOf(sent.id);
      const { error: recErr } = await sb.rpc("engine_record_send", { p_id: o.id, p_subject: subject, p_gmail_id: sent.id, p_thread_id: sent.threadId, p_rfc_id: rfc });
      await sb.from("outreach_queue").update({ status: "gonderildi", gmail_id: sent.id, thread_id: sent.threadId, sent_at: new Date().toISOString(), error: recErr ? "kayıt: " + recErr.message : null }).eq("id", job.id);
      results.push({ job: job.id, status: "gonderildi", to: o.email, step: job.step_to_send });
    } catch (e) { await fail(e?.message || String(e)); }
    if (i < (jobs || []).length - 1) await new Promise((r) => setTimeout(r, 15000 + Math.floor(Math.random() * 10000)));   // mailler arası 15-25 sn
  }
  return json({ ok: true, tr: now, results });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  let body = {};
  try { body = await req.json(); } catch (_e) { /* boş */ }
  try {
    if (body.action === "test") return await actionTest(body);
    if (body.action === "process") return await actionProcess(body);
    if (body.action === "check_replies") {
      const sb = SB();
      const { data: rows } = await sb.from("outreach").select("id, name, company, email, thread_id").eq("status", "aktif").not("thread_id", "is", null).limit(200);
      const found = [];
      for (const o of rows || []) {
        try {
          const st = await threadState(o.thread_id);
          if (st.reply) { await sb.rpc("engine_record_reply", { p_id: o.id, p_note: (st.from ? st.from + ": " : "") + st.snippet }); found.push({ id: o.id, name: o.name, company: o.company, tur: "cevap", ozet: st.snippet }); }
          else if (st.bounce) { await sb.rpc("engine_record_bounce", { p_id: o.id, p_note: "Mail geri döndü: " + st.snippet }); found.push({ id: o.id, name: o.name, company: o.company, email: o.email, tur: "geri_dondu" }); }
        } catch (e) { found.push({ id: o.id, name: o.name, tur: "hata", ozet: e?.message || String(e) }); }
      }
      return json({ ok: true, taranan: (rows || []).length, bulunan: found });
    }
    if (body.action === "diag") {
      const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS"];
      const { error } = await SB().from("allowed_signups").select("email").limit(1);
      return json({ env: Object.fromEntries(names.map((n) => [n, !!env(n)])), admin_key_found: !!adminKey(), db_read_error: error ? error.message : null });
    }
    return json({ ok: false, error: "bilinmeyen işlem" }, 400);
  } catch (e) { return json({ ok: false, error: e?.message || String(e) }, 500); }
});
