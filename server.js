// TikTok Repost Studio — serveur HTTP local (aucune dépendance npm).
import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { balances } from './lib/balances.js';
import { budgetStatus, PERIODS } from './lib/budget.js';
import { claudeCodeStatus, claudeJSON, CLAUDE_MODELS } from './lib/ai/claudecode.js';
import { ROOT, DATA_DIR, getSettings, saveSettings, setSecret, hasSecret, SECRET_NAMES, detectTools } from './lib/config.js';
import * as store from './lib/store.js';
import * as pipeline from './lib/pipeline.js';
import { validateTikTokUrl, remoteFetchStatus, fetchOEmbed, fetchTikTokStats } from './lib/tiktok.js';
import { providers as ttsProviders, TONES, synthesize } from './lib/tts.js';
import { aiAvailable } from './lib/ai/openrouter.js';
import * as agents from './lib/ai/agents.js';
import { DEFAULT_SCRIPT_PROMPT } from './lib/ai/scriptprompt.js';
import * as viral from './lib/ai/viral.js';
import { originalityReport, sourceHandle } from './lib/originality.js';
import * as copies from './lib/copies.js';
import { mergeMontage, DEFAULT_MONTAGE, probe } from './lib/media.js';
import { ensureDir, sha, placeFile, newId } from './lib/util.js';

// Node 24 propose par défaut une clé TLS post-quantique (ML-KEM) : le premier message TLS dépasse alors un paquet
// réseau et certaines box le perdent (négociation de plusieurs secondes ou « fetch failed »). Courbes classiques uniquement.
tls.DEFAULT_ECDH_CURVE = 'X25519:P-256:P-384';

const PORT = Number(process.env.PORT || 4300);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const MAX_UPLOAD = 1024 * 1024 * 1024;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8', '.vtt': 'text/vtt' };

// --- Routage minimal ------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

const httpError = (status, message) => Object.assign(new Error(message), { status });
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };

async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'Requête trop volumineuse'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw httpError(400, 'JSON invalide'); }
}

// Import de fichier : corps brut de la requête écrit en flux sur le disque. Renvoie le chemin relatif final.
async function receiveFile(req, id, relBase, ext) {
  const dest = store.projectPath(id, relBase + ext);
  ensureDir(path.dirname(dest));
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let size = 0;
  try {
    for await (const c of req) {
      size += c.length;
      if (size > MAX_UPLOAD) throw httpError(413, 'Fichier trop volumineux (1 Go maximum).');
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
  if (!size) { fs.rmSync(tmp, { force: true }); throw httpError(400, 'Fichier vide.'); }
  return placeFile(tmp, store.projectPath(id), relBase, ext);
}

function uploadName(req, allowed) {
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'fichier'));
  const ext = path.extname(name).toLowerCase();
  if (!allowed.includes(ext)) throw httpError(400, `Format non pris en charge (${ext || 'sans extension'}). Formats acceptés : ${allowed.join(', ')}`);
  return { name, ext };
}

const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg'];

// Projets antérieurs : les statistiques n'étaient conservées que dans la sortie de l'étape de récupération.
function sourceStats(p) {
  return p.source.stats || p.steps.source_fetch?.output?.info?.stats || null;
}

function view(p) {
  const sp = pipeline.scriptParams(p);
  // scriptTarget : durée de voix off visée par le script et débit de parole mesuré, pour l'affichage.
  return { ...p, source: { ...p.source, stats: sourceStats(p), info: sourceInfo(p) }, originality: originalityReport(p, pipeline.montageParams(p)), pipeline: pipeline.describe(p), scriptTarget: { seconds: sp.durationTarget, wps: sp.wps, video: Number(p.params.durationTarget) || 0 } };
}

function project(id) {
  const p = store.getProject(id);
  if (!p) throw httpError(404, 'Projet introuvable');
  return p;
}

function requireIdle(id) { if (pipeline.isRunning(id)) throw httpError(409, 'Un traitement est déjà en cours sur ce projet. Patientez.'); }

// Lance un traitement en arrière-plan ; l'interface suit l'avancement par interrogation.
function launch(id, target, opts) {
  pipeline.start(id, target, opts).catch(() => { /* erreur consignée dans le projet */ });
}

// --- État général & paramètres ---------------------------------------------------------------

// Version installée (package.json) : affichée dans l'app pour vérifier que tout le monde a la même.
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
route('GET', '/api/version', async () => ({ version: VERSION }));

route('GET', '/api/status', async () => {
  const tools = await detectTools();
  const fetchSt = await remoteFetchStatus();
  const tts = await ttsProviders();
  return {
    tools: { ffmpeg: Boolean(tools.ffmpeg), ytdlp: Boolean(tools.ytdlp) },
    remoteFetch: fetchSt,
    ai: aiAvailable(),
    secrets: Object.fromEntries(SECRET_NAMES.map((n) => [n, hasSecret(n)])),
    tts: tts.map(({ voices, ...x }) => ({ ...x, voiceCount: voices.length })),
    claudeCode: { ...(await claudeCodeStatus()), models: CLAUDE_MODELS },
  };
});

// defaultScriptPrompt : méthode d'écriture par défaut, pour l'afficher et la restaurer dans Paramètres.
route('GET', '/api/settings', async () => ({ ...getSettings(), defaultScriptPrompt: DEFAULT_SCRIPT_PROMPT }));
route('GET', '/api/balances', async () => ({ ...(await balances()), budget: await budgetStatus() }));
route('PUT', '/api/settings', async ({ body }) => {
  const allowed = {};
  if (body.models) allowed.models = { multimodal: String(body.models.multimodal || ''), text: String(body.models.text || '') };
  if (body.remoteFetch) allowed.remoteFetch = { enabled: Boolean(body.remoteFetch.enabled) };
  if (body.ytdlpPath != null) allowed.ytdlpPath = String(body.ytdlpPath);
  if (body.textAI) {
    allowed.textAI = { provider: body.textAI.provider === 'claude-code' ? 'claude-code' : 'openrouter',
      claudeModel: CLAUDE_MODELS.some(([m]) => m === body.textAI.claudeModel) ? body.textAI.claudeModel : 'opus' };
  }
  if (body.defaults) allowed.defaults = body.defaults;
  // Méthode d'écriture des scripts : identique au texte par défaut = vide (les mises à jour du texte par défaut s'appliquent).
  if (body.scriptPrompt != null) { const t = String(body.scriptPrompt).trim().slice(0, 20000); allowed.scriptPrompt = t === DEFAULT_SCRIPT_PROMPT.trim() ? '' : t; }
  if (body.budget) {
    const limit = (v) => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);
    allowed.budget = { period: PERIODS[body.budget.period] ? body.budget.period : 'month', openrouter: limit(body.budget.openrouter), fal: limit(body.budget.fal) };
  }
  const s = saveSettings(allowed);
  await detectTools(true);
  return s;
});
// Les clés sont écrites dans .env côté serveur ; elles ne sont jamais renvoyées au navigateur.
route('PUT', '/api/secrets', async ({ body }) => { setSecret(body.name, body.value); return { ok: true, configured: hasSecret(body.name) }; });

route('POST', '/api/test/claude', async () => {
  const model = getSettings().textAI.claudeModel;
  const st = await claudeCodeStatus({ fresh: true });
  if (!st.loggedIn) throw httpError(400, st.reason);
  const r = await claudeJSON({ system: 'Réponds en JSON {"ok":true}', content: 'test', model, label: 'Test Claude' });
  return { ok: Boolean(r.ok), model };
});
route('POST', '/api/test/openrouter', async () => {
  const r = await (await import('./lib/ai/openrouter.js')).chatJSON({ model: getSettings().models.text, system: 'Réponds en JSON {"ok":true}', content: 'test', maxTokens: 400, label: 'Test' });
  return { ok: Boolean(r.ok), model: getSettings().models.text };
});

route('GET', '/api/voices', async () => ({ providers: await ttsProviders(), tones: Object.keys(TONES) }));

// Échantillon d'écoute d'une voix : généré une seule fois (quelques centimes au plus) puis gardé dans data/voice-previews.
const PREVIEW_TEXT = {
  fr: 'Salut ! Voici ma voix. Reste bien jusqu\'à la fin, tu ne vas pas le regretter.',
  de: 'Hallo! So klingt meine Stimme. Bleib bis zum Ende dran, es lohnt sich.',
  en: 'Hey! This is what I sound like. Stay until the end, you will not regret it.',
  es: '¡Hola! Así suena mi voz. Quédate hasta el final, no te arrepentirás.',
  it: 'Ciao! Questa è la mia voce. Resta fino alla fine, non te ne pentirai.',
  pt: 'Olá! Esta é a minha voz. Fica até ao fim, não te vais arrepender.',
};
const previewJobs = new Map();
route('GET', '/api/voices/preview', async ({ query, req, res }) => {
  const provider = String(query.get('provider') || ''), voice = String(query.get('voice') || '');
  const lang = PREVIEW_TEXT[query.get('lang')] ? query.get('lang') : 'fr';
  const list = await ttsProviders();
  const prov = list.find((x) => x.id === provider);
  if (!prov?.voices.some((v) => v.id === voice)) throw httpError(400, 'Voix inconnue.');
  if (!prov.available) throw httpError(400, prov.reason || 'Fournisseur indisponible.');
  const dir = ensureDir(path.join(DATA_DIR, 'voice-previews'));
  const base = sha(`${provider}|${voice}|${lang}`).slice(0, 16);
  const file = path.join(dir, base + '.mp3');
  if (!fs.existsSync(file)) {
    if (!previewJobs.has(base)) {
      previewJobs.set(base, synthesize({ text: PREVIEW_TEXT[lang], provider, voice, language: lang, outDir: dir, baseName: base }).finally(() => previewJobs.delete(base)));
    }
    try { await previewJobs.get(base); } catch (e) { throw httpError(502, 'Échantillon impossible : ' + e.message); }
  }
  serveFile(req, res, file);
  return undefined;
});
route('GET', '/api/history', async ({ query }) => store.readHistory({ projectId: query.get('project') || undefined, limit: 400 }));

route('GET', '/api/scripts', async () => store.listProjects().flatMap((p) => [
  ...(p.reference.script ? [{ projectId: p.id, project: p.name, kind: 'référence', url: p.reference.url, text: p.reference.validatedText || p.reference.script, validated: p.reference.validated, at: p.reference.validatedAt || p.updatedAt }] : []),
  ...(p.finalScript.text ? [{ projectId: p.id, project: p.name, kind: 'final', url: p.source.url, text: p.finalScript.validatedText || p.finalScript.text, validated: p.finalScript.validated, at: p.finalScript.validatedAt || p.updatedAt }] : []),
]));

// --- Projets ------------------------------------------------------------------------------------

route('GET', '/api/projects', async () => store.listProjects().map((p) => ({
  id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt, sourceUrl: p.source.url, referenceUrl: p.reference.url,
  thumb: p.steps.source_analyze?.output?.frames?.[0] ? `/files/${p.id}/source/frames/${p.steps.source_analyze.output.frames[0].file}` : (p.source.oembed?.thumbnail || ''),
  job: p.job, pipeline: pipeline.describe(p), publications: (p.publications || []).length,
  sourceShares: sourceStats(p)?.shares ?? null,
})));

route('POST', '/api/projects', async ({ body }) => {
  if (!body.quick) return view(store.createProject({ name: String(body.name || '').slice(0, 120), params: sanitizeParams(body.params || {}) }));
  // Démarrage immédiat : réglages du dernier projet modifié (ou valeurs par défaut) et nom provisoire.
  const last = store.listProjects().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const when = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return view(store.createProject({ name: 'Nouvelle vidéo du ' + when, params: last ? sanitizeParams(last.params) : {}, autoName: true }));
});
route('GET', '/api/projects/:id', async ({ id }) => view(project(id)));
route('PATCH', '/api/projects/:id', async ({ id, body }) => view(store.update(id, (p) => {
  if (body.name != null) { p.name = String(body.name).slice(0, 120); p.autoName = false; }
  if (body.params) p.params = { ...p.params, ...sanitizeParams(body.params) };
})));
route('DELETE', '/api/projects/:id', async ({ id }) => { requireIdle(id); store.deleteProject(id); return { ok: true }; });

function sanitizeParams(x) {
  const out = {};
  if (x.durationTarget != null) out.durationTarget = Math.min(180, Math.max(5, Number(x.durationTarget) || 61));
  if (x.language) out.language = String(x.language).slice(0, 5);
  if (x.tone) out.tone = String(x.tone).slice(0, 30);
  if (x.audience != null) out.audience = String(x.audience).slice(0, 200);
  if (x.autoMode != null) out.autoMode = Boolean(x.autoMode);
  if (x.scriptMode) out.scriptMode = x.scriptMode === 'inspire' ? 'inspire' : 'adapt';
  return out;
}

// Reprendre / relancer / réessayer.
route('POST', '/api/projects/:id/run', async ({ id, body }) => { project(id); requireIdle(id); launch(id, body.target, { force: body.force || [] }); return view(project(id)); });
route('POST', '/api/projects/:id/resume', async ({ id }) => {
  const p = project(id); requireIdle(id);
  const target = p.job?.target && pipeline.STEPS[p.job.target] ? p.job.target : null;
  if (!target) throw httpError(400, 'Aucun traitement à reprendre.');
  launch(id, target);
  return view(project(id));
});

// --- Page 1 : vidéo à modifier ------------------------------------------------------------------

route('POST', '/api/projects/:id/source/url', async ({ id, body }) => {
  requireIdle(id);
  const url = validateTikTokUrl(body.url);
  if (!body.rightsConfirmed) throw httpError(400, 'Confirmez disposer des droits d\'utilisation de cette vidéo.');
  store.update(id, (p) => { p.source = { ...p.source, url, urls: null, hook: 0, clips: null, origin: 'tiktok', rightsConfirmed: true, oembed: null }; pipeline.clearStep(p, 'source_fetch'); });
  launch(id, 'source_analyze');
  return view(project(id));
});

// Plusieurs vidéos du même thème mélangées en une seule ; la première sert d'accroche jusqu'à ce qu'une autre soit choisie.
route('POST', '/api/projects/:id/source/urls', async ({ id, body }) => {
  requireIdle(id);
  const urls = [...new Set((Array.isArray(body.urls) ? body.urls : []).map((u) => String(u || '').trim()).filter(Boolean))].map((u) => validateTikTokUrl(u));
  if (!urls.length) throw httpError(400, 'Collez au moins un lien TikTok.');
  if (urls.length > 6) throw httpError(400, '6 vidéos au maximum.');
  if (!body.rightsConfirmed) throw httpError(400, 'Confirmez disposer des droits d\'utilisation de ces vidéos.');
  store.update(id, (p) => {
    p.source = { ...p.source, url: urls[0], urls: urls.length > 1 ? urls : null, hook: 0, clips: null, origin: 'tiktok', rightsConfirmed: true, oembed: null };
    pipeline.clearStep(p, 'source_fetch');
  });
  launch(id, 'source_analyze');
  return view(project(id));
});
route('POST', '/api/projects/:id/source/hook', async ({ id, body }) => {
  requireIdle(id);
  const p0 = project(id);
  const i = Number(body.index);
  if (!p0.source.urls || !(i >= 0 && i < p0.source.urls.length)) throw httpError(400, 'Vidéo introuvable.');
  store.update(id, (p) => { p.source = { ...p.source, hook: i, url: p.source.urls[i] }; });
  launch(id, 'source_analyze');
  return view(project(id));
});

// --- Détecteur de copies : autres comptes qui ont réimporté la vidéo à modifier -------------------------------

// Métadonnées brutes de yt-dlp (son utilisé, hashtags) : lues une fois par projet.
const infoCache = new Map();
function sourceInfo(p) {
  const file = store.projectPath(p.id, 'source/download/download.info.json');
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = infoCache.get(p.id);
  if (hit?.mtime === st.mtimeMs) return hit.info;
  let info = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    info = { uploader: j.uploader || '', description: j.description || '', track: j.track || '', soundAuthor: (j.artists || [j.artist]).filter(Boolean).join(', '), uploadDate: j.upload_date || '' };
  } catch { /* fichier illisible */ }
  infoCache.set(p.id, { mtime: st.mtimeMs, info });
  return info;
}

route('POST', '/api/projects/:id/copies/scan', async ({ id, body }) => {
  const p = project(id);
  if (pipeline.stepState(p, 'source_fetch') !== 'done' || !p.source.file) throw httpError(400, 'Récupérez d\'abord la vidéo à modifier.');
  const links = [...new Set((String(body.urls || '').match(/https?:\/\/[^\s"'<>]*tiktok\.com\/[^\s"'<>]+/gi) || []).map((u) => u.replace(/[),.;]+$/, '')))];
  const accounts = String(body.accounts || '').split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean).slice(0, 5);
  if (!links.length && !accounts.length) throw httpError(400, 'Collez au moins un lien de vidéo TikTok ou un pseudo de compte à analyser.');
  const limit = Math.min(50, Math.max(5, Number(body.limit) || 20));
  pipeline.action(id, 'copies', async () => {
    const urls = [...links];
    for (const a of accounts) urls.push(...await copies.listAccount(a, limit));
    // La vidéo d'origine elle-même (présente dans la liste de son compte) n'est pas une copie.
    const srcVid = copies.videoId(p.source.url);
    const todo = [...new Set(urls)].filter((u) => !srcVid || copies.videoId(u) !== srcVid).slice(0, 150);
    const setProgress = (done, current = '') => store.update(id, (q) => { q.copies = { ...(q.copies || {}), progress: { done, total: todo.length, current } }; });
    setProgress(0, todo[0] || '');
    let done = 0;
    await copies.scanCandidates({
      sourceFile: store.projectPath(id, p.source.file), sourceId: copies.videoId(p.source.url), urls: todo, workDir: store.projectPath(id, 'copies-tmp'),
      onResult: (r) => {
        done++;
        store.update(id, (q) => {
          const list = (q.copies?.results || []).filter((x) => (r.id ? x.id !== r.id : x.url !== r.url));
          q.copies = { ...(q.copies || {}), results: [...list, r], progress: { done, total: todo.length, current: todo[done] || '' } };
        });
      },
    });
    store.update(id, (q) => { q.copies = { ...(q.copies || {}), progress: null, scannedAt: new Date().toISOString() }; });
  }).catch((e) => store.update(id, (q) => { q.copies = { ...(q.copies || {}), progress: null, error: e.message }; }));
  return view(store.update(id, (q) => { q.copies = { ...(q.copies || {}), error: '', progress: { done: 0, total: links.length, current: 'préparation…' } }; }));
});
route('DELETE', '/api/projects/:id/copies', async ({ id, query }) => view(store.update(id, (q) => {
  const key = query.get('id') || query.get('url');
  q.copies = { ...(q.copies || {}), results: key ? (q.copies?.results || []).filter((x) => x.id !== key && x.url !== key) : [] };
})));

// Actualise le nombre de partages et republications de la vidéo à modifier (sans la retélécharger).
route('POST', '/api/projects/:id/source/stats', async ({ id }) => {
  const p = project(id);
  if (p.source.origin !== 'tiktok' || !p.source.url) throw httpError(400, 'Statistiques disponibles seulement pour une vidéo récupérée depuis un lien TikTok.');
  let stats;
  try { stats = await fetchTikTokStats(p.source.url); } catch (e) { throw httpError(502, e.message); }
  return view(store.update(id, (q) => {
    // Premier relevé d'un ancien projet : on garde celui de la récupération pour mesurer l'évolution.
    const first = q.steps.source_fetch?.output?.info?.stats;
    if (!q.source.statsHistory?.length && first) q.source.statsHistory = [{ ...first, at: first.at || q.steps.source_fetch.finishedAt }];
    pipeline.recordSourceStats(q, stats);
  }));
});

route('PUT', '/api/projects/:id/source/upload', async ({ id, req }) => {
  requireIdle(id); project(id);
  const { name, ext } = uploadName(req, VIDEO_EXT);
  if (req.headers['x-rights-confirmed'] !== '1') throw httpError(400, 'Confirmez disposer des droits d\'utilisation de cette vidéo.');
  for (const e of VIDEO_EXT) try { fs.rmSync(store.projectPath(id, 'source/source' + e), { force: true }); } catch { /* fichier ouvert : receiveFile choisira un autre nom */ }
  const rel = await receiveFile(req, id, 'source/source', ext);
  store.update(id, (p) => {
    p.source = { ...p.source, origin: 'upload', file: rel, originalName: name, rightsConfirmed: true, urls: null, hook: 0, clips: null };
    if (p.autoName) { p.name = path.basename(name, path.extname(name)).slice(0, 80) || p.name; p.autoName = false; }
    const st = fs.statSync(store.projectPath(id, rel));
    pipeline.markDone(p, 'source_fetch', { file: rel, origin: 'upload', hash: sha(rel + st.size + st.mtimeMs) });
  });
  launch(id, 'source_analyze');
  return view(project(id));
});

// --- Page 2 : extraction du script de référence --------------------------------------------------

route('POST', '/api/oembed', async ({ body }) => ({ oembed: await fetchOEmbed(validateTikTokUrl(body.url)) }));

route('POST', '/api/projects/:id/reference/url', async ({ id, body }) => {
  requireIdle(id);
  const url = validateTikTokUrl(body.url);
  store.update(id, (p) => {
    if (p.source.url && p.source.url === url) p.reference.sameAsSource = true; else p.reference.sameAsSource = false;
    p.reference = { ...p.reference, url, origin: 'tiktok', oembed: null };
    pipeline.clearStep(p, 'reference_fetch');
  });
  launch(id, 'reference_extract', { force: ['reference_extract'] });
  return view(project(id));
});

route('PUT', '/api/projects/:id/reference/upload', async ({ id, req }) => {
  requireIdle(id); project(id);
  const { name, ext } = uploadName(req, [...VIDEO_EXT, ...AUDIO_EXT]);
  const rel = await receiveFile(req, id, 'reference/reference-upload', ext);
  store.update(id, (p) => {
    p.reference = { ...p.reference, origin: 'upload', file: rel, originalName: name };
    const st = fs.statSync(store.projectPath(id, rel));
    pipeline.markDone(p, 'reference_fetch', { file: rel, origin: 'upload', subtitles: [], hash: sha(rel + st.size + st.mtimeMs) });
  });
  launch(id, 'reference_extract', { force: ['reference_extract'] });
  return view(project(id));
});

// Méthode 4 : texte collé par l'utilisateur.
route('POST', '/api/projects/:id/reference/text', async ({ id, body }) => {
  requireIdle(id);
  const text = String(body.text || '').trim();
  if (text.length < 10) throw httpError(400, 'Collez un script d\'au moins quelques mots.');
  store.update(id, (p) => { p.reference = { ...p.reference, origin: 'text', pastedText: text }; });
  launch(id, 'reference_extract', { force: ['reference_extract'] });
  return view(project(id));
});

route('PUT', '/api/projects/:id/reference/script', async ({ id, body }) => view(store.update(id, (p) => {
  const text = String(body.text ?? '');
  if (text !== p.reference.script) {
    p.reference.script = text;
    p.reference.scriptEdited = true;
    if (p.reference.validated && text !== p.reference.validatedText) { p.reference.validated = false; pipeline.clearStep(p, 'reference_script'); }
  }
})));

route('PUT', '/api/projects/:id/reference/stats', async ({ id, body }) => view(store.update(id, (p) => {
  const n = (v) => (v === '' || v == null ? null : Number(v));
  p.reference.stats = { views: n(body.views), likes: n(body.likes), comments: n(body.comments), shares: n(body.shares), source: 'saisie utilisateur' };
  p.reference.statsManual = true;
})));

route('POST', '/api/projects/:id/reference/validate', async ({ id, body }) => {
  requireIdle(id);
  const p0 = project(id);
  if (pipeline.stepState(p0, 'reference_extract') !== 'done') throw httpError(400, 'Extrayez ou collez d\'abord un script de référence.');
  const text = String(body.text ?? p0.reference.script).trim();
  if (text.length < 10) throw httpError(400, 'Le script de référence est vide.');
  store.update(id, (p) => {
    p.reference.script = text;
    p.reference.validated = true;
    p.reference.validatedText = text;
    p.reference.validatedAt = new Date().toISOString();
    pipeline.markManual(p, 'reference_script', text);
  });
  store.logEvent(id, 'reference_script', 'validated');
  // Transmission automatique à l'analyse narrative.
  launch(id, 'narrative_agent');
  return view(project(id));
});

// --- Page 4 : nouveau script ----------------------------------------------------------------------

route('POST', '/api/projects/:id/script/generate', async ({ id, body }) => {
  requireIdle(id);
  store.update(id, (p) => { if (body.params) p.params = { ...p.params, ...sanitizeParams(body.params) }; if (body.regenerate) p.scriptNonce = (p.scriptNonce || 0) + 1; });
  launch(id, 'script_agent', { force: body.regenerate ? ['script_agent'] : [] });
  return view(project(id));
});

route('PUT', '/api/projects/:id/script', async ({ id, body }) => view(store.update(id, (p) => {
  const text = String(body.text ?? '');
  if (text === p.finalScript.text) return;
  pipeline.setFinalScript(p, pipeline.segmentsFromText(p, text), 'user');
})));

const textAIReady = () => getSettings().textAI.provider === 'claude-code' || aiAvailable();

// Transformation du script par l'IA (raccourcir, développer, changer le ton, ajuster à la durée cible), en arrière-plan.
// custom : consigne libre de l'utilisateur (« Traduis en allemand », « Raccourcis le script »…).
function startTransform(id, action, tone, custom = '') {
  const p = project(id);
  if (!p.finalScript.text) throw httpError(400, 'Générez d\'abord un script.');
  const instructions = {
    shorten: 'Raccourcis le script d\'environ 25 % en gardant l\'accroche, la progression et la chute.',
    expand: 'Développe le script d\'environ 25 % avec des détails visibles à l\'image, sans rien inventer.',
    tone: `Réécris le script avec un ton ${String(tone || 'dynamique')}, mêmes faits, même structure.`,
    fit: (() => { const sp = pipeline.scriptParams(p); const words = Math.round(sp.durationTarget * sp.wps);
      return `Ajuste la longueur du script à environ ${words} mots (≈ ${sp.durationTarget} s de voix off), en développant avec des détails visibles à l'image ou en resserrant, sans rien inventer ni changer la structure.`; })(),
  };
  const instruction = action === 'custom' ? String(custom || '').trim().slice(0, 2000) : instructions[action];
  if (!instruction) throw httpError(400, action === 'custom' ? 'Écrivez une consigne pour l\'IA.' : 'Action inconnue');
  if (!textAIReady()) throw httpError(400, 'Aucune IA configurée : ajoutez une clé OpenRouter ou activez votre abonnement Claude dans Paramètres.');
  const params = { ...pipeline.scriptParams(p), ...(action === 'tone' ? { tone } : {}) };
  pipeline.action(id, 'script_transform', async () => {
    const cur = store.getProject(id);
    const r = await agents.transformScript({ segments: cur.finalScript.segments, visual: cur.steps.visual_agent?.output, params, instruction, referenceScript: cur.reference.validatedText });
    const segs = (r.segments || []).map((s) => ({ text: String(s.text || '').trim(), scene_index: Number.isInteger(s.scene_index) ? s.scene_index : null, intent: s.intent || '' })).filter((s) => s.text);
    if (!segs.length) throw new Error('La transformation n\'a renvoyé aucun texte.');
    store.update(id, (q) => {
      if (action === 'tone') q.params.tone = tone;
      pipeline.setFinalScript(q, segs, action);
      // Derniers prompts de l'utilisateur, proposés à nouveau en un clic.
      if (action === 'custom') q.scriptPrompts = [...(q.scriptPrompts || []).filter((x) => x !== instruction), instruction].slice(-10);
    });
  }).catch(() => {});
}

route('POST', '/api/projects/:id/script/transform', async ({ id, body }) => {
  startTransform(id, body.action, body.tone, body.instruction);
  return view(project(id));
});

// --- Accroche : choisir une autre proposition (ou une accroche écrite à la main) -----------------------------

route('POST', '/api/projects/:id/hook/use', async ({ id, body }) => {
  requireIdle(id);
  const p = project(id);
  const hooks = p.steps.script_agent?.output?.hooks || [];
  const h = body.index != null ? hooks[Number(body.index)] : { spoken: String(body.spoken || '').trim(), screen: String(body.screen || '').trim() };
  if (!h?.spoken) throw httpError(400, 'Accroche introuvable.');
  if (!p.finalScript.segments?.length) throw httpError(400, 'Générez d\'abord un script.');
  return view(store.update(id, (q) => {
    const segs = q.finalScript.segments.map((s) => ({ ...s }));
    segs[0].text = viral.replaceOpening(segs[0].text, h.spoken);
    pipeline.setFinalScript(q, segs, 'hook');
    q.hook = { spoken: h.spoken, screen: h.screen || q.hook?.screen || '' };
  }));
});

// --- Score de viralité ----------------------------------------------------------------------------------------

route('POST', '/api/projects/:id/virality/analyze', async ({ id }) => {
  const p = project(id);
  if (!p.finalScript.text) throw httpError(400, 'Générez d\'abord un script.');
  if (!textAIReady()) throw httpError(400, 'Aucune IA configurée : ajoutez une clé OpenRouter ou activez votre abonnement Claude dans Paramètres.');
  pipeline.action(id, 'virality', async () => {
    const cur = store.getProject(id);
    const m = pipeline.montageParams(cur);
    const render = cur.steps.export?.output || cur.steps.montage?.output;
    const facts = {
      langue: cur.params.language, public: cur.params.audience, duree_cible_s: cur.params.durationTarget,
      duree_video_finale_s: render?.duration ?? null, duree_voix_off_s: cur.steps.voice?.output?.duration ?? null,
      script: cur.finalScript.validatedText || cur.finalScript.text, accroche_orale: cur.hook?.spoken || cur.finalScript.text.split(/(?<=[.!?…])\s/)[0],
      notes_des_accroches: (cur.steps.script_agent?.output?.hooks || []).map((h) => ({ accroche: h.spoken, total_sur_40: h.total })),
      titre_a_l_ecran: m.hookTitle.enabled ? (m.hookTitle.text || cur.hook?.screen || '(vide)') : '(désactivé)',
      montage: { zooms_punch_in: m.punchIn.enabled, sous_titres: m.subtitles.enabled, mot_surligne: m.subtitles.highlight, mots_par_ligne: m.subtitles.maxWords, musique: Boolean(m.musicFile) },
      alertes_montage: (render?.warnings || []).map((w) => w.message),
      // Risque « contenu non original » : une vidéo non éligible au fil « Pour toi » ne fait presque aucune vue.
      originalite: (({ score, level, checks }) => ({ score_sur_100: score, risque_non_original: level, problemes: checks.filter((c) => c.status !== 'ok').map((c) => c.detail) }))(originalityReport(cur, m)),
      publication: { titre: cur.publishDraft.caption, description: cur.publishDraft.description, hashtags: cur.publishDraft.hashtags, appel_a_l_action: cur.publishDraft.cta },
      script_viral_de_reference: cur.steps.narrative_agent?.output?.summary || '',
    };
    const result = await viral.viralityAgent({ project: cur, facts });
    store.update(id, (q) => { q.virality = { ...result, at: new Date().toISOString() }; });
  }).catch(() => {});
  return view(project(id));
});

route('POST', '/api/projects/:id/virality/apply', async ({ id, body }) => {
  requireIdle(id);
  const p = project(id);
  const fix = p.virality?.fixes?.[Number(body.index)];
  if (!fix) throw httpError(400, 'Correction introuvable.');
  if (fix.action === 'fit_duration') {
    startTransform(id, 'fit');
    return view(store.update(id, (q) => { q.virality.fixes[Number(body.index)].applied = true; }));
  }
  return view(store.update(id, (q) => {
    const m = pipeline.montageParams(q);
    const v = fix.value;
    const tags = (x) => (Array.isArray(x) ? x : String(x || '').split(/[\s,]+/)).map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 30);
    switch (fix.action) {
      case 'use_hook': {
        const segs = q.finalScript.segments.map((s) => ({ ...s }));
        segs[0].text = viral.replaceOpening(segs[0].text, String(v));
        pipeline.setFinalScript(q, segs, 'hook');
        q.hook = { ...(q.hook || {}), spoken: String(v) };
        break;
      }
      case 'set_screen_title': q.montageParams = mergeMontage({ ...m, hookTitle: { ...m.hookTitle, enabled: true, text: String(v) } }); break;
      case 'enable_hook_title': q.montageParams = mergeMontage({ ...m, hookTitle: { ...m.hookTitle, enabled: true } }); break;
      case 'enable_punch_in': q.montageParams = mergeMontage({ ...m, punchIn: { ...m.punchIn, enabled: true } }); break;
      case 'enable_highlight': q.montageParams = mergeMontage({ ...m, subtitles: { ...m.subtitles, highlight: true } }); break;
      case 'set_caption': q.publishDraft = { ...q.publishDraft, caption: String(v).slice(0, 150), edited: true }; break;
      case 'set_description': q.publishDraft = { ...q.publishDraft, description: String(v).slice(0, 2200), edited: true }; break;
      case 'set_cta': q.publishDraft = { ...q.publishDraft, cta: String(v).slice(0, 300), edited: true }; break;
      case 'set_hashtags': q.publishDraft = { ...q.publishDraft, hashtags: tags(v), edited: true }; break;
      default: throw httpError(400, 'Action inconnue.');
    }
    q.virality.fixes[Number(body.index)].applied = true;
  }));
});

route('POST', '/api/projects/:id/script/validate', async ({ id, body }) => {
  requireIdle(id);
  const p0 = project(id);
  const text = String(body.text ?? p0.finalScript.text).trim();
  if (!text) throw httpError(400, 'Le script est vide.');
  store.update(id, (p) => {
    if (text !== p.finalScript.text) pipeline.setFinalScript(p, pipeline.segmentsFromText(p, text), 'user');
    p.finalScript.validated = true;
    p.finalScript.validatedText = text;
    p.finalScript.validatedAt = new Date().toISOString();
    pipeline.markManual(p, 'final_script', text);
  });
  store.logEvent(id, 'final_script', 'validated');
  // En mode automatique, la suite (voix, montage, export) s'enchaîne sans intervention.
  if (project(id).params.autoMode) launch(id, 'export');
  return view(project(id));
});

// --- Page 5 : voix off -------------------------------------------------------------------------------

route('PUT', '/api/projects/:id/voice/params', async ({ id, body }) => view(store.update(id, (p) => {
  p.voiceParams = { provider: String(body.provider || ''), voice: String(body.voice || ''), gender: body.gender || 'F', tone: String(body.tone || p.params.tone),
    speed: Math.min(1.5, Math.max(0.6, Number(body.speed) || 1)), language: String(body.language || p.params.language) };
})));
route('POST', '/api/projects/:id/voice/generate', async ({ id, body }) => {
  requireIdle(id);
  const p = project(id);
  if (pipeline.stepState(p, 'final_script') !== 'done') throw httpError(400, 'Validez d\'abord le script final (page « Générer mon nouveau script »).');
  launch(id, 'voice', { force: body.regenerate ? ['voice'] : [] });
  return view(project(id));
});

// --- Page 6 : montage ----------------------------------------------------------------------------------

route('GET', '/api/montage/defaults', async () => DEFAULT_MONTAGE);
route('PUT', '/api/projects/:id/montage/params', async ({ id, body }) => view(store.update(id, (p) => {
  const cur = pipeline.montageParams(p);
  const nested = (k) => ({ ...(cur[k] || {}), ...(body[k] || {}) });
  p.montageParams = mergeMontage({ ...cur, ...body, subtitles: nested('subtitles'), hookTitle: nested('hookTitle'), punchIn: nested('punchIn'), reaction: { ...nested('reaction'), file: body.reaction?.file === '' ? '' : cur.reaction?.file || '' }, credit: nested('credit'), mask: nested('mask') });
})));
route('PUT', '/api/projects/:id/montage/music', async ({ id, req }) => {
  project(id);
  const { ext } = uploadName(req, AUDIO_EXT);
  const rel = await receiveFile(req, id, 'montage/music', ext);
  return view(store.update(id, (p) => { p.montageParams = { ...pipeline.montageParams(p), musicFile: rel }; }));
});
// Mode réaction : votre propre vidéo (visage, commentaire) qui partage l'écran avec l'originale.
route('PUT', '/api/projects/:id/montage/reaction', async ({ id, req }) => {
  project(id);
  const { ext } = uploadName(req, VIDEO_EXT);
  const rel = await receiveFile(req, id, 'montage/reaction', ext);
  const meta = await probe(store.projectPath(id, rel)).catch(() => null);
  if (!meta?.hasVideo) throw httpError(400, "Ce fichier ne contient pas d'image : importez une vidéo de vous.");
  // v : change à chaque import pour que le montage soit refait même si le nom de fichier est identique.
  return view(store.update(id, (p) => {
    const m = pipeline.montageParams(p);
    p.montageParams = mergeMontage({ ...m, reaction: { ...m.reaction, enabled: true, file: rel, v: Date.now(), duration: meta.duration, hasAudio: meta.hasAudio } });
  }));
});

route('POST', '/api/projects/:id/montage/render', async ({ id }) => {
  requireIdle(id);
  if (pipeline.stepState(project(id), 'voice') !== 'done') throw httpError(400, 'Générez d\'abord la voix off.');
  launch(id, 'montage', { force: ['montage'] });
  return view(project(id));
});
route('POST', '/api/projects/:id/montage/validate', async ({ id }) => {
  const p0 = project(id);
  if (pipeline.stepState(p0, 'montage') !== 'done') throw httpError(400, 'Le montage n\'est pas à jour : relancez-le avant de valider.');
  return view(store.update(id, (p) => { pipeline.markManual(p, 'montage_ok', p.steps.montage.outputHash); }));
});

// --- Assistant en 5 étapes -------------------------------------------------------------------------------

// Étape 4 : script adapté du script d'inspiration récupéré (sa validation est implicite).
route('POST', '/api/projects/:id/wizard/script', async ({ id }) => {
  requireIdle(id);
  const p = project(id);
  if (pipeline.stepState(p, 'reference_extract') !== 'done') throw httpError(400, "Récupérez d'abord le script d'une vidéo d'inspiration, ou écrivez directement le vôtre.");
  if (!textAIReady()) throw httpError(400, 'Aucune IA configurée : ajoutez une clé OpenRouter ou activez votre abonnement Claude dans Paramètres.');
  store.update(id, (q) => { q.scriptNonce = (q.scriptNonce || 0) + 1; });
  launch(id, 'script_agent', { auto: true, force: ['script_agent'] });
  return view(project(id));
});

// Étape 5 : le script affiché est validé, puis voix off, montage et export s'enchaînent sans autre validation.
route('POST', '/api/projects/:id/wizard/generate', async ({ id, body }) => {
  requireIdle(id);
  const p0 = project(id);
  if (pipeline.stepState(p0, 'source_analyze') !== 'done') throw httpError(400, "Ajoutez d'abord la vidéo à modifier (étape 1).");
  const text = String(body.text ?? p0.finalScript.text).trim();
  if (text.split(/\s+/).length < 5) throw httpError(400, 'Le script est vide : récupérez-en un ou écrivez le vôtre (étape 4).');
  store.update(id, (p) => {
    if (text !== p.finalScript.text) pipeline.setFinalScript(p, pipeline.segmentsFromText(p, text), 'user');
    p.finalScript.validated = true;
    p.finalScript.validatedText = text;
    p.finalScript.validatedAt = new Date().toISOString();
    pipeline.markManual(p, 'final_script', text);
  });
  launch(id, 'export', { auto: true });
  return view(project(id));
});

// --- Page 7 : export -------------------------------------------------------------------------------------

route('POST', '/api/projects/:id/export', async ({ id, body }) => {
  requireIdle(id);
  store.update(id, (p) => {
    p.exportParams = { quality: ['max', 'high', 'medium', 'light'].includes(body.quality) ? body.quality : 'high',
      fps: ['source', '24', '25', '30', '60'].includes(String(body.fps)) ? String(body.fps) : 'source',
      resolution: ['1080x1920', '720x1280'].includes(body.resolution) ? body.resolution : '1080x1920' };
  });
  if (pipeline.stepState(project(id), 'montage_ok') !== 'done') throw httpError(400, 'Validez d\'abord le montage.');
  launch(id, 'export');
  return view(project(id));
});

// --- Page 8 : publication ----------------------------------------------------------------------------------

route('POST', '/api/projects/:id/caption/generate', async ({ id }) => {
  requireIdle(id);
  store.update(id, (p) => { p.captionNonce = (p.captionNonce || 0) + 1; p.publishDraft.edited = false; });
  launch(id, 'caption', { force: ['caption'] });
  return view(project(id));
});
route('PUT', '/api/projects/:id/publish/draft', async ({ id, body }) => view(store.update(id, (p) => {
  p.publishDraft = { caption: String(body.caption || '').slice(0, 2200), description: String(body.description || '').slice(0, 2200),
    hashtags: (Array.isArray(body.hashtags) ? body.hashtags : String(body.hashtags || '').split(/[\s,]+/)).map((h) => String(h).replace(/^#/, '')).filter(Boolean).slice(0, 30),
    cta: String(body.cta || '').slice(0, 300), edited: true };
})));

// Le champ « caption » du brouillon est le titre ; la description publiée regroupe texte, appel à l'action et hashtags.
function publicationDescription(d) {
  return [d.description, d.cta, d.hashtags.map((h) => '#' + h).join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
}

// --- Registre des publications : l'utilisateur publie lui-même et note chaque mise en ligne -----------------

route('POST', '/api/projects/:id/publications', async ({ id, body }) => {
  const p = project(id);
  const url = String(body.url || '').trim().slice(0, 500);
  if (url && !/^https?:\/\/([\w-]+\.)*tiktok\.com\//i.test(url)) throw httpError(400, 'Le lien doit être une adresse tiktok.com.');
  if (url && (p.publications || []).some((x) => x.url === url)) throw httpError(400, 'Cette publication est déjà enregistrée.');
  const at = body.at && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : new Date().toISOString();
  const exp = p.steps.export?.output;
  return view(store.update(id, (q) => {
    q.publications = [...(q.publications || []), {
      id: newId('pub'), at, url, account: String(body.account || '').trim().replace(/^@/, '').slice(0, 60),
      note: String(body.note || '').trim().slice(0, 300), title: q.publishDraft.caption,
      // Version exportée au moment de la publication, pour distinguer un repost de la même vidéo d'une nouvelle version.
      exportFile: exp?.file || '', exportedAt: q.steps.export?.finishedAt || '',
    }].sort((a, b) => a.at.localeCompare(b.at));
  }));
});
// Diagnostic d'originalité : ajoute le crédit au créateur d'origine à la fin de la description.
route('POST', '/api/projects/:id/originality/credit', async ({ id }) => {
  const handle = sourceHandle(project(id));
  if (!handle) throw httpError(400, 'Créateur d\'origine inconnu : la vidéo n\'a pas été récupérée depuis un lien TikTok.');
  return view(store.update(id, (q) => {
    const d = q.publishDraft.description || '';
    if (!d.toLowerCase().includes('@' + handle.toLowerCase())) q.publishDraft = { ...q.publishDraft, description: `${d}${d ? '\n\n' : ''}Vidéo originale : @${handle}`.slice(0, 2200), edited: true };
  }));
});

route('DELETE', '/api/projects/:id/publications/:pub', async ({ id, pub }) => view(store.update(id, (q) => {
  q.publications = (q.publications || []).filter((x) => x.id !== pub);
})));

route('GET', '/api/projects/:id/publish/package', async ({ id, res }) => {
  const p = project(id);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="publication-${p.id}.txt"` });
  res.end(`TITRE\n${p.publishDraft.caption}\n\nDESCRIPTION\n${publicationDescription(p.publishDraft)}\n`);
  return undefined;
});

// --- Fichiers du projet (avec support des plages pour la lecture vidéo) --------------------------

function serveFile(req, res, file, { download } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'Fichier introuvable' }); }
  if (!st.isFile()) return send(res, 404, { error: 'Fichier introuvable' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(file).pipe(res);
}

// --- Serveur -----------------------------------------------------------------------------------------

// Seule l'interface de l'app, ouverte sur cet ordinateur, peut piloter le serveur : un autre site ouvert dans le navigateur
// (requête d'une autre origine) ou un nom de domaine redirigé vers 127.0.0.1 (DNS rebinding) est refusé.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function trustedRequest(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { const o = new URL(origin); return LOCAL_HOSTS.has(o.hostname.toLowerCase()) && Number(o.port || 80) === PORT; } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  if (!trustedRequest(req)) return send(res, 403, { error: 'Accès refusé : ouvrez l\'app depuis http://localhost:' + PORT });
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const isUpload = req.method === 'PUT' && /\/(upload|music|reaction)$/.test(pathname);
        const body = !isUpload && ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
        const out = await r.handler({ ...params, body, query: url.searchParams, req, res });
        if (out !== undefined) send(res, 200, out);
        return;
      }
      return send(res, 404, { error: 'Route inconnue' });
    }
    if (pathname.startsWith('/files/')) {
      const [, , id, ...rest] = pathname.split('/');
      if (!store.getProject(id)) return send(res, 404, { error: 'Projet introuvable' });
      return serveFile(req, res, store.projectPath(id, rest.join('/')), { download: url.searchParams.has('download') });
    }
    const file = path.resolve(PUBLIC, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Interdit' });
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file);
    return serveFile(req, res, path.join(PUBLIC, 'index.html'));
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    if (!e.status) console.error(e);
  }
});

pipeline.recoverInterrupted();
await detectTools();
server.listen(PORT, HOST, () => console.log(`TikTok Repost Studio v${VERSION} → http://localhost:${PORT}`));
