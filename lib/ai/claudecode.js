// Génération de texte via Claude Code en mode non interactif (`claude -p`) : utilise l'abonnement Claude
// (Pro/Max) connecté sur ce PC, sans clé API. Réservé aux tâches texte : Claude Code ne traite pas l'audio.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { run, retry, ensureDir } from '../util.js';
import { extractJSON } from './openrouter.js';

const CLAUDE = process.env.CLAUDE_CODE_PATH || 'claude';
// Dossier de travail neutre : Claude Code n'y trouve ni CLAUDE.md, ni réglages de projet.
const WORK_DIR = ensureDir(path.join(DATA_DIR, 'claude-code'));
export const CLAUDE_MODELS = [['opus', 'Claude Opus (le plus capable)'], ['sonnet', 'Claude Sonnet (plus rapide, consomme moins de quota)'], ['haiku', 'Claude Haiku (le plus rapide)']];

let statusCache = null;
export async function claudeCodeStatus({ fresh = false } = {}) {
  if (!fresh && statusCache && Date.now() - statusCache.at < 60000) return statusCache.value;
  let value;
  try {
    const { stdout } = await run(CLAUDE, ['auth', 'status'], { timeoutMs: 20000 });
    const s = JSON.parse(stdout);
    value = { installed: true, loggedIn: Boolean(s.loggedIn), subscription: s.authMethod === 'claude.ai',
      reason: !s.loggedIn ? 'Claude Code n\'est pas connecté : lancez « claude » dans un terminal puis /login.' : '' };
  } catch (e) {
    value = { installed: e.code !== 'ENOENT', loggedIn: false, subscription: false,
      reason: e.code === 'ENOENT' ? 'Claude Code n\'est pas installé sur ce PC (https://claude.com/claude-code).' : 'Claude Code ne répond pas : ' + e.message.slice(0, 200) };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

// reasoning (vocabulaire OpenRouter) → effort de Claude Code.
const EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high' };

export async function claudeJSON({ system, content, model = 'opus', reasoning = 'low', label = 'Claude' }) {
  if (typeof content !== 'string') throw Object.assign(new Error('Claude Code ne reçoit que du texte.'), { retryable: false });
  const sysFile = path.join(WORK_DIR, `system-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(sysFile, system + '\n\nRéponds uniquement avec l\'objet JSON demandé, sans texte autour ni bloc de code.', 'utf8');
  try {
    return await retry(async () => {
      let stdout;
      try {
        ({ stdout } = await run(CLAUDE, ['-p', '--output-format', 'json', '--model', model, '--effort', EFFORT[reasoning] || 'low',
          '--tools', '', '--system-prompt-file', sysFile, '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'],
        { cwd: WORK_DIR, input: content, timeoutMs: 300000 }));
      } catch (e) {
        if (e.code === 'ENOENT') throw Object.assign(new Error('Claude Code n\'est pas installé sur ce PC.'), { retryable: false, needsConfig: true });
        stdout = e.stdout; // en cas d'erreur, Claude Code écrit quand même le résultat JSON sur la sortie standard
        if (!stdout) throw Object.assign(new Error('Claude Code a échoué : ' + e.message.slice(0, 300)), { retryable: true });
      }
      let j;
      try { j = JSON.parse(stdout); } catch { throw Object.assign(new Error('réponse illisible de Claude Code'), { retryable: true }); }
      const text = String(j.result ?? '');
      if (j.is_error) {
        if (/usage limit|limit reached|out of (extra )?usage|quota/i.test(text)) {
          throw Object.assign(new Error('Limite d\'utilisation de votre abonnement Claude atteinte : ' + text.slice(0, 200) + ' Patientez jusqu\'à la réinitialisation ou choisissez OpenRouter dans Paramètres.'), { retryable: false, needsConfig: true });
        }
        if (/not logged in|login|authenticat/i.test(text)) throw Object.assign(new Error('Claude Code n\'est pas connecté : lancez « claude » puis /login. (' + text.slice(0, 150) + ')'), { retryable: false, needsConfig: true });
        throw Object.assign(new Error('Claude : ' + text.slice(0, 300)), { retryable: true }); // surcharge (529), coupure réseau…
      }
      try { return extractJSON(text); } catch { throw Object.assign(new Error('Claude n\'a pas renvoyé un JSON valide'), { retryable: true }); }
    }, { attempts: 3, baseMs: 3000, label });
  } finally {
    fs.rmSync(sysFile, { force: true });
  }
}
