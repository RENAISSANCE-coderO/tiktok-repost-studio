// Liens TikTok : validation, métadonnées officielles (oEmbed) et récupération via yt-dlp.
import fs from 'node:fs';
import path from 'node:path';
import { detectTools, getSettings } from './config.js';
import { run, ensureDir, readJSON, lastLines, sleep } from './util.js';

export function validateTikTokUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw Object.assign(new Error('Lien invalide.'), { status: 400, retryable: false }); }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)tiktok\.com$/i.test(u.hostname)) {
    throw Object.assign(new Error('Le lien doit pointer vers tiktok.com (ex. https://www.tiktok.com/@compte/video/123…).'), { status: 400, retryable: false });
  }
  return u.toString();
}

// oEmbed est l'endpoint public officiel de TikTok : titre, auteur, miniature (pas le fichier vidéo).
export async function fetchOEmbed(url) {
  try {
    const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.title && !j.author_name) return null;
    return { title: j.title || '', author: j.author_name || '', authorUrl: j.author_url || '', thumbnail: j.thumbnail_url || '' };
  } catch { return null; }
}

export async function remoteFetchStatus() {
  const t = await detectTools();
  const s = getSettings();
  if (!s.remoteFetch.enabled) return { available: false, reason: 'La récupération par lien est désactivée dans Paramètres.' };
  if (!t.ytdlp) return { available: false, reason: 'yt-dlp est introuvable : installez-le (winget install yt-dlp) ou indiquez son chemin dans Paramètres.' };
  return { available: true, tool: t.ytdlp };
}

// Télécharge la vidéo (et, si demandé, les sous-titres) dans outDir. Lève une erreur explicite en cas d'échec.
// onProgress(0..1) suit le téléchargement. Une connexion figée (aucun octet pendant STALL_MS) est coupée et relancée :
// yt-dlp reprend le fichier partiel au lieu d'attendre la limite de 5 minutes.
const STALL_MS = 30000;
// light : version la plus légère (vidéo de référence, dont seuls le son et le texte affiché servent) ; environ 3 fois moins lourde.
export async function downloadTikTok(url, outDir, { subtitles = false, onProgress, light = false } = {}) {
  const st = await remoteFetchStatus();
  if (!st.available) throw Object.assign(new Error(st.reason), { retryable: false, fallback: true });
  const tools = await detectTools();
  ensureDir(outDir);
  for (const f of fs.readdirSync(outDir)) if (f.startsWith('download.')) fs.rmSync(path.join(outDir, f), { force: true });
  // Morceaux de 4 Mo et délais courts : une coupure réseau ne coûte qu'un morceau, repris aussitôt.
  const args = ['--no-playlist', '--newline', '--restrict-filenames', '--continue',
    '--socket-timeout', '15', '--retries', '10', '--fragment-retries', '10', '--http-chunk-size', '4M',
    ...(light ? ['-f', 'b[vcodec^=h264]/b', '-S', '+size,+br'] : ['-f', 'bv*[vcodec^=h264][height<=1080]+ba/bv*[vcodec^=h264]+ba/bv*+ba/b']),
    '--merge-output-format', 'mp4', '--write-info-json',
    '-o', path.join(outDir, 'download.%(ext)s')];
  if (tools.ffmpeg && tools.ffmpeg !== 'ffmpeg') args.push('--ffmpeg-location', path.dirname(tools.ffmpeg));
  if (subtitles) args.push('--write-subs', '--write-auto-subs', '--sub-format', 'vtt/best', '--sub-langs', 'all,-live_chat');
  args.push(url);
  let lastErr = null;
  onProgress?.(0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    let child = null, stalled = false, last = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - last > STALL_MS) { stalled = true; child?.kill(); } }, 3000);
    try {
      await run(st.tool, args, {
        timeoutMs: 6 * 60 * 1000,
        onSpawn: (c) => { child = c; },
        onStdout: (s) => {
          last = Date.now();
          const m = [...s.matchAll(/\[download\]\s+([\d.]+)%/g)].pop();
          if (m) onProgress?.(Math.min(0.99, Number(m[1]) / 100));
        },
        onStderr: () => { last = Date.now(); },
      });
      lastErr = null;
      break;
    } catch (e) {
      const msg = stalled ? `connexion figée pendant ${STALL_MS / 1000} s` : lastLines(e.stderr || e.message, 2);
      // 403 : TikTok refuse pour un moment après trop de demandes rapprochées ; réessayer aussitôt prolonge le refus.
      const refused = /HTTP Error 403|Forbidden/i.test(msg);
      const hint = refused ? 'TikTok refuse temporairement les demandes de cette connexion : réessayez dans quelques minutes, ou importez le fichier manuellement.' : 'Importez le fichier manuellement.';
      lastErr = Object.assign(new Error(`TikTok n'a pas permis la récupération de ce lien (${msg || 'erreur inconnue'}). ${hint}`), { fallback: true, retryable: !/Unsupported URL|private|unavailable|removed|blocked|login/i.test(msg) });
      if (!lastErr.retryable) break;
      if (attempt < 3) { onProgress?.(0); await sleep(refused ? attempt * 15000 : attempt * 5000); }
    } finally {
      clearInterval(watchdog);
    }
  }
  if (lastErr) throw lastErr;
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith('download.'));
  const video = files.find((f) => /\.(mp4|mov|webm|mkv)$/i.test(f));
  if (!video) throw Object.assign(new Error('Aucun fichier vidéo n\'a été obtenu depuis ce lien. Importez le fichier manuellement.'), { fallback: true, retryable: false });
  const info = readJSON(path.join(outDir, 'download.info.json'), {}) || {};
  const subs = files.filter((f) => f.endsWith('.vtt')).map((f) => ({ file: f, lang: f.split('.').slice(-2, -1)[0] }));
  return {
    file: path.join(outDir, video),
    subtitles: subs,
    info: {
      title: info.title || info.description || '',
      description: info.description || '',
      uploader: info.uploader || info.creator || '',
      duration: info.duration || null,
      // Statistiques publiques au moment de la récupération (servent à qualifier l'analyse narrative).
      stats: statsFromInfo(info),
    },
  };
}

// Statistiques publiques d'une vidéo TikTok. TikTok compte dans « repost_count » les partages et republications.
export function statsFromInfo(info) {
  if (info?.view_count == null && info?.like_count == null) return null;
  return {
    views: info.view_count ?? null, likes: info.like_count ?? null, comments: info.comment_count ?? null,
    shares: info.repost_count ?? null, saves: info.save_count ?? null, uploadDate: info.upload_date || null,
    source: 'métadonnées publiques TikTok', at: new Date().toISOString(),
  };
}

// Relit les statistiques à jour sans retélécharger la vidéo.
export async function fetchTikTokStats(url) {
  const st = await remoteFetchStatus();
  if (!st.available) throw new Error(st.reason);
  let out;
  try {
    out = await run(st.tool, ['--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', url], { timeoutMs: 90 * 1000 });
  } catch (e) {
    throw new Error(`TikTok n'a pas renvoyé les statistiques (${lastLines(e.stderr || e.message, 2) || 'erreur inconnue'}).`);
  }
  let info;
  try { info = JSON.parse(out.stdout); } catch { throw new Error('Réponse illisible de yt-dlp.'); }
  const stats = statsFromInfo(info);
  if (!stats) throw new Error('TikTok ne publie pas les statistiques de cette vidéo.');
  return stats;
}
