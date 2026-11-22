// Configuration : clés secrètes (.env, côté serveur uniquement) + paramètres non secrets (data/settings.json).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, ensureDir, run } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = ensureDir(process.env.TRS_DATA_DIR || path.join(ROOT, 'data'));
export const PROJECTS_DIR = ensureDir(path.join(DATA_DIR, 'projects'));
const ENV_FILE = path.join(ROOT, '.env');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const SECRET_NAMES = ['OPENROUTER_API_KEY', 'FAL_KEY'];

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

let fileEnv = {};
export function loadEnv() {
  fileEnv = fs.existsSync(ENV_FILE) ? parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) : {};
}
loadEnv();

// Les variables d'environnement du processus priment sur le fichier .env.
export function secret(name) {
  return process.env[name] || fileEnv[name] || '';
}

export function hasSecret(name) { return Boolean(secret(name)); }

// Écrit une clé dans .env sans jamais la renvoyer au client.
export function setSecret(name, value) {
  if (!SECRET_NAMES.includes(name)) throw new Error('Clé inconnue : ' + name);
  const clean = String(value || '').trim().replace(/[\r\n]/g, '');
  let lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith(name + '='));
  if (idx >= 0) lines[idx] = `${name}=${clean}`; else lines.push(`${name}=${clean}`);
  lines = lines.filter((l, i) => l !== '' || i < lines.length - 1);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  loadEnv();
}

const DEFAULT_SETTINGS = {
  models: {
    multimodal: 'google/gemini-3.5-flash', // transcription audio, analyse d'images, OCR
    text: 'google/gemini-3.5-flash',       // analyse narrative, réécriture, contrôle qualité
  },
  remoteFetch: { enabled: true },          // récupération des liens TikTok via yt-dlp
  // Fournisseur des tâches texte (analyse narrative, script, contrôle qualité, titre/description/hashtags) :
  // 'openrouter' (modèle texte ci-dessus) ou 'claude-code' (abonnement Claude via la commande claude -p).
  textAI: { provider: 'openrouter', claudeModel: 'opus' },
  ytdlpPath: '',
  // Limites de dépense des API (en dollars, 0 = aucune limite) sur la période choisie : day | week | month | total.
  budget: { period: 'month', openrouter: 0, fal: 0 },
  defaults: {
    language: 'fr',
    tone: 'naturel',
    durationTarget: 61,                   // 1 min 01 s
    audience: 'grand public francophone',
    autoMode: false,
    scriptMode: 'adapt',                  // adapt : le script viral est adapté à la vidéo ; inspire : réécriture originale
  },
};

export function getSettings() {
  const s = readJSON(SETTINGS_FILE, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    models: { ...DEFAULT_SETTINGS.models, ...(s.models || {}) },
    remoteFetch: { ...DEFAULT_SETTINGS.remoteFetch, ...(s.remoteFetch || {}) },
    textAI: { ...DEFAULT_SETTINGS.textAI, ...(s.textAI || {}) },
    budget: { ...DEFAULT_SETTINGS.budget, ...(s.budget || {}) },
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(s.defaults || {}) },
  };
}

export function saveSettings(patch) {
  const cur = getSettings();
  const next = {
    ...cur,
    ...patch,
    models: { ...cur.models, ...(patch.models || {}) },
    remoteFetch: { ...cur.remoteFetch, ...(patch.remoteFetch || {}) },
    textAI: { ...cur.textAI, ...(patch.textAI || {}) },
    budget: { ...cur.budget, ...(patch.budget || {}) },
    defaults: { ...cur.defaults, ...(patch.defaults || {}) },
  };
  writeJSON(SETTINGS_FILE, next);
  return next;
}

// --- Détection des outils locaux -------------------------------------------------------------

async function works(cmd, args) {
  try { await run(cmd, args, { timeoutMs: 15000 }); return true; } catch { return false; }
}

let toolCache = null;
export async function detectTools(force = false) {
  if (toolCache && !force) return toolCache;
  const settings = getSettings();
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const ytCandidates = [
    settings.ytdlpPath,
    process.env.YTDLP_PATH,
    'yt-dlp',
    path.join(os.homedir(), 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  ].filter(Boolean);
  let ytdlp = '';
  for (const c of ytCandidates) { if (await works(c, ['--version'])) { ytdlp = c; break; } }
  toolCache = {
    ffmpeg: (await works(ffmpeg, ['-version'])) ? ffmpeg : '',
    ffprobe: (await works(ffprobe, ['-version'])) ? ffprobe : '',
    ytdlp,
    windowsTts: process.platform === 'win32',
  };
  return toolCache;
}
