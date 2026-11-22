// Orchestrateur : graphe d'étapes, dépendances, réutilisation des résultats valides, reprise et nouvelles tentatives.
//
// Chaque étape « done » mémorise le hachage de ses entrées (sorties des dépendances + paramètres).
// Si une entrée change, l'étape devient « stale » et seule elle (et ce qui en dépend) est relancée.
// Les étapes « manual » sont des validations utilisateur (script de référence, script final, montage).
import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { sha, ensureDir, wordsPerSecond, placeFile, readJSON, writeJSON, wordCount } from './util.js';
import { DATA_DIR } from './config.js';
import * as media from './media.js';
import { sourceHandle } from './originality.js';
import { downloadTikTok, fetchOEmbed } from './tiktok.js';
import * as agents from './ai/agents.js';
import * as viral from './ai/viral.js';
import { aiAvailable } from './ai/openrouter.js';
import { synthesize, providers as ttsProviders } from './tts.js';
import { cuesFromWords, estimateWordTimings, buildAss, parseVtt } from './subtitles.js';

const progress = new Map(); // `${pid}:${step}` → 0..1
const notes = new Map();    // `${pid}:${step}` → ce qui est en cours (affiché sous la barre)
const running = new Map();  // pid → { promise, step }

const fileHash = (p, rel) => { try { const st = fs.statSync(store.projectPath(p.id, rel)); return sha(rel + st.size + st.mtimeMs); } catch { return null; } };

// ---------------------------------------------------------------------------------------------
// Définition du graphe
// ---------------------------------------------------------------------------------------------

export const STEPS = {
  // Les réglages « plusieurs vidéos » n'entrent dans le hachage que s'ils servent : les projets à vidéo unique restent à jour.
  source_fetch: { label: 'Récupération de la vidéo à modifier', deps: () => [],
    params: (p) => ({ url: p.source.url, origin: p.source.origin, ...(p.source.urls?.length > 1 ? { urls: p.source.urls, hook: p.source.hook || 0, target: Number(p.params.durationTarget) || 61 } : {}) }),
    // Forme des réglages entre le 29/10 et le 21/11 pour une vidéo unique : les projets récupérés alors restent à jour.
    legacy: (p) => (p.source.urls?.length > 1 ? [] : [{ url: p.source.url, origin: p.source.origin, urls: null, hook: 0, target: null }]) },
  source_analyze: { label: 'Analyse technique (plans, images clés)', deps: () => ['source_fetch'] },
  visual_agent: { label: 'Agent A — Analyse visuelle', deps: () => ['source_analyze'], ai: true },
  reference_fetch: { label: 'Récupération de la vidéo de référence', deps: () => [], params: (p) => ({ url: p.reference.url, origin: p.reference.origin }) },
  reference_extract: { label: 'Extraction du script de référence', deps: (p) => (p.reference.origin === 'text' ? [] : ['reference_fetch']), params: (p) => (p.reference.origin === 'text' ? { text: p.reference.pastedText } : {}) },
  reference_script: { label: 'Validation du script de référence', deps: () => ['reference_extract'], manual: true },
  narrative_agent: { label: 'Agent B — Analyse narrative', deps: () => ['reference_script'], ai: true, params: (p) => ({ stats: p.reference.stats }) },
  script_agent: { label: 'Agents C + D — Réécriture et contrôle qualité', deps: () => ['visual_agent', 'narrative_agent'], ai: true,
    // scriptMode n'entre dans le hachage que s'il diffère du mode par défaut, pour ne pas périmer les scripts existants.
    params: (p) => ({ language: p.params.language, tone: p.params.tone, audience: p.params.audience, durationTarget: p.params.durationTarget, nonce: p.scriptNonce || 0,
      ...(agents.scriptModeOf(p.params) === 'adapt' ? {} : { scriptMode: 'inspire' }) }) },
  // Sans IA, l'utilisateur peut écrire lui-même son script : la validation ne dépend alors pas de l'Agent C.
  final_script: { label: 'Validation du script final', deps: (p) => (p.finalScript.manualOnly ? [] : ['script_agent']), manual: true },
  voice: { label: 'Génération de la voix off', deps: () => ['final_script'], params: (p) => ({ ...voiceParams(p), slot: voiceSlot(p) }) },
  montage: { label: 'Montage vidéo (prévisualisation)', deps: () => ['source_analyze', 'voice'], params: (p) => ({ ...montageParams(p), hookScreen: p.hook?.screen || '' }),
    legacy: (p) => legacyMontageParams(p) },
  montage_ok: { label: 'Validation du montage', deps: () => ['montage'], manual: true },
  export: { label: 'Exportation MP4', deps: () => ['montage_ok'], params: (p) => p.exportParams },
  caption: { label: 'Titre, description et hashtags', deps: () => ['final_script'], ai: true, params: (p) => ({ nonce: p.captionNonce || 0 }) },
};

// Statistiques publiques de la vidéo à modifier ; l'historique montre l'évolution des partages entre deux relevés.
export function recordSourceStats(p, stats) {
  p.source.stats = stats;
  p.source.statsHistory = [...(p.source.statsHistory || []), stats].slice(-30);
}

// Réglages de montage effectifs : ceux du projet, sinon les valeurs par défaut adaptées au format de la source.
export function montageParams(p) {
  return media.mergeMontage({ fgScale: media.autoFgScale(p.steps.source_analyze?.output?.meta), ...(p.montageParams || {}), targetDuration: Number(p.params.durationTarget) || 0 });
}

// Durée exacte : place disponible pour la voix off entre son début et la marge de fin (0 = pas de durée imposée).
export function voiceSlot(p) {
  const P = montageParams(p);
  return P.exactDuration && P.targetDuration ? Math.max(5, Math.round((P.targetDuration - P.voiceOffset - P.tail) * 100) / 100) : 0;
}

// Débit de parole réellement mesuré (mots par seconde, à vitesse 1) par service de voix et langue :
// il remplace l'estimation fixe pour calibrer la longueur des scripts.
const RATE_FILE = path.join(DATA_DIR, 'speech-rate.json');
const langOf = (vp) => String(vp.language || 'fr').slice(0, 2);

function learnSpeechRate(vp, words, seconds) {
  if (!vp.provider || words < 20 || seconds < 5) return;
  const rates = readJSON(RATE_FILE, {});
  const measured = words / seconds / (Number(vp.speed) || 1);
  const key = vp.provider + '|' + langOf(vp);
  rates[key] = rates[key] ? Math.round((rates[key] * 0.5 + measured * 0.5) * 1000) / 1000 : Math.round(measured * 1000) / 1000;
  writeJSON(RATE_FILE, rates);
}

export function speechRate(p) {
  const vp = voiceParams(p);
  const rates = readJSON(RATE_FILE, {});
  const base = rates[vp.provider + '|' + langOf(vp)] ?? Object.entries(rates).find(([k]) => k.endsWith('|' + langOf(vp)))?.[1] ?? wordsPerSecond(vp.language);
  return Math.round(base * (Number(vp.speed) || 1) * 1000) / 1000;
}

// Paramètres d'écriture du script : en durée exacte, le texte vise le créneau de la voix off au débit mesuré.
export function scriptParams(p) {
  const slot = voiceSlot(p);
  return { ...p.params, durationTarget: slot ? Math.round((slot - 0.5) * 10) / 10 : Number(p.params.durationTarget) || 61, wps: speechRate(p) };
}

export function voiceParams(p) {
  return p.voiceParams || { provider: '', voice: '', tone: p.params.tone, speed: 1, language: p.params.language };
}

function inputHash(p, name, params = STEPS[name].params?.(p) ?? null) {
  const def = STEPS[name];
  return sha({ deps: def.deps(p).map((d) => [d, p.steps[d]?.status === 'done' ? p.steps[d].outputHash : null]), params });
}

// Réglages de montage tels qu'ils étaient hachés avant l'ajout de nouvelles options : tant que ces options gardent
// leur valeur par défaut, un montage déjà fait reste à jour (sinon chaque nouvelle option périmerait tous les projets).
function legacyMontageParams(p) {
  const cur = { ...montageParams(p), hookScreen: p.hook?.screen || '' };
  const D = media.DEFAULT_MONTAGE;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sub = { ...cur.subtitles };
  for (const k of ['animation', 'box', 'boxColor', 'boxOpacity']) { if (sub[k] !== D.subtitles[k]) return []; delete sub[k]; }
  if (!same(cur.mask, D.mask)) return [];
  const { mask, ...v1 } = { ...cur, subtitles: sub };
  const out = [v1];
  if (same(cur.reaction, D.reaction) && same(cur.credit, D.credit)) {
    const { reaction, credit, ...v0 } = v1;
    out.push(v0);
  }
  return out;
}

export function stepState(p, name) {
  if (running.get(p.id)?.step === name) return 'running';
  const s = p.steps[name];
  if (!s) return 'todo';
  if (s.status !== 'done') return s.status; // error | interrupted | running (orphelin)
  const deps = STEPS[name].deps(p);
  if (deps.some((d) => stepState(p, d) !== 'done')) return 'stale';
  if (s.inputHash === inputHash(p, name)) return 'done';
  return (STEPS[name].legacy?.(p) || []).some((alt) => s.inputHash === inputHash(p, name, alt)) ? 'done' : 'stale';
}

export function describe(p) {
  const steps = {};
  for (const name of Object.keys(STEPS)) {
    const s = p.steps[name] || {};
    steps[name] = { label: STEPS[name].label, state: stepState(p, name), error: s.error || '', finishedAt: s.finishedAt || '', attempts: s.attempts || 0,
      progress: progress.get(`${p.id}:${name}`) ?? null, note: notes.get(`${p.id}:${name}`) || '', manual: Boolean(STEPS[name].manual) };
  }
  const states = Object.values(steps).map((s) => s.state);
  let status = 'à faire';
  if (running.has(p.id)) status = 'en cours';
  else if (states.includes('error')) status = 'erreur';
  else if (steps.export.state === 'done') status = 'terminé';
  else if (Object.values(p.steps).length) status = p.job?.status === 'waiting' ? 'en attente' : 'en cours';
  return { status, running: running.has(p.id), runningStep: running.get(p.id)?.step || null, steps };
}

function ancestors(p, target, acc = []) {
  for (const d of STEPS[target].deps(p)) ancestors(p, d, acc);
  if (!acc.includes(target)) acc.push(target);
  return acc;
}

// ---------------------------------------------------------------------------------------------
// Validations utilisateur (étapes « manual »)
// ---------------------------------------------------------------------------------------------

export function markManual(p, name, value) {
  p.steps[name] = { status: 'done', outputHash: sha(value), inputHash: inputHash(p, name), finishedAt: new Date().toISOString() };
}

export function clearStep(p, name) { delete p.steps[name]; }

// Marque une étape comme terminée hors orchestrateur (ex. import manuel d'un fichier).
export function markDone(p, name, output) {
  p.steps[name] = { status: 'done', output, outputHash: sha(output), inputHash: inputHash(p, name), finishedAt: new Date().toISOString(), attempts: 1 };
}

// ---------------------------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------------------------

export function isRunning(pid) { return running.has(pid); }

// Lance la chaîne nécessaire pour atteindre `target`. Les étapes déjà valides sont réutilisées.
// auto : les validations manuelles rencontrées sont faites automatiquement (assistant en 5 étapes).
export function start(pid, target, { force = [], auto = false } = {}) {
  if (running.has(pid)) throw Object.assign(new Error('Un traitement est déjà en cours sur ce projet.'), { status: 409 });
  if (!STEPS[target]) throw Object.assign(new Error('Étape inconnue : ' + target), { status: 400 });
  const entry = { step: null };
  running.set(pid, entry);
  store.update(pid, (p) => { p.job = { target, status: 'running', startedAt: new Date().toISOString(), message: '' }; });
  entry.promise = (async () => {
    try {
      const p0 = store.getProject(pid);
      for (const name of ancestors(p0, target)) {
        const p = store.getProject(pid);
        const def = STEPS[name];
        const state = stepState(p, name);
        if (def.manual) {
          if (state === 'done') continue;
          if (p.params.autoMode || auto) { autoValidate(pid, name); continue; }
          store.update(pid, (q) => { q.job = { ...q.job, status: 'waiting', waitingFor: name, message: `En attente : ${def.label.toLowerCase()}.` }; });
          store.logEvent(pid, name, 'waiting', def.label);
          return;
        }
        if (state === 'done' && !force.includes(name)) continue;
        entry.step = name;
        await runStep(pid, name);
      }
      store.update(pid, (q) => { q.job = { ...q.job, status: 'done', finishedAt: new Date().toISOString(), message: 'Terminé.' }; });
    } catch (e) {
      store.update(pid, (q) => { q.job = { ...q.job, status: 'error', message: e.message }; });
    } finally {
      running.delete(pid);
    }
  })();
  return entry.promise;
}

// Exécute une action ponctuelle (ex. raccourcir le script) sous le même verrou que les étapes.
export function action(pid, label, fn) {
  if (running.has(pid)) throw Object.assign(new Error('Un traitement est déjà en cours sur ce projet.'), { status: 409 });
  const entry = { step: label };
  running.set(pid, entry);
  entry.promise = (async () => {
    try { await fn(); store.logEvent(pid, label, 'done'); }
    catch (e) { store.logEvent(pid, label, 'error', e.message); store.update(pid, (q) => { q.job = { target: label, status: 'error', message: e.message }; }); throw e; }
    finally { running.delete(pid); }
  })();
  return entry.promise;
}

async function runStep(pid, name) {
  const def = STEPS[name];
  const p = store.getProject(pid);
  const hashIn = inputHash(p, name);
  const prev = p.steps[name] || {};
  if (def.ai && !aiAvailable()) {
    const err = 'Clé OpenRouter absente : configurez OPENROUTER_API_KEY dans « Paramètres et intégrations API ».';
    store.update(pid, (q) => { q.steps[name] = { ...prev, status: 'error', error: err, needsConfig: true }; });
    throw new Error(err);
  }
  store.update(pid, (q) => { q.steps[name] = { ...prev, status: 'running', startedAt: new Date().toISOString(), error: '', attempts: (prev.attempts || 0) + 1 }; });
  store.logEvent(pid, name, 'start', def.label);
  progress.set(`${pid}:${name}`, 0);
  const ctx = {
    dir: store.projectDir(pid),
    progress: (f, note) => { progress.set(`${pid}:${name}`, f); if (note) notes.set(`${pid}:${name}`, note); },
  };
  try {
    const output = await RUNNERS[name](store.getProject(pid), ctx);
    store.update(pid, (q) => {
      q.steps[name] = { status: 'done', output, outputHash: sha(output), inputHash: hashIn, finishedAt: new Date().toISOString(), attempts: q.steps[name]?.attempts || 1 };
      AFTER[name]?.(q, output);
    });
    store.logEvent(pid, name, 'done', def.label);
  } catch (e) {
    store.update(pid, (q) => { q.steps[name] = { ...q.steps[name], status: 'error', error: e.message, fallback: Boolean(e.fallback), needsConfig: Boolean(e.needsConfig) }; });
    store.logEvent(pid, name, 'error', e.message);
    throw e;
  } finally {
    progress.delete(`${pid}:${name}`);
    notes.delete(`${pid}:${name}`);
  }
}

// Au démarrage du serveur : les étapes « running » orphelines deviennent « interrupted » (reprise possible).
export function recoverInterrupted() {
  for (const p of store.listProjects()) {
    let changed = false;
    for (const s of Object.values(p.steps)) if (s.status === 'running') { s.status = 'interrupted'; s.error = 'Traitement interrompu (arrêt du serveur). Cliquez sur « Reprendre ».'; changed = true; }
    if (p.job?.status === 'running') { p.job.status = 'interrupted'; changed = true; }
    if (changed) { store.save(p); store.logEvent(p.id, 'job', 'interrupted', p.job?.target || ''); }
  }
}

function autoValidate(pid, name) {
  store.update(pid, (p) => {
    if (name === 'reference_script') { p.reference.validated = true; p.reference.validatedText = p.reference.script; markManual(p, name, p.reference.script); }
    if (name === 'final_script') { p.finalScript.validated = true; p.finalScript.validatedText = p.finalScript.text; markManual(p, name, p.finalScript.text); }
    if (name === 'montage_ok') markManual(p, name, p.steps.montage?.outputHash || '');
  });
  store.logEvent(pid, name, 'auto-validated', 'mode automatique');
}

// ---------------------------------------------------------------------------------------------
// Implémentation des étapes
// ---------------------------------------------------------------------------------------------

const RUNNERS = {
  async source_fetch(p, { dir, progress: prog }) {
    if (p.source.origin === 'upload') {
      if (!p.source.file || !fs.existsSync(path.join(dir, p.source.file))) throw Object.assign(new Error('Fichier importé introuvable : importez à nouveau la vidéo.'), { fallback: true });
      return { file: p.source.file, origin: 'upload', hash: fileHash(p, p.source.file) };
    }
    if (p.source.urls?.length > 1) return fetchClips(p, dir, prog);
    if (!p.source.url) throw Object.assign(new Error('Aucun lien ni fichier pour la vidéo à modifier.'), { fallback: true });
    const outDir = ensureDir(path.join(dir, 'source', 'download'));
    const [res, oembed] = await Promise.all([downloadTikTok(p.source.url, outDir, { onProgress: (x) => prog(x, 'Téléchargement depuis TikTok…') }), fetchOEmbed(p.source.url)]);
    const rel = placeFile(res.file, dir, 'source/source', path.extname(res.file));
    return { file: rel, origin: 'tiktok', info: res.info, oembed, hash: fileHash(p, rel) };
  },

  async source_analyze(p, { dir, progress: prog }) {
    const file = path.join(dir, p.steps.source_fetch.output.file);
    const meta = await media.probe(file);
    if (!meta.hasVideo) throw Object.assign(new Error('Le fichier importé ne contient pas de piste vidéo.'), { fallback: true });
    prog(0.3);
    const scenes = await media.detectScenes(file, meta.duration);
    prog(0.6);
    const framesDir = path.join(dir, 'source', 'frames');
    fs.rmSync(framesDir, { recursive: true, force: true });
    const frames = await media.extractKeyframes(file, scenes, framesDir, 16);
    return { meta, scenes, frames, framesDir: 'source/frames' };
  },

  async visual_agent(p, { dir }) {
    const a = p.steps.source_analyze.output;
    const caption = p.steps.source_fetch.output?.info?.description || p.steps.source_fetch.output?.oembed?.title || '';
    return agents.visualAgent({ frames: a.frames, framesDir: path.join(dir, a.framesDir), scenes: a.scenes, meta: a.meta, caption });
  },

  async reference_fetch(p, { dir, progress: prog }) {
    if (p.reference.origin === 'upload') {
      if (!p.reference.file || !fs.existsSync(path.join(dir, p.reference.file))) throw Object.assign(new Error('Fichier de référence introuvable : importez-le à nouveau.'), { fallback: true });
      return { file: p.reference.file, origin: 'upload', subtitles: [], hash: fileHash(p, p.reference.file) };
    }
    if (!p.reference.url) throw Object.assign(new Error('Aucun lien TikTok de référence.'), { fallback: true });
    const reused = reuseSourceDownload(p, dir);
    if (reused) return reused;
    const outDir = ensureDir(path.join(dir, 'reference', 'download'));
    const [res, oembed] = await Promise.all([downloadTikTok(p.reference.url, outDir, { subtitles: true, light: true, onProgress: (x) => prog(x, 'Téléchargement depuis TikTok…') }), fetchOEmbed(p.reference.url)]);
    const rel = placeFile(res.file, dir, 'reference/reference', path.extname(res.file));
    const subs = res.subtitles.map((s) => ({ ...s, file: 'reference/download/' + s.file }));
    return { file: rel, origin: 'tiktok', subtitles: subs, info: res.info, oembed, hash: fileHash(p, rel) };
  },

  async reference_extract(p, { dir, progress: prog }) {
    const methods = [];
    if (p.reference.origin === 'text') {
      const text = String(p.reference.pastedText || '').trim();
      methods.push({ method: 'manuel', status: 'ok', detail: 'Texte collé par l\'utilisateur.' });
      return { methods, transcript: { source: 'manual', text, segments: paragraphs(text).map((t) => ({ start: null, end: null, text: t, uncertain: false })), language: null, languageConfidence: 'low' }, ocr: [] };
    }
    const fetched = p.steps.reference_fetch.output;
    const file = path.join(dir, fetched.file);
    const meta = await media.probe(file);
    const ai = aiAvailable();

    // Méthode 2 — sous-titres publiés (récupérés avec la vidéo).
    let subsCues = [];
    if (fetched.subtitles?.length) {
      const pick = fetched.subtitles.find((s) => /^fr/.test(s.lang)) || fetched.subtitles[0];
      try {
        subsCues = parseVtt(fs.readFileSync(path.join(dir, pick.file), 'utf8'));
        methods.push({ method: 'sous-titres', status: subsCues.length ? 'ok' : 'vide', detail: `${subsCues.length} sous-titres (${pick.lang}).` });
      } catch (e) { methods.push({ method: 'sous-titres', status: 'échec', detail: e.message }); }
    } else {
      methods.push({ method: 'sous-titres', status: 'indisponible', detail: fetched.origin === 'upload' ? 'Fichier importé : pas de sous-titres associés.' : 'Aucun sous-titre accessible pour cette vidéo.' });
    }
    const subsText = subsCues.map((c) => c.text).join(' ');
    prog(0.1, 'Préparation de l\'audio et des images…');

    // Méthodes 1 et 3 en parallèle : transcription de la piste audio et OCR du texte incrusté (distingué de la parole).
    const pending = new Set();
    const label = () => [pending.has('audio') && 'transcription de la voix', pending.has('ocr') && 'lecture du texte à l\'écran'].filter(Boolean).join(' et ');
    const transcribe = async () => {
      if (!meta.hasAudio) return { audio: null, method: { method: 'transcription audio', status: 'indisponible', detail: 'Aucune piste audio dans le fichier.' } };
      if (!ai) return { audio: null, method: { method: 'transcription audio', status: 'non configurée', detail: 'Clé OpenRouter absente.' } };
      const audioRel = 'reference/reference-audio.ogg';
      await media.extractAudio(file, path.join(dir, audioRel));
      pending.add('audio');
      try {
        const audio = await agents.transcribeAudio(path.join(dir, audioRel), { subtitlesText: subsText, durationHint: meta.duration });
        return { audio, method: { method: 'transcription audio', status: audio.hasSpeech ? 'ok' : 'aucune parole', detail: audio.hasSpeech ? `${audio.segments.length} segments, langue ${audio.language || 'non déterminée'}.` : 'Aucune parole détectée.' } };
      } catch (e) {
        return { audio: null, method: { method: 'transcription audio', status: 'échec', detail: e.message } };
      } finally { pending.delete('audio'); }
    };
    const readScreen = async () => {
      if (!meta.hasVideo || !ai) return { ocr: [], method: { method: 'OCR (texte à l\'écran)', status: ai ? 'indisponible' : 'non configurée', detail: ai ? 'Pas de piste vidéo.' : 'Clé OpenRouter absente.' } };
      try {
        const scenes = await media.detectScenes(file, meta.duration);
        const framesDir = path.join(dir, 'reference', 'frames');
        fs.rmSync(framesDir, { recursive: true, force: true });
        const frames = await media.extractKeyframes(file, scenes, framesDir, 10);
        pending.add('ocr');
        const ocr = await agents.ocrFrames(frames, framesDir);
        return { ocr, method: { method: 'OCR (texte à l\'écran)', status: ocr.length ? 'ok' : 'aucun texte', detail: `${ocr.length} éléments de texte incrusté.` } };
      } catch (e) {
        return { ocr: [], method: { method: 'OCR (texte à l\'écran)', status: 'échec', detail: e.message } };
      } finally { pending.delete('ocr'); }
    };
    // Pendant les appels IA (sans retour intermédiaire), la barre avance d'elle-même vers 95 % en indiquant ce qui reste.
    const t0 = Date.now();
    const timer = setInterval(() => {
      const k = 1 - Math.exp(-(Date.now() - t0) / 1000 / Math.max(15, meta.duration / 2));
      const what = label();
      prog(0.15 + 0.8 * k * 0.97, what ? what.charAt(0).toUpperCase() + what.slice(1) + '…' : 'Préparation de l\'audio et des images…');
    }, 1000);
    let audio = null, ocr = [];
    try {
      const [a, o] = await Promise.all([transcribe(), readScreen()]);
      audio = a.audio;
      ocr = o.ocr;
      methods.push(a.method, o.method);
    } finally { clearInterval(timer); }
    prog(0.97, 'Assemblage du script…');

    let transcript;
    if (audio?.hasSpeech) {
      transcript = { source: 'audio', ...audio, text: audio.segments.map((s) => s.text).join('\n\n') };
    } else if (subsCues.length) {
      transcript = { source: 'subtitles', language: null, languageConfidence: 'low', segments: subsCues.map((c) => ({ ...c, uncertain: false })), text: subsCues.map((c) => c.text).join(' ') };
    } else if (ocr.some((o) => o.kind !== 'other')) {
      const items = ocr.filter((o) => o.kind !== 'other');
      transcript = { source: 'ocr', language: null, languageConfidence: 'low', segments: items.map((o) => ({ start: o.t, end: null, text: o.text, uncertain: true, note: 'Texte affiché à l\'écran, pas forcément prononcé.' })), text: items.map((o) => o.text).join('\n\n') };
    } else {
      const reason = ai ? 'Aucune parole, aucun sous-titre et aucun texte incrusté exploitable n\'ont été trouvés.'
        : 'Sans clé OpenRouter, seule la récupération des sous-titres est possible, et aucun sous-titre n\'est disponible.';
      throw Object.assign(new Error(reason + ' Collez le texte manuellement ou configurez la transcription.'), { fallback: true, retryable: false });
    }
    return { methods, transcript, ocr, subtitlesText: subsText, meta: { duration: meta.duration, hasAudio: meta.hasAudio } };
  },

  async narrative_agent(p) {
    const stats = p.reference.stats || p.steps.reference_fetch?.output?.info?.stats || null;
    const language = p.steps.reference_extract?.output?.transcript?.language || null;
    return agents.narrativeAgent({ script: p.reference.validatedText, stats, language });
  },

  async script_agent(p, { progress: prog }) {
    const visual = p.steps.visual_agent.output;
    const narrative = p.steps.narrative_agent.output;
    const params = scriptParams(p);
    const temperature = p.scriptNonce ? 0.85 : 0.7;
    const referenceScript = p.reference.validatedText;
    let draft = await agents.rewriteAgent({ visual, narrative, params, referenceScript, temperature });
    let segments = normalizeSegments(draft.segments);
    prog(0.45);
    let qa = await agents.qaAgent({ segments, visual, params, referenceScript });
    const rounds = [{ qa: summarizeQa(qa) }];
    if (qa.verdict === 'needs_revision') {
      const feedback = [...qa.issues.map((i) => `- [${i.severity}] ${i.segment_index != null ? 'segment ' + i.segment_index + ' : ' : ''}${i.problem} → ${i.suggestion}`),
        ...(qa.invented_facts || []).map((f) => `- Fait non visible à retirer : ${f}`)].join('\n');
      prog(0.6);
      draft = await agents.rewriteAgent({ visual, narrative, params, referenceScript, feedback, previous: { segments }, temperature: 0.5 });
      segments = normalizeSegments(draft.segments);
      prog(0.8);
      qa = await agents.qaAgent({ segments, visual, params, referenceScript });
      rounds.push({ qa: summarizeQa(qa) });
    }
    // Accroche optimisée : 5 variantes notées ; la mieux notée remplace la première phrase. Un échec ici ne bloque pas le script.
    prog(0.9);
    let hooks = [];
    let hook = null;
    try {
      hooks = await viral.hookAgent({ segments, visual, narrative, params, referenceScript: agents.scriptModeOf(params) === 'adapt' ? referenceScript : '' });
      hook = hooks.reduce((best, h) => (h.total > best.total ? h : best), hooks[0]);
      if (hook && !hook.current && segments[0]) segments[0] = { ...segments[0], text: viral.replaceOpening(segments[0].text, hook.spoken) };
    } catch (e) { hooks = []; hook = null; }
    return { title: draft.title || '', segments, qa, rounds, notes: draft.notes || '', hooks, hook };
  },

  async voice(p, { dir }) {
    const vp = await resolveVoiceParams(p);
    const text = p.finalScript.validatedText;
    const n = (p.versions.voice?.length || 0) + 1;
    const outDir = ensureDir(path.join(dir, 'voice'));
    const r = await synthesize({ text, provider: vp.provider, voice: vp.voice, tone: vp.tone, speed: vp.speed, language: vp.language, outDir, baseName: `voice-v${n}`, maxDuration: voiceSlot(p) });
    learnSpeechRate(vp, wordCount(text), r.naturalDuration);
    return { file: `voice/voice-v${n}.mp3`, duration: Math.round(r.duration * 100) / 100, naturalDuration: Math.round(r.naturalDuration * 100) / 100, fit: r.fit, slot: voiceSlot(p),
      words: r.words, provider: vp.provider, voice: vp.voice, tone: vp.tone, speed: vp.speed };
  },

  async montage(p, { dir, progress: prog }) {
    return renderProject(p, dir, { kind: 'preview', onProgress: prog });
  },

  async export(p, { dir, progress: prog }) {
    return renderProject(p, dir, { kind: 'export', onProgress: prog });
  },

  async caption(p) {
    return agents.captionAgent({ script: p.finalScript.validatedText, visual: p.steps.visual_agent?.output, params: p.params });
  },
};

// Effets de bord après succès : mise à jour des documents modifiables par l'utilisateur.
const AFTER = {
  source_fetch(p, out) {
    p.source.file = out.file;
    p.source.clips = out.clips || null;
    if (out.oembed) p.source.oembed = out.oembed;
    const title = out.oembed?.title || out.info?.description || '';
    if (p.autoName && title) { p.name = title.replace(/\s+/g, ' ').trim().slice(0, 80); p.autoName = false; }
    if (out.info?.stats) recordSourceStats(p, out.info.stats);
  },
  source_analyze(p, out) { p.source.meta = out.meta; },
  reference_fetch(p, out) {
    p.reference.file = out.file;
    if (out.oembed) p.reference.oembed = out.oembed;
    if (out.info?.stats && !p.reference.statsManual) p.reference.stats = out.info.stats;
  },
  reference_extract(p, out) {
    // Une nouvelle extraction remplace le brouillon et annule la validation précédente.
    p.reference.script = out.transcript.text;
    p.reference.scriptEdited = false;
    p.reference.validated = false;
    store.pushVersion(p, 'referenceScript', { source: out.transcript.source, text: out.transcript.text });
    delete p.steps.reference_script;
  },
  script_agent(p, out) {
    setFinalScript(p, out.segments, 'agent');
    if (out.hook) p.hook = { spoken: out.hook.spoken, screen: out.hook.screen };
  },
  voice(p, out) { store.pushVersion(p, 'voice', { file: out.file, duration: out.duration, provider: out.provider, voice: out.voice, tone: out.tone, speed: out.speed }); },
  montage(p, out) { store.pushVersion(p, 'montage', { file: out.file, duration: out.duration, params: p.montageParams }); delete p.steps.montage_ok; },
  export(p, out) { store.pushVersion(p, 'export', { file: out.file, size: out.size, duration: out.duration, width: out.width, height: out.height }); },
  caption(p, out) {
    // Le créateur d'origine est crédité dans la description : une reprise créditée est moins souvent signalée.
    const handle = sourceHandle(p);
    const credit = handle && !String(out.description || '').toLowerCase().includes('@' + handle.toLowerCase()) ? `\n\nVidéo originale : @${handle}` : '';
    if (!p.publishDraft.edited) p.publishDraft = { caption: out.caption || '', description: (out.description || '') + credit, hashtags: (out.hashtags || []).map((h) => String(h).replace(/^#/, '').replace(/\s+/g, '')), cta: out.cta || '', edited: false };
  },
};

// ---------------------------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------------------------

export function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function normalizeSegments(segs) {
  return (Array.isArray(segs) ? segs : []).map((s) => ({ text: String(s.text || '').trim(), scene_index: Number.isInteger(s.scene_index) ? s.scene_index : null, intent: s.intent || '' })).filter((s) => s.text);
}

function summarizeQa(qa) { return { verdict: qa.verdict, scores: qa.scores, issues: qa.issues?.length || 0, estimatedDuration: qa.estimatedDuration }; }

export function setFinalScript(p, segments, origin) {
  // Script écrit à la main sans passage par l'Agent C (ex. pas de clé IA) : sa validation ne dépend pas de l'agent.
  const manualOnly = origin === 'agent' ? false : (p.finalScript.manualOnly ?? !p.steps.script_agent);
  p.finalScript = { segments, text: segments.map((s) => s.text).join('\n\n'), edited: origin === 'user', manualOnly, validated: false, validatedText: '', validatedAt: '' };
  store.pushVersion(p, 'script', { origin, text: p.finalScript.text, segments });
  delete p.steps.final_script;
}

// Texte modifié à la main : chaque paragraphe retrouve son plan en le comparant aux passages connus
// (toutes versions confondues) ; à défaut, on reprend l'association de la version courante par position.
export function segmentsFromText(p, text) {
  const current = p.finalScript.segments || [];
  const known = [...current, ...(p.versions.script || []).flatMap((v) => v.segments || [])].filter((s) => s.scene_index != null);
  const words = (t) => new Set(String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const similarity = (a, b) => { const A = words(a), B = words(b); const inter = [...A].filter((w) => B.has(w)).length; return inter / Math.max(1, Math.min(A.size, B.size)); };
  return paragraphs(text).map((t, i) => {
    let best = null, score = 0;
    for (const s of known) { const sc = similarity(t, s.text); if (sc > score) { score = sc; best = s; } }
    const match = score >= 0.6 ? best : current[i];
    return { text: t, scene_index: match?.scene_index ?? null, intent: match?.intent || '' };
  });
}

export async function resolveVoiceParams(p) {
  const vp = { ...voiceParams(p) };
  const list = await ttsProviders();
  let prov = list.find((x) => x.id === vp.provider && x.available) || list.find((x) => x.available);
  if (!prov) throw Object.assign(new Error('Aucun service de synthèse vocale disponible : configurez FAL_KEY ou installez une voix Windows.'), { needsConfig: true, retryable: false });
  vp.provider = prov.id;
  const lang = String(vp.language || p.params.language || 'fr').slice(0, 2);
  if (!prov.voices.some((v) => v.id === vp.voice)) {
    const candidates = prov.voices.filter((v) => v.lang === '*' || v.lang === lang);
    vp.voice = (candidates.find((v) => v.gender === (vp.gender || 'F')) || candidates[0] || prov.voices[0])?.id || '';
  }
  return vp;
}

// Horodatage des mots de la voix off : exact (ElevenLabs) ou estimé et recalé sur les pauses détectées.
async function voiceWordTimings(p, dir) {
  const v = p.steps.voice.output;
  if (v.words?.length) return { words: v.words, timing: 'exact' };
  const text = p.finalScript.validatedText;
  const silences = await media.detectSilences(path.join(dir, v.file), { min: 0.25 });
  const sentences = text.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];
  const totalChars = sentences.reduce((a, s) => a + s.length, 0);
  const bounds = [0];
  let acc = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    acc += sentences[i].length;
    const predicted = (acc / totalChars) * v.duration;
    const near = silences.map((s) => ({ mid: (s.start + s.end) / 2, d: Math.abs((s.start + s.end) / 2 - predicted) })).filter((s) => s.d < 1.5 && s.mid > bounds[bounds.length - 1]).sort((a, b) => a.d - b.d)[0];
    bounds.push(near ? near.mid : predicted);
  }
  bounds.push(v.duration);
  const words = [];
  sentences.forEach((s, i) => {
    const ws = estimateWordTimings(s, bounds[i + 1] - bounds[i]);
    words.push(...ws.map((w) => ({ ...w, start: w.start + bounds[i], end: w.end + bounds[i] })));
  });
  return { words, timing: 'estimé (recalé sur les pauses)' };
}

// Passe d'un temps de sortie à un temps de la vidéo source (en tenant compte des coupes).
function outputToSource(segs, t) {
  let acc = 0;
  for (const s of segs) {
    const len = s.end - s.start;
    if (t < acc + len) return s.start + (t - acc);
    acc += len;
  }
  return null; // tombe sur l'image figée finale
}

function sceneAt(scenes, t) { return t == null ? null : (scenes.find((s) => t >= s.start && t < s.end) || scenes[scenes.length - 1])?.index ?? null; }

// Analyse de synchronisation : écarts de durée, coupes proposées, passages mal placés.
export function syncReport(p, words) {
  const params = montageParams(p);
  const a = p.steps.source_analyze.output;
  const v = p.steps.voice.output;
  const plan = media.planTimeline(params, a.meta.duration, v.duration);
  const warnings = [];
  const diff = plan.videoLen - plan.voiceEnd;
  const target = params.exactDuration ? params.targetDuration : 0;
  if (target) {
    // Durée exacte : la vidéo est déjà coupée ou prolongée ; on signale seulement une narration hors créneau.
    const silent = target - plan.voiceEnd - params.tail;
    if (plan.total > target + 0.05) warnings.push({ level: 'warning', message: `La narration (fin à ${plan.voiceEnd.toFixed(1)} s) dépasse la durée cible de ${target} s : la vidéo dure ${plan.total.toFixed(1)} s pour ne pas couper la voix. Raccourcissez le script (bouton « Ajuster à la durée cible »).` });
    else if (silent > 2) warnings.push({ level: 'warning', message: `La narration se termine à ${plan.voiceEnd.toFixed(1)} s : les ${silent.toFixed(1)} dernières secondes de la vidéo de ${target} s sont sans voix. Allongez le script (bouton « Ajuster à la durée cible »), puis régénérez la voix off.` });
    if (plan.freeze > 0.05) warnings.push({ level: 'info', message: `La vidéo source (${plan.videoLen.toFixed(1)} s) est plus courte que ${target} s : la dernière image est figée ${plan.freeze.toFixed(1)} s.` });
    if (v.fit > 1.001) warnings.push({ level: 'info', message: `La voix off a été accélérée de ${Math.round((v.fit - 1) * 100)} % pour tenir dans les ${target} s.` });
  } else if (diff < -0.2) warnings.push({ level: params.fit === 'freeze' ? 'info' : 'warning', message: `La voix off (fin à ${plan.voiceEnd.toFixed(1)} s) dépasse les images conservées (${plan.videoLen.toFixed(1)} s). ${params.fit === 'freeze' ? `La dernière image est figée ${plan.freeze.toFixed(1)} s pour ne pas couper la narration.` : 'Activez « Figer la dernière image » ou raccourcissez le script.'}` });
  if (!target && diff > 1.5 && !params.trimToVoice) warnings.push({ level: 'info', message: `La vidéo dure ${diff.toFixed(1)} s de plus que la narration. Appliquez la coupe proposée ou cochez « Couper à la fin de la narration ».` });

  // Coupes proposées : retirer d'abord les plans non commentés, puis couper la fin au plus près d'un changement de plan.
  let suggestion = null;
  const needed = plan.voiceEnd + params.tail;
  if (!target && plan.videoLen > needed + 1) {
    const referenced = new Set((p.finalScript.segments || []).map((s) => s.scene_index).filter((x) => x != null));
    let kept = a.scenes.map((s) => ({ ...s }));
    let total = kept.reduce((x, s) => x + s.end - s.start, 0);
    const removable = kept.filter((s) => s.index !== 0 && !referenced.has(s.index)).sort((x, y) => (y.end - y.start) - (x.end - x.start));
    for (const s of removable) {
      if (total - (s.end - s.start) < needed) continue;
      kept = kept.filter((k) => k.index !== s.index);
      total -= s.end - s.start;
    }
    const segs = [];
    let acc = 0;
    for (const s of kept) {
      if (acc >= needed) break;
      const len = s.end - s.start;
      const end = acc + len > needed ? s.start + (needed - acc) : s.end;
      segs.push({ start: s.start, end: Math.round(end * 100) / 100, scene: s.index });
      acc += end - s.start;
    }
    suggestion = { segments: segs, removedScenes: a.scenes.filter((s) => !kept.some((k) => k.index === s.index)).map((s) => s.index), duration: Math.round(acc * 100) / 100 };
  }

  // Passages dont la narration ne tombe pas sur le plan qu'ils décrivent.
  const issues = [];
  const segsText = p.finalScript.segments || [];
  if (words?.length && segsText.length) {
    let wi = 0;
    for (const [i, seg] of segsText.entries()) {
      const n = seg.text.split(/\s+/).filter(Boolean).length;
      const w = words[Math.min(wi, words.length - 1)];
      wi += n;
      if (seg.scene_index == null || !w) continue;
      const tOut = params.voiceOffset + w.start;
      const src = outputToSource(plan.segs, tOut);
      const actual = sceneAt(a.scenes, src);
      if (actual != null && actual !== seg.scene_index) {
        const target = a.scenes.find((s) => s.index === seg.scene_index);
        issues.push({ segment: i, text: seg.text.slice(0, 80), expectedScene: seg.scene_index, actualScene: actual, at: Math.round(tOut * 10) / 10,
          message: `Le passage ${i + 1} décrit le plan ${seg.scene_index}${target ? ` (${target.start.toFixed(1)}–${target.end.toFixed(1)} s)` : ''} mais tombe sur le plan ${actual} à ${tOut.toFixed(1)} s.` });
      }
    }
  }
  return { plan, warnings, suggestion, issues };
}

// Plusieurs vidéos à mélanger : chacune est téléchargée une fois (dossier source/clips/<id>), puis les passages sont
// assemblés en une seule vidéo source, l'accroche choisie en premier. Les étapes suivantes travaillent sur cet assemblage.
// La vidéo de référence est souvent l'une des vidéos à modifier : le fichier déjà téléchargé est réutilisé (aucun second téléchargement).
export function reuseSourceDownload(p, dir) {
  const vid = (u) => String(u || '').match(/\/video\/(\d+)/)?.[1] || '';
  // Même vidéo : même numéro de vidéo, ou même lien (les liens courts vm.tiktok.com n'en contiennent pas).
  const norm = (u) => String(u || '').trim().split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
  const ref = p.reference.url;
  if (!ref) return null;
  const same = (u, id = '') => (vid(ref) && (vid(u) || id) === vid(ref)) || norm(u) === norm(ref);
  const isVideo = (x) => /^download\.(mp4|mov|webm|mkv)$/i.test(x);
  let srcDir = null;
  const clip = p.source.urls?.find((u) => same(u));
  if (clip) srcDir = path.join(dir, 'source', 'clips', vid(clip) || sha(clip).slice(0, 12));
  else if (p.source.origin === 'tiktok' && p.steps.source_fetch?.status === 'done') {
    const id = String(readJSON(path.join(dir, 'source', 'download', 'download.info.json'), {})?.id || '');
    if (same(p.source.url, id)) srcDir = path.join(dir, 'source', 'download');
  }
  if (!srcDir || !fs.existsSync(srcDir)) return null;
  // Source unique : le fichier vidéo a été déplacé vers source/source.* ; seules les métadonnées restent dans le dossier.
  const name = fs.readdirSync(srcDir).find(isVideo);
  const file = name ? path.join(srcDir, name) : (p.source.file && path.join(dir, p.source.file));
  if (!file || !fs.existsSync(file)) return null;
  const rel = placeFile(file, dir, 'reference/reference', path.extname(file), { copy: true });
  const info = readJSON(path.join(srcDir, 'download.info.json'), {}) || {};
  const stats = info.view_count != null || info.like_count != null ? { views: info.view_count ?? null, likes: info.like_count ?? null, comments: info.comment_count ?? null, shares: info.repost_count ?? null, source: 'métadonnées publiques TikTok' } : null;
  return { file: rel, origin: 'tiktok', subtitles: [], info: { title: info.title || '', description: info.description || '', uploader: info.uploader || '', stats }, oembed: null, reused: true, hash: fileHash(p, rel) };
}

async function fetchClips(p, dir, prog = () => {}) {
  const urls = p.source.urls;
  const hook = Math.min(urls.length - 1, Math.max(0, Number(p.source.hook) || 0));
  // Téléchargements en parallèle ; la progression affichée est la moyenne des vidéos (l'assemblage occupe les derniers 15 %).
  const done = urls.map(() => 0);
  const report = () => prog(0.85 * (done.reduce((a, b) => a + b, 0) / urls.length), `Téléchargement de ${urls.length} vidéos depuis TikTok…`);
  const isVideo = (x) => /^download\.(mp4|mov|webm|mkv)$/i.test(x);
  const clips = await Promise.all(urls.map(async (url, i) => {
    const vid = url.match(/\/video\/(\d+)/)?.[1] || sha(url).slice(0, 12);
    const outDir = ensureDir(path.join(dir, 'source', 'clips', vid));
    const have = fs.readdirSync(outDir).find(isVideo);
    let info = readJSON(path.join(outDir, 'clip.json'));
    if (!have || !info) {
      const [res, oembed] = await Promise.all([downloadTikTok(url, outDir, { onProgress: (f) => { done[i] = f; report(); } }), fetchOEmbed(url)]);
      info = { ...res.info, oembed };
      writeJSON(path.join(outDir, 'clip.json'), info);
    }
    done[i] = 1;
    report();
    const file = path.join(outDir, fs.readdirSync(outDir).find(isVideo));
    const meta = await media.probe(file);
    return { index: i, url, vid, file, rel: path.relative(dir, file).split(path.sep).join('/'), meta, info };
  }));
  const order = [clips[hook], ...clips.filter((_, i) => i !== hook)];
  const share = media.shareClips(order.map((c) => ({ duration: c.meta.duration })), (Number(p.params.durationTarget) || 61) + 2);
  const first = order[0].meta;
  const vertical = !first.width || first.height >= first.width;
  const mix = path.join(dir, 'source', 'source-mix.mp4');
  prog(0.88, 'Assemblage des vidéos…');
  await media.concatClips(order.map((c, k) => ({ file: c.file, hasAudio: c.meta.hasAudio, ...share[k] })), mix, vertical ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 });
  // Métadonnées de l'accroche aux emplacements habituels : statistiques, crédit et détecteur de copies s'y réfèrent.
  const hookDir = path.dirname(order[0].file);
  const hookInfo = path.join(hookDir, 'download.info.json');
  if (fs.existsSync(hookInfo)) fs.copyFileSync(hookInfo, path.join(ensureDir(path.join(dir, 'source', 'download')), 'download.info.json'));
  const rel = 'source/source-mix.mp4';
  return {
    file: rel, origin: 'tiktok', info: order[0].info, oembed: order[0].info.oembed, hash: fileHash(p, rel),
    clips: clips.map((c) => ({ index: c.index, url: c.url, file: c.rel, duration: Math.round(c.meta.duration * 10) / 10, title: (c.info.description || c.info.title || '').slice(0, 140),
      uploader: c.info.uploader || '', stats: c.info.stats || null, used: share[order.indexOf(c)] })),
  };
}

// Montage dynamique : une phrase sur deux est zoomée (jusqu'au début de la suivante), pour relancer l'attention à chaque idée.
function punchInWindows(words, offset) {
  const sentences = [];
  let start = null;
  for (const w of words || []) {
    if (start == null) start = w.start;
    if (/[.!?…:;]["»]?$/.test(w.text)) { sentences.push({ start, end: w.end }); start = null; }
  }
  if (start != null) sentences.push({ start, end: words.at(-1).end });
  return sentences.map((s, i) => ({ start: s.start + offset, end: (sentences[i + 1]?.start ?? s.end) + offset }))
    .filter((w, i) => i % 2 === 1 && w.end - w.start > 0.3);
}

async function renderProject(p, dir, { kind, onProgress }) {
  const a = p.steps.source_analyze.output;
  const v = p.steps.voice.output;
  const params = montageParams(p);
  if (params.musicFile && !fs.existsSync(path.join(dir, params.musicFile))) throw new Error('Musique de fond introuvable : importez-la à nouveau ou retirez-la.');
  const R = params.reaction;
  const useReaction = R.enabled && R.file;
  if (useReaction && !fs.existsSync(path.join(dir, R.file))) throw new Error('Votre vidéo de réaction est introuvable : importez-la à nouveau (page Montage) ou désactivez le mode réaction.');
  const reactionMeta = useReaction ? await media.probe(path.join(dir, R.file)) : null;
  if (reactionMeta && !reactionMeta.hasVideo) throw new Error('Le fichier de réaction ne contient pas d\'image : importez une vidéo de vous.');
  // Écran partagé : les sous-titres se placent sur la ligne de séparation, entre l'originale et vous.
  let subStyle = useReaction && R.layout === 'split' ? { ...params.subtitles, position: 'bottom', marginV: 900 } : params.subtitles;
  // Masque des anciens sous-titres : les nouveaux se centrent sur la zone floutée (marge exprimée pour un canevas de 1920 px).
  const mbox = media.maskBox(params, a.meta);
  if (mbox && params.mask.centerSubs) {
    const fg = media.foregroundBox(params, a.meta, 1080, 1920);
    const cy = fg.y + ((mbox.y + mbox.h / 2) / a.meta.height) * fg.h;
    subStyle = { ...subStyle, position: 'bottom', marginV: Math.max(0, Math.round(1920 - cy - (subStyle.size || 72) * 0.6)) };
  }
  const handle = sourceHandle(p);
  const credit = params.credit.enabled && handle ? { text: `Vidéo originale : @${handle}` } : null;
  const { words, timing } = await voiceWordTimings(p, dir);
  const report = syncReport(p, words);

  const isExport = kind === 'export';
  const ep = p.exportParams || {};
  const [W, H] = isExport ? String(ep.resolution || '1080x1920').split('x').map(Number) : [720, 1280];
  const fps = isExport && ep.fps !== 'source' ? Number(ep.fps) : a.meta.fps;
  const crf = isExport ? ({ max: 16, high: 19, medium: 23, light: 27 }[ep.quality] || 19) : 26;
  const preset = isExport ? (ep.quality === 'max' ? 'slow' : 'medium') : 'veryfast';

  const outDirName = isExport ? 'export' : 'montage';
  const outDir = ensureDir(path.join(dir, outDirName));
  const n = (p.versions[isExport ? 'export' : 'montage']?.length || 0) + 1;
  const outName = isExport ? `final-v${n}.mp4` : `preview-v${n}.mp4`;

  let subsName = null;
  let cues = [];
  const hookText = params.hookTitle.enabled ? (params.hookTitle.text || p.hook?.screen || '') : '';
  if (params.subtitles.enabled || hookText || credit) {
    if (params.subtitles.enabled) cues = cuesFromWords(words, { maxWords: params.subtitles.animation === 'mot' ? 1 : params.subtitles.maxWords, offset: params.voiceOffset });
    subsName = `subs-${kind}.ass`;
    const hook = hookText ? { ...params.hookTitle, text: hookText } : null;
    fs.writeFileSync(path.join(outDir, subsName), buildAss(cues, subStyle, { width: W, height: H, hook, credit }), 'utf8');
  }
  // Les chemins sont relatifs au dossier de sortie (cwd) : évite l'échappement des chemins Windows dans le filtre subtitles.
  const rel = (f) => path.relative(outDir, path.join(dir, f)).split(path.sep).join('/');
  const r = await media.renderMontage({
    source: rel(p.steps.source_fetch.output.file), sourceMeta: a.meta, voice: rel(v.file), voiceDuration: v.duration,
    params: { ...params, musicFile: params.musicFile ? rel(params.musicFile) : '', reaction: { ...R, file: useReaction ? rel(R.file) : '' } }, reactionMeta,
    out: outName, cwd: outDir, subtitlesFile: subsName, zoomWindows: punchInWindows(words, params.voiceOffset), width: W, height: H, fps, crf, preset, onProgress,
  });
  const meta = await media.probe(path.join(outDir, outName));
  return {
    file: `${outDirName}/${outName}`, duration: Math.round(meta.duration * 100) / 100, width: meta.width, height: meta.height, fps: meta.fps, size: meta.size,
    plan: r.plan, warnings: report.warnings, suggestion: report.suggestion, issues: report.issues, subtitleTiming: params.subtitles.enabled ? timing : null,
    cues: cues.length, cueList: cues.slice(0, 400).map((c) => ({ s: Math.round(c.start * 100) / 100, e: Math.round(c.end * 100) / 100, t: c.text })), sourceUpscaled: isExport && a.meta.width && W > a.meta.width * 1.6,
  };
}

export { wordsPerSecond };
