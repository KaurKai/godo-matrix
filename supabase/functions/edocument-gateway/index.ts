import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Nilvera production integration. Credentials remain server-side in Edge Function Secrets.
const env = (key: string) => (Deno.env.get(key) || "").trim();
const NILVERA_API_KEY = env("NILVERA_API_KEY");
const NILVERA_ENV = env("NILVERA_ENV").toLowerCase() === "test" ? "test" : "live";
const NILVERA_BASE_URL = NILVERA_ENV === "live" ? "https://api.nilvera.com" : "https://apitest.nilvera.com";
const ORIGINS = new Set(["https://kaurkai.github.io", "https://godo.tr", "https://www.godo.tr"]);
type DocumentType = "e_invoice" | "e_archive_invoice" | "e_despatch";
type ProviderState = "submitted" | "accepted" | "rejected" | "failed";
type InboundDocumentType = "e_invoice" | "e_archive_invoice" | "e_despatch";
type ProviderCapabilities = {
  sendInvoice: boolean;
  sendDespatch: boolean;
  queryStatus: boolean;
  fetchIncomingInvoice: boolean;
  fetchIncomingDespatch: boolean;
  respondToIncoming: boolean;
};
interface EDocumentProviderAdapter {
  validate(snapshot: unknown): Promise<{ valid: boolean; errors: string[] }>;
  submit(input: { idempotencyKey: string; documentType: DocumentType; snapshot: unknown }): Promise<{
    providerDocumentId: string; ettn?: string; documentNumber?: string; state: ProviderState; safeMetadata?: Record<string, unknown>;
  }>;
  getStatus(providerDocumentId: string): Promise<{ state: ProviderState; safeMetadata?: Record<string, unknown> }>;
  listIncoming(input: { documentType: InboundDocumentType; cursor?: string }): Promise<{
    documents: Array<{ providerDocumentId: string; ettn?: string; documentNumber?: string; issueDate?: string; responseDueAt?: string; safeMetadata?: Record<string, unknown> }>;
    nextCursor?: string;
  }>;
  respondToIncoming(input: { providerDocumentId: string; response: "accept" | "reject"; reason?: string; idempotencyKey: string }): Promise<{
    state: "responded" | "failed"; safeMetadata?: Record<string, unknown>;
  }>;
}
// The browser only invokes authenticated actions; all provider requests are server-side.
const providerAdapter = { ready:true };

const CAPABILITIES: ProviderCapabilities = {sendInvoice:true,sendDespatch:true,queryStatus:true,fetchIncomingInvoice:true,fetchIncomingDespatch:true,respondToIncoming:true};
const isoDateTime=(v:unknown)=>{const d=new Date(String(v||""));return Number.isFinite(d.getTime())?d.toISOString():new Date().toISOString();};
async function nilveraRequest(path:string,method="GET",body?:unknown){
 if(!NILVERA_API_KEY)throw new Error("Nilvera API anahtarı sunucuda tanımlı değil.");
 if(!path.startsWith("/")||path.startsWith("//")||path.includes(".."))throw new Error("Nilvera API yolu geçersiz.");
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
 try{const response=await fetch(NILVERA_BASE_URL+path,{method,headers:{Authorization:"Bearer "+NILVERA_API_KEY,Accept:"application/json",...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:"error",signal:controller.signal});const raw=await response.text();let parsed:any=null;try{parsed=raw?JSON.parse(raw):null;}catch{parsed=raw;}if(!response.ok){const errObj=parsed&&typeof parsed==="object"?parsed:{};const errDetails=errObj.Errors||errObj.errors||errObj.Details||errObj.details;const detailText=Array.isArray(errDetails)?errDetails.map((x:any)=>typeof x==="string"?x:String(x?.Message||x?.message||x?.Description||JSON.stringify(x))).join("; "):errDetails&&typeof errDetails==="object"?Object.entries(errDetails).map(([k,v])=>k+": "+(Array.isArray(v)?v.join(", "):String(v))).join("; "):"";const msg=typeof parsed==="string"?parsed:String(errObj.ErrorMessage||errObj.errorMessage||errObj.Message||errObj.message||errObj.Error||errObj.error||detailText||errObj.Title||"");const safe=msg.replace(/Bearer\s+[^\s]+/ig,"Bearer [gizli]").replace(/<[^>]*>/g," ").replace(/[\r\n]+/g," ").replace(/\b\d{10,11}\b/g,"[VKN/TCKN]").slice(0,640);const e=new Error(safe||("Nilvera API HTTP "+response.status));(e as any).status=response.status;throw e;}return parsed;}catch(e){if(e instanceof DOMException&&e.name==="AbortError")throw new Error("Nilvera isteği zaman aşımına uğradı; gönderim sonucunu kontrol etmeden tekrar gönderme.");throw e;}finally{clearTimeout(timer);}
}
async function nilveraHtmlRequest(path:string){
 if(!NILVERA_API_KEY)throw new Error("Nilvera API anahtarı sunucuda tanımlı değil.");
 if(!path.startsWith("/")||path.startsWith("//")||path.includes(".."))throw new Error("Nilvera API yolu geçersiz.");
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
 try{
  const response=await fetch(NILVERA_BASE_URL+path,{method:"GET",headers:{Authorization:"Bearer "+NILVERA_API_KEY,Accept:"text/html,application/xhtml+xml"},redirect:"error",signal:controller.signal});
  const declared=Number(response.headers.get("content-length")||0);if(declared>4000000)throw new Error("Belge önizlemesi 4 MB sınırını aşıyor.");
  const html=await response.text();if(new TextEncoder().encode(html).length>4000000)throw new Error("Belge önizlemesi 4 MB sınırını aşıyor.");
  if(!response.ok){const safe=html.replace(/Bearer\s+[^\s]+/ig,"Bearer [gizli]").replace(/<[^>]*>/g," ").replace(/[\r\n]+/g," ").slice(0,240);const e=new Error(safe||("Nilvera API HTTP "+response.status));(e as any).status=response.status;throw e;}
  if(!/<(?:!doctype\s+html|html|table|div)\b/i.test(html))throw new Error("Nilvera yanıtı görüntülenebilir HTML belge içermiyor.");
  return html;
 }catch(e){if(e instanceof DOMException&&e.name==="AbortError")throw new Error("Belge önizlemesi zaman aşımına uğradı.");throw e;}finally{clearTimeout(timer);}
}
function asList(p:any){if(Array.isArray(p))return p;if(Array.isArray(p?.Content))return p.Content;if(Array.isArray(p?.content))return p.content;if(Array.isArray(p?.Items))return p.Items;return [];}
function mapProviderState(d:any):ProviderState{const s=safeProviderStatus(d),x=[s.statusCode,s.status,s.detail,s.answerCode,s.answer].join(" ").toLocaleLowerCase("tr-TR");if(/rejected|reject|error|hata|redded|ret edildi|\bret\b/.test(x))return "rejected";if(/accepted|accept|success|succeed|approved|başarılı|onaylandı|kabul edildi/.test(x))return "accepted";return "submitted";}
function safeProviderStatus(d:any){const p=(o:any,ks:string[])=>{for(const k of ks)if(o&&["string","number"].includes(typeof o[k]))return String(o[k]).slice(0,240);return "";};return {statusCode:p(d,["StatusCode","Code"]),status:p(d,["Description","Status","InvoiceStatus","DespatchStatus"]),detail:p(d,["StatusDetail","DetailDescription","GIBDescription","AnswerNote"]),answerCode:p(d?.Answer,["AnswerCode","Code"]),answer:p(d?.Answer,["Description","AnswerNote"]),envelopeId:p(d?.EnvelopeInfo,["UUID"]),envelopeDate:p(d?.EnvelopeInfo,["CreatedDate"])};}
function unitCode(raw:unknown){const u=String(raw||"").trim().toLocaleLowerCase("tr-TR"),m:Record<string,string>={"adet":"C62","ad":"C62","pcs":"C62","piece":"C62","c62":"C62","saat":"HUR","hour":"HUR","hur":"HUR","gün":"DAY","gun":"DAY","day":"DAY","metre":"MTR","m":"MTR","mtr":"MTR","mm":"MMT","kg":"KGM","kilogram":"KGM","gram":"GRM","litre":"LTR","lt":"LTR","set":"SET","paket":"PK","kutu":"BX","box":"BX"};return m[u]||(String(raw||"").length<=3?String(raw||"C62").toUpperCase():"C62");}
function buildNilveraPayload(s:any){
 const lines=asList(s.lines),issue=isoDateTime(String(s.issue_date)+"T12:00:00+03:00"),cur=String(s.currency||"TRY");
 if(s.document_type==="e_despatch"){const d=asObject(s.dispatch);return {EDespatch:{DespatchInfo:{UUID:crypto.randomUUID(),IssueDate:issue,ActualDespatchDateTime:isoDateTime(d.actualDespatchDateTime||s.issue_date+"T12:00:00+03:00"),PayableAmount:Number(s.gross_amount||0),CurrencyCode:cur,DespatchType:"SEVK",DespatchProfile:"TEMELIRSALIYE",...(d.despatchNumber?{DespatchSerieOrNumber:String(d.despatchNumber)}:{}),...(d.shipmentNumber?{ShipmentNumber:String(d.shipmentNumber)}:{})},DespatchSupplierInfo:{TaxNumber:String(s.issuer.taxNo||""),Name:String(s.issuer.legalName||s.issuer.name||""),TaxOffice:String(s.issuer.taxOffice||""),Address:String(s.issuer.address||""),Country:"Türkiye",...(s.issuer.phone?{Phone:s.issuer.phone}:{})},DeliveryCustomerInfo:{TaxNumber:String(s.customer.taxNo||""),Name:String(s.customer.name||""),TaxOffice:String(s.customer.taxOffice||""),Address:String(s.customer.address||""),Country:"Türkiye",...(s.customer.phone?{Phone:s.customer.phone}:{})},DespatchLines:lines.map((l:any,i:number)=>({Name:l.description,Description:l.description,SellerCode:l.product_code||null,DeliveredQuantity:Number(l.quantity),DeliveredUnitType:unitCode(l.unit),DeliveredUnitName:String(l.unit||"Adet"),QuantityPrice:Number(l.unit_price),LineTotal:Number((Number(l.quantity)*Number(l.unit_price)).toFixed(2))})),ShipmentDetail:{ShipmentInfo:{LicensePlateID:String(d.licensePlate),DriverPerson:[{FirstName:String(d.driverFirstName),LastName:String(d.driverLastName),TaxNumber:String(d.driverTaxNumber)}]},Delivery:{AddressInfo:{Address:String(d.deliveryAddress),City:String(d.deliveryCity),District:String(d.deliveryDistrict),Country:"Türkiye"},CarrierInfo:{Name:String(d.carrierName),TaxNumber:String(d.carrierTaxNumber||""),Country:"Türkiye"}}},...(s.order_no?{OrderReference:{ID:String(s.order_no),IssueDate:issue}}:{}),Notes:[String(s.order_no?"Matrix sipariş: "+s.order_no:"GODO Matrix sevkiyat")]},CustomerAlias:s.customer_alias||null};}
 const invLines=lines.map((l:any,i:number)=>({Index:String(i+1),SellerCode:l.product_code||null,Name:l.description,Description:l.description,Quantity:Number(l.quantity),UnitType:unitCode(l.unit),Price:Number(l.unit_price),AllowanceTotal:0,KDVPercent:Number(l.tax_rate||0),KDVTotal:Number((Number(l.quantity)*Number(l.unit_price)*Number(l.tax_rate||0)/100).toFixed(2))}));
 const net=Number(s.net_amount||0),vat=Number(s.vat_amount||0);
 const invoice={InvoiceInfo:{UUID:crypto.randomUUID(),InvoiceType:String(s.invoice_type||"SATIS"),...(s.vat_rate===0?{TaxExemptionReasonInfo:{KDVExemptionReasonCode:String(s.vat_exemption_code||"")}}:{}),InvoiceProfile:s.document_type==="e_archive_invoice"?"EARSIVFATURA":(s.invoice_profile||"TEMELFATURA"),IssueDate:issue,CurrencyCode:cur,ExchangeRate:1,...(s.internal_dispatch_number?{DespatchDocumentReference:[{IssueDate:issue,Value:String(s.internal_dispatch_number)}]}:{}),...(s.order_no?{OrderReference:{IssueDate:issue,Value:String(s.order_no)}}:{}),LineExtensionAmount:net,PayableAmount:Number(s.gross_amount||net+vat),KdvTotal:vat,GeneralKDV1Total:Number(s.vat_buckets?.["1"]||0),GeneralKDV8Total:Number(s.vat_buckets?.["8"]||0),GeneralKDV10Total:Number(s.vat_buckets?.["10"]||0),GeneralKDV18Total:Number(s.vat_buckets?.["18"]||0),GeneralKDV20Total:Number(s.vat_buckets?.["20"]||0)},CompanyInfo:{TaxNumber:String(s.issuer.taxNo||""),Name:String(s.issuer.legalName||s.issuer.name||""),TaxOffice:String(s.issuer.taxOffice||""),Address:String(s.issuer.address||""),Country:"Türkiye",City:String(s.issuer.city||""),District:String(s.issuer.district||""),...(s.issuer.phone?{Phone:s.issuer.phone}:{}),...(s.issuer.email?{Mail:s.issuer.email}:{})},CustomerInfo:{TaxNumber:String(s.customer.taxNo||""),Name:String(s.customer.name||""),TaxOffice:String(s.customer.taxOffice||""),Address:String(s.customer.address||""),Country:"Türkiye",City:String(s.customer.city||""),District:String(s.customer.district||""),...(s.customer.phone?{Phone:s.customer.phone}:{}),...(s.customer.email?{Mail:s.customer.email}:{})},InvoiceLines:invLines,Notes:[String(s.order_no?"Matrix sipariş: "+s.order_no:"GODO Matrix sevkiyat")]};
 if(s.document_type==="e_archive_invoice"){delete invoice.InvoiceInfo.InvoiceProfile;return {ArchiveInvoice:invoice,CustomerAlias:s.customer_alias||null};}return {EInvoice:invoice,CustomerAlias:s.customer_alias||null};
}
async function createNilveraDraft(doc:any){const s=asObject(doc.payload_snapshot),p=buildNilveraPayload(s),prefix=doc.document_type==="e_despatch"?"/edespatch":doc.document_type==="e_archive_invoice"?"/earchive":"/einvoice",r=await nilveraRequest(prefix+"/Draft/Create","POST",p),uuid=String(r?.UUID||r?.uuid||"").trim();if(!uuid)throw new Error("Nilvera taslak yanıtında UUID bulunamadı; tekrar göndermeden önce Portalı kontrol edin.");return {uuid,documentNumber:String(r?.InvoiceNumber||r?.DespatchNumber||"").trim()};}
async function confirmNilveraDraft(doc:any,uuid:string){const s=asObject(doc.payload_snapshot),prefix=doc.document_type==="e_despatch"?"/edespatch":doc.document_type==="e_archive_invoice"?"/earchive":"/einvoice",body=doc.document_type==="e_archive_invoice"?[uuid]:[{UUID:uuid,Alias:s.customer_alias||null}];return await nilveraRequest(prefix+"/Draft/ConfirmAndSend","POST",body);}
async function getNilveraStatus(doc:any){const id=encodeURIComponent(String(doc.provider_document_id||"")),path=doc.document_type==="e_despatch"?"/edespatch/Sale/"+id+"/Status":doc.document_type==="e_archive_invoice"?"/earchive/Invoices/"+id+"/Status":"/einvoice/Sale/"+id+"/Status";return await nilveraRequest(path);}
async function checkNilveraScopes(){const scopes:Record<string,unknown>={};for(const [k,p] of [["general","/general/ExchangeRate"],["incomingInvoice","/einvoice/Purchase?Page=1&PageSize=1"],["incomingDespatch","/edespatch/Purchase?Page=1&PageSize=1"],["taxpayerCheck","/general/GlobalCompany?Page=1&PageSize=1"]]){try{await nilveraRequest(p);scopes[k]={ok:true};}catch(e){scopes[k]={ok:false,code:(e as any)?.status===403?"scope_missing":(e as any)?.status===401?"key_rejected":"provider_error"};}}return scopes;}
async function syncIncoming(admin:ReturnType<typeof createClient>,userId:string){
 let created=0,updated=0,unchanged=0,pages=0;
 const errors:{documentType:string;code:string}[]=[];
 for(const spec of [{type:"e_invoice",path:"/einvoice/Purchase"},{type:"e_despatch",path:"/edespatch/Purchase"}]){
  try{
   for(let page=1;page<=10;page++){
    const result=await nilveraRequest(spec.path+"?Page="+page+"&PageSize=100");
    pages++;
    const docs=asList(result);
    for(const row of docs){
     const uuid=String(row.UUID||"").trim();
     if(!uuid)continue;
     const ans=String(row.AnswerCode||"").toLowerCase();
     const mappedStatus=ans==="waitingforapproval"?"awaiting_response":ans==="rejected"?"rejected":["approved","acceptall","documentanswered","documentansweredautomatically"].includes(ans)?"responded":"received";
     const issue=String(row.IssueDate||"").slice(0,10),number=String(row.InvoiceNumber||row.DespatchNumber||"").trim(),amount=Number(row.PayableAmount??row.TotalAmount??0),currency=String(row.CurrencyCode||"TRY");
     const safe={senderName:String(row.SenderName||"").slice(0,180),senderTaxNumber:String(row.SenderTaxNumber||row.TaxNumber||"").slice(0,20),senderAlias:String(row.SenderAlias||"").slice(0,240),receiverAlias:String(row.ReceiverAlias||"").slice(0,240),answerCode:ans.slice(0,80),providerStatusCode:String(row.StatusCode||"").slice(0,80),statusDetail:String(row.StatusDetail||"").slice(0,240),envelopeId:String(row.EnvelopeUUID||"").slice(0,80),envelopeDate:String(row.EnvelopeDate||"").slice(0,40),profile:String(row.InvoiceProfile||row.DespatchProfile||"").slice(0,80),invoiceType:String(row.InvoiceType||row.DespatchType||"").slice(0,80),isRead:row.IsRead===true,isArchived:row.IsArchive===true};
     const key="nilvera:in:"+spec.type+":"+uuid;
     const {data:old,error:findError}=await admin.from("e_documents").select("id,status").eq("user_id",userId).eq("idempotency_key",key).maybeSingle();
     if(findError)throw new Error("db");
     const status=old?.status==="response_uncertain"&&mappedStatus!=="responded"&&mappedStatus!=="rejected"?"response_uncertain":mappedStatus;
     if(old){
      const changed=old.status!==status;
      const {error}=await admin.from("e_documents").update({status,document_number:number||null,issue_date:validDate(issue)?issue:null,currency,total_amount:Number.isFinite(amount)&&amount>=0?amount:null,provider_metadata:safe,payload_snapshot:{direction:"inbound",document_type:spec.type,sender:safe.senderName,sender_tax_number:safe.senderTaxNumber,document_number:number,issue_date:issue,currency,total_amount:Number.isFinite(amount)?amount:null}}).eq("user_id",userId).eq("id",old.id);
      if(error)throw new Error("db");
      if(changed){await saveEvent(admin,userId,old.id,"provider-sync:"+status+":"+String(row.CreatedDate||""),"provider_status_synced",status,{provider:"nilvera"});updated++;}else unchanged++;
     }else{
      const {data:saved,error}=await admin.from("e_documents").insert({user_id:userId,document_type:spec.type,direction:"inbound",source_kind:"nilvera_inbox",source_id:uuid,source_revision:1,status,provider_key:"nilvera",provider_document_id:uuid,ettn:uuid,document_number:number||null,issue_date:validDate(issue)?issue:null,currency,total_amount:Number.isFinite(amount)&&amount>=0?amount:null,idempotency_key:key,payload_snapshot:{direction:"inbound",document_type:spec.type,sender:safe.senderName,sender_tax_number:safe.senderTaxNumber,document_number:number,issue_date:issue,currency,total_amount:Number.isFinite(amount)?amount:null},provider_metadata:safe}).select("id").single();
      if(error||!saved){if(error?.code==="23505"){unchanged++;continue;}throw new Error("db");}
      await saveEvent(admin,userId,saved.id,"received:"+uuid,"inbound_document_received",status,{provider:"nilvera"});created++;
     }
    }
    if(docs.length<100)break;
   }
  }catch(e){
   const status=Number((e as any)?.status||0);
   const code=status===401?"key_rejected":status===403?"permission_denied":status===404?"endpoint_not_found":e instanceof DOMException&&e.name==="AbortError"?"timeout":status>=500?"provider_unavailable":status?"provider_error":"sync_error";
   errors.push({documentType:spec.type,code});
  }
 }
 return {created,updated,unchanged,pages,errors};
}

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
async function nilveraReadOnlyProbe() {
  if (!NILVERA_API_KEY) return {ok:false,code:"not_configured",scopes:{}};
  const scopes=await checkNilveraScopes(),ok=Object.values(scopes).some((x:any)=>x?.ok===true),bad=Object.values(scopes).some((x:any)=>x?.code==="key_rejected");
  return {ok,code:ok?"connected":bad?"key_rejected":"scope_missing",scopes};
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
  const fields = ["name", "legalName", "taxOffice", "taxNo", "address", "phone", "email", "website", "city", "district", "postalCode", "country"];
  return Object.fromEntries(fields.filter(k => source[k] !== undefined).map(k => [k, source[k]]));
}
function safeCustomer(source: Record<string, unknown>) {
  const fields = ["name", "taxOffice", "taxNo", "address", "contactName", "phone", "email", "city", "district", "postalCode", "country"];
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
async function fetchTcmbForexBuying(currency: string, issueDate: string) {
 const code=String(currency||"").toUpperCase();
 if(code==="TRY")return {rate:1,rateDate:issueDate,source:"TRY",field:"Not applicable"};
 if(!["EUR","USD","GBP"].includes(code))throw new Error("TCMB dönüşümü şu an EUR, USD ve GBP için açık; kaynak para birimini kontrol edin.");
 const shift=(date:string,days:number)=>{const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
 for(let back=0;back<=10;back++){
  const rateDate=shift(issueDate,-back),[y,mo,d]=rateDate.split("-");
  let response:Response;
  try{response=await fetch(`https://www.tcmb.gov.tr/kurlar/${y}${mo}/${d}${mo}${y}.xml`,{signal:AbortSignal.timeout(8000)});}
  catch{continue;}
  if(response.status===404)continue;
  if(!response.ok)throw new Error("TCMB kur servisi yanıt vermedi (HTTP "+response.status+").");
  const xml=await response.text(), re=new RegExp(`<Currency\\b[^>]*?CurrencyCode="${code}"[^>]*>([\\s\\S]*?)<\\/Currency>`),match=xml.match(re);
  if(!match)continue;
  const tag=(name:string)=>{const m=match[1].match(new RegExp("<"+name+">([^<]*)</"+name+">"));return m?Number(String(m[1]).trim().replace(",",".")):NaN;};
  const unit=tag("Unit")||1, buying=tag("ForexBuying");
  if(Number.isFinite(buying)&&buying>0&&Number.isFinite(unit)&&unit>0)return {rate:buying/unit,rateDate,source:"TCMB",field:"ForexBuying"};
 }
 throw new Error("Fatura tarihine ait veya önceki 10 gün içinde yayımlanmış TCMB döviz alış kuru bulunamadı. Fatura taslağı oluşturulmadı.");
}
async function normalizedSnapshot(type: DocumentType, shipment: Record<string, unknown>, company: Record<string, unknown>, options: Record<string,unknown> = {}) {
 const isInvoice=type!=="e_despatch",today=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),date=String(isInvoice?(asObject(options.invoiceOptions).issueDate||today):shipment.date||"");
 if(!validDate(date))throw new Error("Belge tarihi eksik veya geçersiz.");
 if(isInvoice&&date>today)throw new Error("Fatura tarihi ileri bir tarih olamaz.");
 const rawCurrency=String(shipment.currency||"TRY").trim().toUpperCase(),currencyMap={"€":"EUR","EUR":"EUR","$":"USD","USD":"USD","₺":"TRY","TL":"TRY","TRY":"TRY","£":"GBP","GBP":"GBP"} as Record<string,string>,sourceCurrency=currencyMap[rawCurrency];if(!sourceCurrency)throw new Error("Kaynak para birimi tanınmıyor; dönüşüm yapılmadı.");
 const invoiceOptions=asObject(options.invoiceOptions),vatRate=Number(invoiceOptions.vatRate);
 if(isInvoice&&(![0,1,10,20].includes(vatRate)||invoiceOptions.vatRate===undefined||invoiceOptions.vatRate===null||String(invoiceOptions.vatRate)===""))throw new Error("Fatura için KDV oranını ayrıca seçin; sipariş oranı kullanılmaz.");
 const exemptionCode=String(invoiceOptions.vatExemptionCode||"").trim();
 if(isInvoice&&vatRate===0&&!/^\d{3}$/.test(exemptionCode))throw new Error("KDV %0 için Nilvera kod listesinden geçerli 3 haneli istisna kodu girilmelidir.");
 const rateInfo=isInvoice?await fetchTcmbForexBuying(sourceCurrency,date):{rate:1,rateDate:date,source:sourceCurrency,field:"Not applicable"};
 const lines=safeLines(shipment.lines).map((line,i)=>{
  const sourceLine=asArray(shipment.lines)[i]||{},unitPrice=Number(line.unit_price||0),converted=!isInvoice||sourceCurrency==="TRY"?unitPrice:Number((unitPrice*rateInfo.rate).toFixed(6));
  return {...line,quote_item_id:String(sourceLine.quoteItemId||""),unit_price:converted,currency:isInvoice?"TRY":sourceCurrency,tax_rate:isInvoice?vatRate:Number(sourceLine.vatRate??shipment.vatRate??0),source_unit_price:unitPrice,source_currency:sourceCurrency};
 });
 if(!lines.length||lines.some(x=>!x.product_code||!x.description||!(x.quantity>0)||x.unit_price<0))throw new Error("Belge satırları eksik veya geçersiz.");
 const customer=safeCustomer(asObject(shipment.customer));
 if(!customer.name||!customer.taxNo||!customer.address)throw new Error("Alıcı adı, vergi numarası ve adresi tamamlanmalı.");
 if(!company.name&&!company.legalName)throw new Error("Şirket unvanı tanımlı değil.");
 if(!company.taxNo||!company.address)throw new Error("Şirket vergi numarası ve adresi tamamlanmalı.");
 if(type==="e_despatch"&&String(shipment.officialIrsaliyeNo||"").trim())throw new Error("Bu sevkiyatın resmi e-İrsaliye numarası zaten kayıtlı; ikinci irsaliye oluşturmadan önce eşleştirin.");
 if(type!=="e_despatch"&&(String(shipment.invoiceNo||"").trim()||String(shipment.invoiceDate||"").trim()))throw new Error("Bu sevkiyatta fatura numarası/tarihi zaten var. Mevcut faturayla eşleştirmeden ikinci fatura oluşturmayın.");
 const roundLine=(value:number)=>Number(value.toFixed(2)),net=lines.reduce((a,l)=>a+roundLine(l.quantity*l.unit_price),0),vat=lines.reduce((a,l)=>a+roundLine(l.quantity*l.unit_price*l.tax_rate/100),0),dispatch=asObject(options.dispatch);
 if(type==="e_despatch")for(const [k,label] of [["licensePlate","Araç plakası"],["carrierName","Taşıyıcı adı"],["driverFirstName","Sürücü adı"],["driverLastName","Sürücü soyadı"],["driverTaxNumber","Sürücü TCKN/VKN"],["deliveryCity","Teslimat ili"],["deliveryDistrict","Teslimat ilçesi"],["deliveryAddress","Teslimat adresi"]])if(!String(dispatch[k]||"").trim())throw new Error(label+" e-İrsaliye için gerekli.");
 const profile=String(options.invoiceProfile||"TEMELFATURA");
 if(type==="e_invoice"&&!["TEMELFATURA","TICARIFATURA"].includes(profile))throw new Error("e-Fatura profili geçersiz.");
 const vatBuckets=Object.fromEntries([1,8,10,18,20].map(r=>[String(r),Number(lines.filter(x=>x.tax_rate===r).reduce((a,x)=>a+Number((x.quantity*x.unit_price*x.tax_rate/100).toFixed(2)),0).toFixed(2))]));
 return {document_type:type,direction:"outbound",source:{kind:"shipment",id:String(shipment.id||""),order_no:String(shipment.orderNo||"")},issuer:safeCompany(company),customer,issue_date:date,internal_invoice_number:null,internal_dispatch_number:String(shipment.officialIrsaliyeNo||shipment.irsaliyeNo||"")||null,currency:isInvoice?"TRY":sourceCurrency,vat_rate:isInvoice?vatRate:null,vat_exemption_code:isInvoice&&vatRate===0?exemptionCode:null,invoice_type:isInvoice&&vatRate===0?"ISTISNA":"SATIS",net_amount:Number(net.toFixed(2)),vat_amount:Number(vat.toFixed(2)),gross_amount:Number((net+(isInvoice?vat:0)).toFixed(2)),vat_buckets:vatBuckets,lines,invoice_profile:profile,customer_alias:String(options.customerAlias||"").trim()||null,dispatch,currency_conversion:isInvoice?{source_currency:sourceCurrency,target_currency:"TRY",rate:Number(rateInfo.rate.toFixed(6)),rate_date:rateInfo.rateDate,rate_source:rateInfo.source,rate_field:rateInfo.field,source_net_amount:Number(lines.reduce((a,l)=>a+Number((l.quantity*l.source_unit_price).toFixed(2)),0).toFixed(2))}:null};
}
function invoiceFinancialSnapshot(s:any){
 const conversion=asObject(s.currency_conversion);
 return {currency:"TRY",vatRate:Number(s.vat_rate||0),netAmount:Number(s.net_amount||0),vatAmount:Number(s.vat_amount||0),totalAmount:Number(s.gross_amount||0),sourceCurrency:String(conversion.source_currency||s.currency||"TRY"),sourceNetAmount:Number(conversion.source_net_amount||s.net_amount||0),currencyConversion:{rate:Number(conversion.rate||1),rateDate:String(conversion.rate_date||s.issue_date||""),source:String(conversion.rate_source||""),field:String(conversion.rate_field||"")},lines:asArray(s.lines).map((l:any)=>({quoteItemId:String(l.quote_item_id||""),code:String(l.product_code||""),desc:String(l.description||""),qty:Number(l.quantity||0),unitPrice:Number(l.unit_price||0),currency:"TRY",vatRate:Number(l.tax_rate||0)}))};
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
    if(action==="status")return reply({ok:true,providerKeyConfigured:!!NILVERA_API_KEY,providerEnvironment:NILVERA_ENV,providerConfigured:!!NILVERA_API_KEY,providerAdapterReady:true,canSubmit:!!NILVERA_API_KEY,canRefresh:!!NILVERA_API_KEY,canReceive:!!NILVERA_API_KEY,capabilities:CAPABILITIES},200,origin);
    if (action === "probe") {
      const probe=await nilveraReadOnlyProbe();
      return reply({ok:probe.ok,providerKeyConfigured:!!NILVERA_API_KEY,providerEnvironment:NILVERA_ENV,providerConfigured:!!NILVERA_API_KEY,providerAdapterReady:true,canSubmit:!!NILVERA_API_KEY,canRefresh:!!NILVERA_API_KEY,canReceive:!!NILVERA_API_KEY,capabilities:CAPABILITIES,connection:probe},200,origin);
    }
    if(action==="submit"){
 if(!NILVERA_API_KEY)return reply({ok:false,error:"Nilvera API anahtarı sunucuda tanımlı değil."},200,origin);
 if(body.confirmSend!==true)return reply({ok:false,error:"Canlı gönderim için önizleme sonrası açık onay gerekli."},200,origin);
 const id=String(body.documentId||"").trim();if(!id)return reply({ok:false,error:"documentId gerekli."},200,origin);
 const {data:doc,error}=await admin.from("e_documents").select("id,user_id,document_type,direction,source_kind,source_id,status,provider_key,provider_document_id,document_number,payload_snapshot,provider_metadata,attempt_count").eq("user_id",identity.user.id).eq("id",id).maybeSingle();
 if(error||!doc)return reply({ok:false,error:"e-Belge taslağı bulunamadı."},200,origin);
 if(doc.direction!=="outbound"||doc.source_kind!=="shipment"||!(doc.status==="draft"||(doc.status==="failed"&&!doc.provider_document_id)))return reply({ok:false,error:"Bu kayıt gönderime uygun taslak değil. Olası tekrar engellendi."},200,origin);
 if(doc.document_type!=="e_despatch"){
  const snapshot=asObject(doc.payload_snapshot),taxNo=String(asObject(snapshot.customer).taxNo||"").replace(/\D/g,"");
  if(!/^\d{10,11}$/.test(taxNo))return reply({ok:false,error:"Alıcı VKN/TCKN 10 veya 11 haneli olmalı."},200,origin);
  try{const taxpayer=await nilveraRequest("/general/GlobalCompany/Check/TaxNumber/"+encodeURIComponent(taxNo)+"?globalUserType=Invoice"),registered=asList(taxpayer).length>0;if((doc.document_type==="e_invoice"&&!registered)||(doc.document_type==="e_archive_invoice"&&registered))return reply({ok:false,error:registered?"Alıcı e-Fatura mükellefi; e-Fatura seçin.":"Alıcı e-Fatura mükellefi değil; e-Arşiv Fatura seçin."},200,origin);}
  catch(e){const status=Number((e as any)?.status||0),message=status===401?"Nilvera API anahtarı alıcı kontrolünü reddetti.":status===403?"Nilvera API anahtarında mükellef sorgulama izni eksik.":e instanceof Error?e.message:"Nilvera alıcı kontrolü başarısız.";return reply({ok:false,error:"Gönderim öncesi alıcı türü doğrulanamadı: "+message},200,origin);}
 }
 const {data:claim,error:claimError}=await admin.from("e_documents").update({status:"sending",attempt_count:Number(doc.attempt_count||0)+1,last_error:null,provider_key:"nilvera"}).eq("user_id",identity.user.id).eq("id",id).in("status",["draft","failed"]).select("id").maybeSingle();
 if(claimError||!claim)return reply({ok:false,error:"Belge başka bir işlem tarafından alındı veya durumu değişti."},200,origin);
 await saveEvent(admin,identity.user.id,id,"send-claim:"+String(Number(doc.attempt_count||0)+1),"send_confirmed","sending",{provider:"nilvera"});
 try{
  const draft=await createNilveraDraft(doc),meta={...asObject(doc.provider_metadata),remoteDraftUuid:draft.uuid,remoteDraftNumber:draft.documentNumber};
  const {error:saveDraftError}=await admin.from("e_documents").update({provider_document_id:draft.uuid,ettn:draft.uuid,document_number:draft.documentNumber||doc.document_number,provider_metadata:meta}).eq("user_id",identity.user.id).eq("id",id);
  if(saveDraftError)throw new Error("Nilvera taslağı oluştu; Matrix kaydı güncellenemedi. Portal kontrol edilmeden tekrar gönderim yapmayın.");
  try{await confirmNilveraDraft(doc,draft.uuid);}catch(e){
    await admin.from("e_documents").update({last_error:"Nilvera gönderim cevabı belirsiz; tekrar göndermeden önce Portal ve durum sorgusu kontrol edilmeli."}).eq("user_id",identity.user.id).eq("id",id);
    await saveEvent(admin,identity.user.id,id,"send-uncertain","send_result_uncertain","sending",{provider:"nilvera"});
    return reply({ok:false,uncertain:true,error:"Nilvera gönderim sonucu belirsiz. Çift belge riskine karşı tekrar gönderim kilitlendi; önce durum sorgulayın ve Nilvera Portalı kontrol edin."},202,origin);
  }
  const now=new Date().toISOString(),number=draft.documentNumber||doc.document_number||null;
  const {data:done,error:doneError}=await admin.from("e_documents").update({status:"submitted",document_number:number,submitted_at:now,provider_key:"nilvera",last_error:null,provider_metadata:{...meta,submittedAt:now,sourceSyncStatus:number?"pending":"awaiting_provider_number"}}).eq("user_id",identity.user.id).eq("id",id).select("id,status,document_type,provider_document_id,ettn,document_number,submitted_at").single();
  if(doneError||!done)throw new Error("Nilvera gönderimi tamamladı; Matrix durumu yazılamadı. Portal kontrol edilmeli.");
  await saveEvent(admin,identity.user.id,id,"submitted:"+draft.uuid,"provider_submitted","submitted",{provider:"nilvera"});
  let sourceSynced=false;
  if(number){try{const out=await admin.rpc("matrix_sync_shipment_edocument_fx",{p_user_id:identity.user.id,p_shipment_id:String(doc.source_id),p_document_type:String(doc.document_type),p_document_number:String(number),p_issue_date:String(asObject(doc.payload_snapshot).issue_date),p_invoice_snapshot:doc.document_type==="e_despatch"?null:invoiceFinancialSnapshot(asObject(doc.payload_snapshot))});sourceSynced=!out.error&&out.data?.updated===true;if(sourceSynced)await admin.from("e_documents").update({provider_metadata:{...meta,submittedAt:now,sourceSyncStatus:"synced",sourceSyncedAt:now}}).eq("user_id",identity.user.id).eq("id",id);}catch{}}
  return reply({ok:true,document:done,sourceSynced},200,origin);
 }catch(e){
  const message=String((e as Error)?.message||""),httpStatus=Number((e as any)?.status||0),uncertain=/tekrar gönder|belirsiz|Portal.*kontrol/i.test(message)||!httpStatus||httpStatus>=500||httpStatus===409;
  if(!uncertain){await admin.from("e_documents").update({status:"failed",last_error:"Nilvera taslak oluşturma başarısız; belge gönderilmedi."}).eq("user_id",identity.user.id).eq("id",id).eq("status","sending");await saveEvent(admin,identity.user.id,id,"create-failed","provider_create_failed","failed",{provider:"nilvera"});}
  return reply({ok:false,uncertain,error:uncertain?message:"Nilvera taslağı oluşturulamadı. Belge gönderilmedi."},uncertain?202:200,origin);
 }
}
if(action==="refresh"){
 if(!NILVERA_API_KEY)return reply({ok:false,error:"Nilvera API anahtarı sunucuda tanımlı değil."},409,origin);
 const id=String(body.documentId||"");const {data:doc,error}=await admin.from("e_documents").select("id,direction,document_type,status,provider_document_id").eq("user_id",identity.user.id).eq("id",id).maybeSingle();
 if(error||!doc||!doc.provider_document_id)return reply({ok:false,error:"Durumu sorgulanacak Nilvera belgesi bulunamadı."},404,origin);
 if(doc.direction!=="outbound")return reply({ok:false,error:"Bu belge için durum sorgusu desteklenmiyor."},400,origin);
 const result=await getNilveraStatus(doc),state=mapProviderState(result),safe=safeProviderStatus(result),patch:any={provider_metadata:safe,last_error:null};
 if(state==="accepted"){patch.status="accepted";patch.accepted_at=new Date().toISOString();}else if(state==="rejected"){patch.status="rejected";patch.rejected_at=new Date().toISOString();}else if(doc.status==="sending")patch.last_error="Nilvera durumu kesinleşmedi; tekrar gönderim yapmayın.";
 const {data:updated,error:updateError}=await admin.from("e_documents").update(patch).eq("user_id",identity.user.id).eq("id",id).select("id,status,document_type,provider_document_id,ettn,document_number,provider_metadata").single();
 if(updateError||!updated)throw new Error("Belge durumu Matrix'e kaydedilemedi.");
 await saveEvent(admin,identity.user.id,id,"status:"+state+":"+String(safe.statusCode||"unknown"),"provider_status_refreshed",String(patch.status||doc.status),{provider:"nilvera"});
 return reply({ok:true,document:updated},200,origin);
}
if(action==="sync_source"){
 const id=String(body.documentId||"").trim();if(!id)return reply({ok:false,error:"documentId gerekli."},400,origin);
 const {data:doc,error}=await admin.from("e_documents").select("id,direction,document_type,source_kind,source_id,status,provider_document_id,document_number,issue_date,payload_snapshot,provider_metadata").eq("user_id",identity.user.id).eq("id",id).maybeSingle();
 if(error||!doc)return reply({ok:false,error:"e-Belge kaydı bulunamadı."},404,origin);
 if(doc.direction!=="outbound"||doc.source_kind!=="shipment"||!doc.provider_document_id||!["submitted","accepted","rejected"].includes(doc.status))return reply({ok:false,error:"Bu belge sevkiyata eşitlemeye uygun değil."},409,origin);
 let number=String(doc.document_number||"").trim();
 if(!number&&NILVERA_API_KEY){try{const remote=await getNilveraStatus(doc);number=String(remote?.InvoiceNumber||remote?.DespatchNumber||remote?.DocumentNumber||remote?.Status?.DocumentNumber||"").trim();}catch{}}
 if(!number)return reply({ok:false,error:"Nilvera belge numarası henüz alınamıyor. Durum sorgulayıp sonra tekrar deneyin; yeniden belge göndermeyin."},409,origin);
 if(!doc.document_number){const {error:saveError}=await admin.from("e_documents").update({document_number:number}).eq("user_id",identity.user.id).eq("id",id);if(saveError)throw new Error("Belge numarası Matrix'e kaydedilemedi.");}
 const snapshot=asObject(doc.payload_snapshot),issue=String(snapshot.issue_date||doc.issue_date||"").slice(0,10);
 const out=await admin.rpc("matrix_sync_shipment_edocument_fx",{p_user_id:identity.user.id,p_shipment_id:String(doc.source_id),p_document_type:String(doc.document_type),p_document_number:number,p_issue_date:issue,p_invoice_snapshot:doc.document_type==="e_despatch"?null:invoiceFinancialSnapshot(snapshot)});
 if(out.error||out.data?.updated!==true)return reply({ok:false,error:"Nilvera belgesi bulundu ancak sevkiyat kaydı eşitlenemedi. Çift belge oluşturmadan tekrar deneyin; mevcut resmi kayıt korunuyor."},409,origin);
 const metadata={...asObject(doc.provider_metadata),sourceSyncStatus:"synced",sourceSyncedAt:new Date().toISOString()};
 const {data:updated,error:updateError}=await admin.from("e_documents").update({document_number:number,provider_metadata:metadata}).eq("user_id",identity.user.id).eq("id",id).select("id,status,document_type,document_number,provider_metadata").single();
 if(updateError||!updated)throw new Error("Sevkiyat kaydı eşitlendi; e-Belge merkezindeki durum yenilenemedi.");
 return reply({ok:true,sourceSynced:true,document:updated},200,origin);
}
if(action==="preview_incoming"){
 if(!NILVERA_API_KEY)return reply({ok:false,error:"Nilvera API anahtarı sunucuda tanımlı değil."},409,origin);
 const id=String(body.documentId||"").trim();if(!id)return reply({ok:false,error:"documentId gerekli."},400,origin);
 const {data:doc,error}=await admin.from("e_documents").select("id,direction,document_type,provider_document_id,document_number,ettn,payload_snapshot,provider_metadata").eq("user_id",identity.user.id).eq("id",id).maybeSingle();
 if(error||!doc)return reply({ok:false,error:"Gelen e-belge bulunamadı."},404,origin);
 if(doc.direction!=="inbound"||!["e_invoice","e_despatch"].includes(doc.document_type)||!doc.provider_document_id)return reply({ok:false,error:"Bu kayıt gelen fatura veya e-İrsaliye önizlemesine uygun değil."},400,origin);
 const uuid=String(doc.provider_document_id).trim();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid))return reply({ok:false,error:"Belge kimliği geçersiz."},400,origin);
 const path=doc.document_type==="e_despatch"?"/edespatch/Purchase/"+encodeURIComponent(uuid)+"/html":"/einvoice/Purchase/"+encodeURIComponent(uuid)+"/html";
 let html:string;
 try{html=await nilveraHtmlRequest(path);}catch(e){const status=Number((e as any)?.status||0),message=status===401?"Nilvera API anahtarı belge önizlemesini reddetti.":status===403?"Nilvera API anahtarında gelen belge görüntüleme izni eksik.":e instanceof Error?e.message:"Nilvera belge önizlemesi alınamadı.";return reply({ok:false,error:message},200,origin);}
 return new Response(JSON.stringify({ok:true,html,document:{id:doc.id,documentType:doc.document_type,documentNumber:doc.document_number||"",ettn:doc.ettn||uuid,sender:String(asObject(doc.provider_metadata).senderName||asObject(doc.payload_snapshot).sender||"Gelen belge").slice(0,180)}}),{status:200,headers:{...headers(origin),"Cache-Control":"no-store"}});
}
if(action==="inbox"){if(!NILVERA_API_KEY)return reply({ok:false,error:"Nilvera API anahtarı sunucuda tanımlı değil."},409,origin);return reply({ok:true,...await syncIncoming(admin,identity.user.id)},200,origin);}
if(action==="respond"){
 if(!NILVERA_API_KEY)return reply({ok:false,error:"Nilvera API anahtarı sunucuda tanımlı değil."},409,origin);
 if(body.confirmResponse!==true)return reply({ok:false,error:"Gelen belge yanıtı için açık onay gerekli."},400,origin);
 const id=String(body.documentId||"").trim(),response=String(body.response||"").toLowerCase(),reason=String(body.reason||"").trim().slice(0,500);
 if(!id||!["accept","reject"].includes(response))return reply({ok:false,error:"Belge ve kabul/ret seçimi gerekli."},400,origin);
 if(response==="reject"&&!reason)return reply({ok:false,error:"Ret yanıtı için gerekçe gerekli."},400,origin);
 const {data:doc,error}=await admin.from("e_documents").select("id,direction,document_type,status,provider_document_id,provider_metadata").eq("user_id",identity.user.id).eq("id",id).maybeSingle();
 if(error||!doc)return reply({ok:false,error:"Gelen belge bulunamadı."},404,origin);
 if(doc.direction!=="inbound"||!doc.provider_document_id||doc.document_type==="e_archive_invoice")return reply({ok:false,error:"Bu gelen belge yanıt için uygun değil."},400,origin);
 if(!["received","awaiting_response"].includes(doc.status))return reply({ok:false,error:doc.status==="response_uncertain"?"Yanıt sonucu belirsiz; tekrar yanıt göndermeden önce Nilvera Portalı ve gelen kutusu kontrolünü yenileyin.":"Bu belge yanıt için bekleyen durumda değil."},409,origin);
 const {data:claim,error:claimError}=await admin.from("e_documents").update({status:"responding",last_error:null}).eq("user_id",identity.user.id).eq("id",id).in("status",["received","awaiting_response"]).select("id").maybeSingle();
 if(claimError||!claim)return reply({ok:false,error:"Belge durumu değişti veya başka bir yanıt işlemi başladı."},409,origin);
 await saveEvent(admin,identity.user.id,id,"response-claim:"+Date.now(),"inbound_response_confirmed","responding",{provider:"nilvera",response});
 try{
  const uuid=String(doc.provider_document_id),path=doc.document_type==="e_despatch"?"/edespatch/Purchase/SendAnswer":"/einvoice/Purchase/SendAnswer";
  const request=doc.document_type==="e_despatch"?{DespatchUUID:uuid,AcceptAll:response==="accept",RejectAll:response==="reject",...(reason?{Notes:[reason]}:{})}:{UUID:uuid,AnswerCode:response==="accept"?"approved":"rejected",...(reason?{RejectNote:reason}:{})};
  const result=await nilveraRequest(path,"POST",request),safe={...asObject(doc.provider_metadata),response,responseAt:new Date().toISOString(),responseResult:String(result||"").slice(0,240)};
  const {data:done,error:doneError}=await admin.from("e_documents").update({status:"responded",last_error:null,provider_metadata:safe}).eq("user_id",identity.user.id).eq("id",id).select("id,status,document_type,provider_document_id").single();
  if(doneError||!done)throw new Error("Yanıt gönderildi ancak Matrix kaydı güncellenemedi; Nilvera Portalı kontrol edilmeli.");
  await saveEvent(admin,identity.user.id,id,"response-sent:"+response,"inbound_response_sent","responded",{provider:"nilvera",response});
  return reply({ok:true,document:done},200,origin);
 }catch(e){
  const statusCode=Number((e as any)?.status||0),uncertain=!statusCode||statusCode>=500||statusCode===409;
  const next=uncertain?"response_uncertain":"awaiting_response",msg=uncertain?"Yanıt sonucu belirsiz; tekrar göndermeden önce Nilvera Portalı ve gelen kutusu kontrolünü yenileyin.":"Nilvera yanıtı kabul etmedi; belge bekleyen durumda kaldı.";
  await admin.from("e_documents").update({status:next,last_error:msg}).eq("user_id",identity.user.id).eq("id",id).eq("status","responding");
  await saveEvent(admin,identity.user.id,id,uncertain?"response-uncertain":"response-failed","inbound_response_result",next,{provider:"nilvera"});
  return reply({ok:false,uncertain,error:uncertain?msg:(e instanceof Error?e.message:msg)},uncertain?202:422,origin);
 }
}
if (action !== "prepare") return reply({ ok: false, error: "action status, probe, prepare, submit, refresh, inbox, respond veya sync_source olmalı." }, 400, origin);

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
    const snapshot=await normalizedSnapshot(type,shipment,company,{invoiceProfile:body.invoiceProfile,customerAlias:body.customerAlias,dispatch:body.dispatch,invoiceOptions:body.invoiceOptions});
    if(type!=="e_despatch"&&!/^\d{10,11}$/.test(String(snapshot.customer.taxNo||"").replace(/\D/g,"")))throw new Error("Alıcı VKN/TCKN 10 veya 11 haneli olmalı.");

    if (type !== "e_despatch") {
      const keyNo = normalizeInvoiceNumber(shipment.invoiceNo);
      const conflict = shipments.filter(row => String(row.id || "") !== sourceId && normalizeInvoiceNumber(row.invoiceNo) === keyNo && keyNo);
      if (conflict.length) return reply({ ok: false, error: "Aynı satış fatura numarası başka sevkiyat kayıtlarında da var; önce fatura mutabakatı gerekli.", conflictCount: conflict.length }, 409, origin);
    }

    const { data: existing, error: existingError } = await admin.from("e_documents")
      .select("id,status,document_type,source_id,idempotency_key,created_at,payload_snapshot")
      .eq("user_id", identity.user.id).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw new Error("e-Belge kaydı okunamadı.");
    if (existing) return reply({ ok: true, idempotent: true, document: existing, preview: existing.payload_snapshot, canSubmit: false }, 200, origin);

    const { data: saved, error: saveError } = await admin.from("e_documents").insert({
      user_id: identity.user.id, document_type: type, direction: "outbound", source_kind: "shipment",
      source_id: sourceId, source_revision: 1, status: "draft", idempotency_key: idempotencyKey,
      document_number:null,
      issue_date: snapshot.issue_date, currency: snapshot.currency, total_amount: snapshot.gross_amount,
      payload_snapshot: snapshot,
    }).select("id,status,document_type,source_id,idempotency_key,created_at").single();
    if (saveError || !saved) throw new Error("e-Belge taslağı kaydedilemedi.");
    await saveEvent(admin, identity.user.id, saved.id, `prepared:${idempotencyKey}`, "draft_prepared", "draft", { source_kind: "shipment" });
    return reply({ ok: true, idempotent: false, document: saved, preview: snapshot, canSubmit: false, providerConfigured: !!NILVERA_API_KEY }, 201, origin);
  } catch (error) {
    return reply({ ok: false, code:"prepare_failed", error: error instanceof Error ? error.message : "e-Belge hazırlığı başarısız." }, 200, req.headers.get("origin") || "");
  }
});
