# Repost Studio — reposts TikTok améliorés par IA

## Installation (Windows)

1. Ouvrez l'onglet **Releases** du dépôt et téléchargez le fichier **ZIP de la dernière version publiée** (par exemple `v1.0.0`). Ne téléchargez pas la branche principale : seule une version publiée garantit d'avoir exactement la même app que tout le monde.
2. Décompressez le ZIP dans un dossier, par exemple `Documents\TikTok Repost Studio`.
3. Double-cliquez sur **Installer.bat** : il installe Node.js, FFmpeg et yt-dlp s'ils manquent (via winget), puis redémarrez l'ordinateur si un outil vient d'être installé.
4. Double-cliquez sur **Lancer Repost Studio.bat** : l'app s'ouvre dans le navigateur sur `http://localhost:4300`.
5. Dans **Paramètres et intégrations API**, collez **vos propres clés** (OpenRouter, FAL) ou activez votre abonnement Claude.

Le numéro de version s'affiche en haut à gauche de l'app (`v1.0.0`).

**Vos données restent chez vous.** L'app tourne uniquement sur votre ordinateur : vos clés sont dans le fichier `.env` et vos projets dans le dossier `data/`, jamais envoyés à l'auteur ni partagés. Le serveur n'accepte que les connexions de votre propre ordinateur et refuse les requêtes venant d'autres sites. Les seuls services contactés sont ceux que vous configurez (OpenRouter, FAL, Claude) et TikTok pour les liens que vous collez.

Licence : utilisation seule, modification et redistribution interdites (voir [LICENSE](LICENSE)).

---

Application web locale qui part de **deux vidéos distinctes** :

1. la **vidéo à modifier** (source visuelle) ;
2. une **vidéo TikTok de référence**, dont le script est extrait pour servir d'**inspiration narrative**.

Elle extrait et transcrit le script de référence, en analyse les mécanismes narratifs, l'**adapte au contenu de la vidéo à modifier** (même accroche, même structure, mêmes tournures, mais un contenu fidèle aux images ; un mode « s'inspirer » écrit à la place un texte entièrement original), génère la voix off, monte une vraie vidéo 9:16 avec arrière-plan flouté et sous-titres, puis exporte en MP4 avec une légende et des hashtags prêts à publier manuellement sur TikTok.

## Démarrage

Prérequis : Node.js ≥ 20, FFmpeg dans le PATH, et facultativement yt-dlp (récupération par lien).

```powershell
cd tiktok-repost-studio
copy .env.example .env      # facultatif : les clés peuvent aussi être saisies dans Paramètres
npm start                   # → http://localhost:4300
```

Ou double-cliquez sur **Lancer Repost Studio.bat**. Le serveur n'écoute que sur `127.0.0.1`. Il n'y a aucune dépendance npm à installer.

Tests de bout en bout (vrai FFmpeg, vraie voix Windows, faux serveur IA) : `npm test`.

## Workflow et dépendances

```
Vidéo à modifier ─► source_fetch ─► source_analyze ─► visual_agent (A) ─┐
                                         │                              ├─► script_agent (C+D) ─► [validation] ─► voice ─► montage ─► [validation] ─► export ─► publication
Lien de référence ─► reference_fetch ─► reference_extract ─► [validation] ─► narrative_agent (B) ─┘                    │
                                                                                                              caption (légende, hashtags)
```

| Étape | Dépend de | Produit |
|---|---|---|
| `source_fetch` | lien TikTok **ou** fichier importé (confirmation des droits) | `source/source.mp4` |
| `source_analyze` | vidéo source | métadonnées, plans (détection FFmpeg), images clés |
| `visual_agent` (A) | analyse technique | description des plans, faits visibles, moments forts |
| `reference_fetch` | lien de référence **ou** fichier importé | `reference/…` + sous-titres publiés |
| `reference_extract` | vidéo/audio de référence **ou** texte collé | transcription horodatée, incertitudes, langue, OCR séparé |
| `reference_script` | validation utilisateur | script de référence validé |
| `narrative_agent` (B) | script de référence validé (+ statistiques si disponibles) | accroche, structure, rythme, mécanismes, formulations à éviter |
| `script_agent` (C + D) | A + B + paramètres (durée, langue, ton, public) | script viral adapté à la vidéo (ou nouveau script original) par passages liés aux plans + contrôle qualité (une révision automatique si nécessaire) |
| `final_script` | validation utilisateur (ou mode automatique) | script final validé |
| `voice` | script final validé + réglages de voix | `voice/voice-vN.mp3`, durée réelle, horodatage des mots |
| `montage` | vidéo source + voix + réglages | `montage/preview-vN.mp4` (720×1280) + rapport de synchronisation |
| `montage_ok` | validation utilisateur | — |
| `export` | montage validé + réglages d'export | `export/final-vN.mp4` (1080×1920, rendu depuis les sources) |

**Réutilisation des résultats** : chaque étape terminée mémorise le hachage de ses entrées (sorties des dépendances + paramètres). Une modification ne rend « à mettre à jour » que les étapes en aval : changer la voix relance voix → montage → export, sans refaire l'analyse vidéo ni le script.

**Reprise** : un arrêt du serveur en plein traitement marque l'étape « interrompue » ; le bouton « Reprendre » relance la chaîne en réutilisant tout ce qui est déjà valide. Les appels aux API externes sont retentés automatiquement (3 tentatives, attente exponentielle) ; les étapes en erreur peuvent être relancées individuellement.

**Données** : `data/projects/<id>/project.json` + fichiers médias du projet. Le lien source, le lien de référence et leurs scripts sont stockés dans des champs séparés (`source`, `reference`, `finalScript`). Toutes les versions (scripts, voix, montages, exports) sont conservées. Journal global : `data/history.jsonl`.

## Architecture

| Couche | Fichiers |
|---|---|
| Interface (SPA sans build) | `public/index.html`, `public/js/app.js` (navigation, pages globales), `public/js/pages.js` (8 pages du workflow), `public/js/montage.js` (timeline) |
| API HTTP + fichiers (lecture par plages) | `server.js` |
| Orchestration (graphe, hachage, reprise) | `lib/pipeline.js` |
| Agents IA | `lib/ai/agents.js`, client `lib/ai/openrouter.js` |
| Vidéo / audio (FFmpeg) | `lib/media.js`, `lib/subtitles.js` |
| Synthèse vocale | `lib/tts.js` |
| TikTok : liens, oEmbed, yt-dlp | `lib/tiktok.js` |
| Stockage, clés, paramètres | `lib/store.js`, `lib/config.js` |

Les clés API sont lues côté serveur (`.env` ou variables d'environnement) et ne sont jamais envoyées au navigateur ; la page Paramètres les écrit dans `.env` sans pouvoir les relire.

## Intégrations externes

| Service | Utilisation | Configuration | Coût |
|---|---|---|---|
| **FFmpeg** (local) | probe, détection des plans, images clés, extraction audio, montage, export | dans le PATH (ou `FFMPEG_PATH` / `FFPROBE_PATH`) | gratuit |
| **yt-dlp** (local) | téléchargement d'une vidéo TikTok à partir de son lien, sous-titres publiés, statistiques publiques | PATH, `%USERPROFILE%\tools\yt-dlp.exe`, ou chemin dans Paramètres ; désactivable | gratuit |
| **TikTok oEmbed** (officiel, public) | titre, auteur, miniature d'un lien | aucune | gratuit |
| **OpenRouter** | transcription audio, OCR, agents A/B/C/D, légendes. Modèle par défaut `google/gemini-3.5-flash` (modifiable) | `OPENROUTER_API_KEY` — https://openrouter.ai/keys | à l'usage ; quelques centimes par projet avec Gemini Flash |
| **FAL — ElevenLabs multilingue v2** | voix off : tons (stabilité/style), vitesse 0,7–1,2, horodatage par mot (sous-titres exacts) | `FAL_KEY` — https://fal.ai/dashboard/keys | à l'usage (≈ 0,10 $ / 1000 caractères, indicatif) |
| **FAL — Inworld TTS** | voix off (voix françaises Hélène, Alain, Mathieu, Étienne…), vitesse appliquée par FFmpeg | `FAL_KEY` | à l'usage |
| **Abonnement Claude (via Claude Code)** | facultatif : remplace OpenRouter pour les tâches texte (analyse narrative, script, contrôle qualité, titre, description, hashtags) ; la transcription et les images restent sur OpenRouter | Claude Code installé et connecté (`claude` puis /login), puis Paramètres → « IA pour les scripts et la publication » | inclus dans l'abonnement (décompté de ses limites) |
| **Voix Windows (SAPI)** | voix off hors ligne gratuite (ex. Hortense fr-FR) ; repli sans clé | aucune | gratuit |

### Publication

La page « Publication TikTok » propose un titre, une description et des hashtags (modifiables, chacun copiable en un clic), puis le téléchargement de la vidéo et d'un fichier texte avec le titre et la description. La publication sur TikTok se fait manuellement : l'application ne publie rien automatiquement.

### Leviers de viralité

- **Accroche optimisée** : après le script, 5 accroches sont écrites et notées sur 40 (curiosité, clarté, émotion, cohérence) ; la mieux notée remplace la première phrase, les autres restent au choix sur la page du script.
- **Titre choc à l'écran** : gros titre en haut de la vidéo pendant les premières secondes (texte de l'accroche, modifiable ; `*mot*` = mot en couleur).
- **Montage dynamique** : zoom « punch-in » une phrase sur deux, calé sur la voix off.
- **Score de viralité** (page Publication) : note sur 100 par critère et corrections applicables en un clic. Il estime la rétention et l'attrait du texte ; il ne garantit pas la viralité.

### Assistant en 5 étapes

« Nouvelle vidéo » ouvre un assistant (`#/p/<id>/go/1` à `5`, `public/js/wizard.js`) : **Liens** (jusqu'à 6 vidéos TikTok du même thème) → **Hook** (choix de la vidéo qui ouvre le montage, avec ses vues) → **Paramètres** (voix en cartes avec écoute, styles de sous-titres, musique, arrière-plan flou, masque des sous-titres incrustés) → **Script** (récupération d'un script viral et adaptation, ou texte libre ; consignes libres à l'IA) → **Génération** (voix off, montage et export enchaînés, validations automatiques). Les pages détaillées restent disponibles.

- **Plusieurs vidéos** : chacune est téléchargée une fois (`source/clips/<id>`), puis un passage de durée équitable de chacune est assemblé en 1080×1920 (`source/source-mix.mp4`), l'accroche en premier. Changer d'accroche réassemble sans retélécharger.
- **Sous-titres** : styles prêts à l'emploi, fond « box » (BorderStyle 3 de libass), animation par phrase ou mot par mot.
- **Masque** : zone dessinée sur une image de la vidéo d'origine, floutée avant la composition ; les nouveaux sous-titres se centrent dessus.
- **Écoute des voix** : échantillon généré une fois par voix et par langue (`data/voice-previews`).

### Originalité et copies

- **Diagnostic d'originalité** (page Publication) : risque d'être classé « contenu non original » par TikTok (part de la vidéo d'origine réutilisée et à l'écran, son d'origine, voix off, texte réécrit, crédit, publication en double), avec une liste de vérifications pour une vidéo à 0 vue.
- **Mode réaction** (page Montage) : votre propre vidéo partage l'écran avec l'originale (écran partagé ou incrustation). Le créateur d'origine est crédité sur la vidéo et dans la description.
- **Statistiques de la vidéo d'origine** (page Vidéo à modifier) : partages et republications, vues, j'aime, avec historique des relevés.
- **Détecteur de copies** (page Vidéo à modifier) : compare l'empreinte visuelle de la vidéo d'origine (dHash 256 bits, 2 images/s, plusieurs recadrages, miroir) à des liens collés ou aux dernières vidéos de comptes donnés, via yt-dlp (`lib/copies.js`). TikTok ne relie pas les réimportations à l'originale et les listes « son »/« hashtag » de yt-dlp sont hors service : la recherche des candidates part de liens de recherche préremplis. Les copies en écran partagé ou très retouchées peuvent passer inaperçues.

## Limites connues et solutions de remplacement

- **Récupération par lien** : TikTok n'offre pas d'API officielle pour télécharger la vidéo d'un tiers. yt-dlp peut échouer (vidéo privée, blocage d'IP — observé lors des tests : « Your IP address is blocked from accessing this post »). L'application l'indique clairement et propose l'**import du fichier** ou, pour la référence, le **texte collé**. N'utilisez cette récupération que pour des contenus que vous avez le droit d'exploiter.
- **Horodatages de transcription** : fournis par le modèle, donc approximatifs ; les passages inaudibles sont marqués `[inaudible]` et signalés, jamais complétés.
- **Sous-titres** : exacts avec ElevenLabs (horodatage par mot) ; avec les autres voix, estimés puis recalés sur les pauses détectées dans l'audio.
- **Synchronisation** : la narration n'est jamais coupée. Si elle dépasse les images, la dernière image est figée (désactivable) ; si la vidéo est plus longue, une coupe aux changements de plan est proposée sans être imposée. Les passages qui ne tombent pas sur le plan qu'ils décrivent sont signalés.
- **Analyse de viralité** : sans statistiques (récupérées par yt-dlp ou saisies à la main), l'analyse parle de mécanismes « potentiellement efficaces ».
