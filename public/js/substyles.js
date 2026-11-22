// Styles de sous-titres prêts à l'emploi (cartes d'aperçu cliquables), partagés par la page Montage et l'assistant.
import { esc } from './core.js';

export const SUB_PRESETS = [
  { id: 'tiktok', label: 'TikTok', patch: { box: false, color: '#FFFFFF', outline: '#000000', highlight: true, highlightColor: '#FFD60A', font: 'Segoe UI Black', uppercase: true } },
  { id: 'box-noire', label: 'Box noire', patch: { box: true, boxColor: '#000000', boxOpacity: 0.85, color: '#FFFFFF', highlight: true, highlightColor: '#FFD60A', font: 'Segoe UI Black', uppercase: true } },
  { id: 'box-blanche', label: 'Box blanche', patch: { box: true, boxColor: '#FFFFFF', boxOpacity: 0.95, color: '#111111', highlight: true, highlightColor: '#E11D48', font: 'Segoe UI Black', uppercase: true } },
  { id: 'neon', label: 'Néon vert', patch: { box: false, color: '#FFFFFF', outline: '#000000', highlight: true, highlightColor: '#39FF14', font: 'Arial Black', uppercase: true } },
  { id: 'bleu', label: 'Bleu', patch: { box: false, color: '#FFFFFF', outline: '#0B1220', highlight: true, highlightColor: '#38BDF8', font: 'Segoe UI Black', uppercase: true } },
  { id: 'sobre', label: 'Sobre', patch: { box: false, color: '#FFFFFF', outline: '#000000', highlight: false, font: 'Segoe UI', uppercase: false } },
];

// Le style actif est celui dont tous les réglages correspondent.
export function activePreset(sub) {
  return SUB_PRESETS.find((p) => Object.entries(p.patch).every(([k, v]) => sub[k] === v))?.id || '';
}

// Aperçu CSS d'un style : deux mots, le second surligné, avec box ou contour.
export function presetSample(sub, words = ['MON', 'TIKTOK']) {
  const box = sub.box ? `background:${hexA(sub.boxColor || '#000000', sub.boxOpacity ?? 0.85)};padding:4px 10px;border-radius:4px;` : '';
  const stroke = sub.box ? '' : `-webkit-text-stroke:3px ${sub.outline || '#000'};paint-order:stroke fill;`;
  const txt = words.map((w) => (sub.uppercase === false ? w.charAt(0) + w.slice(1).toLowerCase() : w));
  return `<span style="${box}${stroke}font-family:'${esc(sub.font || 'Segoe UI Black')}';font-weight:900;font-size:17px;white-space:nowrap;color:${esc(sub.color || '#fff')}">${esc(txt[0])} <span style="color:${esc(sub.highlight ? sub.highlightColor || '#FFD60A' : sub.color || '#fff')}">${esc(txt[1])}</span></span>`;
}

export function presetCards(sub, attr = 'data-subpreset') {
  const cur = activePreset(sub);
  return `<div class="sub-presets">${SUB_PRESETS.map((p) => `<button type="button" class="sub-preset${p.id === cur ? ' on' : ''}" ${attr}="${p.id}" title="${esc(p.label)}">
    <div class="sample">${presetSample({ ...sub, ...p.patch })}</div><div class="small">${esc(p.label)}</div></button>`).join('')}</div>`;
}

function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}
