# Asset Grabber — extension Chrome

Capture les assets d'une page **à partir de ses appels réseau**, les liste avec aperçu,
et télécharge ceux que tu choisis dans un sous-dossier de *Téléchargements*.

## Installation (mode développeur)

1. Décompresse le dossier `asset-grabber`.
2. Va sur `chrome://extensions`, active le **Mode développeur** (en haut à droite).
3. Clique **Charger l'extension non empaquetée** et sélectionne le dossier `asset-grabber`.
4. L'icône ambre apparaît dans la barre d'outils.

Fonctionne aussi sur Edge, Brave et tout navigateur Chromium.

## Utilisation

1. Va sur le site, clique sur l'icône de l'extension.
2. **Scanner** : lit immédiatement tous les appels réseau déjà effectués par la page.
3. La grille affiche les assets avec aperçu, filtrables par type
   (Images, SVG, CSS, JS, Polices, Média, Données, Autres), avec leur **taille réelle**.
4. Coche les assets voulus (ou *Tout cocher*), nomme le dossier, puis **Télécharger**.

## Comment les assets sont détectés (réseau, pas HTML)

Contrairement à une analyse du HTML, l'extension se base sur ce que le navigateur
**télécharge réellement**. Deux sources sont fusionnées :

- **Resource Timing** (`performance.getEntriesByType`) — instantané, sans rechargement.
  Liste toutes les ressources déjà chargées, y compris celles injectées par JavaScript.
- **Enregistrement du trafic** (`webRequest`, service worker) — capture les requêtes au
  fil de l'eau, avec le **type MIME** et la **taille exacte** (en-tête `Content-Length`).

### Pour une capture complète (lazy-load, XHR/fetch, vidéo…)

- Clique **Enregistrer le trafic**, puis recharge/scrolle/navigue dans la page pour
  déclencher les chargements différés, puis **Scanner**. Le service worker continue
  d'enregistrer même quand le popup est fermé.
- Ou **↻ Recharger + enregistrer** : recharge la page en enregistrant dès le départ,
  puis scanne automatiquement — le moyen le plus exhaustif.

## Vidéos (HLS, XHR, iframes)

- Les vidéos/audio et playlists `.m3u8`/`.mpd` sont **toujours capturées** en arrière-plan,
  même sans enregistrement, y compris dans les iframes de lecteurs. Lance la vidéo, puis ouvre l'extension.
- Une playlist **HLS** (`.m3u8`) est téléchargée comme **un seul `.mp4`** (lisible dans QuickTime) :
  meilleure qualité, segments assemblés, chiffrement AES-128 déchiffré, sans réencodage.
- Codec autre que H.264/AAC (HEVC, AC-3, MP3…) → gardé en `.ts` (VLC).
- Piste audio séparée → 2 fichiers. Fusion : `ffmpeg -i video.mp4 -i video-audio.m4a -c copy out.mp4`
- Non pris en charge : DRM (SAMPLE-AES, Widevine…), DASH (seul le manifeste est téléchargé).

## Images WebP/AVIF → PNG

Activé par défaut (case *WebP/AVIF → PNG* au-dessus du dossier, mémorisée). Le format réel est lu
dans chaque image, même si son URL ou son type MIME masque le WebP/AVIF
(`image.png?format=webply` est bien converti). WebP animé → première image seulement.

## Images originales

Coche **Images originales** au-dessus du dossier pour télécharger les images et SVG
en retirant les paramètres de redimensionnement/recadrage de leur URL (`w`, `width`,
`wid`, `h`, `height`, `hei`, `maxwidth`, `maxheight`, leurs variantes avec tiret ou
underscore, `resize`, `size`, `fit`, `crop`, `rect`, `dpr`, `scale`, `scl`,
`imwidth`, `imheight`, `imagewidth`, `imageheight`).
Le choix est mémorisé et désactivé par défaut. Les autres types d'assets sont inchangés.

Les URLs réseau des proxies Next.js (`/_next/image?url=…`) et Cloudflare
(`/cdn-cgi/image/…/source`) sont remplacées par l'URL source avant nettoyage.
Le fichier prend le nom de cette source.

La conversion **WebP/AVIF → PNG** reste indépendante : coche-la pour convertir
également les originaux, décoche-la pour garder les octets servis. Les autres paramètres
(format, qualité, tokens…) sont conservés tels quels. Les aperçus, tailles et dimensions
affichés restent ceux de la version captée par le navigateur.

La version originale dépend du serveur : les transformations dans le chemin de l'URL
des services non reconnus ne sont pas retirées, et une URL signée peut être refusée après modification.
En cas d'échec, décoche l'option pour télécharger la version affichée.

## Limites (sécurité Chrome)

- Les fichiers vont dans un **sous-dossier de *Téléchargements*** (nom au choix). Chrome
  interdit aux extensions d'écrire ailleurs sans dialogue par fichier.
- Si Chrome demande où enregistrer chaque fichier :
  `Paramètres → Téléchargements` → désactive « Toujours demander où enregistrer ».
- Les URLs `blob:` et `data:` (générées en mémoire) ne sont pas re-téléchargeables et sont ignorées.
- Le Resource Timing peut ne pas donner la taille des ressources tierces (affichage du type
  à la place) ; l'enregistrement du trafic, lui, récupère la taille via les en-têtes.
