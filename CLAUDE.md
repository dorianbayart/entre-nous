# CLAUDE.md — Entre Nous

Projet perso : presse-papier partagé chiffré de bout en bout (PWA, applis Mac, Linux/Windows,
Android, relais Docker). `BRAINSTORM.md` fait référence pour les décisions de conception ;
`docs/developpement.md` pour les commandes, `docs/` pour la documentation publique.

- Le cœur (`web/src/core/`) ne dépend pas du DOM : il tourne dans le navigateur, la WKWebView
  du Mac et Node (tests). Garder cette propriété.
- Interface : Alpine.js **build CSP** (`@alpinejs/csp`) : pas d'`eval`, donc pas de fonctions
  fléchées ni de template literals dans les attributs HTML ; passer par des méthodes.
- Protocole relais : requêtes JSON `{ rid, op, … }`, réponses `{ rid, ok, … }`, évènements `{ ev, … }`.
  Ne jamais réutiliser `rid` comme champ métier.
- Dépôt public : aucune information d'infrastructure (hébergeur, serveur, chemins, hôtes SSH)
  dans les fichiers versionnés. Le déploiement du relais public est dans `CLAUDE.local.md` et
  `deploy/` (non versionnés).
- Tests : `cd web && npm test`, avec le relais lancé (`docker compose up -d --build` à la racine).
- Le relais ne doit jamais journaliser de contenu ni d'identifiant de salle.
- Pas de version figée pour les images Docker de base (`node:lts-alpine`, `eclipse-temurin:21-jdk`).
- Interface : `native` = appli embarquée (Mac, Linux, Windows, Android), `desktop` = appli de
  bureau (pause, partage automatique, notifications), `mac` = ce qui est propre au Mac (icône
  de la barre des menus).
- Linux/Windows : `desktop/build.sh` (Docker), même pont que le Mac (`platform/desktop.ts`) ;
  non testées sur une vraie machine.
- Android : compiler avec `android/build.sh` (Docker), jamais d'outils installés sur le Mac.
  Ne jamais committer la clé de signature (`~/.config/entrenous/`).
