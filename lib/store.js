// Persistance des projets : data/projects/<id>/project.json + fichiers médias du projet.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, DATA_DIR, getSettings } from './config.js';
import { readJSON, writeJSON, ensureDir, newId } from './util.js';

const cache = new Map();
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

export const projectDir = (id) => path.join(PROJECTS_DIR, id);
export const projectPath = (id, rel = '') => {
  const base = projectDir(id);
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Chemin hors du projet');
  return p;
};

function blankProject(id, name, params) {
  const now = new Date().toISOString();
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    params,
    // Vidéo à modifier (source visuelle) — jamais confondue avec la référence.
    source: { url: '', origin: '', rightsConfirmed: false, file: '', meta: null, oembed: null },
    // Vidéo TikTok de référence (source d'inspiration narrative).
    reference: {
      url: '', origin: '', file: '', audioFile: '', oembed: null, info: null, stats: null,
      script: '', scriptEdited: false, validated: false, validatedText: '', validatedAt: '',
    },
    finalScript: { segments: [], text: '', edited: false, validated: false, validatedText: '', validatedAt: '' },
    voiceParams: null,
    montageParams: null,
    exportParams: { quality: 'high', fps: 'source', resolution: '1080x1920' },
    publishDraft: { caption: '', description: '', hashtags: [], cta: '' },
    publications: [],
    steps: {},
    job: null,
    versions: { referenceScript: [], script: [], voice: [], montage: [], export: [] },
  };
}

export function createProject({ name, params = {}, autoName = false }) {
  const id = newId('p');
  ensureDir(projectDir(id));
  const p = blankProject(id, name || 'Projet sans titre', { ...getSettings().defaults, ...params });
  // Nom provisoire : remplacé par le titre de la vidéo à modifier dès qu'il est connu.
  if (autoName) p.autoName = true;
  save(p);
  logEvent(id, 'project', 'created', p.name);
  return p;
}

export function getProject(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  if (cache.has(id)) return cache.get(id);
  const p = readJSON(path.join(projectDir(id), 'project.json'));
  if (p) cache.set(id, p);
  return p;
}

export function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .map((id) => getProject(id))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function save(p) {
  p.updatedAt = new Date().toISOString();
  cache.set(p.id, p);
  writeJSON(path.join(projectDir(p.id), 'project.json'), p);
  return p;
}

// Modifie un projet de façon synchrone (pas d'await entre lecture et écriture → pas de course).
export function update(id, fn) {
  const p = getProject(id);
  if (!p) throw Object.assign(new Error('Projet introuvable'), { status: 404 });
  fn(p);
  return save(p);
}

export function deleteProject(id) {
  cache.delete(id);
  fs.rmSync(projectDir(id), { recursive: true, force: true });
  logEvent(id, 'project', 'deleted', '');
}

export function logEvent(projectId, step, event, detail = '') {
  const line = JSON.stringify({ at: new Date().toISOString(), projectId, step, event, detail: String(detail).slice(0, 500) });
  fs.appendFileSync(HISTORY_FILE, line + '\n');
}

export function readHistory({ projectId, limit = 300 } = {}) {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (!projectId || e.projectId === projectId) out.push(e);
    } catch { /* ligne corrompue ignorée */ }
  }
  return out;
}

// Ajoute une version horodatée (script, voix, montage…) sans écraser les précédentes.
export function pushVersion(p, kind, entry) {
  p.versions[kind] ||= [];
  const v = { n: p.versions[kind].length + 1, at: new Date().toISOString(), ...entry };
  p.versions[kind].push(v);
  return v;
}
