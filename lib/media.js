// Traitement vidéo/audio local avec FFmpeg : analyse, extraction, montage 9:16, encodage.
import fs from 'node:fs';
import path from 'node:path';
import { detectTools } from './config.js';
import { run, ensureDir } from './util.js';

async function bins() {
  const t = await detectTools();
  if (!t.ffmpeg || !t.ffprobe) throw Object.assign(new Error('FFmpeg/FFprobe introuvable dans le PATH. Installez FFmpeg puis redémarrez.'), { retryable: false });
  return t;
}

export async function probe(file) {
  const { ffprobe } = await bins();
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const fpsOf = (r) => { const [n, d] = String(r || '0/1').split('/').map(Number); return d ? n / d : 0; };
  let width = v?.width || 0;
  let height = v?.height || 0;
  const rot = Math.abs(Number(v?.tags?.rotate || v?.side_data_list?.find((s) => s.rotation != null)?.rotation || 0));
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  return {
    duration: Number(j.format.duration || v?.duration || a?.duration || 0),
    size: Number(j.format.size || fs.statSync(file).size),
    format: j.format.format_long_name || j.format.format_name,
    container: path.extname(file).slice(1).toLowerCase(),
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    width,
    height,
    fps: v ? Math.round(fpsOf(v.avg_frame_rate || v.r_frame_rate) * 100) / 100 : 0,
    videoCodec: v?.codec_name || '',
    audioCodec: a?.codec_name || '',
    aspect: width && height ? `${(width / height).toFixed(3)} (${width}×${height})` : '',
  };
}

// Plusieurs vidéos : chacune garde un passage d'une durée équitable (le surplus des vidéos courtes va aux autres),
// la première (l'accroche) en tête. clips : [{ duration }] → [{ start, end }].
export function shareClips(clips, total) {
  const n = clips.length;
  const take = clips.map(() => 0);
  let left = total;
  let open = clips.map((_, i) => i);
  while (left > 0.05 && open.length) {
    const share = left / open.length;
    const next = [];
    for (const i of open) {
      const room = clips[i].duration - take[i];
      const add = Math.min(room, share);
      take[i] += add;
      left -= add;
      if (clips[i].duration - take[i] > 0.05) next.push(i);
    }
    open = next;
  }
  return take.map((t, i) => ({ start: 0, end: Math.round(Math.min(clips[i].duration, Math.max(t, n > 1 ? 2 : t)) * 100) / 100 }));
}

// Assemble des passages de plusieurs vidéos en une seule (même cadre vertical rempli, 30 i/s, son conservé ou silence).
export async function concatClips(parts, out, { width = 1080, height = 1920, fps = 30 } = {}) {
  const { ffmpeg } = await bins();
  const W = Math.round(width / 2) * 2, H = Math.round(height / 2) * 2;
  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error'];
  parts.forEach((c) => args.push('-ss', String(c.start), '-t', String(Math.max(0.1, c.end - c.start)), '-i', c.file));
  const f = [];
  parts.forEach((c, i) => {
    f.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`);
    f.push(c.hasAudio
      ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${(c.end - c.start).toFixed(3)}[a${i}]`);
  });
  f.push(`${parts.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${parts.length}:v=1:a=1[v][a]`);
  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  await run(ffmpeg, args, { timeoutMs: 15 * 60 * 1000 });
  return out;
}

// Détection des changements de plan (filtre « scene » de FFmpeg sur une version réduite).
export async function detectScenes(file, duration, threshold = 0.3) {
  const { ffmpeg } = await bins();
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-an',
    '-vf', `scale=320:-2,select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  const cuts = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.4 && t < duration - 0.4);
  const bounds = [0];
  for (const c of cuts) if (c - bounds[bounds.length - 1] >= 0.6) bounds.push(c);
  bounds.push(duration);
  const scenes = [];
  for (let i = 0; i < bounds.length - 1; i++) scenes.push({ index: i, start: round(bounds[i]), end: round(bounds[i + 1]) });
  return scenes;
}

const round = (x) => Math.round(x * 100) / 100;

// Images clés : milieu de chaque plan + échantillonnage régulier dans les plans longs.
export async function extractKeyframes(file, scenes, outDir, max = 16) {
  const { ffmpeg } = await bins();
  ensureDir(outDir);
  let times = [];
  for (const s of scenes) {
    const len = s.end - s.start;
    const n = Math.max(1, Math.min(4, Math.floor(len / 3)));
    for (let k = 0; k < n; k++) times.push({ t: round(s.start + (len * (k + 0.5)) / n), scene: s.index });
  }
  if (times.length > max) {
    const step = times.length / max;
    times = Array.from({ length: max }, (_, i) => times[Math.floor(i * step)]);
  }
  const frames = [];
  for (const [i, f] of times.entries()) {
    const name = `frame-${String(i).padStart(2, '0')}.jpg`;
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(f.t), '-i', file, '-frames:v', '1',
      // Compression soutenue : les images partent à l'IA, et un envoi plus léger est bien plus rapide sur une connexion lente.
      '-vf', 'scale=512:-2', '-q:v', '8', path.join(outDir, name)]);
    if (fs.existsSync(path.join(outDir, name))) frames.push({ ...f, file: name });
  }
  return frames;
}

// Audio pour la transcription : Opus 16 kbit/s mono (≈ 4 fois plus léger qu'un MP3 64k, même précision mesurée),
// car le temps d'envoi domine sur une connexion lente.
export async function extractAudio(file, out, { rate = 16000, bitrate = '16k' } = {}) {
  const { ffmpeg } = await bins();
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate),
    '-c:a', 'libopus', '-b:a', bitrate, '-application', 'voip', out]);
  return out;
}

// Normalise un fichier audio TTS en MP3 44,1 kHz, avec changement de tempo facultatif (sans changer la hauteur).
export async function normalizeAudio(input, out, { tempo = 1 } = {}) {
  const { ffmpeg } = await bins();
  const filters = [];
  let t = tempo;
  while (t > 2) { filters.push('atempo=2'); t /= 2; }
  while (t < 0.5) { filters.push('atempo=0.5'); t /= 0.5; }
  if (Math.abs(t - 1) > 0.001) filters.push(`atempo=${t.toFixed(3)}`);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '44100'];
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-codec:a', 'libmp3lame', '-b:a', '160k', out);
  await run(ffmpeg, args);
  return out;
}

export async function mediaDuration(file) {
  return (await probe(file)).duration;
}

// Pauses dans la voix off (utile pour placer les coupes sans couper la narration).
export async function detectSilences(file, { noise = '-35dB', min = 0.35 } = {}) {
  const { ffmpeg } = await bins();
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${noise}:d=${min}`, '-f', 'null', '-']);
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  return starts.map((s, i) => ({ start: round(s), end: round(ends[i] ?? s) }));
}

// --- Montage -------------------------------------------------------------------------------

export const DEFAULT_MONTAGE = {
  blur: 30,            // intensité du flou de l'arrière-plan (sigma à pleine résolution)
  bgZoom: 1.15,        // agrandissement de la copie floutée
  bgBrightness: -0.12, // luminosité de l'arrière-plan (-1 … 1)
  fgScale: 1.0,        // largeur de la vidéo principale relative au canevas
  fgX: 0,              // décalage horizontal (fraction du canevas)
  fgY: 0,              // décalage vertical (fraction du canevas)
  segments: null,      // passages conservés de la source [{start,end}] ; null = toute la vidéo
  voiceOffset: 0.3,    // position de départ de la voix off (s)
  voiceVolume: 1.0,
  originalVolume: 0.0, // 0 = son original coupé
  musicFile: '',
  musicVolume: 0.12,
  fit: 'freeze',       // voix plus longue que l'image : 'freeze' (fige la dernière image) | 'none'
  trimToVoice: false,  // vidéo plus longue que la voix : couper à la fin de la narration
  exactDuration: true, // vidéo finale de la durée cible du projet exactement (coupée, ou prolongée par image figée)
  targetDuration: 0,   // durée cible en secondes, fournie par le projet (0 = pas de durée imposée)
  tail: 0.6,           // marge après la fin de la narration (s)
  // Sous-titres style TikTok : mot prononcé surligné (highlight), apparition animée (animate), contour épais.
  subtitles: { enabled: true, font: 'Segoe UI Black', size: 76, color: '#FFFFFF', outline: '#000000', outlineWidth: 7, position: 'bottom', marginV: 520,
    uppercase: true, maxWords: 3, highlight: true, highlightColor: '#FFD60A', animate: true,
    animation: 'phrase', box: false, boxColor: '#000000', boxOpacity: 0.85 }, // animation : 'phrase' (quelques mots) | 'mot' (un mot à la fois)
  // Titre choc incrusté en haut pendant les premières secondes ; texte vide = titre de l'accroche choisie (*mot* = mot en couleur).
  hookTitle: { enabled: true, text: '', duration: 3, size: 92 },
  // Montage dynamique : zoom « punch-in » une phrase sur deux, calé sur la voix, pour relancer l'attention.
  punchIn: { enabled: true, zoom: 1.12 },
  // Mode réaction : votre propre vidéo (visage, commentaire) partage l'écran avec l'originale ('split' : originale en haut,
  // vous en bas ; 'pip' : vous en incrustation). volume = son de votre vidéo, offset = début utilisé dans votre vidéo (s).
  reaction: { enabled: false, file: '', layout: 'split', pipSize: 0.34, pipSide: 'right', volume: 0, offset: 0 },
  // Crédit visible du créateur d'origine (« Vidéo originale : @pseudo ») en petit en haut à gauche : désactivé par défaut.
  credit: { enabled: false },
  // Masque des sous-titres incrustés dans la vidéo d'origine : zone floutée (fractions de l'image source) ;
  // centerSubs : les nouveaux sous-titres se placent au centre de la zone.
  mask: { enabled: false, x: 0.1, y: 0.62, w: 0.8, h: 0.12, blur: 24, centerSubs: true },
};

// Taille par défaut de la vidéo dans le canevas 9:16 (même règle côté navigateur, public/js/core.js) :
// - verticale : réduite à 92 % pour laisser une fine bordure floue visible ;
// - carrée ou horizontale : agrandie pour couvrir environ 80 % de la hauteur (côtés légèrement rognés),
//   au lieu de laisser deux grandes bandes floues ; plafonnée pour ne pas trop rogner une vidéo très large.
export function autoFgScale(meta) {
  if (!meta?.width || !meta?.height) return 1;
  const ar = meta.width / meta.height;
  if (ar < 0.75) return 0.92;
  return Math.round(Math.min(1.45, 0.8 * ar * (1920 / 1080)) * 100) / 100;
}

export function mergeMontage(params = {}) {
  return { ...DEFAULT_MONTAGE, ...params, subtitles: { ...DEFAULT_MONTAGE.subtitles, ...(params.subtitles || {}) },
    hookTitle: { ...DEFAULT_MONTAGE.hookTitle, ...(params.hookTitle || {}) }, punchIn: { ...DEFAULT_MONTAGE.punchIn, ...(params.punchIn || {}) },
    reaction: { ...DEFAULT_MONTAGE.reaction, ...(params.reaction || {}) }, credit: { ...DEFAULT_MONTAGE.credit, ...(params.credit || {}) },
    mask: { ...DEFAULT_MONTAGE.mask, ...(params.mask || {}) } };
}

// Zone du masque en pixels de la source (null si inactif ou trop petite).
export function maskBox(P, meta) {
  const m = P.mask;
  if (!m?.enabled || !meta?.width || !meta?.height) return null;
  const cl = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const x = Math.floor(cl(m.x) * meta.width / 2) * 2, y = Math.floor(cl(m.y) * meta.height / 2) * 2;
  const w = Math.min(meta.width - x, Math.floor(cl(m.w) * meta.width / 2) * 2), h = Math.min(meta.height - y, Math.floor(cl(m.h) * meta.height / 2) * 2);
  return w >= 8 && h >= 8 ? { x, y, w, h } : null;
}

// Position du premier plan (vidéo d'origine) dans le canevas de sortie, même calcul que renderMontage.
export function foregroundBox(P, meta, W, H) {
  const RH = P.reaction?.enabled && P.reaction?.file && P.reaction.layout === 'split' ? even(H / 2) : H;
  const fw0 = even(W * Math.min(2, Math.max(0.2, Number(P.fgScale) || 1)));
  const ar = meta.width / meta.height;
  let w = fw0, h = fw0 / ar;
  if (h > RH * 2) { h = RH * 2; w = h * ar; }
  return { x: (W - w) / 2 + (Number(P.fgX) || 0) * W, y: (RH - h) / 2 + (Number(P.fgY) || 0) * RH, w, h, RH };
}

export function keptSegments(params, sourceDuration) {
  const segs = (params.segments?.length ? params.segments : [{ start: 0, end: sourceDuration }])
    .map((s) => ({ start: Math.max(0, Number(s.start)), end: Math.min(sourceDuration, Number(s.end)) }))
    .filter((s) => s.end - s.start > 0.05)
    .sort((a, b) => a.start - b.start);
  return segs.length ? segs : [{ start: 0, end: sourceDuration }];
}

// Calcule la durée finale sans jamais couper la narration.
export function planTimeline(params, sourceDuration, voiceDuration) {
  const segs = keptSegments(params, sourceDuration);
  const videoLen = segs.reduce((a, s) => a + (s.end - s.start), 0);
  const voiceEnd = voiceDuration ? params.voiceOffset + voiceDuration : 0;
  let total = videoLen;
  let freeze = 0;
  const target = params.exactDuration ? Number(params.targetDuration) || 0 : 0;
  if (target) {
    // Durée imposée : la vidéo est coupée ou prolongée, mais la narration n'est jamais tronquée
    // (si elle déborde, la marge de fin est réduite à 0,1 s avant d'allonger la vidéo).
    total = Math.max(target, voiceEnd ? voiceEnd + 0.1 : 0);
    freeze = Math.max(0, total - videoLen);
  } else if (voiceEnd && voiceEnd + params.tail > videoLen) {
    if (params.fit === 'freeze') { freeze = voiceEnd + params.tail - videoLen; total = voiceEnd + params.tail; }
    else total = Math.max(videoLen, voiceEnd);
  } else if (voiceEnd && params.trimToVoice) {
    total = Math.min(videoLen, voiceEnd + params.tail);
  }
  return { segs, videoLen: round(videoLen), voiceEnd: round(voiceEnd), total: round(total), freeze: round(freeze) };
}

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

export async function renderMontage({ source, sourceMeta, reactionMeta = null, voice, voiceDuration, params, out, cwd, subtitlesFile, zoomWindows = [], width = 1080, height = 1920, fps, crf = 20, preset = 'veryfast', onProgress }) {
  const { ffmpeg } = await bins();
  const P = mergeMontage(params);
  const plan = planTimeline(P, sourceMeta.duration, voice ? voiceDuration : 0);
  const F = Math.min(60, Math.max(15, Math.round(fps || sourceMeta.fps || 30)));
  const W = even(width);
  const H = even(height);

  // Progression lue sur stderr (-stats) : « -progress pipe:1 » bloque l'encodage avec certaines versions Windows de FFmpeg.
  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-stats', '-stats_period', '0.5', '-i', source];
  let idx = 1;
  const voiceIdx = voice ? idx++ : -1;
  if (voice) args.push('-i', voice);
  const musicIdx = P.musicFile ? idx++ : -1;
  if (P.musicFile) args.push('-stream_loop', '-1', '-i', P.musicFile);
  // Votre vidéo de réaction tourne en boucle si elle est plus courte que le montage.
  const R = P.reaction.enabled && P.reaction.file && reactionMeta ? P.reaction : null;
  const faceIdx = R ? idx++ : -1;
  if (R) args.push('-stream_loop', '-1', '-i', R.file);
  const split = R?.layout === 'split';
  // Zone de la vidéo d'origine : tout l'écran, ou la moitié haute en écran partagé.
  const RH = split ? even(H / 2) : H;

  const f = [];
  const useOrig = sourceMeta.hasAudio && P.originalVolume > 0;
  plan.segs.forEach((s, i) => {
    f.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS,fps=${F},format=yuv420p,setsar=1[v${i}]`);
    if (useOrig) f.push(`[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS,aresample=48000[oa${i}]`);
  });
  const n = plan.segs.length;
  if (n > 1) {
    f.push(`${plan.segs.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vcat]`);
    if (useOrig) f.push(`${plan.segs.map((_, i) => `[oa${i}]`).join('')}concat=n=${n}:v=0:a=1[ocat]`);
  } else {
    f.push('[v0]null[vcat]');
    if (useOrig) f.push('[oa0]anull[ocat]');
  }
  const pad = plan.freeze > 0 ? `,tpad=stop_mode=clone:stop_duration=${plan.freeze.toFixed(2)}` : '';
  const M = maskBox(P, sourceMeta);
  if (M) {
    // Flou appliqué sur la vidéo d'origine avant la composition : l'arrière-plan flouté et le premier plan sont masqués.
    const r = Math.max(2, Math.min(Math.round(Math.min(M.w, M.h) / 2) - 1, Math.round(Number(P.mask.blur) || 24)));
    f.push('[vcat]split=2[vm0][vm1]', `[vm1]crop=${M.w}:${M.h}:${M.x}:${M.y},boxblur=${r}:3[vmb]`, `[vm0][vmb]overlay=${M.x}:${M.y}[vmasked]`);
    f.push('[vmasked]split=2[vbg][vfg]');
  } else f.push(`[vcat]split=2[vbg][vfg]`);
  // Arrière-plan : copie agrandie, recadrée et floutée (flou appliqué en basse résolution pour la vitesse).
  const q = 4;
  const bw = even(W / q), bh = even(RH / q);
  const z = Math.max(1, Number(P.bgZoom) || 1);
  const sigma = Math.max(0, Number(P.blur) || 0) / q;
  f.push(`[vbg]scale=${even(bw * z)}:${even(bh * z)}:force_original_aspect_ratio=increase,crop=${bw}:${bh}` +
    (sigma > 0 ? `,gblur=sigma=${sigma.toFixed(2)}` : '') +
    `,scale=${W}:${RH},eq=brightness=${Number(P.bgBrightness).toFixed(2)}[bg]`);
  // Premier plan : proportions d'origine conservées, ajusté dans le canevas.
  const fw = even(W * Math.min(2, Math.max(0.2, Number(P.fgScale) || 1)));
  f.push(`[vfg]scale=${fw}:${even(RH * 2)}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg]`);
  const ox = Math.round((Number(P.fgX) || 0) * W);
  const oy = Math.round((Number(P.fgY) || 0) * RH);
  let last = 'comp';
  f.push(`[bg][fg]overlay=x=(W-w)/2+${ox}:y=(H-h)/2+${oy}:shortest=1${pad}[comp]`);
  // Punch-in : une copie agrandie de l'image remplace l'originale pendant les fenêtres données (coupe zoomée, sans calcul par image).
  if (P.punchIn.enabled && zoomWindows.length) {
    const z = Math.min(1.5, Math.max(1.01, Number(P.punchIn.zoom) || 1.12));
    const enable = zoomWindows.map((w) => `between(t,${w.start.toFixed(2)},${w.end.toFixed(2)})`).join('+');
    f.push('[comp]split=2[cz0][cz1]', `[cz1]scale=${even(W * z)}:${even(RH * z)},crop=${W}:${RH}[czz]`, `[cz0][czz]overlay=0:0:enable='${enable}'[compz]`);
    last = 'compz';
  }
  const T = plan.total.toFixed(3);
  if (R) {
    const off = Math.max(0, Number(R.offset) || 0);
    const face = `[${faceIdx}:v]trim=start=${off}:end=${(off + plan.total).toFixed(3)},setpts=PTS-STARTPTS,fps=${F},format=yuv420p,setsar=1`;
    if (split) {
      f.push(`${face},scale=${W}:${RH}:force_original_aspect_ratio=increase,crop=${W}:${RH}[face]`, `[${last}]format=yuv420p[top]`, '[top][face]vstack=inputs=2[stk]');
      last = 'stk';
    } else {
      // Incrustation portrait 3:4 avec un liseré blanc, à mi-hauteur haute (sous le titre choc, au-dessus des sous-titres).
      const pw = even(W * Math.min(0.6, Math.max(0.2, Number(R.pipSize) || 0.34)));
      const ph = even(pw * 4 / 3);
      const b = Math.max(2, Math.round(W / 180));
      const x = R.pipSide === 'left' ? Math.round(W * 0.04) : W - pw - 2 * b - Math.round(W * 0.04);
      f.push(`${face},scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph},pad=${pw + 2 * b}:${ph + 2 * b}:${b}:${b}:white[face]`,
        `[${last}][face]overlay=x=${x}:y=${Math.round(H * 0.3)}:eof_action=pass[pip]`);
      last = 'pip';
    }
  }
  if (subtitlesFile) { f.push(`[${last}]subtitles=${subtitlesFile}[vsub]`); last = 'vsub'; }
  f.push(`[${last}]format=yuv420p[vout]`);

  const mix = [];
  if (useOrig) { f.push(`[ocat]volume=${P.originalVolume}[ao]`); mix.push('[ao]'); }
  if (voice) {
    const ms = Math.max(0, Math.round(P.voiceOffset * 1000));
    f.push(`[${voiceIdx}:a]aresample=48000,adelay=${ms}:all=1,volume=${P.voiceVolume}[av]`);
    mix.push('[av]');
  }
  if (R && reactionMeta.hasAudio && Number(R.volume) > 0) {
    const off = Math.max(0, Number(R.offset) || 0);
    f.push(`[${faceIdx}:a]atrim=start=${off}:end=${(off + plan.total).toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,volume=${Number(R.volume)}[af]`);
    mix.push('[af]');
  }
  // Tous les flux audio sont bornés à la durée prévue : un flux infini (apad, musique en boucle) bloque le multiplexage.
  if (P.musicFile) { f.push(`[${musicIdx}:a]atrim=end=${T},aresample=48000,volume=${P.musicVolume}[am]`); mix.push('[am]'); }
  const hasAudioOut = mix.length > 0;
  if (mix.length > 1) f.push(`${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0,apad=whole_dur=${T},atrim=end=${T}[aout]`);
  else if (mix.length === 1) f.push(`${mix[0]}apad=whole_dur=${T},atrim=end=${T}[aout]`);

  args.push('-filter_complex', f.join(';'), '-map', '[vout]');
  if (hasAudioOut) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  args.push('-t', plan.total.toFixed(3), '-r', String(F), '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);

  // Chien de garde : si le temps encodé n'avance plus pendant 60 s, le rendu est arrêté et signalé.
  let lastT = -1;
  let lastMove = Date.now();
  let stalled = false;
  let child;
  const watchdog = setInterval(() => { if (Date.now() - lastMove > 60000) { stalled = true; child?.kill(); } }, 5000);
  try {
    await run(ffmpeg, args, {
      cwd,
      onSpawn: (c) => { child = c; },
      onStderr: (s) => {
        const m = [...s.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
        if (!m) return;
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        if (t > lastT) { lastT = t; lastMove = Date.now(); }
        onProgress?.(Math.min(0.99, t / plan.total));
      },
    });
  } catch (e) {
    if (stalled) throw new Error(`Le rendu FFmpeg s'est bloqué à ${lastT.toFixed(1)} s et a été arrêté. Relancez le montage ; si le problème persiste, retirez la musique ou les coupes.`);
    throw e;
  } finally {
    clearInterval(watchdog);
  }
  return { plan, fps: F, width: W, height: H };
}

export async function thumbnail(file, out, t = 0.5) {
  const { ffmpeg } = await bins();
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out]);
  return out;
}
