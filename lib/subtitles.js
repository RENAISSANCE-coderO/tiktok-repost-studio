// Sous-titres synchronisés sur la voix off : découpage en courtes lignes + fichier ASS.

// words : [{text, start, end}] relatifs au début de la voix off.
export function cuesFromWords(words, { maxWords = 4, maxChars = 26, offset = 0 } = {}) {
  const cues = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start + offset, end: cur[cur.length - 1].end + offset, text: cur.map((w) => w.text).join(' '),
      words: cur.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })) });
    cur = [];
  };
  for (const w of words) {
    const len = cur.map((x) => x.text).join(' ').length + w.text.length + 1;
    if (cur.length >= maxWords || len > maxChars) flush();
    cur.push(w);
    if (/[.!?…:;]$/.test(w.text)) flush();
  }
  flush();
  // Évite les chevauchements et les sous-titres trop brefs.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (next && cues[i].end > next.start) cues[i].end = next.start;
    if (cues[i].end - cues[i].start < 0.25) cues[i].end = cues[i].start + 0.25;
  }
  return cues;
}

// Repli sans horodatage : répartit les mots proportionnellement à leur longueur, pauses incluses après la ponctuation.
export function estimateWordTimings(text, duration) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  if (!tokens.length || !duration) return [];
  const weight = (t) => t.length + 2 + (/[.!?…]$/.test(t) ? 6 : /[,;:]$/.test(t) ? 3 : 0);
  const total = tokens.reduce((a, t) => a + weight(t), 0);
  let t = 0;
  return tokens.map((tok) => {
    const d = (weight(tok) / total) * duration;
    const w = { text: tok, start: t, end: t + d * 0.9 };
    t += d;
    return w;
  });
}

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const ss = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(Math.min(cs, 99)).padStart(2, '0')}`;
}

function assColor(hex, alpha = 0) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'F');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

// Couleur pour une balise en ligne (\c&HBBGGRR&).
function assInline(hex) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'F');
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}

// Style « TikTok » : police grasse, contour épais, ombre douce, mot prononcé surligné, apparition animée.
// hook : titre choc { text, duration, size } affiché en haut dès la première image ; *mot* = mot en couleur.
export function buildAss(cues, style, { width = 1080, height = 1920, hook = null, credit = null } = {}) {
  const align = style.position === 'top' ? 8 : style.position === 'middle' ? 5 : 2;
  const scale = height / 1920;
  const esc = (t) => String(t).replace(/[{}]/g, '').replace(/\\/g, '').replace(/\r?\n/g, '\\N');
  const up = (t) => (style.uppercase ? String(t).toUpperCase() : String(t));
  const outline = Math.round((style.outlineWidth ?? 6) * scale);
  // Style « box » : fond plein derrière le texte (BorderStyle 3 : la boîte prend la couleur du contour, sa marge = épaisseur).
  const boxAlpha = Math.round((1 - Math.min(1, Math.max(0.1, Number(style.boxOpacity ?? 0.85)))) * 255);
  const border = style.box ? `3,${Math.round(16 * scale)},0` : `1,${outline},${Math.round(4 * scale)}`;
  const outlineColor = style.box ? assColor(style.boxColor || '#000000', boxAlpha) : assColor(style.outline);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.font || 'Arial'},${Math.round((style.size || 72) * scale)},${assColor(style.color)},${assColor(style.color)},${outlineColor},${assColor('#000000', 0x70)},-1,0,0,0,100,100,1,0,${border},${align},70,70,${Math.round((style.marginV ?? 380) * scale)},1`,
    `Style: Hook,${style.font || 'Arial'},${Math.round((hook?.size || 92) * scale)},${assColor(style.color)},${assColor(style.color)},${assColor(style.outline)},${assColor('#000000', 0x60)},-1,0,0,0,100,100,1,0,1,${Math.round(9 * scale)},${Math.round(5 * scale)},8,80,80,${Math.round(250 * scale)},1`,
    `Style: Credit,Segoe UI,${Math.round(34 * scale)},${assColor('#FFFFFF')},${assColor('#FFFFFF')},${assColor('#000000')},${assColor('#000000', 0x80)},-1,0,0,0,100,100,0,0,1,${Math.round(3 * scale)},0,7,50,50,${Math.round(165 * scale)},1`,
    '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  if (hook?.text?.trim()) {
    const hl = assInline(style.highlightColor || '#FFD60A');
    const base = assInline(style.color);
    const text = esc(String(hook.text).toUpperCase()).replace(/\*([^*]+)\*/g, (_, w) => `{\\c${hl}}${w}{\\c${base}}`).replace(/\*/g, '');
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(Number(hook.duration) || 3)},Hook,,0,0,0,,{\\fad(0,250)\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)}${text}`);
  }
  if (credit?.text) lines.push(`Dialogue: 2,${assTime(0)},${assTime(credit.end || 36000)},Credit,,0,0,0,,${esc(credit.text)}`);
  // Apparition : la ligne grossit légèrement de 85 % à 100 % en 90 ms.
  const pop = style.animate ? '{\\fscx85\\fscy85\\t(0,90,\\fscx100\\fscy100)}' : '';
  const hl = assInline(style.highlightColor || '#FFD60A');
  const base = assInline(style.color);
  for (const c of cues) {
    if (style.highlight && c.words?.length) {
      // Une ligne par mot : le mot en cours de prononciation est coloré, les autres restent dans la couleur de base.
      c.words.forEach((w, i) => {
        const start = i === 0 ? c.start : w.start;
        const end = i === c.words.length - 1 ? c.end : c.words[i + 1].start;
        if (end - start < 0.01) return;
        const text = c.words.map((x, j) => (j === i ? `{\\c${hl}}${esc(up(x.text))}{\\c${base}}` : esc(up(x.text)))).join(' ');
        lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${i === 0 ? pop : ''}${text}`);
      });
    } else {
      lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${pop}${esc(up(c.text))}`);
    }
  }
  return lines.join('\n') + '\n';
}

// Lecture d'un fichier WebVTT (sous-titres TikTok récupérés).
export function parseVtt(text) {
  const out = [];
  const blocks = String(text).replace(/\r/g, '').split(/\n\n+/);
  const toSec = (t) => { const p = t.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->').map((s) => s.trim().split(' ')[0]);
    const txt = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (txt) out.push({ start: toSec(a), end: toSec(z), text: txt });
  }
  // Supprime les doublons consécutifs (fréquents dans les sous-titres automatiques).
  return out.filter((c, i) => i === 0 || c.text !== out[i - 1].text);
}
