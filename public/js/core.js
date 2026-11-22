// Outils partagés de l'interface : appels API, échappement HTML, notifications, formats.

export async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* corps vide */ }
  if (!r.ok) throw new Error(j?.error || `Erreur HTTP ${r.status}`);
  return j;
}

// Import d'un fichier en flux brut, avec progression.
export function upload(url, file, headers = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('x-filename', encodeURIComponent(file.name));
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let j = null;
      try { j = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (x.status >= 200 && x.status < 300) resolve(j); else reject(new Error(j?.error || 'Import échoué'));
    };
    x.onerror = () => reject(new Error('Connexion interrompue pendant l\'import'));
    x.send(file);
  });
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s === false || s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

// Gabarit HTML : les valeurs interpolées sont échappées, sauf celles marquées raw() (ou issues d'un autre html``).
export function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => {
    const v = values[i - 1];
    const val = Array.isArray(v) ? v.map((x) => (x?.__raw ? x.s : esc(x))).join('') : v?.__raw ? v.s : esc(v);
    return out + val + s;
  }));
}
export const raw = (s) => (s?.__raw ? s : { __raw: true, s: String(s ?? ''), toString() { return this.s; } });

export function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 3500);
}

export const STATE_LABELS = { todo: 'à faire', running: 'en cours', done: 'terminé', error: 'erreur', stale: 'à mettre à jour', interrupted: 'interrompu' };
export const badge = (state, label) => raw(`<span class="badge ${esc(String(state).replace(/\s+/g, '-'))}">${esc(label || STATE_LABELS[state] || state)}</span>`);

export function fmtDuration(s) {
  if (s == null || isNaN(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m ? `${m} min ${sec.toFixed(0).padStart(2, '0')} s` : `${sec.toFixed(1)} s`;
}
export function fmtTime(s) {
  if (s == null || isNaN(s)) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
export function fmtSize(b) {
  if (!b) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
export const fmtDate = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

// `v` force le rechargement quand un fichier garde le même nom mais change de contenu.
// Taille par défaut de la vidéo dans le cadre 9:16 : même règle que le serveur (lib/media.js autoFgScale).
export function autoFgScale(meta) {
  if (!meta?.width || !meta?.height) return 1;
  const ar = meta.width / meta.height;
  if (ar < 0.75) return 0.92;
  return Math.round(Math.min(1.45, 0.8 * ar * (1920 / 1080)) * 100) / 100;
}
// Taille qui remplit tout le cadre (aucun flou visible).
export const fillScale = (meta) => (meta?.width && meta?.height ? Math.max(1, Math.round((meta.width / meta.height) * (1920 / 1080) * 100) / 100) : 1);

export const fileUrl =(p, rel, { download = false, v = '' } = {}) => `/files/${p.id}/${rel.split('/').map(encodeURIComponent).join('/')}${download ? '?download=1' : v ? '?v=' + encodeURIComponent(v) : ''}`;

export function wordCount(t) { return String(t || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length; }
export const WPS = { fr: 2.6, en: 2.6, es: 2.8, it: 2.7, de: 2.3, pt: 2.6 };

export const SCRIPT_MODES = [['adapt', 'Adapter le script viral à ma vidéo'], ['inspire', 'S\'inspirer du script viral (texte original)']];
export const LANGS = [['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['it', 'Italien'], ['de', 'Allemand'], ['pt', 'Portugais']];
export const TONES = ['naturel', 'dynamique', 'émotionnel', 'mystérieux', 'sérieux', 'conversationnel'];

export const options = (list, selected) => raw(list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(l)}</option>`).join(''));

// Affiche l'erreur d'une étape, avec les solutions de remplacement lorsque c'est pertinent.
export function stepError(p, step, extra = '') {
  const s = p.pipeline.steps[step];
  if (s.state === 'interrupted') return raw(`<div class="alert warning"><strong>Traitement interrompu</strong>${esc(s.error)}<div class="row" style="margin-top:8px"><button class="btn sm primary" data-action="resume">Reprendre</button></div></div>`);
  if (s.state !== 'error') return raw('');
  const raw0 = p.steps[step] || {};
  const cfg = raw0.needsConfig ? ' <a href="#/settings">Ouvrir les paramètres</a>' : '';
  return raw(`<div class="alert error"><strong>${esc(s.label)} : échec</strong>${esc(s.error)}${cfg}${extra}</div>`);
}

export function progressBar(p, step) {
  const s = p.pipeline.steps[step];
  if (s.state !== 'running') return raw('');
  const pct = s.progress != null ? Math.round(s.progress * 100) : null;
  // note : ce qui est en cours dans l'étape (téléchargement, transcription…), envoyé par le serveur.
  return raw(`<div class="progress${pct == null || pct === 0 ? ' indeterminate' : ''}"><div style="width:${pct || 0}%"></div></div><div class="small muted">${esc(s.label)}${s.note ? ' : ' + esc(s.note) : ''}${pct ? ' — ' + pct + ' %' : s.note ? '' : '…'}</div>`);
}
