// Texts of the CLI, in English and French (the language of the environment: LC_ALL,
// LC_MESSAGES, LANG). The engine's own messages come from web/src/i18n, set to the same language.
import { pick, setLang, type Lang } from '../../web/src/i18n/index.ts';

const en = {
  // ---------------------------------------------------------------- help
  tagline: 'Entre Nous in your terminal: a smart clipboard, shared, cross-platform, end-to-end encrypted, ephemeral, no account, no trace.',
  usage: 'Usage',
  commands: 'Commands',
  options: 'Options',
  globalOptions: 'Global options',
  examples: 'Examples',
  docs: 'Documentation',
  'section.share': 'Share',
  'section.devices': 'Devices and groups',
  'help.more': 'Help on a command: entrenous <command> --help',

  'opt.group': 'group to use (name or id), instead of the default one',
  'opt.json': 'machine-readable output (JSON)',
  'opt.quiet': 'print only the results, no messages',
  'opt.home': 'folder of this device’s keys ($ENTRENOUS_HOME)',
  'opt.help': 'show this help',
  'opt.version': 'show the version',
  'opt.yes': 'do not ask for confirmation',
  'opt.timeout': 'give up after this long (30s, 10m, 2h), exit code 124',
  'opt.output': 'where to save a file: a folder, a file name, or - for the standard output',
  'opt.force': 'overwrite an existing file',
  'opt.clipboardGet': 'put the text into this computer’s clipboard instead of printing it',

  'cmd.send': 'Send files, a text (-m) or the standard input',
  'cmd.send.long':
    'Sends to every device of the group. Files are encrypted here, then uploaded in chunks; a text up to 64 KB travels in its announcement. A folder goes as one item, with its subfolders: the apps browse it.\nWith no argument, sends what arrives on the standard input: a text, or a file if it is not UTF-8 text.',
  'opt.send.message': 'send this text',
  'opt.send.clipboard': 'send the text of this computer’s clipboard',
  'opt.send.name': 'name of the file read on the standard input (it is then sent as a file)',

  'cmd.get': 'Print the latest text, or save the latest file',
  'cmd.get.long':
    'ITEM is a position in the history (1 = the latest, as in `entrenous list`) or the beginning of an id. Without ITEM: the latest item.\nA text is printed on the standard output. A file is saved in the current folder under its own name (never overwriting one: “name (2).pdf”), and its path is printed. A folder is recreated there the same way (-o - writes it as a ZIP).',

  'cmd.list': 'Show the history',
  'cmd.list.long': 'The items of the group, the latest first, with their position (for get and rm), their sender and their expiry; ✓ or ✓✓: delivered to one device or to all (green once read).',
  'opt.list.limit': 'show only the N latest',

  'cmd.wait': 'Wait for the next item sent by another device, then get it',
  'cmd.wait.long':
    'Connects, waits for an item sent from another device, then does what `get` does with it (same options). With --note: waits for another device to change the shared note, then prints it.',
  'opt.wait.note': 'wait for the shared note to change',

  'cmd.watch': 'Print the items as they arrive (until Ctrl-C)',
  'cmd.watch.long':
    'One line per item sent by another device: its text, or its name and size. With --output FOLDER, files are also saved there. With --json: one JSON object per line.',
  'opt.watch.output': 'save the files received into this folder',

  'cmd.note': 'Show or change the shared note',
  'cmd.note.long': 'Without TEXT: prints the note. With TEXT (or - to read the standard input): replaces it on every device.',
  'opt.note.clear': 'clear the note on every device',

  'cmd.rm': 'Delete items on every device',
  'cmd.rm.long': 'ITEM is a position (1 = the latest) or the beginning of an id. --all empties the whole history.',
  'opt.rm.all': 'delete the whole history',

  'cmd.join': 'Join a group with an invitation link',
  'cmd.join.long':
    'On a paired device: Settings → Invite a device shows a QR code and, under it, the link to give here (valid 3 minutes, for one device).',
  'opt.join.name': 'name of this device, seen by the others',

  'cmd.invite': 'Invite a device: QR code and link, valid 3 minutes',
  'cmd.invite.long':
    'Prints the invitation link on the standard output (and its QR code on a terminal), then waits until a device has joined. Scan it with a phone, or give the link to `entrenous join` on another computer.',
  'opt.invite.noQr': 'do not draw the QR code',

  'cmd.create': 'Create a group',
  'cmd.create.long': 'A new group, with this device alone in it: then invite the others. NAME defaults to “My devices”.',
  'opt.create.relay': 'relay server of the group ($ENTRENOUS_RELAY, default {relay})',

  'cmd.groups': 'List the groups of this device',
  'cmd.use': 'Choose the default group',
  'cmd.leave': 'Leave a group',
  'cmd.leave.long': 'This device leaves the group: the others renew its keys, and it loses access to the history.',
  'cmd.status': 'This device, its groups, who is online',
  'cmd.name': 'Rename this device',
  'cmd.reset': 'Erase this device: its identity and its groups',
  'cmd.reset.long': 'Leaves every group, then deletes the keys of this device from its folder.',

  // ---------------------------------------------------------------- messages
  'msg.sent': 'Sent to “{group}”: {what}',
  'msg.sentText': 'text',
  'msg.saved': 'Saved: {path}',
  'msg.noItem': 'No item in “{group}”.',
  'msg.noNote': 'No note in “{group}”.',
  'msg.noteSet': 'Note updated on every device of “{group}”.',
  'msg.noteCleared': 'Note cleared on every device of “{group}”.',
  'msg.deleted': 'Deleted: {n}',
  'msg.cleared': 'History of “{group}” deleted.',
  'msg.joined': 'This device joined “{group}”.',
  'msg.inviteValid': 'Valid {left}, for one device. Waiting for it… (Ctrl-C to cancel)',
  'msg.inviteJoined': '“{name}” joined “{group}”.',
  'msg.created': 'Group “{group}” created. Invite a device: entrenous invite',
  'msg.default': 'Default group: “{group}”.',
  'msg.left': 'This device left “{group}”.',
  'msg.renamed': 'This device is now “{name}”.',
  'msg.reset': 'This device is erased.',
  'msg.waiting': 'Waiting for an item in “{group}”… (Ctrl-C to stop)',
  'msg.waitingNote': 'Waiting for the note of “{group}” to change… (Ctrl-C to stop)',
  'msg.watching': 'Watching “{group}”… (Ctrl-C to stop)',
  'msg.confirm': '{what} [y/N] ',
  'msg.confirmLeave': 'Leave “{group}”?',
  'msg.confirmReset': 'Erase this device and leave all its groups?',
  'msg.confirmClear': 'Delete the whole history of “{group}” on every device?',
  'msg.getIt': 'entrenous get {id}',
  'msg.default.mark': 'default',
  'msg.online': 'online',
  'msg.offline': 'offline',
  'msg.you': 'this device',
  'msg.members': 'Devices',
  'msg.relay': 'Relay',
  'msg.keep': 'Kept for',
  'msg.space': 'Space',
  'msg.device': 'This device',
  'msg.home': 'Keys',
  'msg.groups': 'Groups',
  'msg.noGroups': 'No group yet.',
  'msg.expires': 'expires in {d}',
  'msg.update': 'New version available ({v}): npm install -g {url}',

  // ---------------------------------------------------------------- errors
  'err.usage': 'Usage: {usage}',
  'err.unknownCommand': 'Unknown command “{cmd}”.',
  'err.didYouMean': 'Did you mean “{cmd}”?',
  'err.noGroup':
    'This device is not in any group yet.\n  Join one: entrenous join <link>   (on a paired device: Settings → Invite a device)\n  or create one: entrenous create',
  'err.whichGroup': 'This device is in several groups: choose one with --group, or set the default one with `entrenous use`.\n  {groups}',
  'err.unknownGroup': 'No group “{group}”. Groups: {groups}',
  'err.ambiguousGroup': '“{group}” matches several groups: {groups}',
  'err.unreachable': 'Cannot reach the relay {relay}.',
  'err.noSuchItem': 'No item “{item}” in “{group}” (see entrenous list).',
  'err.ambiguousItem': '“{item}” matches several items: give more of its id.',
  'err.noSuchFile': '{path}: no such file. To send a text: entrenous send -m "…"',
  'err.nothingToSend': 'Nothing to send: give files, -m "text", or pipe something in.',
  'err.exists': '{path} already exists (--force to overwrite).',
  'err.textOnly': '--clipboard only takes a text: this item is a file.',
  'err.clipboard': 'No clipboard tool found ({tools}).',
  'err.clipboardEmpty': 'The clipboard is empty.',
  'err.localOnly': '“{group}” is set to “local network only”: its contents never go through the relay, which is all this CLI uses.',
  'err.timeout': 'Timed out.',
  'err.notConfirmed': 'Cancelled. (--yes to skip the question)',
  'err.needsYes': 'This needs a confirmation: add --yes.',
  'err.badDuration': 'Invalid duration “{value}” (examples: 45s, 10m, 2h).',
  'err.badNumber': 'Invalid number “{value}”.',
  'err.inviteExpired': 'The invitation expired: nobody joined.',
  'err.noteTooLong': 'The note is too long ({n} characters, at most {max}).',
} as const;

export type CliKey = keyof typeof en;
type Strings = { [K in CliKey]: string };

const fr: Strings = {
  tagline: 'Entre Nous dans ton terminal : un presse-papier malin, partagé, multiplateforme, chiffré de bout en bout, éphémère, sans compte, sans trace.',
  usage: 'Utilisation',
  commands: 'Commandes',
  options: 'Options',
  globalOptions: 'Options générales',
  examples: 'Exemples',
  docs: 'Documentation',
  'section.share': 'Partager',
  'section.devices': 'Appareils et groupes',
  'help.more': 'Aide d’une commande : entrenous <commande> --help',

  'opt.group': 'groupe à utiliser (nom ou identifiant), au lieu de celui par défaut',
  'opt.json': 'sortie lisible par un programme (JSON)',
  'opt.quiet': 'n’affiche que les résultats, sans les messages',
  'opt.home': 'dossier des clés de cet appareil ($ENTRENOUS_HOME)',
  'opt.help': 'affiche cette aide',
  'opt.version': 'affiche la version',
  'opt.yes': 'ne demande pas de confirmation',
  'opt.timeout': 'abandonne au bout de cette durée (30s, 10m, 2h), code de sortie 124',
  'opt.output': 'où enregistrer un fichier : un dossier, un nom de fichier, ou - pour la sortie standard',
  'opt.force': 'remplace un fichier existant',
  'opt.clipboardGet': 'met le texte dans le presse-papier de cet ordinateur au lieu de l’afficher',

  'cmd.send': 'Envoie des fichiers, un texte (-m) ou l’entrée standard',
  'cmd.send.long':
    'Envoie à tous les appareils du groupe. Les fichiers sont chiffrés ici, puis envoyés par morceaux ; un texte de 64 Ko au plus voyage dans son annonce. Un dossier part en un seul élément, avec ses sous-dossiers : les applis le parcourent.\nSans argument, envoie ce qui arrive sur l’entrée standard : un texte, ou un fichier si ce n’est pas du texte UTF-8.',
  'opt.send.message': 'envoie ce texte',
  'opt.send.clipboard': 'envoie le texte du presse-papier de cet ordinateur',
  'opt.send.name': 'nom du fichier lu sur l’entrée standard (il est alors envoyé comme fichier)',

  'cmd.get': 'Affiche le dernier texte, ou enregistre le dernier fichier',
  'cmd.get.long':
    'ÉLÉMENT est une position dans l’historique (1 = le plus récent, comme dans `entrenous list`) ou le début d’un identifiant. Sans ÉLÉMENT : le plus récent.\nUn texte s’affiche sur la sortie standard. Un fichier est enregistré dans le dossier courant sous son nom (sans jamais en remplacer un : « nom (2).pdf »), et son chemin s’affiche. Un dossier y est recréé de la même façon (-o - l’écrit en ZIP).',

  'cmd.list': 'Affiche l’historique',
  'cmd.list.long': 'Les éléments du groupe, du plus récent au plus ancien, avec leur position (pour get et rm), leur expéditeur et leur expiration ; ✓ ou ✓✓ : reçu par un appareil ou par tous (en vert une fois lu).',
  'opt.list.limit': 'n’affiche que les N plus récents',

  'cmd.wait': 'Attend le prochain élément envoyé par un autre appareil, puis le récupère',
  'cmd.wait.long':
    'Se connecte, attend un élément envoyé depuis un autre appareil, puis fait comme `get` (mêmes options). Avec --note : attend qu’un autre appareil modifie la note partagée, puis l’affiche.',
  'opt.wait.note': 'attend une modification de la note partagée',

  'cmd.watch': 'Affiche les éléments à leur arrivée (jusqu’à Ctrl-C)',
  'cmd.watch.long':
    'Une ligne par élément envoyé par un autre appareil : son texte, ou son nom et sa taille. Avec --output DOSSIER, les fichiers y sont aussi enregistrés. Avec --json : un objet JSON par ligne.',
  'opt.watch.output': 'enregistre les fichiers reçus dans ce dossier',

  'cmd.note': 'Affiche ou modifie la note partagée',
  'cmd.note.long': 'Sans TEXTE : affiche la note. Avec TEXTE (ou - pour lire l’entrée standard) : la remplace sur tous les appareils.',
  'opt.note.clear': 'efface la note sur tous les appareils',

  'cmd.rm': 'Supprime des éléments sur tous les appareils',
  'cmd.rm.long': 'ÉLÉMENT est une position (1 = le plus récent) ou le début d’un identifiant. --all vide tout l’historique.',
  'opt.rm.all': 'supprime tout l’historique',

  'cmd.join': 'Rejoint un groupe avec un lien d’invitation',
  'cmd.join.long':
    'Sur un appareil déjà associé : Réglages → Inviter un appareil affiche un QR code et, dessous, le lien à donner ici (valable 3 minutes, pour un seul appareil).',
  'opt.join.name': 'nom de cet appareil, vu par les autres',

  'cmd.invite': 'Invite un appareil : QR code et lien, valables 3 minutes',
  'cmd.invite.long':
    'Affiche le lien d’invitation sur la sortie standard (et son QR code dans un terminal), puis attend qu’un appareil l’utilise. Scanne-le avec un téléphone, ou donne le lien à `entrenous join` sur un autre ordinateur.',
  'opt.invite.noQr': 'ne dessine pas le QR code',

  'cmd.create': 'Crée un groupe',
  'cmd.create.long': 'Un nouveau groupe, avec cet appareil seul dedans : invite ensuite les autres. NOM vaut « Mes appareils » par défaut.',
  'opt.create.relay': 'serveur relais du groupe ($ENTRENOUS_RELAY, {relay} par défaut)',

  'cmd.groups': 'Liste les groupes de cet appareil',
  'cmd.use': 'Choisit le groupe par défaut',
  'cmd.leave': 'Quitte un groupe',
  'cmd.leave.long': 'Cet appareil quitte le groupe : les autres renouvellent ses clés, et il perd l’accès à l’historique.',
  'cmd.status': 'Cet appareil, ses groupes, qui est en ligne',
  'cmd.name': 'Renomme cet appareil',
  'cmd.reset': 'Efface cet appareil : son identité et ses groupes',
  'cmd.reset.long': 'Quitte tous les groupes, puis supprime les clés de cet appareil de son dossier.',

  'msg.sent': 'Envoyé à « {group} » : {what}',
  'msg.sentText': 'texte',
  'msg.saved': 'Enregistré : {path}',
  'msg.noItem': 'Aucun élément dans « {group} ».',
  'msg.noNote': 'Aucune note dans « {group} ».',
  'msg.noteSet': 'Note mise à jour sur tous les appareils de « {group} ».',
  'msg.noteCleared': 'Note effacée sur tous les appareils de « {group} ».',
  'msg.deleted': 'Supprimés : {n}',
  'msg.cleared': 'Historique de « {group} » supprimé.',
  'msg.joined': 'Cet appareil a rejoint « {group} ».',
  'msg.inviteValid': 'Valable {left}, pour un seul appareil. En attente… (Ctrl-C pour annuler)',
  'msg.inviteJoined': '« {name} » a rejoint « {group} ».',
  'msg.created': 'Groupe « {group} » créé. Invite un appareil : entrenous invite',
  'msg.default': 'Groupe par défaut : « {group} ».',
  'msg.left': 'Cet appareil a quitté « {group} ».',
  'msg.renamed': 'Cet appareil s’appelle maintenant « {name} ».',
  'msg.reset': 'Cet appareil est effacé.',
  'msg.waiting': 'En attente d’un élément dans « {group} »… (Ctrl-C pour arrêter)',
  'msg.waitingNote': 'En attente d’une modification de la note de « {group} »… (Ctrl-C pour arrêter)',
  'msg.watching': 'À l’écoute de « {group} »… (Ctrl-C pour arrêter)',
  'msg.confirm': '{what} [o/N] ',
  'msg.confirmLeave': 'Quitter « {group} » ?',
  'msg.confirmReset': 'Effacer cet appareil et quitter tous ses groupes ?',
  'msg.confirmClear': 'Supprimer tout l’historique de « {group} » sur tous les appareils ?',
  'msg.getIt': 'entrenous get {id}',
  'msg.default.mark': 'par défaut',
  'msg.online': 'en ligne',
  'msg.offline': 'hors ligne',
  'msg.you': 'cet appareil',
  'msg.members': 'Appareils',
  'msg.relay': 'Relais',
  'msg.keep': 'Conservation',
  'msg.space': 'Espace',
  'msg.device': 'Cet appareil',
  'msg.home': 'Clés',
  'msg.groups': 'Groupes',
  'msg.noGroups': 'Aucun groupe pour l’instant.',
  'msg.expires': 'expire dans {d}',
  'msg.update': 'Nouvelle version disponible ({v}) : npm install -g {url}',

  'err.usage': 'Utilisation : {usage}',
  'err.unknownCommand': 'Commande inconnue « {cmd} ».',
  'err.didYouMean': 'Tu voulais dire « {cmd} » ?',
  'err.noGroup':
    'Cet appareil n’est encore dans aucun groupe.\n  Pour en rejoindre un : entrenous join <lien>   (sur un appareil associé : Réglages → Inviter un appareil)\n  ou pour en créer un : entrenous create',
  'err.whichGroup': 'Cet appareil est dans plusieurs groupes : choisis-en un avec --group, ou règle celui par défaut avec `entrenous use`.\n  {groups}',
  'err.unknownGroup': 'Aucun groupe « {group} ». Groupes : {groups}',
  'err.ambiguousGroup': '« {group} » correspond à plusieurs groupes : {groups}',
  'err.unreachable': 'Relais injoignable : {relay}.',
  'err.noSuchItem': 'Aucun élément « {item} » dans « {group} » (voir entrenous list).',
  'err.ambiguousItem': '« {item} » correspond à plusieurs éléments : donne plus de caractères de son identifiant.',
  'err.noSuchFile': '{path} : fichier introuvable. Pour envoyer un texte : entrenous send -m "…"',
  'err.nothingToSend': 'Rien à envoyer : donne des fichiers, -m "texte", ou envoie quelque chose sur l’entrée standard.',
  'err.exists': '{path} existe déjà (--force pour le remplacer).',
  'err.textOnly': '--clipboard ne prend qu’un texte : cet élément est un fichier.',
  'err.clipboard': 'Aucun outil de presse-papier trouvé ({tools}).',
  'err.clipboardEmpty': 'Le presse-papier est vide.',
  'err.localOnly': '« {group} » est réglé sur « Réseau local uniquement » : ses contenus ne passent jamais par le relais, le seul chemin de ce CLI.',
  'err.timeout': 'Délai dépassé.',
  'err.notConfirmed': 'Annulé. (--yes pour ne pas avoir la question)',
  'err.needsYes': 'Il faut une confirmation : ajoute --yes.',
  'err.badDuration': 'Durée invalide « {value} » (exemples : 45s, 10m, 2h).',
  'err.badNumber': 'Nombre invalide « {value} ».',
  'err.inviteExpired': 'L’invitation a expiré : personne ne l’a utilisée.',
  'err.noteTooLong': 'La note est trop longue ({n} caractères, {max} au plus).',
};

const dict: Record<Lang, Strings> = { en, fr };
let current: Lang = 'en';

/** The language of the environment (LC_ALL, LC_MESSAGES, LANG, then the system's), for the CLI and the engine. */
export function initLang(env = process.env) {
  const prefs = [env.LC_ALL, env.LC_MESSAGES, env.LANG].filter((v): v is string => !!v && v !== 'C' && v !== 'POSIX');
  if (!prefs.length) prefs.push(Intl.DateTimeFormat().resolvedOptions().locale);
  current = pick(prefs);
  setLang(current);
}

export const lang = () => current;

/** The text of `key`, with its {placeholders} filled. */
export function tr(key: CliKey, vars?: Record<string, string | number>): string {
  const s = dict[current][key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}
