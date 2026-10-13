import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const jobId = process.env.JOB_ID || '';
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const renderSecret = process.env.GODO_RENDER_SECRET || '';
const chromePath = process.env.CHROME_PATH || 'chrome';

if (!/^[0-9a-f-]{36}_[0-9a-f]{64}$/i.test(jobId)) throw new Error('Invalid PDF job ID.');
if (!supabaseUrl || !publicKey || !renderSecret) throw new Error('Renderer environment is incomplete.');

const headers = { apikey: publicKey, 'x-godo-render-secret': renderSecret };
const endpoint = `${supabaseUrl}/functions/v1/quote-pdf-render`;
const workspace = await mkdtemp(join(tmpdir(), 'godo-pdf-'));
const htmlPath = join(workspace, 'quote.html');
const pdfPath = join(workspace, 'quote.pdf');

try {
  const pull = await fetch(`${endpoint}?action=pull`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jobId }),
  });
  const job = await pull.json().catch(() => ({}));
  if (!pull.ok || !job.ok || typeof job.html !== 'string') throw new Error(`Could not retrieve PDF job (${pull.status}).`);
  await writeFile(htmlPath, job.html, { mode: 0o600 });
  await execFileAsync(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-javascript', '--no-pdf-header-footer',
    '--run-all-compositor-stages-before-draw', '--virtual-time-budget=2500', `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`,
  ], { timeout: 120000, maxBuffer: 1024 * 1024 });
  const pdf = await readFile(pdfPath);
  if (pdf.length < 1000 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Chrome did not produce a valid PDF.');

  const uploaded = await fetch(`${endpoint}?action=complete&jobId=${encodeURIComponent(jobId)}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/pdf' }, body: pdf,
  });
  const result = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok || !result.ok) throw new Error(`Could not archive rendered PDF (${uploaded.status}).`);
  console.log(`PDF archived successfully (${pdf.length} bytes).`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'PDF render failed.';
  console.error(message);
  try {
    await fetch(`${endpoint}?action=fail`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, error: message.slice(0, 240) }),
    });
  } catch { /* Keep the original render failure as the visible result. */ }
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
