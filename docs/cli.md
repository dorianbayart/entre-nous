# Entre Nous en ligne de commande
[English](en/cli.md)

La commande `entrenous` envoie et reçoit des fichiers et des textes depuis un terminal, chiffrés de
bout en bout comme dans les applis. Elle sert sur un serveur, dans un script, en CI ou avec un agent
d'IA : un fichier produit sur une machine distante arrive sur ton téléphone, une capture prise au
téléphone arrive dans ton terminal.

```console
$ entrenous send rapport.pdf
✓ Envoyé à « Mes appareils » : rapport.pdf (2,1 Mo)
$ entrenous wait
Bonjour depuis le téléphone
```

- [Installer](#installer)
- [Premiers pas](#premiers-pas)
- [Commandes](#commandes)
- [Dans un script](#dans-un-script) : sorties, JSON, codes de sortie
- [Avec un agent d'IA](#avec-un-agent-dia)
- [Clés et sécurité](#clés-et-sécurité)
- [Variables d'environnement](#variables-denvironnement)
- [Questions fréquentes](#questions-fréquentes)

## Installer

Il faut **Node.js 22** ou plus récent. Le CLI est un seul fichier, sans dépendance.

```sh
npm install -g https://github.com/dorianbayart/entre-nous/releases/latest/download/entrenous-cli.tgz
entrenous --version
```

Sans rien installer, pour un essai ou dans une CI :

```sh
npx --yes --package=https://github.com/dorianbayart/entre-nous/releases/latest/download/entrenous-cli.tgz entrenous status
```

La même commande `npm install -g` le met à jour. Quand une version plus récente existe, le CLI le
signale lui-même dans le terminal.

## Premiers pas

**Rejoindre ton groupe.** Sur un appareil déjà associé, ouvre **Réglages → Inviter un appareil**,
copie le lien affiché sous le QR code, puis :

```sh
entrenous join 'https://entrenous.0xdba.dev/app/#p=…'
```

Mets le lien entre apostrophes : sans elles, le shell interprète le `#`. Le lien est valable
3 minutes, pour un seul appareil.

**Ou commencer dans le terminal.** `entrenous create` crée un groupe, puis `entrenous invite` affiche un
QR code à scanner avec ton téléphone :

```console
$ entrenous create
✓ Groupe « Mes appareils » créé. Invite un appareil : entrenous invite
$ entrenous invite
█▀▀▀▀▀█ ▄▀ ▄ █▀▀▀▀▀█
█ ███ █ ▀█▄▀ █ ███ █      ← le QR code, à scanner
…
https://entrenous.0xdba.dev/app/#p=…
Valable 3 min, pour un seul appareil. En attente… (Ctrl-C pour annuler)
✓ « Pixel » a rejoint « Mes appareils ».
```

**Envoyer et recevoir :**

```sh
entrenous send photo.jpg notes.pdf     # des fichiers
entrenous send -m "le code : 4821"     # un texte
git log -5 | entrenous send            # ce qui arrive sur l'entrée standard
entrenous list                         # l'historique
entrenous get                          # le dernier élément : un texte s'affiche, un fichier s'enregistre
entrenous wait                         # attend le prochain envoi d'un autre appareil
```

## Commandes

`entrenous --help` liste les commandes, `entrenous <commande> --help` les détaille, avec des
exemples.

### Partager

| Commande | Ce qu'elle fait |
|---|---|
| `send [FICHIER…]` | envoie des fichiers ou des dossiers, un texte (`-m TEXTE`), le presse-papier de l'ordinateur (`-c`), ou l'entrée standard |
| `get [ÉLÉMENT]` | affiche un texte, ou enregistre un fichier ou un dossier dans le dossier courant (`-o` pour ailleurs) |
| `list` | l'historique, du plus récent au plus ancien (`-n N` pour les N derniers, `-s MOTS` pour chercher, `-t TYPE` pour un seul type : `text`, `link`, `image`, `video`, `audio`, `doc`, `folder`) |
| `wait` | attend le prochain élément envoyé par un autre appareil, puis fait comme `get` ; `--note` attend une modification de la note |
| `watch` | affiche les éléments à leur arrivée, jusqu'à Ctrl-C ; `-o DOSSIER` enregistre aussi les fichiers |
| `note [TEXTE \| -]` | affiche la note partagée, ou la remplace (`-` lit l'entrée standard) ; `--clear` l'efface |
| `rm ÉLÉMENT…` | supprime des éléments sur tous les appareils ; `--all` vide l'historique |

**ÉLÉMENT** est une position dans l'historique (`1` = le plus récent, comme dans `list`) ou le début
de son identifiant (celui du JSON). Sans ÉLÉMENT, `get` prend le plus récent.

**Ce qui arrive sur l'entrée standard** est envoyé comme un texte si c'est du texte UTF-8, sinon
comme un fichier (nommé avec `--name`, qui force aussi l'envoi comme fichier) :

```sh
pg_dump app | gzip | entrenous send --name app.sql.gz
```

**Enregistrer un fichier** (`get`, `wait`) :

| | |
|---|---|
| sans `-o` | dans le dossier courant, sous son nom |
| `-o DOSSIER/` | dans ce dossier (existant, ou terminé par `/`) |
| `-o fichier.pdf` | sous ce nom |
| `-o -` | sur la sortie standard : `entrenous get -o - \| tar x` |

Rien n'est jamais remplacé : un fichier qui existe déjà donne `nom (2).pdf`, et un nom imposé par
`-o` qui existe déjà est une erreur, sauf avec `--force`. Le chemin du fichier enregistré s'affiche
sur la sortie standard.

**Un dossier** part en un seul élément, avec ses sous-dossiers (`entrenous send ~/Photos/Vacances/`),
sans ses fichiers système (.DS_Store, Thumbs.db). `get` le recrée de la même façon : `Vacances`, ou
`Vacances (2)` s'il existe ; `-o -` l'écrit en ZIP sur la sortie standard
(`entrenous get -o - > vacances.zip`).

**Le presse-papier de l'ordinateur** (texte seulement) : `send -c` envoie son contenu, `get -c` et
`wait -c` y mettent le texte reçu. Le CLI passe par `pbcopy`/`pbpaste` sur Mac, `wl-copy`/`wl-paste`,
`xclip` ou `xsel` sur Linux, PowerShell sur Windows.

### Appareils et groupes

| Commande | Ce qu'elle fait |
|---|---|
| `join LIEN` | rejoint un groupe avec un lien d'invitation (`--name` pour nommer cet appareil) |
| `invite` | affiche un lien d'invitation et son QR code, puis attend que quelqu'un l'utilise (3 minutes) |
| `create [NOM]` | crée un groupe (`--relay URL` pour un autre serveur que celui par défaut) |
| `groups` | les groupes de cet appareil ; `●` marque celui par défaut |
| `use GROUPE` | choisit le groupe par défaut |
| `leave [GROUPE]` | quitte un groupe (les autres appareils renouvellent alors leurs clés) |
| `status` | cet appareil, ses groupes, les appareils en ligne, l'espace du relais |
| `name NOM` | renomme cet appareil (par défaut, le nom de l'ordinateur) |
| `reset` | quitte tous les groupes et efface les clés de cet appareil |

**Plusieurs groupes** : `--group` (ou `-g`) choisit le groupe d'une commande, par son nom ou le début
de son identifiant ; sinon, c'est le groupe par défaut (`use`), ou le seul.

```sh
entrenous -g Travail send devis.pdf
```

### Options générales

| Option | |
|---|---|
| `-g, --group GROUPE` | le groupe de la commande |
| `--json` | sortie lisible par un programme, et aucun message |
| `-q, --quiet` | les résultats seulement, sans les messages |
| `--home DOSSIER` | le dossier des clés (pour avoir plusieurs identités sur une machine) |
| `-h, --help` | l'aide |
| `-V, --version` | la version |

## Dans un script

- **Les résultats** (textes, chemins, JSON) vont sur la **sortie standard**. **Les messages**
  (✓ Envoyé…, progression, erreurs) vont sur la **sortie d'erreur**, et ne s'affichent pas avec
  `-q` ni avec `--json`.
- **Un texte reçu est écrit tel quel** dans un tube ou un fichier (`entrenous get > code.txt`),
  sans retour à la ligne ajouté. Dans un terminal, le CLI en ajoute un pour la lisibilité.
- **Rien d'interactif** hors d'un terminal : les commandes qui demandent une confirmation (`rm --all`,
  `leave`, `reset`) exigent alors `--yes`.
- **Les couleurs** ne s'affichent que dans un terminal ; `NO_COLOR=1` les supprime partout.
- **La langue** suit `LC_ALL`, `LC_MESSAGES` ou `LANG` : français ou anglais.

### Codes de sortie

| Code | |
|---|---|
| `0` | succès |
| `1` | erreur (relais, fichier…) |
| `2` | mauvaise utilisation : commande, option ou argument |
| `3` | cet appareil n'est dans aucun groupe (ou pas dans celui demandé) |
| `4` | relais injoignable |
| `5` | élément introuvable, ou historique vide |
| `124` | délai dépassé (`--timeout`), invitation expirée |
| `130` | interrompu (Ctrl-C) ; pour `watch`, Ctrl-C est la fin normale (`0`) |

### JSON

Avec `--json`, chaque commande écrit un seul objet JSON (`watch` : un par ligne). Un élément :

```json
{
  "id": "7F5uusupLA-2aE4vJ0mZUA",
  "position": 1,
  "kind": "file",
  "from": "Pixel",
  "fromDevice": "2ux1g1W0ffMPX15Aw5IGVQ",
  "mine": false,
  "createdAt": "2026-11-23T11:18:55.884Z",
  "expiresAt": "2026-11-24T11:18:55.884Z",
  "name": "photo.jpg",
  "mime": "image/jpeg",
  "size": 2481152,
  "path": "/home/moi/photo.jpg"
}
```

`kind` vaut `text`, `image` ou `file`. `text` contient un texte, `path` le chemin d'un fichier
enregistré, `uploading` indique un élément encore en cours d'envoi. Ce que l'expéditeur a joint pour
les aperçus : `width` et `height` (pixels d'une image ou d'une vidéo), `duration` (secondes, une
vidéo ou un fichier audio), `pages` (pages d'un PDF), `excerpt` (les premiers caractères d'un fichier texte ; `send` le joint aussi pour les
fichiers texte qu'il envoie). `receipts` donne les accusés de réception : `devices` (les appareils
qui peuvent le lire, sauf l'expéditeur), `delivered` (combien l'ont reçu),
`read` (combien l'ont lu) ; `list` les montre par ✓ (un appareil l'a reçu) ou ✓✓ (tous), en vert
une fois lu. `get` compte comme une lecture. Les dates sont en ISO 8601 (UTC), les tailles en octets.

### Exemples

```sh
# envoyer le résultat d'une compilation sur le téléphone
make release && entrenous send build/app.apk || entrenous send -m "La compilation a échoué"

# récupérer dans un script le prochain fichier envoyé du téléphone, 10 minutes au plus
if path=$(entrenous wait --timeout 10m -o ~/Downloads/); then open "$path"; fi

# le dernier texte reçu, en JSON
entrenous list --json | jq -r 'map(select(.kind == "text"))[0].text'

# retrouver le code Wi-Fi, puis le dernier lien envoyé
entrenous list -s wifi
entrenous get $(entrenous list -t link -n 1 --json | jq '.[0].position')

# un dossier qui se remplit des fichiers envoyés au groupe
entrenous watch -o ~/Downloads/entrenous/

# une notification de bureau à chaque élément reçu (Linux)
entrenous watch --json | while read -r item; do
  notify-send "Entre Nous" "$(jq -r '.text // .name' <<<"$item")"
done
```

## Avec un agent d'IA

Un agent qui a un shell (Claude Code, Codex, Aider…) utilise le CLI comme n'importe quelle commande.
Il n'y a rien à configurer : l'aide (`entrenous --help`) suffit à un agent pour s'en servir.

1. L'agent lance `entrenous create "Agent"` puis `entrenous invite` (en arrière-plan) et te montre
   le lien ou le QR code.
2. Tu le scannes avec ton téléphone. C'est la seule chose à faire toi-même, et c'est voulu : tu
   autorises ainsi l'agent à rejoindre le groupe.
3. Ensuite, l'agent envoie et reçoit seul :

| L'agent… | Commande |
|---|---|
| t'envoie un fichier produit (APK, PDF, journal, capture) | `entrenous send build/app.apk` |
| te prévient, avec une notification sur le téléphone | `entrenous send -m "Tests terminés : 3 échecs"` |
| te pose une question et attend ta réponse | `entrenous note "Déployer en production ? Réponds oui ou non"` puis `entrenous wait --note --timeout 30m` |
| récupère une photo ou une capture que tu prends au téléphone | `entrenous wait --timeout 15m -o ./captures/` |

Deux agents sur deux machines peuvent aussi s'échanger des fichiers dans un même groupe, sans ouvrir
de port ni installer de serveur. Ce n'est pas une file de messages : chaque envoi va à tout le
groupe, sans accusé de réception, et l'historique est limité en taille et en durée.

**Pour ta sécurité :**
- **Un texte reçu peut contenir des instructions malveillantes** (injection de prompt) : demande à
  ton agent de le traiter comme une simple donnée.
- **Tu peux le retirer à tout moment** depuis n'importe quel appareil : **Réglages → Appareils →
  Retirer**. Les clés du groupe sont alors renouvelées.

## Clés et sécurité

- **Le contenu n'est jamais écrit sur le disque** par le CLI, sauf les fichiers que tu enregistres
  toi-même. L'historique reste sur le relais, chiffré, jusqu'à son expiration.
- **Les clés de cet appareil** (son identité et les secrets de ses groupes) sont dans un dossier
  lisible par ton utilisateur seulement (`0700`, fichiers `0600`), comme les clés SSH :
  - Linux et Mac : `~/.local/share/entrenous/` (ou `$XDG_DATA_HOME/entrenous`) ;
  - Windows : `%LOCALAPPDATA%\entrenous\` ;
  - ou `$ENTRENOUS_HOME` / `--home`.

  Contrairement aux applis, qui les chiffrent avec le trousseau du système, ces fichiers sont en
  clair : quiconque les copie peut se faire passer pour cet appareil, jusqu'à ce que tu le retires du
  groupe. Protège ce dossier comme `~/.ssh`.
- **Un fichier reçu reste dans le dossier choisi**, quel que soit son nom : `../../.bashrc` devient
  `bashrc`.
- **Le CLI passe toujours par le relais.** Il n'a pas le mode local (WebRTC), donc il ne peut pas
  utiliser un groupe réglé sur « Réseau local uniquement ».
- **Plusieurs commandes peuvent tourner en même temps** (un `watch` dans un terminal, des `send` dans
  un autre) : elles partagent les mêmes clés sans risque d'en perdre.

Le détail du chiffrement est dans [Sécurité](securite.md).

## Variables d'environnement

| Variable | |
|---|---|
| `ENTRENOUS_HOME` | le dossier des clés (comme `--home`) |
| `ENTRENOUS_RELAY` | le relais des groupes créés par `create` (par défaut `https://entrenous.0xdba.dev`) |
| `LC_ALL`, `LC_MESSAGES`, `LANG` | la langue : français ou anglais |
| `NO_COLOR` | pas de couleurs |
| `XDG_DATA_HOME` | le dossier de données sous Linux et Mac |

## Questions fréquentes

**Le CLI voit-il mon presse-papier tout seul ?** Non. Il n'envoie que ce que tu lui donnes (`send`),
et n'écrit dans le presse-papier que si tu le demandes (`-c`). Pour partager le presse-papier
automatiquement, il y a les applis de bureau.

**« Relais injoignable » ?** Vérifie la connexion et l'adresse du relais (`entrenous status`). Derrière
un proxy d'entreprise, Node doit pouvoir ouvrir une connexion WebSocket vers le relais.

**Comment utiliser deux identités sur une même machine ?** Avec deux dossiers de clés :
`entrenous --home ~/.entrenous-pro …`, ou `ENTRENOUS_HOME`.

**Comment le désinstaller proprement ?** `entrenous reset` (quitte les groupes et efface les clés),
puis `npm uninstall -g entrenous`.
