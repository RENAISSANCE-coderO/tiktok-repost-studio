// Agents IA spécialisés. Chaque agent a une seule responsabilité et renvoie un JSON structuré.
import path from 'node:path';
import { getSettings } from '../config.js';
import { chatJSON, imagePart, audioPart, textPart } from './openrouter.js';
import { claudeJSON } from './claudecode.js';
import { wordCount, wordsPerSecond } from '../util.js';
import { scriptMethod } from './scriptprompt.js';

const models = () => getSettings().models;

// Tâches texte : abonnement Claude (Claude Code) ou modèle texte OpenRouter, selon Paramètres.
export function textJSON({ system, content, temperature, reasoning, label }) {
  const { textAI } = getSettings();
  if (textAI.provider === 'claude-code') return claudeJSON({ system, content, model: textAI.claudeModel, reasoning, label });
  return chatJSON({ model: models().text, system, content, temperature, reasoning, label });
}
const LANG_NAMES = { fr: 'français', en: 'anglais', es: 'espagnol', it: 'italien', de: 'allemand', pt: 'portugais' };
export const langName = (l) => LANG_NAMES[String(l || 'fr').slice(0, 2)] || l;

// --- Extraction du script de référence --------------------------------------------------------

export async function transcribeAudio(audioFile, { subtitlesText = '', durationHint = 0 } = {}) {
  const system = `Tu es un transcripteur professionnel. Tu retranscris UNIQUEMENT les paroles réellement prononcées dans l'audio fourni.
Règles absolues :
- N'invente jamais un mot. Un passage inaudible s'écrit [inaudible] et son segment porte "uncertain": true.
- Un mot dont tu n'es pas sûr reste dans le texte mais le segment porte "uncertain": true et "note" explique le doute.
- Ne traduis pas, ne reformule pas, ne corrige pas le style de l'orateur.
- Ignore la musique et les bruits ; si aucune parole n'est audible, renvoie "has_speech": false et des segments vides.
- Les horodatages (secondes depuis le début) sont approximatifs mais croissants ; un segment = une phrase ou une idée.
- "language" : code ISO 639-1 uniquement si tu es sûr, sinon null.
Réponds en JSON strict : {"has_speech":bool,"language":"fr"|null,"language_confidence":"high"|"medium"|"low","segments":[{"start":0.0,"end":2.1,"text":"…","uncertain":false,"note":""}]}`;
  const content = [
    textPart(`Durée de l'audio : ${durationHint ? durationHint.toFixed(1) + ' s' : 'inconnue'}.` +
      (subtitlesText ? `\nDes sous-titres publiés avec la vidéo sont disponibles ci-dessous. Sers-t'en pour lever les ambiguïtés, mais l'audio reste la source de vérité :\n"""\n${subtitlesText.slice(0, 8000)}\n"""` : '')),
    audioPart(audioFile, path.extname(audioFile).slice(1) || 'mp3'),
  ];
  const r = await chatJSON({ model: models().multimodal, system, content, temperature: 0, reasoning: 'low', label: 'Transcription' }); // « minimal » saute parfois la fin de l'audio
  return {
    hasSpeech: r.has_speech !== false && (r.segments || []).length > 0,
    language: r.language || null,
    languageConfidence: r.language_confidence || 'low',
    segments: (r.segments || []).map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim(), uncertain: Boolean(s.uncertain) || /\[inaudible\]/i.test(s.text || ''), note: s.note || '' })).filter((s) => s.text),
  };
}

export async function ocrFrames(frames, framesDir) {
  const system = `Tu lis le texte incrusté à l'écran sur des images extraites d'une vidéo TikTok (titres, légendes, sous-titres incrustés).
Recopie le texte exactement tel qu'il apparaît. N'invente rien ; si un texte est illisible, ignore-le.
Classe chaque texte : "caption" (sous-titre de la parole), "title" (titre/accroche incrustée), "other" (logo, interface, nom d'utilisateur).
Fusionne un même texte visible sur plusieurs images consécutives.
JSON strict : {"items":[{"t":0.0,"text":"…","kind":"caption|title|other"}]}`;
  const content = [textPart('Images (horodatage en secondes indiqué avant chacune) :')];
  for (const f of frames) { content.push(textPart(`t=${f.t}s`)); content.push(imagePart(path.join(framesDir, f.file))); }
  const r = await chatJSON({ model: models().multimodal, system, content, temperature: 0, reasoning: 'minimal', label: 'OCR' });
  return (r.items || []).filter((i) => i.text).map((i) => ({ t: Number(i.t) || 0, text: String(i.text).trim(), kind: i.kind || 'other' }));
}

// --- Agent A : analyse visuelle de la vidéo source ---------------------------------------------

export async function visualAgent({ frames, framesDir, scenes, meta, caption }) {
  const system = `Tu es l'Agent A « Analyse visuelle ». Tu décris objectivement une vidéo à partir d'images clés horodatées et de la liste des plans détectés.
Règles :
- Décris seulement ce qui est visible. Aucune supposition présentée comme un fait ; les hypothèses vont dans "uncertain".
- Pour chaque plan (scene index), décris le lieu, les sujets, les actions visibles et le texte affiché.
- Repère les moments forts (révélation, geste spectaculaire, changement brusque) utiles pour placer une accroche ou une chute.
- "visible_facts" : liste de faits vérifiables à l'image sur lesquels un narrateur peut s'appuyer.
- Rédige en français.
JSON strict : {"summary":"…","setting":"…","subjects":["…"],"scenes":[{"index":0,"start":0,"end":0,"description":"…","actions":["…"],"on_screen_text":"","energy":"calme|moyen|intense"}],"key_moments":[{"t":0,"description":"…"}],"visible_facts":["…"],"uncertain":["…"],"narration_opportunities":["…"]}`;
  const content = [textPart(`Durée : ${meta.duration.toFixed(1)} s, ${meta.width}×${meta.height}.\nPlans détectés : ${JSON.stringify(scenes)}\n` +
    (caption ? `Légende d'origine (indicative, non vérifiée) : ${caption}\n` : '') + 'Images clés :')];
  for (const f of frames) { content.push(textPart(`t=${f.t}s (plan ${f.scene})`)); content.push(imagePart(path.join(framesDir, f.file))); }
  return chatJSON({ model: models().multimodal, system, content, temperature: 0.2, label: 'Agent A' });
}

// --- Agent B : analyse narrative du script de référence ----------------------------------------

export async function narrativeAgent({ script, stats, language }) {
  const hasStats = Boolean(stats && (stats.views || stats.likes));
  const system = `Tu es l'Agent B « Analyse narrative ». Tu analyses un script TikTok de référence pour en extraire des mécanismes réutilisables, sans jamais reprendre ses formulations distinctives.
Analyse : accroche des premières secondes, structure, progression, rythme des phrases, curiosité/suspense, transitions, émotions sollicitées, éléments de rétention, conclusion et appel à l'action.
Prudence épistémique : ${hasStats
    ? 'des statistiques publiques sont fournies ; tu peux les citer mais une corrélation ne prouve pas la cause du succès.'
    : 'AUCUNE statistique d\'audience n\'est fournie : parle de « mécanismes potentiellement efficaces », jamais de viralité certaine ou garantie.'}
"distinctive_phrases" : expressions propres à ce script qu'une réécriture NE doit PAS reprendre.
Rédige en français.
JSON strict : {"summary":"…","hook":{"excerpt":"…","technique":"…","why_it_may_work":"…"},"structure":[{"part":"Accroche|Contexte|Tension|Révélation|Chute|CTA|…","description":"…","share_percent":0}],"progression":"…","rhythm":{"avg_words_per_sentence":0,"pace":"lent|moyen|rapide","notes":"…"},"curiosity_mechanisms":["…"],"transitions":["…"],"emotions":["…"],"retention_devices":["…"],"ending":{"type":"…","cta":"…"},"reusable_patterns":[{"pattern":"…","how_to_adapt":"…"}],"distinctive_phrases":["…"],"evidence_level":"${hasStats ? 'stats_available' : 'no_stats'}","caveat":"…"}`;
  const content = `Langue du script : ${language || 'inconnue'}.\n${hasStats ? 'Statistiques publiques : ' + JSON.stringify(stats) + '\n' : ''}Script de référence :\n"""\n${script}\n"""`;
  return textJSON({ system, content, temperature: 0.3, label: 'Agent B' });
}

// --- Agent C : adaptation ou réécriture ---------------------------------------------------------

// « adapt » : le script viral est conservé (accroche, structure, tournures) et son contenu remplacé par celui de la vidéo à modifier.
// « inspire » : nouvelle voix off originale qui ne reprend que les mécanismes narratifs.
export const scriptModeOf = (params) => (params?.scriptMode === 'inspire' ? 'inspire' : 'adapt');

// La méthode d'écriture de l'utilisateur (Paramètres) sert de base ; le cadre technique fixe la longueur calibrée
// sur le débit de la voix, le lien avec les plans de la vidéo et le format JSON attendu par l'application.
function rewriteSystem({ language, tone, audience, durationTarget, scriptMode, wps: measuredWps }) {
  const wps = measuredWps || wordsPerSecond(language);
  const targetWords = Math.round(durationTarget * wps);
  const adapt = scriptModeOf({ scriptMode }) === 'adapt';
  return `${scriptMethod()}

---
Agent C « ${adapt ? 'Adaptation' : 'Réécriture'} » — CADRE TECHNIQUE DE L'APPLICATION (prioritaire sur les indications de forme ci-dessus) :
1. Langue : ${langName(language)}. Audience : ${audience}. Ton : ${tone}. Si le script d'inspiration est dans une autre langue, écris directement dans la langue demandée, comme un natif de cette audience (pas de traduction mot à mot).
2. Longueur : la voix off doit durer environ ${durationTarget} s, soit environ ${targetWords} mots (±10 %), d'après le débit réel de la voix. Cette cible remplace l'indication de 1 500 caractères. Compte tes mots.
3. Éléments transmis : le « script d'inspiration » est le SCRIPT DE RÉFÉRENCE ; l'ANALYSE NARRATIVE détaille ses mécanismes ; le « sujet de la nouvelle vidéo » est décrit par l'ANALYSE VISUELLE (visible_facts, scènes, key_moments) : n'utilise que ce qui s'y voit.
4. ${adapt
    ? 'Mode « adapter » : reste proche du script d\'inspiration (même formule de hook, même structure et ordre des temps forts, même rythme, mêmes transitions, même type de chute). Ses tournures peuvent être reprises quand elles s\'appliquent telles quelles à la nouvelle vidéo ; tout ce qui ne s\'y voit pas (sujet, personnes, objets, lieux, actions, chiffres) est remplacé ou supprimé.'
    : 'Mode « s\'inspirer » : reprends les mécanismes, jamais les formulations : aucune suite de plus de 4 mots identique au script d\'inspiration, aucune "distinctive_phrase" de l\'analyse narrative.'}
5. Écris pour l'oral : pas d'émojis, pas de hashtags, pas d'indications scéniques entre crochets, nombres écrits comme ils se prononcent.
6. Format de réponse : au lieu du texte brut, rends le script final découpé en paragraphes courts dans "segments" (un paragraphe = un segment, sans titre de section ni timecode), chacun associé au plan de la vidéo (scene_index) sur lequel il doit tomber, dans l'ordre chronologique : le hook sur le premier plan, la révélation ou la chute sur les moments forts.
"notes" : en une ou deux phrases, ce que tu as repris du script d'inspiration et ce que tu as adapté.
JSON strict : {"title":"…","segments":[{"scene_index":0,"text":"…","intent":"accroche|contexte|tension|révélation|chute|cta"}],"notes":"…"}`;
}

export async function rewriteAgent({ visual, narrative, params, referenceScript = '', feedback = '', previous = null, temperature = 0.7 }) {
  const content = `ANALYSE VISUELLE DE LA VIDÉO SOURCE (Agent A) :\n${JSON.stringify(visual)}\n\nANALYSE NARRATIVE DU SCRIPT DE RÉFÉRENCE (Agent B) :\n${JSON.stringify(narrative)}\n` +
    (scriptModeOf(params) === 'adapt' && referenceScript ? `\nSCRIPT DE RÉFÉRENCE À ADAPTER :\n"""\n${referenceScript}\n"""\n` : '') +
    (previous ? `\nVERSION PRÉCÉDENTE :\n${JSON.stringify(previous)}\n` : '') +
    (feedback ? `\nCORRECTIONS DEMANDÉES (contrôle qualité / utilisateur) :\n${feedback}\n` : '');
  return textJSON({ system: rewriteSystem(params), content, temperature, label: 'Agent C' });
}

// Transformation d'un script existant (éventuellement modifié à la main) : raccourcir, développer, changer de ton.
export async function transformScript({ segments, visual, params, instruction, referenceScript = '' }) {
  const system = rewriteSystem(params) + `\nTu modifies un script existant selon l'instruction donnée, en conservant les faits, l'ordre des scènes et ce que l'utilisateur a écrit lorsque c'est compatible.
L'INSTRUCTION est prioritaire sur la méthode d'écriture et sur le cadre technique (langue, longueur, ton, structure) : applique-la entièrement. Seule la cohérence avec les images reste impérative ; si l'instruction demande explicitement d'ajouter une information, intègre-la.`;
  const content = `INSTRUCTION : ${instruction}\n\nSCRIPT ACTUEL :\n${JSON.stringify({ segments })}\n\nANALYSE VISUELLE :\n${JSON.stringify(visual)}` +
    (scriptModeOf(params) === 'adapt' && referenceScript ? `\n\nSCRIPT DE RÉFÉRENCE ADAPTÉ :\n"""\n${referenceScript}\n"""` : '');
  return textJSON({ system, content, temperature: 0.5, label: 'Transformation' });
}

// --- Agent D : contrôle qualité -----------------------------------------------------------------

export function ngramOverlap(a, b, n = 5) {
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const grams = (w) => { const g = new Set(); for (let i = 0; i + n <= w.length; i++) g.add(w.slice(i, i + n).join(' ')); return g; };
  const ga = grams(norm(a)), gb = grams(norm(b));
  if (!ga.size) return { ratio: 0, shared: [] };
  const shared = [...ga].filter((g) => gb.has(g));
  return { ratio: shared.length / ga.size, shared: shared.slice(0, 10) };
}

export async function qaAgent({ segments, visual, params, referenceScript }) {
  const text = segments.map((s) => s.text).join(' ');
  const words = wordCount(text);
  const estimated = Math.round((words / (params.wps || wordsPerSecond(params.language))) * 10) / 10;
  const overlap = ngramOverlap(text, referenceScript || '');
  const adapt = scriptModeOf(params) === 'adapt';
  const system = `Tu es l'Agent D « Contrôle qualité ». Tu vérifies une voix off avant sa synthèse vocale.${adapt ? `
Cette voix off est une ADAPTATION du script de référence à une autre vidéo : vérifie qu'elle en garde l'accroche, la structure et le rythme, et qu'il ne reste aucun élément propre à la vidéo de référence qui ne se voit pas dans la nouvelle vidéo.` : ''}
Vérifie : cohérence et logique, adéquation avec les images (aucun fait inventé par rapport à l'analyse visuelle), fluidité à l'oral, force de l'accroche, respect de la durée cible (${params.durationTarget} s ; durée estimée ${estimated} s pour ${words} mots), langue ${langName(params.language)}.
"invented_facts" : toute affirmation non soutenue par l'analyse visuelle.
"verdict" : "ok" si publiable tel quel, "needs_revision" si un problème de gravité "high" existe.
JSON strict : {"scores":{"coherence":0,"video_fit":0,"fluency":0,"hook":0},"issues":[{"severity":"low|medium|high","segment_index":0,"problem":"…","suggestion":"…"}],"invented_facts":["…"],"verdict":"ok|needs_revision","summary":"…"}`;
  const content = `ANALYSE VISUELLE :\n${JSON.stringify(visual)}\n\n${adapt && referenceScript ? `SCRIPT DE RÉFÉRENCE :\n"""\n${referenceScript}\n"""\n\n` : ''}SCRIPT À CONTRÔLER :\n${JSON.stringify(segments)}`;
  const r = await textJSON({ system, content, temperature: 0.1, label: 'Agent D' });
  const issues = Array.isArray(r.issues) ? r.issues : [];
  if (!adapt && overlap.ratio > 0.08) issues.push({ severity: overlap.ratio > 0.2 ? 'high' : 'medium', segment_index: null, problem: `Trop proche du script de référence (${Math.round(overlap.ratio * 100)} % de 5-grammes communs).`, suggestion: 'Reformuler : ' + overlap.shared.slice(0, 3).join(' / ') });
  const durationGap = Math.abs(estimated - params.durationTarget) / params.durationTarget;
  // Durée imposée à la seconde près : au-delà de 10 % d'écart, le script est révisé automatiquement.
  if (durationGap > 0.05) issues.push({ severity: durationGap > 0.1 ? 'high' : 'medium', segment_index: null, problem: `Durée estimée ${estimated} s pour une cible de ${params.durationTarget} s.`, suggestion: estimated > params.durationTarget ? 'Raccourcir.' : 'Développer.' });
  const verdict = issues.some((i) => i.severity === 'high') || (r.invented_facts || []).length ? 'needs_revision' : 'ok';
  return { ...r, issues, verdict, words, estimatedDuration: estimated, overlap: Math.round(overlap.ratio * 1000) / 10 };
}

// --- Publication : légende, description, hashtags ------------------------------------------------

export async function captionAgent({ script, visual, params }) {
  const system = `Tu prépares la publication TikTok d'une vidéo. Langue : ${langName(params.language)}. Public : ${params.audience}.
- "caption" : TITRE de la vidéo, court et accrocheur (max 100 caractères), qui donne envie de regarder sans promesse mensongère.
- "description" : description de 2 à 4 phrases fidèles au contenu de la vidéo, qui complète le titre sans le répéter.
- "hashtags" : 4 à 8 hashtags pertinents (sans #, sans espaces), mélange de larges et de spécifiques ; pas de hashtags trompeurs.
- "cta" : appel à l'action facultatif et naturel (peut être vide).
JSON strict : {"caption":"…","description":"…","hashtags":["…"],"cta":"…"}`;
  const content = `SCRIPT :\n${script}\n\nRÉSUMÉ VISUEL :\n${visual?.summary || ''}`;
  return textJSON({ system, content, temperature: 0.6, reasoning: 'minimal', label: 'Titre et description' });
}
