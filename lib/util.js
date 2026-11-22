// Utilitaires partagés : processus, hachage, identifiants, nouvelles tentatives.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Requête HTTP(S) qui s'utilise comme fetch, mais essaie toutes les adresses IP du serveur l'une après l'autre.
// fetch (undici) ne tente que la première : si elle est injoignable alors que les autres répondent, il échoue.
// headersTimeout / idleTimeout (ms) : certaines connexions bloquent l'envoi au hasard ; sans en-têtes de réponse dans le délai,
// ou sans nouvelles données pendant la réception, la requête est abandonnée pour être relancée sur une connexion neuve.
export function httpRequest(url, { method = 'GET', headers = {}, body, signal, headersTimeout = 0, idleTimeout = 0 } = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const h = body != null ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers;
  return new Promise((resolve, reject) => {
    let timer;
    const watch = (ms, target, message, code) => {
      clearTimeout(timer);
      if (ms) timer = setTimeout(() => target.destroy(Object.assign(new Error(message), { code })), ms);
    };
    const fail = (e) => { clearTimeout(timer); reject(e); };
    const req = lib.request(u, { method, headers: h, signal, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 2500 }, (res) => {
      const chunks = [];
      const stall = () => watch(idleTimeout, res, `réponse interrompue (aucune donnée pendant ${Math.round(idleTimeout / 1000)} s)`, 'ERESPONSESTALL');
      stall();
      res.on('data', (c) => { chunks.push(c); stall(); });
      res.on('error', fail);
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
          text: async () => buf.toString('utf8'), json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf });
      });
    });
    req.on('error', fail);
    watch(headersTimeout, req, `envoi bloqué par la connexion (pas de réponse en ${Math.round(headersTimeout / 1000)} s)`, 'EUPLOADSTALL');
    if (body != null) req.write(body);
    req.end();
  });
}

export function sha(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function newId(prefix = '') {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, '');
  return prefix + stamp + '-' + crypto.randomBytes(3).toString('hex');
}

// Lance un exécutable sans shell (arguments jamais interprétés), capture stdout/stderr.
export function run(cmd, args, { cwd, onStdout, onStderr, onSpawn, timeoutMs = 0, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    onSpawn?.(child);
    let out = '';
    let err = '';
    let timer;
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b) => { const s = b.toString(); out += s; onStdout?.(s); });
    child.stderr.on('data', (b) => { const s = b.toString(); err += s; if (err.length > 2e6) err = err.slice(-1e6); onStderr?.(s); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else {
        const e = new Error(`${path.basename(cmd)} a échoué (code ${code}) : ${lastLines(err, 4)}`);
        e.stdout = out; e.stderr = err; e.code = code;
        reject(e);
      }
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

export function lastLines(s, n = 3) {
  return String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ');
}

// Nouvelles tentatives avec attente exponentielle, uniquement pour les erreurs marquées « retryable ».
export async function retry(fn, { attempts = 3, baseMs = 1500, label = 'appel' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(i); } catch (e) {
      lastErr = e;
      if (e.retryable === false || i === attempts) break;
      await sleep(baseMs * 2 ** (i - 1));
    }
  }
  if (lastErr && attempts > 1 && lastErr.retryable !== false) lastErr.message = `${label} : ${lastErr.message} (après ${attempts} tentatives)`;
  throw lastErr;
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

export function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

export function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Place src à relBase + ext dans root. Sous Windows, un fichier ouvert (ex. vidéo en cours de lecture
// dans le navigateur) ne peut pas être remplacé : on prend alors un nom unique. Renvoie le chemin relatif.
// copy : le fichier d'origine est conservé (copie au lieu d'un déplacement).
export function placeFile(src, root, relBase, ext, { copy = false } = {}) {
  let rel = relBase + ext;
  const put = (to) => (copy ? fs.copyFileSync(src, to) : fs.renameSync(src, to));
  ensureDir(path.dirname(path.join(root, rel)));
  try {
    put(path.join(root, rel));
  } catch (e) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
    rel = `${relBase}-${Date.now().toString(36)}${ext}`;
    put(path.join(root, rel));
  }
  return rel;
}

// Écriture atomique : fichier temporaire puis renommage.
export function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function fmtTime(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function wordCount(text) {
  return String(text || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

// Débit de parole moyen (mots/seconde) par langue, pour estimer la durée d'un script.
export function wordsPerSecond(lang = 'fr') {
  const l = String(lang).slice(0, 2).toLowerCase();
  return { fr: 2.6, en: 2.6, es: 2.8, it: 2.7, de: 2.3, pt: 2.6 }[l] || 2.5;
}
