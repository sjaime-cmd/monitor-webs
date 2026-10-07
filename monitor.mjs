// Monitor de webs de clientes — Rotundo
// Revisa cada web, y manda mail cuando una se cae (y cuando vuelve).
import fs from 'node:fs';
import nodemailer from 'nodemailer';

const TIMEOUT_MS = 15000;      // espera máxima por web
const SLOW_MS = 5000;          // "lenta" (solo informativo, no manda mail)
const CONFIRM_FAILS = 2;       // chequeos fallidos seguidos para dar la alerta
const RETRY_WAIT_MS = 10000;   // espera antes del reintento dentro del mismo chequeo
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const TZ = 'America/Argentina/Buenos_Aires';
const DRY_RUN = process.env.DRY_RUN === '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 RotundoMonitor/1.0';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = ts => new Date(ts).toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' });
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'menos de 1 minuto';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function loadSites() {
  if (process.env.SITES_JSON) return JSON.parse(process.env.SITES_JSON);
  if (fs.existsSync('sites.json')) return JSON.parse(fs.readFileSync('sites.json', 'utf8'));
  throw new Error('Falta la lista de sitios (secret SITES_JSON).');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function explainError(e) {
  if (e?.name === 'AbortError') return `No respondió en ${TIMEOUT_MS / 1000} segundos (timeout)`;
  const code = e?.cause?.code || e?.code || '';
  const msg = `${e?.cause?.message || ''} ${e?.message || ''}`;
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'El dominio no se resuelve (problema de DNS o dominio vencido)';
  if (code === 'ECONNREFUSED') return 'Conexión rechazada: el servidor no está atendiendo';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'El servidor cortó la conexión';
  if (code === 'CERT_HAS_EXPIRED') return 'Certificado SSL vencido';
  if (/CERT|SSL|TLS|certificate/i.test(code + msg)) return `Problema con el certificado SSL (${code || 'inválido'})`;
  if (/timeout/i.test(code + msg)) return 'Timeout de conexión';
  return `Error de conexión (${code || e?.message || 'desconocido'})`;
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
    const ms = Date.now() - t0;
    try { await r.body?.cancel(); } catch {}
    return { reached: true, status: r.status, ms, finalUrl: r.url };
  } catch (e) {
    return { reached: false, ms: Date.now() - t0, error: explainError(e) };
  } finally { clearTimeout(timer); }
}

// down | slow | up  (+ motivo)
function classify(r) {
  if (!r.reached) return { state: 'down', reason: r.error };
  const s = r.status;
  if (s >= 500) return { state: 'down', reason: `Error del servidor (HTTP ${s})`, status: s };
  if (s === 404 || s === 410) return { state: 'down', reason: `Página no encontrada (HTTP ${s})`, status: s };
  if (s >= 400 && ![401, 403, 429].includes(s)) return { state: 'down', reason: `Respuesta de error (HTTP ${s})`, status: s };
  // 401/403/429: el servidor responde pero bloquea al monitor; la web está arriba
  return { state: r.ms > SLOW_MS ? 'slow' : 'up', status: s };
}

async function check(site) {
  let r = await probe(site.url);
  let c = classify(r);
  if (c.state === 'down') {            // reintento antes de contar la falla
    await sleep(RETRY_WAIT_MS);
    r = await probe(site.url);
    c = classify(r);
  }
  return { ...c, ms: r.ms, finalUrl: r.finalUrl };
}

function mailShell(title, color, rowsHtml, footer) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111827">
  <div style="background:${color};color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-size:18px;font-weight:700">${title}</div>
  <div style="border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px;padding:8px 20px 16px">${rowsHtml}
  <p style="font-size:12px;color:#6B7280;margin:16px 0 0">${footer}</p></div></div>`;
}
const row = (label, value) => `<tr><td style="padding:4px 12px 4px 0;color:#6B7280;font-size:13px;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:4px 0;font-size:14px">${value}</td></tr>`;

function downMail(items) {
  const n = items.length;
  const subject = n === 1 ? `Web caída: ${items[0].site.name}` : `${n} webs caídas: ${items.map(i => i.site.name).join(', ')}`;
  const blocks = items.map(i => `<div style="padding:12px 0;border-bottom:1px solid #F3F4F6"><div style="font-size:16px;font-weight:700;margin-bottom:6px">${esc(i.site.name)}</div><table style="border-collapse:collapse">
    ${row('Web', `<a href="${esc(i.site.url)}">${esc(i.site.url)}</a>`)}
    ${row('Problema', `<b style="color:#EF4444">${esc(i.reason)}</b>`)}
    ${row('Primera falla', fmtDate(i.since))}
    ${row('Último OK', i.lastOk ? fmtDate(i.lastOk) : 'sin registro')}
    ${row('Fallas seguidas', `${i.fails} chequeos (cada 5 min)`)}
  </table></div>`).join('');
  const html = mailShell(n === 1 ? 'Web caída' : `${n} webs caídas`, '#EF4444', blocks, 'Aviso automático del monitor de Rotundo. Recibirás otro mail cuando la web vuelva a responder.');
  const text = items.map(i => `${i.site.name} (${i.site.url})\n  Problema: ${i.reason}\n  Primera falla: ${fmtDate(i.since)}\n  Último OK: ${i.lastOk ? fmtDate(i.lastOk) : 'sin registro'}`).join('\n\n');
  return { subject, html, text };
}
function upMail(items) {
  const n = items.length;
  const subject = n === 1 ? `Web recuperada: ${items[0].site.name}` : `${n} webs recuperadas: ${items.map(i => i.site.name).join(', ')}`;
  const blocks = items.map(i => `<div style="padding:12px 0;border-bottom:1px solid #F3F4F6"><div style="font-size:16px;font-weight:700;margin-bottom:6px">${esc(i.site.name)}</div><table style="border-collapse:collapse">
    ${row('Web', `<a href="${esc(i.site.url)}">${esc(i.site.url)}</a>`)}
    ${row('Estuvo caída', `<b>${fmtDur(i.downMs)}</b> (desde ${fmtDate(i.since)})`)}
    ${row('Motivo de la caída', esc(i.reason))}
    ${row('Ahora responde en', `${i.ms} ms`)}
  </table></div>`).join('');
  const html = mailShell(n === 1 ? 'Web recuperada' : `${n} webs recuperadas`, '#22C55E', blocks, 'Aviso automático del monitor de Rotundo.');
  const text = items.map(i => `${i.site.name} (${i.site.url})\n  Estuvo caída ${fmtDur(i.downMs)} (desde ${fmtDate(i.since)})\n  Motivo: ${i.reason}`).join('\n\n');
  return { subject, html, text };
}

async function sendMail({ subject, html, text }) {
  if (DRY_RUN) { console.log(`\n--- MAIL (dry run) ---\nAsunto: ${subject}\n${text}\n----------------------\n`); return; }
  const { GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_TO } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !MAIL_TO) throw new Error('Faltan GMAIL_USER, GMAIL_APP_PASSWORD o MAIL_TO.');
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  await transporter.sendMail({ from: `Monitor Rotundo <${GMAIL_USER}>`, to: MAIL_TO, subject, html, text });
}

async function main() {
  const sites = loadSites();
  const state = loadState();
  const before = JSON.stringify(state);
  const now = Date.now();

  const results = await Promise.all(sites.map(async s => ({ site: s, res: await check(s) })));

  // Si caen TODAS a la vez, probablemente sea un problema de red del monitor: no tocar nada.
  if (results.length > 2 && results.every(x => x.res.state === 'down')) {
    const control = await probe('https://www.google.com');
    if (!control.reached) { console.log('Sin conexión general desde el monitor. Se omite este chequeo.'); return; }
  }

  const downs = [], ups = [];
  for (const { site, res } of results) {
    const st = state[site.id] || { status: 'unknown', fails: 0, since: null, firstFail: null, lastOk: null, reason: null };
    if (res.state === 'down') {
      st.fails += 1;
      if (st.fails === 1) st.firstFail = now;
      st.reason = res.reason;
      if (st.fails >= CONFIRM_FAILS && st.status !== 'down') {
        st.status = 'down';
        st.since = st.firstFail;
        downs.push({ site, reason: res.reason, since: st.since, lastOk: st.lastOk, fails: st.fails });
      }
    } else {
      if (st.status === 'down') {
        ups.push({ site, reason: st.reason, since: st.since, downMs: now - st.since, ms: res.ms });
      }
      st.status = res.state; st.fails = 0; st.firstFail = null; st.since = null; st.reason = null; st.lastOk = now;
    }
    state[site.id] = st;
    console.log(`${res.state.toUpperCase().padEnd(5)} ${String(res.ms).padStart(5)} ms  ${site.name}${res.reason ? ' — ' + res.reason : ''}`);
  }

  // Primero se envían los mails; si falla el envío, no se guarda el estado y se reintenta en el próximo chequeo.
  if (downs.length) await sendMail(downMail(downs));
  if (ups.length) await sendMail(upMail(ups));

  // Limpiar sitios que ya no están en la lista
  const ids = new Set(sites.map(s => s.id));
  for (const k of Object.keys(state)) if (!ids.has(k)) delete state[k];

  const after = JSON.stringify(state);
  if (after !== before) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
