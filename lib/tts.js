// Synthèse vocale : FAL (ElevenLabs multilingue, Inworld) ou voix Windows hors ligne.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { secret, detectTools } from './config.js';
import { run, retry, sleep, httpRequest } from './util.js';
import { normalizeAudio, mediaDuration } from './media.js';
import { assertWithinBudget, recordSpend, FAL_USD_PER_CHAR } from './budget.js';

const ELEVEN_VOICES = [
  ['Aria', 'F'], ['Sarah', 'F'], ['Laura', 'F'], ['Charlotte', 'F'], ['Alice', 'F'], ['Matilda', 'F'], ['Jessica', 'F'], ['Lily', 'F'],
  ['Roger', 'M'], ['Charlie', 'M'], ['George', 'M'], ['Callum', 'M'], ['Liam', 'M'], ['Will', 'M'], ['Eric', 'M'], ['Chris', 'M'], ['Brian', 'M'], ['Daniel', 'M'], ['Bill', 'M'],
  ['River', 'N'],
];
const INWORLD_VOICES = [
  ['Hélène (fr)', 'F', 'fr'], ['Alain (fr)', 'M', 'fr'], ['Mathieu (fr)', 'M', 'fr'], ['Étienne (fr)', 'M', 'fr'],
  ['Sarah (en)', 'F', 'en'], ['Olivia (en)', 'F', 'en'], ['Ashley (en)', 'F', 'en'], ['Craig (en)', 'M', 'en'], ['Mark (en)', 'M', 'en'], ['Edward (en)', 'M', 'en'],
  ['Lupita (es)', 'F', 'es'], ['Diego (es)', 'M', 'es'], ['Miguel (es)', 'M', 'es'],
  ['Johanna (de)', 'F', 'de'], ['Josef (de)', 'M', 'de'], ['Orietta (it)', 'F', 'it'], ['Gianni (it)', 'M', 'it'],
  ['Maitê (pt)', 'F', 'pt'], ['Heitor (pt)', 'M', 'pt'],
];

// Le ton se traduit en réglages de stabilité/expressivité pour ElevenLabs.
export const TONES = {
  naturel: { stability: 0.5, style: 0.2 },
  dynamique: { stability: 0.35, style: 0.55 },
  'émotionnel': { stability: 0.3, style: 0.7 },
  'mystérieux': { stability: 0.6, style: 0.4 },
  'sérieux': { stability: 0.75, style: 0.05 },
  conversationnel: { stability: 0.45, style: 0.3 },
};

let windowsVoices = null;
async function listWindowsVoices() {
  if (process.platform !== 'win32') return [];
  if (windowsVoices) return windowsVoices;
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | % { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture + "|" + $_.VoiceInfo.Gender }'], { timeoutMs: 20000 });
    windowsVoices = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [name, culture, gender] = l.split('|');
      return { id: name, label: name.replace(/^Microsoft /, '').replace(/ Desktop$/, ''), gender: gender === 'Female' ? 'F' : gender === 'Male' ? 'M' : 'N', lang: culture.slice(0, 2), accent: culture };
    });
  } catch { windowsVoices = []; }
  return windowsVoices;
}

export async function providers() {
  const fal = Boolean(secret('FAL_KEY'));
  const win = await listWindowsVoices();
  return [
    { id: 'fal-elevenlabs', label: 'ElevenLabs multilingue (via FAL)', available: fal, reason: fal ? '' : 'FAL_KEY manquante', tones: true, speed: true, wordTimestamps: true,
      voices: ELEVEN_VOICES.map(([n, g]) => ({ id: n, label: n, gender: g, lang: '*', accent: 'multilingue' })), cost: '≈ 0,10 $ / 1000 caractères (tarif FAL indicatif)' },
    { id: 'fal-inworld', label: 'Inworld TTS (via FAL)', available: fal, reason: fal ? '' : 'FAL_KEY manquante', tones: false, speed: true, wordTimestamps: false,
      voices: INWORLD_VOICES.map(([n, g, l]) => ({ id: n, label: n, gender: g, lang: l, accent: l })), cost: 'tarif FAL en vigueur' },
    { id: 'windows', label: 'Voix Windows (hors ligne, gratuite)', available: win.length > 0, reason: win.length ? '' : 'Aucune voix SAPI installée', tones: false, speed: true, wordTimestamps: false,
      voices: win, cost: 'gratuit' },
  ];
}

async function falQueue(endpoint, input) {
  const key = secret('FAL_KEY');
  if (!key) throw Object.assign(new Error('FAL_KEY absente : configurez-la dans Paramètres.'), { retryable: false, needsConfig: true });
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const sub = await retry(async () => {
    await assertWithinBudget('fal');
    const r = await httpRequest(`https://queue.fal.run/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(input), signal: AbortSignal.timeout(60000), headersTimeout: 15000 });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`FAL ${r.status} : ${t.slice(0, 300)}`), { retryable: r.status === 429 || r.status >= 500 });
    return JSON.parse(t);
  }, { attempts: 5, label: 'FAL (soumission)' });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await httpRequest(sub.status_url, { headers, signal: AbortSignal.timeout(30000) }).catch(() => null); // coupure réseau : on réessaie au tour suivant
    if (!r?.ok) continue;
    const s = await r.json();
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED' || s.error) throw new Error('FAL : génération échouée ' + JSON.stringify(s.error || s).slice(0, 300));
  }
  const res = await retry(() => httpRequest(sub.response_url, { headers, signal: AbortSignal.timeout(30000) }), { attempts: 4, label: 'FAL (résultat)' });
  const j = await res.json();
  if (!res.ok || j.detail) throw new Error('FAL : ' + JSON.stringify(j.detail || j).slice(0, 300));
  recordSpend('fal', String(input.text || '').length * FAL_USD_PER_CHAR, endpoint);
  return j;
}

async function download(url, out) {
  const r = await retry(() => httpRequest(url, { signal: AbortSignal.timeout(120000) }), { attempts: 4, label: 'Téléchargement audio' });
  if (!r.ok) throw new Error('Téléchargement audio impossible : HTTP ' + r.status);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return out;
}

// Horodatages par mot renvoyés par ElevenLabs (formats « mots » ou « caractères » acceptés).
function parseTimestamps(ts) {
  if (!ts) return null;
  const arr = Array.isArray(ts) ? ts : [ts];
  const words = [];
  for (const item of arr) {
    if (item && item.text != null && item.start != null) {
      const text = String(item.text).trim();
      if (text) words.push({ text, start: Number(item.start), end: Number(item.end ?? item.start) });
    } else if (item?.characters && item.character_start_times_seconds) {
      let cur = null;
      item.characters.forEach((ch, i) => {
        const s = item.character_start_times_seconds[i], e = item.character_end_times_seconds[i];
        if (/\s/.test(ch)) { if (cur) words.push(cur); cur = null; }
        else if (!cur) cur = { text: ch, start: s, end: e };
        else { cur.text += ch; cur.end = e; }
      });
      if (cur) words.push(cur);
    }
  }
  return words.length ? words : null;
}

// Synthèse longue découpée en morceaux (limite de caractères par appel).
function chunkText(text, max) {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { chunks.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

export async function synthesize({ text, provider, voice, tone = 'naturel', speed = 1, language = 'fr', outDir, baseName, maxDuration = 0 }) {
  let raw = '';
  const out = path.join(outDir, baseName + '.mp3');
  let words = null;
  let tempo = 1;

  if (provider === 'fal-elevenlabs') {
    const t = TONES[tone] || TONES.naturel;
    const sp = Math.min(1.2, Math.max(0.7, Number(speed) || 1));
    const chunks = chunkText(text, 4500);
    const parts = [];
    let offset = 0;
    words = [];
    for (const [i, chunk] of chunks.entries()) {
      const r = await falQueue('fal-ai/elevenlabs/tts/multilingual-v2', {
        text: chunk, voice, stability: t.stability, style: t.style, similarity_boost: 0.75, speed: sp, timestamps: true,
        previous_text: i > 0 ? chunks[i - 1].slice(-300) : undefined,
      });
      if (!r.audio?.url) throw new Error('FAL ElevenLabs : aucune URL audio dans la réponse.');
      const part = path.join(outDir, `${baseName}.part${i}.mp3`);
      await download(r.audio.url, part);
      const ws = parseTimestamps(r.timestamps);
      if (ws && words) words.push(...ws.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })));
      else words = null;
      offset += await mediaDuration(part);
      parts.push(part);
    }
    raw = path.join(outDir, baseName + '.src.mp3');
    await concatAudio(parts, raw);
    parts.forEach((p) => fs.rmSync(p, { force: true }));
  } else if (provider === 'fal-inworld') {
    const chunks = chunkText(text, 1900);
    const parts = [];
    for (const [i, chunk] of chunks.entries()) {
      const r = await falQueue('fal-ai/inworld-tts', { text: chunk, voice, sample_rate_hertz: 48000 });
      if (!r.audio?.url) throw new Error('FAL Inworld : aucune URL audio dans la réponse.');
      const part = path.join(outDir, `${baseName}.part${i}.wav`);
      await download(r.audio.url, part);
      parts.push(part);
    }
    raw = path.join(outDir, baseName + '.src.wav');
    await concatAudio(parts, raw);
    parts.forEach((p) => fs.rmSync(p, { force: true }));
    tempo = Number(speed) || 1;
  } else if (provider === 'windows') {
    const txt = path.join(outDir, baseName + '.txt');
    fs.writeFileSync(txt, text, 'utf8');
    const rate = Math.max(-10, Math.min(10, Math.round(((Number(speed) || 1) - 1) * 10)));
    const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;` +
      ` $s.SelectVoice($env:TRS_VOICE); $s.Rate=${rate}; $s.SetOutputToWaveFile($env:TRS_OUT);` +
      ` $s.Speak([IO.File]::ReadAllText($env:TRS_TXT,[Text.Encoding]::UTF8)); $s.Dispose()`;
    raw = path.join(outDir, baseName + '.src.wav');
    // Texte et chemins passés par variables d'environnement : aucune interpolation dans la commande.
    const env = { ...process.env, TRS_VOICE: voice, TRS_OUT: raw, TRS_TXT: txt };
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env, windowsHide: true, timeout: 180000 },
        (err, _o, stderr) => (err ? reject(new Error('Synthèse Windows échouée : ' + (stderr || err.message).slice(0, 300))) : resolve()));
    });
    fs.rmSync(txt, { force: true });
  } else {
    throw Object.assign(new Error('Fournisseur de voix inconnu : ' + provider), { retryable: false });
  }

  // Voix plus longue que le créneau disponible : légère accélération (15 % au plus) plutôt qu'une vidéo plus longue.
  const naturalDuration = (await mediaDuration(raw)) / tempo;
  const fit = maxDuration && naturalDuration > maxDuration ? Math.min(1.15, naturalDuration / maxDuration) : 1;
  tempo *= fit;
  await normalizeAudio(raw, out, { tempo });
  fs.rmSync(raw, { force: true });
  if (words && tempo !== 1) words = words.map((w) => ({ ...w, start: w.start / tempo, end: w.end / tempo }));
  const duration = await mediaDuration(out);
  return { file: out, duration, words, naturalDuration, fit: Math.round(fit * 1000) / 1000 };
}

async function concatAudio(parts, out) {
  if (parts.length === 1) { fs.copyFileSync(parts[0], out); return; }
  const { ffmpeg } = await detectTools();
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  parts.forEach((p) => args.push('-i', p));
  args.push('-filter_complex', parts.map((_, i) => `[${i}:a]`).join('') + `concat=n=${parts.length}:v=0:a=1[a]`, '-map', '[a]', out);
  await run(ffmpeg, args);
}
