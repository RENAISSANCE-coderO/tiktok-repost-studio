// Leviers de viralité : accroches concurrentes notées, et score de viralité avec corrections applicables en un clic.
// Aucune garantie de viralité : ces agents optimisent la rétention (accroche, rythme, clarté) et le texte de publication.
import { textJSON, langName } from './agents.js';

// --- Accroches : 5 variantes de la première phrase, notées, avec leur titre à l'écran ----------------------------

export async function hookAgent({ segments, visual, narrative, params, referenceScript = '' }) {
  const current = String(segments[0]?.text || '').match(/^.+?[.!?…](?=\s|$)/)?.[0] || segments[0]?.text || '';
  const system = `Tu es spécialiste des accroches TikTok. Les 3 premières secondes décident si le spectateur reste.
Écris 5 accroches DIFFÉRENTES pour remplacer la première phrase de la voix off ci-dessous, en ${langName(params.language)}, ton ${params.tone}, public ${params.audience}.
Règles :
- Une seule phrase orale, 6 à 14 mots, qui s'enchaîne naturellement avec la suite du script.
- Techniques variées : question intrigante, affirmation surprenante, promesse de révélation, conflit/enjeu, « tu ne vas pas croire… », chiffre concret.
- Strictement fidèle aux images (visible_facts) : aucun fait inventé, aucune promesse que la vidéo ne tient pas.
${referenceScript ? '- Une des 5 reprend la formule d\'accroche du script viral de référence, adaptée à cette vidéo.\n' : ''}- "screen" : titre à afficher en gros à l'écran pendant l'accroche, 3 à 6 mots, même langue, sans emoji ; entoure LE mot clé d'astérisques (ex. « Il a *tout* perdu »).
- Note chaque accroche de 1 à 10 : "curiosity" (envie de connaître la suite), "clarity" (compris en une écoute), "emotion" (surprise, tension, humour), "fit" (cohérence avec les images et la suite).
Évalue aussi l'accroche actuelle avec les mêmes critères dans "current".
JSON strict : {"current":{"screen":"…","scores":{"curiosity":0,"clarity":0,"emotion":0,"fit":0}},"hooks":[{"spoken":"…","screen":"…","technique":"…","scores":{"curiosity":0,"clarity":0,"emotion":0,"fit":0}}]}`;
  const content = `ACCROCHE ACTUELLE : ${current}\n\nSCRIPT COMPLET :\n${segments.map((s) => s.text).join('\n\n')}\n\nANALYSE VISUELLE :\n${JSON.stringify({ summary: visual?.summary, visible_facts: visual?.visible_facts, key_moments: visual?.key_moments })}\n\n` +
    `ACCROCHE DU SCRIPT VIRAL (analyse) : ${JSON.stringify(narrative?.hook || {})}` + (referenceScript ? `\n\nSCRIPT VIRAL DE RÉFÉRENCE :\n"""\n${referenceScript.slice(0, 4000)}\n"""` : '');
  const r = await textJSON({ system, content, temperature: 0.9, label: 'Accroches' });
  const total = (s = {}) => ['curiosity', 'clarity', 'emotion', 'fit'].reduce((a, k) => a + (Number(s[k]) || 0), 0);
  const hooks = [{ spoken: current, screen: r.current?.screen || '', technique: 'accroche actuelle', scores: r.current?.scores || {}, current: true },
    ...(r.hooks || []).filter((h) => h.spoken)]
    .map((h) => ({ spoken: String(h.spoken).trim(), screen: String(h.screen || '').trim(), technique: h.technique || '', scores: h.scores || {}, total: total(h.scores), current: Boolean(h.current) }));
  return hooks;
}

// Remplace la première phrase d'un texte par l'accroche choisie.
export function replaceOpening(text, hook) {
  const m = String(text).match(/^(.+?[.!?…])(\s+|$)/);
  return m ? hook + (m[2] || ' ') + String(text).slice(m[0].length) : hook;
}

// --- Score de viralité ---------------------------------------------------------------------------------------

export const VIRAL_ACTIONS = ['use_hook', 'set_screen_title', 'set_caption', 'set_description', 'set_hashtags', 'set_cta', 'enable_hook_title', 'enable_punch_in', 'enable_highlight', 'fit_duration'];

export async function viralityAgent({ project, facts }) {
  const system = `Tu es un expert de la croissance TikTok. Tu évalues une vidéo AVANT publication, à partir de ses éléments (pas de l'image elle-même).
Note sur 100 son potentiel de rétention et de partage, sans jamais promettre la viralité (l'algorithme dépend aussi du compte, du sujet et du moment).
Critères (sur 10 chacun) : "hook" (3 premières secondes), "retention" (rythme, relances, montée en tension), "length" (durée adaptée), "clarity" (compris sans le son grâce aux sous-titres et au titre à l'écran), "emotion", "packaging" (titre, description, hashtags), "cta" (incite à commenter, partager ou suivre).
Donne 3 à 6 corrections concrètes, de la plus rentable à la moins rentable. Chaque correction a une action applicable automatiquement parmi :
${VIRAL_ACTIONS.join(', ')}.
- use_hook : "value" = nouvelle première phrase orale (fidèle aux images). set_screen_title : "value" = titre à l'écran (3 à 6 mots, *mot clé*).
- set_caption / set_description / set_cta : "value" = nouveau texte. set_hashtags : "value" = liste de hashtags sans #.
- enable_hook_title / enable_punch_in / enable_highlight / fit_duration : pas de "value".
Langue des textes proposés : ${langName(project.params.language)}. Explications en français.
JSON strict : {"score":0,"criteria":{"hook":0,"retention":0,"length":0,"clarity":0,"emotion":0,"packaging":0,"cta":0},"summary":"…","strengths":["…"],"fixes":[{"problem":"…","fix":"…","impact":"fort|moyen|faible","action":"…","value":"…"}]}`;
  const r = await textJSON({ system, content: JSON.stringify(facts, null, 1), temperature: 0.4, label: 'Score de viralité' });
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))), criteria: r.criteria || {}, summary: r.summary || '', strengths: r.strengths || [],
    fixes: (r.fixes || []).filter((x) => VIRAL_ACTIONS.includes(x.action)).map((x) => ({ problem: x.problem || '', fix: x.fix || '', impact: x.impact || 'moyen', action: x.action, value: x.value ?? '', applied: false })),
  };
}
