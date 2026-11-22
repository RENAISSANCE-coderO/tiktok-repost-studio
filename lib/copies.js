// Détecteur de copies : retrouve les comptes qui ont réimporté la vidéo à modifier, par comparaison d'empreintes visuelles.
// TikTok ne relie pas les réimportations à l'originale (et les listes « son » ou « hashtag » ne sont pas accessibles) :
// les vidéos candidates viennent de liens collés par l'utilisateur ou des dernières vidéos d'un compte.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectTools } from './config.js';
import { run, ensureDir, lastLines } from './util.js';
import { remoteFetchStatus, validateTikTokUrl } from './tiktok.js';

// Recadrages centraux comparés (la tolérance d'échelle d'une empreinte est d'environ 5 %) :
// côté candidate, une image réduite avec bordure (repost flouté) ; côté originale, une copie zoomée.
const SOURCE_CROPS = [1, 0.94, 0.88];
const CAND_CROPS = [1, 0.94, 0.88, 0.82];
const MATCH_DIST = 48;   // distance de Hamming maximale (sur 256 bits) pour deux images identiques
const SURE = 0.6;        // part d'images correspondantes au-delà de laquelle la copie est certaine
const LIKELY = 0.3;

async function ffmpegBin() {
  const t = await detectTools();
  if (!t.ffmpeg) throw new Error('FFmpeg est introuvable.');
  return t.ffmpeg;
}

// dHash 17×16 (256 bits) : chaque bit indique si un pixel est plus clair que son voisin de droite. Renvoie [normal, miroir, bits à 1 de chacun],
// ou null pour une image sans information (écran noir, couleur unie) qui ressemblerait à n'importe quelle autre.
const N = 16;
const POP = Uint8Array.from({ length: 256 }, (_, i) => { let n = 0; for (let x = i; x; x >>= 1) n += x & 1; return n; });
function dhash(px) {
  const a = new Uint8Array(N * N / 8), b = new Uint8Array(N * N / 8);
  let bit = 0, ones = 0, onesM = 0;
  for (let y = 0; y < N; y++) {
    const row = y * (N + 1);
    for (let x = 0; x < N; x++, bit++) {
      if (px[row + x] > px[row + x + 1]) { a[bit >> 3] |= 1 << (bit & 7); ones++; }
      if (px[row + N - x] > px[row + N - 1 - x]) { b[bit >> 3] |= 1 << (bit & 7); onesM++; }
    }
  }
  let min = 255, max = 0;
  for (const v of px) { if (v < min) min = v; if (v > max) max = v; }
  return max - min < 24 || ones < 24 || ones > N * N - 24 ? null : [a, b, ones, onesM];
}

function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += POP[a[i] ^ b[i]];
  return n;
}

// Empreintes d'une vidéo : une image toutes les 1/fps secondes, pour chaque recadrage, en un seul décodage.
export async function fingerprint(file, { fps = 1, crops = [1], maxSeconds = 180 } = {}) {
  const ffmpeg = await ffmpegBin();
  const size = (N + 1) * N;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  try {
    const graph = [`[0:v]fps=${fps},split=${crops.length}${crops.map((_, i) => `[s${i}]`).join('')}`,
      ...crops.map((c, i) => `[s${i}]${c < 1 ? `crop=iw*${c}:ih*${c},` : ''}scale=${N + 1}:${N}:flags=area,format=gray[o${i}]`)];
    const args = ['-v', 'error', '-t', String(maxSeconds), '-i', file, '-filter_complex', graph.join(';')];
    crops.forEach((_, i) => args.push('-map', `[o${i}]`, '-f', 'rawvideo', path.join(tmp, `${i}.raw`)));
    await runRaw(ffmpeg, args);
    const out = {};
    crops.forEach((c, i) => {
      const buf = fs.readFileSync(path.join(tmp, `${i}.raw`));
      const frames = [];
      for (let k = 0; k + size <= buf.length; k += size) { const h = dhash(buf.subarray(k, k + size)); if (h) frames.push(h); }
      out[c] = frames;
    });
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
export const sourcePrint = (file) => fingerprint(file, { fps: 2, crops: SOURCE_CROPS });
export const candidatePrint = (file) => fingerprint(file, { fps: 1, crops: CAND_CROPS });

// run() renvoie du texte : la sortie brute des images est lue ici en binaire.
async function runRaw(cmd, args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout: Buffer.concat(chunks) }) : reject(new Error(`FFmpeg a échoué : ${lastLines(err, 2)}`))));
  });
}

// Part des images de la candidate retrouvées dans l'originale (meilleure paire de recadrages), et si elles sont en miroir.
export function compare(source, candidate) {
  let best = { ratio: 0, mirrored: false, crop: 1 };
  for (const [sc, src] of Object.entries(source)) {
    for (const [cc, frames] of Object.entries(candidate)) {
      // Une copie est soit réduite (recadrage côté candidate), soit zoomée (côté originale), pas les deux.
      if (!src.length || !frames.length || (Number(sc) < 1 && Number(cc) < 1)) continue;
      let hit = 0, mir = 0;
      for (const [h, hm, on, om] of frames) {
        // Seuil relatif au détail des images : deux images peu détaillées (aplats) sont proches sans être identiques.
        let okN = false, okM = false;
        for (const [x, , ox] of src) {
          if (!okN && hamming(h, x) <= Math.min(MATCH_DIST, 0.5 * Math.min(on, ox))) okN = true;
          if (!okM && hamming(hm, x) <= Math.min(MATCH_DIST, 0.5 * Math.min(om, ox))) okM = true;
          if (okN) break;
        }
        if (okN || okM) { hit++; if (!okN) mir++; }
      }
      const ratio = hit / frames.length;
      if (ratio > best.ratio) best = { ratio, mirrored: mir > hit / 2, crop: Number(cc) < 1 ? Number(cc) : 1 / Number(sc) };
    }
  }
  return best;
}

export const verdict = (ratio) => (ratio >= SURE ? 'copie' : ratio >= LIKELY ? 'probable' : 'différente');

async function ytdlp() {
  const st = await remoteFetchStatus();
  if (!st.available) throw new Error(st.reason);
  return st.tool;
}

// Télécharge une candidate en basse qualité et renvoie ses métadonnées publiques.
async function fetchCandidate(url, dir) {
  const tool = await ytdlp();
  ensureDir(dir);
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  let out;
  try {
    out = await run(tool, ['--no-playlist', '--no-warnings', '--no-simulate', '-j', '-f', 'worst[vcodec!=none]/worst', '-o', path.join(dir, 'c.%(ext)s'), url], { timeoutMs: 3 * 60 * 1000 });
  } catch (e) {
    throw new Error(lastLines(e.stderr || e.message, 1) || 'récupération impossible');
  }
  const info = JSON.parse(out.stdout.trim().split('\n').pop());
  const file = fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => /\.(mp4|webm|mov|mkv)$/i.test(f));
  if (!file) throw new Error('aucune vidéo obtenue');
  return { info, file };
}

// Dernières vidéos publiques d'un compte (liens seulement, sans téléchargement).
export async function listAccount(handle, limit = 20) {
  const tool = await ytdlp();
  const h = String(handle).trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
  if (!/^[\w.]{2,40}$/.test(h)) throw new Error(`Pseudo TikTok invalide : ${handle}`);
  let out;
  try {
    out = await run(tool, ['--flat-playlist', '-J', '--no-warnings', '--playlist-end', String(limit), `https://www.tiktok.com/@${h}`], { timeoutMs: 2 * 60 * 1000 });
  } catch (e) {
    throw new Error(`Impossible de lister les vidéos de @${h} (${lastLines(e.stderr || e.message, 1) || 'erreur inconnue'}).`);
  }
  const j = JSON.parse(out.stdout);
  return (j.entries || []).map((e) => e.url || e.webpage_url || (e.id ? `https://www.tiktok.com/@${h}/video/${e.id}` : '')).filter(Boolean);
}

export const videoId = (url) => String(url).match(/\/video\/(\d+)/)?.[1] || '';

// Analyse une liste de liens. onResult est appelé après chaque candidate (enregistrement progressif).
export async function scanCandidates({ sourceFile, sourceId, urls, workDir, onResult }) {
  const source = await sourcePrint(sourceFile);
  for (const url of urls.filter((u) => !sourceId || videoId(u) !== sourceId)) {
    const base = { url, at: new Date().toISOString() };
    try {
      validateTikTokUrl(url);
      const { info, file } = await fetchCandidate(url, workDir);
      const cand = await candidatePrint(file);
      const m = compare(source, cand);
      onResult({
        ...base, url: info.webpage_url?.split('?')[0] || url, id: info.id || videoId(url), account: info.uploader || '', title: (info.description || info.title || '').slice(0, 200),
        uploadDate: info.upload_date || '', duration: info.duration || null, views: info.view_count ?? null, likes: info.like_count ?? null, shares: info.repost_count ?? null,
        match: Math.round(m.ratio * 100) / 100, mirrored: m.mirrored, cropped: m.crop !== 1, status: verdict(m.ratio),
      });
    } catch (e) {
      onResult({ ...base, id: videoId(url), status: 'erreur', error: e.message });
    }
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}
