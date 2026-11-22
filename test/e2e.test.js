// Test de bout en bout via l'API HTTP : vrai FFmpeg, vraie voix Windows (hors ligne),
// et un faux serveur OpenRouter qui renvoie des réponses JSON déterministes pour les agents.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'source-16x9.mp4');
const DATA = process.env.TRS_TEST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'trs-e2e-'));
const PORT = 4391;
const MOCK_PORT = 4392;
const BASE = `http://127.0.0.1:${PORT}`;
const aiCalls = [];
let server;
let mock;

// --- Faux OpenRouter --------------------------------------------------------------------------
function mockAnswer(system, user) {
  if (system.includes('transcripteur')) return { has_speech: true, language: 'fr', language_confidence: 'high', segments: [
    { start: 0, end: 2.5, text: 'Personne ne s\'attendait à ce qui allait se passer ici.', uncertain: false },
    { start: 2.5, end: 6, text: 'Au début, tout semble parfaitement normal.', uncertain: false },
    { start: 6, end: 9, text: 'Puis [inaudible] change complètement.', uncertain: true, note: 'mot couvert par la musique' },
    { start: 9, end: 12, text: 'Abonne-toi pour voir la suite.', uncertain: false }] };
  if (system.includes('texte incrusté')) return { items: [{ t: 1, text: 'ATTENDS LA FIN', kind: 'title' }] };
  if (system.includes('Agent A')) return { summary: 'Mire de test, puis fond bleu, puis fractale.', setting: 'écran', subjects: ['motifs'],
    scenes: [{ index: 0, start: 0, end: 4, description: 'Mire colorée animée', actions: ['défilement'] }, { index: 1, start: 4, end: 8, description: 'Fond bleu uni', actions: [] }, { index: 2, start: 8, end: 12, description: 'Fractale de Mandelbrot', actions: ['zoom'] }],
    key_moments: [{ t: 8, description: 'apparition de la fractale' }], visible_facts: ['une mire de couleurs', 'un fond bleu', 'une fractale'], uncertain: [], narration_opportunities: ['révélation à 8 s'] };
  if (system.includes('Agent B')) return { summary: 'Accroche mystère, montée, révélation, CTA.', hook: { excerpt: 'Personne ne s\'attendait', technique: 'promesse de surprise', why_it_may_work: 'crée une attente' },
    structure: [{ part: 'Accroche', description: 'promesse', share_percent: 20 }], progression: 'linéaire', rhythm: { avg_words_per_sentence: 7, pace: 'rapide', notes: '' },
    curiosity_mechanisms: ['retard de la révélation'], transitions: ['puis'], emotions: ['curiosité'], retention_devices: ['attends la fin'], ending: { type: 'CTA', cta: 'abonnement' },
    reusable_patterns: [{ pattern: 'annonce d\'un basculement', how_to_adapt: 'annoncer la fractale' }], distinctive_phrases: ['Personne ne s\'attendait'], evidence_level: 'no_stats', caveat: 'sans statistiques' };
  if (system.includes('Agent C')) {
    if (user.includes('INSTRUCTION')) return { segments: [{ scene_index: 0, text: 'Regarde bien ces couleurs.', intent: 'accroche' }, { scene_index: 2, text: 'Et là, une fractale surgit.', intent: 'révélation' }] };
    return { title: 'La fractale cachée', segments: [
      { scene_index: 0, text: 'Ces couleurs cachent un secret que peu de gens remarquent.', intent: 'accroche' },
      { scene_index: 1, text: 'Pendant quelques secondes, l\'écran devient d\'un bleu parfaitement calme.', intent: 'tension' },
      { scene_index: 2, text: 'Puis une fractale apparaît, infinie, et tout bascule.', intent: 'révélation' }] };
  }
  if (system.includes('Agent D')) return { scores: { coherence: 8, video_fit: 9, fluency: 8, hook: 7 }, issues: [], invented_facts: [], verdict: 'ok', summary: 'Conforme.' };
  if (system.includes('accroches TikTok')) return { current: { screen: 'Un *secret* caché', scores: { curiosity: 6, clarity: 7, emotion: 5, fit: 8 } }, hooks: [
    { spoken: 'Personne ne remarque ce qui se cache dans ces couleurs.', screen: 'Regarde *bien*', technique: 'curiosité', scores: { curiosity: 9, clarity: 8, emotion: 8, fit: 9 } },
    { spoken: 'Ces couleurs ne sont pas là par hasard.', screen: 'Pas un *hasard*', technique: 'affirmation', scores: { curiosity: 7, clarity: 8, emotion: 6, fit: 8 } }] };
  if (system.includes('croissance TikTok')) return { score: 64, criteria: { hook: 8, retention: 6, length: 5, clarity: 7, emotion: 6, packaging: 6, cta: 5 }, summary: 'Bonne accroche, fin trop plate.', strengths: ['accroche visuelle'],
    fixes: [{ problem: 'Titre peu intrigant', fix: 'Poser une question', impact: 'fort', action: 'set_caption', value: 'Tu avais vu la fractale ?' }, { problem: 'Action inconnue', fix: '…', impact: 'faible', action: 'publier_maintenant', value: '' }] };
  if (system.includes('publication TikTok')) return { caption: 'Le secret derrière ces couleurs', description: 'Une mire, un fond bleu, puis une fractale.', hashtags: ['fractale', 'maths', 'satisfying'], cta: 'Tu l\'avais vue venir ?' };
  return { ok: true };
}

function startMock() {
  return new Promise((resolve) => {
    mock = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      if (req.url.endsWith('/key')) { // dépense de la clé, lue pour les limites de dépense
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: { usage: 3, usage_daily: 1, usage_weekly: 2, usage_monthly: 3, limit: null } }));
      }
      if (req.url.endsWith('/credits')) { // solde du compte, affiché dans Paramètres
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: { total_credits: 10, total_usage: 3 } }));
      }
      const j = JSON.parse(body);
      const system = j.messages[0].content;
      const userContent = j.messages[1].content;
      const user = typeof userContent === 'string' ? userContent : userContent.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
      const parts = Array.isArray(userContent) ? userContent.map((x) => x.type) : ['text'];
      aiCalls.push({ system, user, parts });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockAnswer(system, user)) } }] }));
    }).listen(MOCK_PORT, '127.0.0.1', resolve);
  });
}

// --- Application ----------------------------------------------------------------------------------
function startApp() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), TRS_DATA_DIR: DATA, OPENROUTER_API_KEY: 'mock', OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, FAL_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(d));
    server.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) resolve(); });
    server.on('exit', (c) => reject(new Error('serveur arrêté ' + c)));
  });
}
function stopApp() { return new Promise((r) => { server.removeAllListeners('exit'); server.once('exit', r); server.kill(); }); }

async function api(method, url, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const r = await fetch(BASE + url, { method, headers: { ...(isBuf ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body == null ? undefined : isBuf ? body : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
}

async function waitIdle(id, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = await api('GET', `/api/projects/${id}`);
    if (!p.pipeline.running) return p;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('délai dépassé');
}

const state = (p, s) => p.pipeline.steps[s].state;
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());

before(async () => { await startMock(); await startApp(); });
after(async () => { await stopApp(); mock.close(); if (!process.env.TRS_TEST_DATA) fs.rmSync(DATA, { recursive: true, force: true }); });

let id;

test('sécurité : un autre site ou un domaine redirigé ne peut pas piloter l\'app ; version affichée', async () => {
  const { version } = await api('GET', '/api/version');
  assert.equal(version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  const evil = await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://site-malveillant.example' }, body: '{"scriptPrompt":"piraté"}' });
  assert.equal(evil.status, 403, 'requête d\'un autre site refusée');
  // DNS rebinding : un nom de domaine qui pointe vers 127.0.0.1 est refusé (en-tête Host).
  const http = await import('node:http');
  const status = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/settings', headers: { Host: 'attaque.example:' + PORT } }, (r) => { r.resume(); resolve(r.statusCode); }));
  assert.equal(status, 403);
  assert.equal((await fetch(`${BASE}/api/version`, { headers: { Origin: `http://localhost:${PORT}` } })).status, 200, 'l\'interface de l\'app reste autorisée');
});

test('page 1 — import de la vidéo à modifier et analyse des plans', async () => {
  const p = await api('POST', '/api/projects', { name: 'E2E', params: { durationTarget: 12, language: 'fr', tone: 'mystérieux' } });
  id = p.id;
  await assert.rejects(api('PUT', `/api/projects/${id}/source/upload`, fs.readFileSync(FIXTURE), { 'x-filename': 'source.mp4' }), /droits/);
  await api('PUT', `/api/projects/${id}/source/upload`, fs.readFileSync(FIXTURE), { 'x-filename': 'source.mp4', 'x-rights-confirmed': '1' });
  const done = await waitIdle(id);
  assert.equal(state(done, 'source_analyze'), 'done');
  const a = done.steps.source_analyze.output;
  assert.equal(a.meta.width, 1280);
  assert.equal(a.scenes.length, 3, 'trois plans détectés : ' + JSON.stringify(a.scenes));
  assert.ok(a.frames.length >= 3);
});

test('page 1 — lien non TikTok refusé, lien TikTok sans droits refusé', async () => {
  await assert.rejects(api('POST', `/api/projects/${id}/source/url`, { url: 'https://example.com/v.mp4', rightsConfirmed: true }), /tiktok\.com/);
  await assert.rejects(api('POST', `/api/projects/${id}/source/url`, { url: 'https://www.tiktok.com/@a/video/1', rightsConfirmed: false }), /droits/);
});

test('page 2 — extraction du script de référence (audio + OCR), modification et validation', async () => {
  await api('PUT', `/api/projects/${id}/reference/upload`, fs.readFileSync(FIXTURE), { 'x-filename': 'reference.mp4' });
  let p = await waitIdle(id);
  assert.equal(state(p, 'reference_extract'), 'done', p.steps.reference_extract?.error);
  const ex = p.steps.reference_extract.output;
  assert.equal(ex.transcript.source, 'audio');
  assert.equal(ex.transcript.language, 'fr');
  assert.ok(ex.transcript.segments.some((s) => s.uncertain), 'segment incertain signalé');
  assert.ok(ex.ocr.length === 1 && ex.ocr[0].kind === 'title', 'texte incrusté séparé de la parole');
  assert.ok(aiCalls.some((c) => c.parts.includes('input_audio')), 'audio envoyé à la transcription');
  // Le fichier source et la référence restent distincts.
  assert.notEqual(p.source.file, p.reference.file);
  assert.ok(p.reference.script.includes('[inaudible]'));
  const corrected = p.reference.script.replace('[inaudible] change', 'tout change');
  p = await api('PUT', `/api/projects/${id}/reference/script`, { text: corrected });
  assert.equal(p.reference.scriptEdited, true);
  await api('POST', `/api/projects/${id}/reference/validate`, { text: corrected });
  p = await waitIdle(id);
  assert.equal(p.reference.validatedText, corrected);
  assert.equal(state(p, 'narrative_agent'), 'done', 'analyse narrative lancée automatiquement après validation');
  assert.equal(p.steps.narrative_agent.output.evidence_level, 'no_stats');
});

test('page 4 — génération du script (agents A, C, D) puis transformation et validation', async () => {
  await api('POST', `/api/projects/${id}/script/generate`, {});
  let p = await waitIdle(id);
  assert.equal(state(p, 'visual_agent'), 'done');
  assert.equal(state(p, 'script_agent'), 'done', p.steps.script_agent?.error);
  assert.ok(aiCalls.some((c) => c.system.includes('Agent A') && c.parts.includes('image_url')), 'images clés envoyées à l\'agent visuel');
  assert.equal(p.finalScript.segments.length, 3);
  assert.equal(p.steps.script_agent.output.qa.verdict, 'ok');
  // Accroche optimisée : la mieux notée (34/40) remplace la première phrase, avec son titre à l'écran.
  assert.equal(p.steps.script_agent.output.hooks.length, 3);
  assert.ok(p.finalScript.segments[0].text.startsWith('Personne ne remarque ce qui se cache dans ces couleurs.'), p.finalScript.segments[0].text);
  assert.equal(p.hook.screen, 'Regarde *bien*');
  const agentC = () => aiCalls.filter((c) => c.system.includes('Agent C')).at(-1);
  assert.ok(agentC().system.includes('Adaptation') && agentC().user.includes('SCRIPT DE RÉFÉRENCE À ADAPTER'), 'mode par défaut : le script viral est adapté à la vidéo');
  assert.ok(agentC().system.startsWith('Tu es un spécialiste de l\'écriture de scripts TikTok viraux'), 'méthode d\'écriture de l\'utilisateur en tête des consignes');
  assert.ok(/environ \d+ mots/.test(agentC().system), 'longueur calibrée sur le débit de la voix');

  // Mode « s'inspirer » : seule l'analyse narrative est transmise.
  await api('POST', `/api/projects/${id}/script/generate`, { params: { scriptMode: 'inspire' } });
  p = await waitIdle(id);
  assert.ok(agentC().system.includes('Réécriture') && !agentC().user.includes('SCRIPT DE RÉFÉRENCE À ADAPTER'));
  await api('POST', `/api/projects/${id}/script/generate`, { params: { scriptMode: 'adapt' } });
  p = await waitIdle(id);

  await api('POST', `/api/projects/${id}/script/transform`, { action: 'shorten' });
  p = await waitIdle(id);
  assert.equal(p.finalScript.segments.length, 2);
  assert.ok(p.versions.script.length >= 2, 'versions conservées');
  // Consigne libre transmise telle quelle à l'IA ; consigne vide refusée.
  await assert.rejects(api('POST', `/api/projects/${id}/script/transform`, { action: 'custom', instruction: '  ' }), /consigne/);
  await api('POST', `/api/projects/${id}/script/transform`, { action: 'custom', instruction: 'Traduis en allemand' });
  p = await waitIdle(id);
  assert.ok(aiCalls.at(-1).user.includes('INSTRUCTION : Traduis en allemand'));
  assert.ok(aiCalls.at(-1).system.includes('L\'INSTRUCTION est prioritaire'), 'le prompt de l\'utilisateur prime sur la méthode');
  assert.deepEqual(p.scriptPrompts, ['Traduis en allemand'], 'prompt mémorisé pour être réutilisé');
  const long = 'Rends le début plus choquant. '.repeat(40).trim();
  await api('POST', `/api/projects/${id}/script/transform`, { action: 'custom', instruction: long });
  p = await waitIdle(id);
  assert.ok(aiCalls.at(-1).user.includes(long.slice(0, 1000)), 'prompt long transmis (jusqu\'à 2 000 caractères)');
  // Méthode d'écriture personnalisée dans Paramètres, puis retour au texte par défaut.
  await api('PUT', '/api/settings', { scriptPrompt: 'MA MÉTHODE PERSO : phrases très courtes.' });
  await api('POST', `/api/projects/${id}/script/transform`, { action: 'custom', instruction: 'Garde le sens' });
  p = await waitIdle(id);
  assert.ok(aiCalls.at(-1).system.startsWith('MA MÉTHODE PERSO'));
  const s = await api('PUT', '/api/settings', { scriptPrompt: '' });
  assert.equal(s.scriptPrompt, '');
  assert.ok((await api('GET', '/api/settings')).defaultScriptPrompt.includes('STRUCTURE RECHERCHÉE'));

  // Retour à la version longue, modifiée à la main, puis validation.
  const text = p.versions.script[0].text + ' Regarde jusqu\'au bout.';
  await api('POST', `/api/projects/${id}/script/validate`, { text });
  p = await waitIdle(id);
  assert.equal(state(p, 'final_script'), 'done');
  assert.deepEqual(p.finalScript.segments.map((s) => s.scene_index), [0, 1, 2], 'association paragraphe → plan retrouvée après restauration');
});

test('page 5 — voix off générée (voix Windows hors ligne)', { skip: process.platform !== 'win32' }, async () => {
  const voices = await api('GET', '/api/voices');
  const win = voices.providers.find((x) => x.id === 'windows');
  assert.ok(win.available);
  const fr = win.voices.find((v) => v.lang === 'fr') || win.voices[0];
  await api('PUT', `/api/projects/${id}/voice/params`, { provider: 'windows', voice: fr.id, speed: 1.1, tone: 'naturel' });
  await api('POST', `/api/projects/${id}/voice/generate`, {});
  const p = await waitIdle(id);
  assert.equal(state(p, 'voice'), 'done', p.steps.voice?.error);
  const v = p.steps.voice.output;
  assert.ok(v.duration > 3, 'durée réelle ' + v.duration);
  assert.ok(fs.existsSync(path.join(DATA, 'projects', id, v.file)));
});

test('page 6 — montage 9:16 avec arrière-plan flouté, voix et sous-titres', { skip: process.platform !== 'win32' }, async () => {
  await api('PUT', `/api/projects/${id}/montage/params`, { blur: 40, fgScale: 1, originalVolume: 0.1, subtitles: { enabled: true, size: 70 } });
  await api('POST', `/api/projects/${id}/montage/render`, {});
  const p = await waitIdle(id);
  assert.equal(state(p, 'montage'), 'done', p.steps.montage?.error);
  const m = p.steps.montage.output;
  const info = probe(path.join(DATA, 'projects', id, m.file));
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(`${v.width}x${v.height}`, '720x1280');
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  const voiceEnd = 0.3 + p.steps.voice.output.duration;
  assert.ok(Number(info.format.duration) >= voiceEnd - 0.1, 'la narration n\'est jamais coupée');
  assert.ok(m.cues > 0);
  // Bordures floutées : le haut de l'image n'est pas uni (copie floutée de la vidéo, pas des bandes noires).
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', path.join(DATA, 'projects', id, m.file), '-frames:v', '1', '-vf', 'crop=720:200:0:0,scale=36:10', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const vals = [...raw];
  assert.ok(Math.max(...vals) > 20, 'arrière-plan non noir');
});

test('page 7 — export 1080×1920 réel', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(api('POST', `/api/projects/${id}/export`, { quality: 'medium' }), /Validez/);
  await api('POST', `/api/projects/${id}/montage/validate`, {});
  await api('POST', `/api/projects/${id}/export`, { quality: 'medium', fps: 'source', resolution: '1080x1920' });
  const p = await waitIdle(id);
  assert.equal(state(p, 'export'), 'done', p.steps.export?.error);
  const out = path.join(DATA, 'projects', id, p.steps.export.output.file);
  const info = probe(out);
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(`${v.width}x${v.height}`, '1080x1920');
  // Durée exacte (par défaut) : la vidéo finale dure la durée cible du projet (12 s), à une image près.
  assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.1, `durée exportée ${info.format.duration} s pour une cible de 12 s`);
  const r = await fetch(`${BASE}/files/${id}/${p.steps.export.output.file}?download=1`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
});

test('page 8 — légende générée, publication automatique retirée', async () => {
  await api('POST', `/api/projects/${id}/caption/generate`, {});
  const p = await waitIdle(id);
  assert.equal(p.publishDraft.hashtags.length, 3);
  await assert.rejects(api('POST', `/api/projects/${id}/publish`, { privacy: 'SELF_ONLY' }));
});

test('score de viralité : note, corrections filtrées et application en un clic', async () => {
  await api('POST', `/api/projects/${id}/virality/analyze`, {});
  let p = await waitIdle(id);
  assert.equal(p.virality.score, 64);
  assert.equal(p.virality.fixes.length, 1, 'action inconnue écartée');
  p = await api('POST', `/api/projects/${id}/virality/apply`, { index: 0 });
  assert.equal(p.publishDraft.caption, 'Tu avais vu la fractale ?');
  assert.equal(p.virality.fixes[0].applied, true);
});

test('diagnostic d\'originalité : image d\'origine signalée, crédit ajouté en un clic', async () => {
  let p = await api('GET', `/api/projects/${id}`);
  const o = p.originality;
  assert.ok(o.score >= 0 && o.score <= 65, `image d'origine en permanence : jamais « faible risque » (${o.score})`);
  assert.equal(o.checks.find((c) => c.id === 'screen').status, 'bad');
  assert.equal(o.checks.find((c) => c.id === 'audio').status, 'bad', 'son d\'origine conservé à 10 % (page 6)');
  const credit = o.checks.find((c) => c.id === 'credit');
  if (credit) {
    p = await api('POST', `/api/projects/${id}/originality/credit`, {});
    assert.match(p.publishDraft.description, new RegExp(`Vidéo originale : @${o.handle}`));
    assert.equal(p.originality.checks.find((c) => c.id === 'credit').status, 'ok');
  }
});

test('mode réaction : écran partagé puis incrustation, rendu réel et diagnostic', { skip: process.platform !== 'win32' }, async () => {
  let p = await api('PUT', `/api/projects/${id}/montage/reaction`, fs.readFileSync(FIXTURE), { 'x-filename': 'moi.mp4' });
  assert.equal(p.montageParams.reaction.enabled, true);
  assert.equal(p.originality.checks.find((c) => c.id === 'screen').status, 'ok', 'écran partagé : image d\'origine sur la moitié de l\'écran');
  await api('PUT', `/api/projects/${id}/montage/params`, { reaction: { file: '../../secret.mp4' } });
  p = await api('GET', `/api/projects/${id}`);
  assert.match(p.montageParams.reaction.file, /^montage\/reaction/, 'chemin du fichier non modifiable depuis le navigateur');
  for (const layout of ['split', 'pip']) {
    await api('PUT', `/api/projects/${id}/montage/params`, { reaction: { layout, volume: 0.5 } });
    await api('POST', `/api/projects/${id}/montage/render`, {});
    p = await waitIdle(id);
    assert.equal(state(p, 'montage'), 'done', `${layout} : ${p.steps.montage?.error}`);
    const info = probe(path.join(DATA, 'projects', id, p.steps.montage.output.file));
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.equal(`${v.width}x${v.height}`, '720x1280');
    assert.ok(Math.abs(Number(info.format.duration) - 12) < 0.1, `${layout} : durée ${info.format.duration}`);
  }
  assert.equal(p.originality.checks.find((c) => c.id === 'screen').status, 'warn', 'incrustation : moins sûre que l\'écran partagé');
  p = await api('PUT', `/api/projects/${id}/montage/params`, { reaction: { enabled: false, file: '' } });
  assert.equal(p.montageParams.reaction.file, '');
});

test('sous-titres box mot par mot et masque des sous-titres incrustés : rendu réel', { skip: process.platform !== 'win32' }, async () => {
  await api('PUT', `/api/projects/${id}/montage/params`, { subtitles: { enabled: true, box: true, boxColor: '#000000', animation: 'mot' }, mask: { enabled: true, x: 0.1, y: 0.7, w: 0.8, h: 0.15 } });
  await api('POST', `/api/projects/${id}/montage/render`, {});
  const p = await waitIdle(id);
  assert.equal(state(p, 'montage'), 'done', p.steps.montage?.error);
  const ass = fs.readFileSync(path.join(DATA, 'projects', id, 'montage', 'subs-preview.ass'), 'utf8');
  const def = ass.split('\n').find((l) => l.startsWith('Style: Default'));
  assert.equal(def.split(',')[15], '3', 'BorderStyle 3 : box');
  const cues = ass.split('\n').filter((l) => l.startsWith('Dialogue: 0'));
  assert.ok(cues.every((l) => !l.split(',,').pop().trim().includes(' ')), 'un mot par sous-titre');
  await api('PUT', `/api/projects/${id}/montage/params`, { subtitles: { box: false, animation: 'phrase' }, mask: { enabled: false } });
});

test('plusieurs vidéos : partage équitable des durées et assemblage réel', { skip: process.platform !== 'win32' }, async () => {
  const media = await import('../lib/media.js');
  assert.deepEqual(media.shareClips([{ duration: 10 }, { duration: 30 }], 30).map((c) => c.end), [10, 20], 'le surplus de la vidéo courte va à l\'autre');
  assert.deepEqual(media.shareClips([{ duration: 40 }, { duration: 40 }, { duration: 40 }], 30).map((c) => c.end), [10, 10, 10]);
  const tmp = fs.mkdtempSync(path.join(DATA, 'mix-'));
  const out = path.join(tmp, 'mix.mp4');
  await media.concatClips([{ file: FIXTURE, start: 0, end: 3, hasAudio: true }, { file: FIXTURE, start: 5, end: 9, hasAudio: false }], out, { width: 540, height: 960 });
  const info = probe(out);
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.equal(`${v.width}x${v.height}`, '540x960');
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'));
  assert.ok(Math.abs(Number(info.format.duration) - 7) < 0.3, `durée ${info.format.duration}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  await assert.rejects(api('POST', `/api/projects/${id}/source/hook`, { index: 1 }), /introuvable/);
});

test('assistant : génération enchaînée jusqu\'à l\'export, écoute d\'une voix', { skip: process.platform !== 'win32' }, async () => {
  let p = await api('GET', `/api/projects/${id}`);
  const text = p.finalScript.text + ' Et tu vas voir la suite.';
  await assert.rejects(api('POST', `/api/projects/${id}/wizard/generate`, { text: 'trop court' }), /vide/);
  await api('POST', `/api/projects/${id}/wizard/generate`, { text });
  p = await waitIdle(id);
  assert.equal(state(p, 'final_script'), 'done');
  assert.equal(state(p, 'montage_ok'), 'done', 'montage validé automatiquement');
  assert.equal(state(p, 'export'), 'done', p.steps.export?.error || p.job?.message);
  assert.equal(p.finalScript.validatedText, text);
  // Écoute : échantillon généré une fois avec une voix Windows (gratuite), puis servi depuis le cache.
  const { providers } = await api('GET', '/api/voices');
  const win = providers.find((x) => x.id === 'windows' && x.available);
  if (win) {
    const url = `${BASE}/api/voices/preview?provider=windows&voice=${encodeURIComponent(win.voices[0].id)}&lang=fr`;
    const r = await fetch(url);
    assert.equal(r.status, 200);
    assert.ok((await r.arrayBuffer()).byteLength > 1000);
  }
  assert.equal((await fetch(`${BASE}/api/voices/preview?provider=windows&voice=inconnue`)).status, 400);
});

test('script de référence : la vidéo déjà téléchargée comme vidéo à modifier est réutilisée', async () => {
  const { reuseSourceDownload } = await import('../lib/pipeline.js');
  const dir = fs.mkdtempSync(path.join(DATA, 'reuse-'));
  const clipDir = path.join(dir, 'source', 'clips', '111');
  fs.mkdirSync(clipDir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(clipDir, 'download.mp4'));
  fs.writeFileSync(path.join(clipDir, 'download.info.json'), JSON.stringify({ view_count: 42, description: 'desc' }));
  const base = { id: 'x', steps: {}, source: { urls: ['https://www.tiktok.com/@a/video/111', 'https://www.tiktok.com/@a/video/222'] } };
  const r = reuseSourceDownload({ ...base, reference: { url: 'https://www.tiktok.com/@a/video/111?lang=fr' } }, dir);
  assert.ok(r?.reused && fs.existsSync(path.join(dir, r.file)), 'fichier copié');
  assert.ok(fs.existsSync(path.join(clipDir, 'download.mp4')), 'la vidéo à modifier reste en place');
  assert.equal(r.info.stats.views, 42);
  assert.equal(reuseSourceDownload({ ...base, reference: { url: 'https://www.tiktok.com/@a/video/333' } }, dir), null, 'autre vidéo : téléchargement normal');
  // Source unique : le fichier a été déplacé vers source/source.mp4, les métadonnées restent dans source/download.
  const single = fs.mkdtempSync(path.join(DATA, 'reuse1-'));
  fs.mkdirSync(path.join(single, 'source', 'download'), { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(single, 'source', 'source.mp4'));
  const r1 = reuseSourceDownload({ id: 'y', steps: { source_fetch: { status: 'done' } }, source: { origin: 'tiktok', url: 'https://www.tiktok.com/@a/video/555', file: 'source/source.mp4' }, reference: { url: 'https://www.tiktok.com/@a/video/555' } }, single);
  assert.ok(r1?.reused && fs.existsSync(path.join(single, r1.file)));
  // Lien court vm.tiktok.com identique pour les deux vidéos (cas fréquent) : réutilisé aussi.
  const short = { id: 'z', steps: { source_fetch: { status: 'done' } }, source: { origin: 'tiktok', url: 'https://vm.tiktok.com/ZGdXWW1cS/', file: 'source/source.mp4' } };
  assert.ok(reuseSourceDownload({ ...short, reference: { url: 'https://vm.tiktok.com/ZGdXWW1cS' } }, single)?.reused);
  // Lien court d'un côté, lien long de l'autre : reconnu par le numéro de vidéo enregistré au téléchargement.
  fs.writeFileSync(path.join(single, 'source', 'download', 'download.info.json'), JSON.stringify({ id: '7706747289699699998' }));
  assert.ok(reuseSourceDownload({ ...short, reference: { url: 'https://www.tiktok.com/@x/video/7706747289699699998' } }, single)?.reused);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(single, { recursive: true, force: true });
});

test('détecteur de copies : copie en miroir recadrée reconnue, vidéo différente écartée', { skip: process.platform !== 'win32' }, async () => {
  const copies = await import('../lib/copies.js');
  const tmp = fs.mkdtempSync(path.join(DATA, 'cp-'));
  const mirror = path.join(tmp, 'miroir.mp4');
  const other = path.join(tmp, 'autre.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', FIXTURE, '-vf', 'hflip,crop=iw*0.85:ih*0.85,eq=saturation=1.3', '-an', mirror]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'life=s=640x360:mold=10:r=25:ratio=0.3:life_color=#00ff00:death_color=#aa2222,trim=duration=6', other]);
  const src = await copies.sourcePrint(FIXTURE);
  const m = copies.compare(src, await copies.candidatePrint(mirror));
  assert.equal(copies.verdict(m.ratio), 'copie', `miroir : ${m.ratio}`);
  assert.equal(m.mirrored, true);
  const o = copies.compare(src, await copies.candidatePrint(other));
  assert.equal(copies.verdict(o.ratio), 'différente', `autre vidéo : ${o.ratio}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  await assert.rejects(api('POST', `/api/projects/${id}/copies/scan`, { urls: 'rien ici' }), /au moins un lien/);
});

test('registre des publications : compteur, doublon et lien non TikTok refusés, retrait', async () => {
  const url = 'https://www.tiktok.com/@moi/video/7400000000000000001';
  let p = await api('POST', `/api/projects/${id}/publications`, { url, account: '@moi' });
  await api('POST', `/api/projects/${id}/publications`, { note: 'repost', at: '2026-01-02T10:00:00Z' });
  await assert.rejects(api('POST', `/api/projects/${id}/publications`, { url }), /déjà enregistrée/);
  await assert.rejects(api('POST', `/api/projects/${id}/publications`, { url: 'https://example.com/v' }), /tiktok\.com/);
  p = await api('GET', `/api/projects/${id}`);
  assert.equal(p.publications.length, 2);
  assert.equal(p.publications[0].note, 'repost', 'trié par date');
  assert.equal(p.publications[1].account, 'moi');
  assert.equal((await api('GET', '/api/projects')).find((x) => x.id === id).publications, 2);
  p = await api('DELETE', `/api/projects/${id}/publications/${p.publications[0].id}`);
  assert.equal(p.publications.length, 1);
});

test('réutilisation : changer la voix ne relance ni l\'analyse ni le script', { skip: process.platform !== 'win32' }, async () => {
  const before = await api('GET', `/api/projects/${id}`);
  const callsBefore = aiCalls.length;
  const v = before.voiceParams;
  let p = await api('PUT', `/api/projects/${id}/voice/params`, { ...v, speed: 0.9 });
  assert.equal(state(p, 'voice'), 'stale');
  assert.equal(state(p, 'montage'), 'stale');
  assert.equal(state(p, 'export'), 'stale');
  assert.equal(state(p, 'visual_agent'), 'done');
  assert.equal(state(p, 'script_agent'), 'done');
  await api('POST', `/api/projects/${id}/run`, { target: 'montage' });
  p = await waitIdle(id);
  assert.equal(state(p, 'montage'), 'done');
  assert.equal(aiCalls.length, callsBefore, 'aucun appel IA supplémentaire');
  assert.equal(p.steps.source_analyze.finishedAt, before.steps.source_analyze.finishedAt);
});

test('reprise : un montage interrompu par l\'arrêt du serveur reprend sans tout recommencer', { skip: process.platform !== 'win32' }, async () => {
  await api('POST', `/api/projects/${id}/montage/render`, {});
  await new Promise((r) => setTimeout(r, 400));
  await stopApp();
  await startApp();
  let p = await api('GET', `/api/projects/${id}`);
  assert.equal(state(p, 'montage'), 'interrupted');
  const voiceAt = p.steps.voice.finishedAt;
  await api('POST', `/api/projects/${id}/resume`, {});
  p = await waitIdle(id);
  assert.equal(state(p, 'montage'), 'done');
  assert.equal(p.steps.voice.finishedAt, voiceAt, 'voix réutilisée');
});

test('repli : texte collé quand l\'extraction est impossible', async () => {
  const p0 = await api('POST', '/api/projects', { name: 'Repli' });
  await api('POST', `/api/projects/${p0.id}/reference/text`, { text: 'Voici un script collé à la main.\n\nDeuxième paragraphe.' });
  const p = await waitIdle(p0.id);
  assert.equal(state(p, 'reference_extract'), 'done');
  assert.equal(p.steps.reference_extract.output.transcript.segments.length, 2);
  assert.equal(p.reference.validated, false, 'jamais validé sans action de l\'utilisateur');
});

test('sans IA : script écrit à la main → voix off → montage', { skip: process.platform !== 'win32' }, async () => {
  const p0 = await api('POST', '/api/projects', { name: 'Manuel' });
  await api('PUT', `/api/projects/${p0.id}/source/upload`, fs.readFileSync(FIXTURE), { 'x-filename': 'source.mp4', 'x-rights-confirmed': '1' });
  await waitIdle(p0.id);
  await api('PUT', `/api/projects/${p0.id}/script`, { text: 'Premier passage écrit à la main.\n\nSecond passage.' });
  let p = await api('POST', `/api/projects/${p0.id}/script/validate`, {});
  assert.equal(state(p, 'final_script'), 'done', 'validation possible sans Agent C');
  await api('POST', `/api/projects/${p0.id}/voice/generate`, {});
  p = await waitIdle(p0.id);
  assert.equal(state(p, 'voice'), 'done', p.steps.voice?.error);
  await api('POST', `/api/projects/${p0.id}/montage/render`, {});
  p = await waitIdle(p0.id);
  assert.equal(state(p, 'montage'), 'done', p.steps.montage?.error);
});

test('limite de dépense : un appel IA est refusé une fois la limite atteinte', async () => {
  const p0 = await api('POST', '/api/projects', { name: 'Budget' });
  await api('PUT', '/api/settings', { budget: { period: 'month', openrouter: 2.5, fal: 0 } }); // le faux OpenRouter déclare 3 $ ce mois-ci
  const b = await api('GET', '/api/balances');
  assert.equal(b.budget.openrouter.spent, 3);
  await api('POST', `/api/projects/${p0.id}/reference/text`, { text: 'Un script collé à la main.' });
  await waitIdle(p0.id);
  const calls = aiCalls.length;
  await api('POST', `/api/projects/${p0.id}/reference/validate`, { text: 'Un script collé à la main.' }); // lance l'analyse narrative (IA)
  let p = await waitIdle(p0.id);
  assert.equal(state(p, 'narrative_agent'), 'error');
  assert.match(p.steps.narrative_agent.error, /Limite de dépense OpenRouter atteinte/);
  assert.equal(aiCalls.length, calls, 'aucun appel payant envoyé');

  // Limite retirée : l'analyse passe de nouveau.
  await api('PUT', '/api/settings', { budget: { period: 'month', openrouter: 0, fal: 0 } });
  await api('POST', `/api/projects/${p0.id}/run`, { target: 'narrative_agent', force: ['narrative_agent'] });
  p = await waitIdle(p0.id);
  assert.equal(state(p, 'narrative_agent'), 'done', p.steps.narrative_agent?.error);
});

test('suppression d\'un projet : retiré de la liste et fichiers effacés', async () => {
  const p0 = await api('POST', '/api/projects', { name: 'À supprimer' });
  assert.ok(fs.existsSync(path.join(DATA, 'projects', p0.id)));
  await api('DELETE', `/api/projects/${p0.id}`);
  const list = await api('GET', '/api/projects');
  assert.ok(!list.some((p) => p.id === p0.id), 'projet retiré de la liste');
  assert.ok(!fs.existsSync(path.join(DATA, 'projects', p0.id)), 'dossier du projet effacé');
});

test('démarrage immédiat : réglages du dernier projet, nom tiré de la vidéo importée', async () => {
  const ref = await api('POST', '/api/projects', { name: 'Réglages', params: { language: 'de', durationTarget: 61, tone: 'dynamique' } });
  const p0 = await api('POST', '/api/projects', { quick: true });
  assert.equal(p0.autoName, true);
  assert.equal(p0.params.language, 'de');
  assert.equal(p0.params.durationTarget, 61);
  assert.equal(p0.params.tone, 'dynamique');
  await api('PUT', `/api/projects/${p0.id}/source/upload`, fs.readFileSync(FIXTURE), { 'x-filename': 'Ma recette.mp4', 'x-rights-confirmed': '1' });
  const p = await waitIdle(p0.id);
  assert.equal(p.name, 'Ma recette');
  await api('DELETE', `/api/projects/${ref.id}`);
});
