import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// TCMB günlük döviz kurlarını (USD, EUR) sunucu tarafında çeker. Tarayıcı TCMB'ye doğrudan erişemediği için aracı görevi görür.
// İstek:  POST { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }  (en fazla 62 gün; JWT zorunlu)
// Yanıt:  { rates: { "YYYY-MM-DD": { USD:{buy,sell}, EUR:{buy,sell} } }, missing: [...], skipped: [...], failed: [...] }
//   missing = TCMB'nin kur yayımlamadığı günler (resmi tatil / henüz yayımlanmadı), skipped = hafta sonu, failed = geçici hata

// Yalnızca uygulamanın yayınlandığı adres bu fonksiyonu tarayıcıdan çağırabilir (JWT zaten zorunlu; bu ek katman).
const ALLOWED_ORIGINS = ["https://kaurkai.github.io"];
function corsFor(req) {
  const origin = req.headers.get("origin") || "";
  const h = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (obj, status = 200, cors = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function parseTcmb(text) {
  const out = {};
  const re = /<Currency\b[^>]*?CurrencyCode="(USD|EUR)"[^>]*>([\s\S]*?)<\/Currency>/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2];
    const num = (tag) => {
      const x = body.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">"));
      return x ? parseFloat(x[1]) : NaN;
    };
    const unit = num("Unit") || 1;
    const buy = num("ForexBuying") / unit, sell = num("ForexSelling") / unit;
    if (buy > 0 && sell > 0) out[m[1]] = { buy, sell };
  }
  return out;
}
async function fetchDay(date) {
  const [y, mo, d] = date.split("-");
  const res = await fetch(`https://www.tcmb.gov.tr/kurlar/${y}${mo}/${d}${mo}${y}.xml`, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("TCMB HTTP " + res.status);
  const rates = parseTcmb(await res.text());
  return Object.keys(rates).length ? rates : null;
}
export async function handler(req) {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Yalnızca POST" }, 405, cors);
  try {
    const p = await req.json().catch(() => ({}));
    const today = new Date().toISOString().slice(0, 10);
    let to = p.to || p.from || today, from = p.from || to;
    if (!isDate(from) || !isDate(to)) return json({ error: "from/to YYYY-MM-DD biçiminde olmalı" }, 400, cors);
    if (to > today) to = today;
    if (from > to) return json({ rates: {}, missing: [], skipped: [], failed: [] }, 200, cors);
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    if (days.length > 62) return json({ error: "En fazla 62 günlük aralık istenebilir" }, 400, cors);
    const rates = {}, missing = [], skipped = [], failed = [];
    const queue = days.filter((d) => {
      const wd = new Date(d + "T00:00:00Z").getUTCDay();
      if (wd === 0 || wd === 6) { skipped.push(d); return false; }
      return true;
    });
    let i = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (i < queue.length) {
        const d = queue[i++];
        try { const r = await fetchDay(d); if (r) rates[d] = r; else missing.push(d); }
        catch (_e) { failed.push(d); }
      }
    }));
    missing.sort(); failed.sort();
    return json({ rates, missing, skipped, failed, source: "tcmb.gov.tr" }, 200, cors);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500, cors);
  }
}
Deno.serve(handler);
