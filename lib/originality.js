// Diagnostic d'originalité : estime le risque que TikTok classe la vidéo en « contenu non original »
// (vidéo non proposée dans le fil « Pour toi », d'où 0 vue). Calcul local, sans IA.
import { planTimeline } from './media.js';

const words = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}']+/gu) || [];

// Part des groupes de 3 mots du script final déjà présents dans le script de référence.
export function scriptOverlap(finalText, refText) {
  const grams = (t) => { const w = words(t); const s = new Set(); for (let i = 0; i + 2 < w.length; i++) s.add(w.slice(i, i + 3).join(' ')); return s; };
  const a = grams(finalText);
  const b = grams(refText);
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / a.size;
}

// Pseudo du créateur d'origine, tiré du lien TikTok (https://www.tiktok.com/@pseudo/video/…).
export function sourceHandle(p) {
  const m = String(p.source.url || p.source.oembed?.authorUrl || '').match(/tiktok\.com\/@([\w.]+)/i);
  return m ? m[1] : '';
}

export function originalityReport(p, montage) {
  const checks = [];
  const add = (id, status, label, detail, fix = '', penalty = 0, action = '') => checks.push({ id, status, label, detail, fix, penalty: status === 'ok' ? 0 : penalty, action });
  const pct = (x) => `${Math.round(x * 100)} %`;
  const srcDur = Number(p.source.meta?.duration) || 0;
  const voiceDur = Number(p.steps.voice?.output?.duration) || 0;

  if (srcDur) {
    const plan = planTimeline(montage, srcDur, voiceDur);
    // La durée imposée coupe la vidéo : seule la partie réellement montrée compte.
    const shown = Math.min(plan.videoLen, plan.total || plan.videoLen);
    const reused = Math.min(1, shown / srcDur);
    add('reuse', reused >= 0.8 ? 'bad' : reused >= 0.5 ? 'warn' : 'ok', 'Part de la vidéo d\'origine réutilisée',
      `${pct(reused)} de la vidéo d'origine (${Math.round(shown)} s sur ${Math.round(srcDur)} s) se retrouve dans votre vidéo, dans le même ordre.`,
      'Gardez seulement les passages utiles à votre script (page Montage, « Passages conservés ») et complétez avec vos propres images.', reused >= 0.8 ? 30 : 15);
    // Les images figées viennent aussi de la vidéo d'origine : l'écran la montre en permanence, sauf mode réaction.
    const R = montage.reaction || {};
    const loops = R.duration && R.duration < plan.total - 1 ? ` Votre vidéo dure ${Math.round(R.duration)} s : elle passe en boucle ; filmez au moins ${Math.ceil(plan.total)} s pour éviter la répétition.` : '';
    const fix = 'Apportez vos propres images : votre visage qui réagit ou commente (mode réaction, page Montage), d\'autres plans filmés par vous. Réduire, retourner ou accélérer l\'image ne la rend pas originale aux yeux de TikTok.';
    if (R.enabled && R.file && R.layout === 'split') {
      add('screen', 'ok', 'Image d\'origine à l\'écran', `Écran partagé : la vidéo d'origine occupe la moitié haute, votre réaction la moitié basse (format réaction, accepté par TikTok).${loops}`, fix);
    } else if (R.enabled && R.file) {
      add('screen', 'warn', 'Image d\'origine à l\'écran', `Votre réaction est en incrustation, mais la vidéo d'origine occupe encore presque tout l'écran. L'écran partagé est plus sûr.${loops}`, 'Choisissez la mise en page « Écran partagé » dans le mode réaction (page Montage).', 15);
    } else {
      add('screen', 'bad', 'Image d\'origine à l\'écran',
        `La vidéo d'origine est visible pendant 100 % de votre vidéo, en grand (${pct(montage.fgScale || 1)} de la largeur). C'est surtout l'image que TikTok compare aux vidéos existantes.`, fix, 35);
    }
  }

  const useOrig = Number(montage.originalVolume) > 0;
  add('audio', useOrig ? 'bad' : 'ok', 'Son d\'origine',
    useOrig ? `Le son d'origine est conservé à ${pct(montage.originalVolume)} : TikTok le reconnaît et peut le rendre muet ou limiter la vidéo.` : 'Le son d\'origine est coupé.',
    'Mettez le volume du son original à 0 dans la page Montage.', 15);

  const hasVoice = st(p, 'voice') && Number(montage.voiceVolume) > 0;
  add('voice', hasVoice ? 'ok' : 'bad', 'Voix off originale',
    hasVoice ? `Une nouvelle voix off de ${Math.round(voiceDur)} s raconte la vidéo.` : 'Aucune voix off : la vidéo n\'apporte rien de nouveau par rapport à l\'originale.',
    'Générez la voix off (page Voix off).', 20);

  const ref = p.reference.validatedText || p.reference.script;
  const fin = p.finalScript.validatedText || p.finalScript.text;
  if (ref && fin) {
    const o = scriptOverlap(fin, ref);
    add('script', o > 0.5 ? 'bad' : o > 0.25 ? 'warn' : 'ok', 'Texte réécrit',
      `${pct(o)} des tournures du script reprennent mot pour mot le script viral de référence.`,
      'Utilisez « Reformuler » sur la page du script ou passez en mode « Nouveau script ».', o > 0.5 ? 15 : 8);
  }

  const extras = [montage.hookTitle?.enabled && 'titre choc', montage.subtitles?.enabled && 'sous-titres', montage.punchIn?.enabled && 'zooms', montage.musicFile && 'musique'].filter(Boolean);
  add('extras', extras.length >= 2 ? 'ok' : 'warn', 'Éléments ajoutés',
    extras.length ? `Ajouts : ${extras.join(', ')}.` : 'Aucun texte, zoom ni musique ajouté.',
    'Activez le titre choc, les sous-titres et les zooms (page Montage).', 5);

  const handle = sourceHandle(p);
  if (handle) {
    const desc = `${p.publishDraft.description} ${p.publishDraft.cta}`.toLowerCase();
    const credited = desc.includes('@' + handle.toLowerCase());
    add('credit', credited ? 'ok' : 'warn', 'Crédit au créateur',
      (credited ? `La description cite @${handle}.` : `La description ne cite pas le créateur d'origine (@${handle}). Une reprise non créditée est plus souvent signalée.`)
        + (montage.credit?.enabled ? ' Le crédit est aussi affiché en petit sur la vidéo.' : ''),
      `Ajoutez « Vidéo originale : @${handle} » à la description.`, 5, 'credit');
  }

  const curFile = p.steps.export?.output?.file;
  const same = curFile ? (p.publications || []).filter((x) => x.exportFile === curFile).length : 0;
  if (same) {
    add('duplicate', 'warn', 'Déjà publiée à l\'identique',
      `Cette version exacte a déjà été publiée ${same} fois. Republier la même vidéo, ou la supprimer puis la remettre, est traité comme un doublon.`,
      'Ne republiez pas la même version : modifiez réellement le montage ou le script, puis réexportez.', 10);
  }

  const score = Math.max(0, 100 - checks.reduce((a, c) => a + c.penalty, 0));
  return { score, level: score >= 75 ? 'faible' : score >= 50 ? 'moyen' : 'élevé', checks, handle };
}

function st(p, name) {
  return p.steps[name]?.status === 'done';
}
