# ZEN HUE LGTV — Lumières pour webOS

**Lumières** est une application pour piloter son éclairage Philips Hue depuis une TV LG webOS, avec la télécommande ou son pointeur. Elle communique avec le pont Hue sur le réseau local, après association par le bouton du pont.

## Fonctions

- Afficher les pièces et leurs lampes, les allumer ou les éteindre et régler leur luminosité.
- Régler la couleur ou la température du blanc sur les lampes compatibles, avec un aperçu en direct et la possibilité d'annuler.
- Activer les scènes existantes et enregistrer une ambiance statique à partir de l'état d'une pièce.
- Activer ou désactiver les automatisations Hue existantes prises en charge.

La création et la modification des horaires d'automatisation restent à effectuer dans l'application Hue. Les effets animés et dégradés ne sont pas enregistrés dans les ambiances statiques.

## Matériel testé

- **TV :** LG OLED65C28LB, webOS 26, version système indiquée 11.2.0-3704.
- **Pont :** Philips Hue Bridge Pro, sur le même réseau local que la TV.
- **Installation utilisée pour les tests :** TV rootée avec Homebrew Channel et service JavaScript local installé.

Les autres modèles de TV, versions de webOS et ponts Hue n'ont pas été vérifiés. Le dépôt contient le code source, pas un paquet universel prêt à installer : la configuration du pont est nécessaire avant la construction, comme indiqué plus bas.

## Installation

La méthode ci-dessous utilise le même service d'installation que celui employé sur la TV testée, avec un transfert par SSH. Elle doit être adaptée et vérifiée sur d'autres téléviseurs. Elle demande de construire un paquet personnalisé : l'application n'est pas actuellement dans le catalogue Homebrew Channel et aucune version prête à installer n'est fournie dans ce dépôt.

### 1. Prérequis

- Une TV LG déjà rootée, avec [Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel) installé et son serveur SSH activé ; un accès SSH fonctionnel à la TV en tant que `root`.
- Un pont Hue accessible sur le même réseau local, ainsi que son adresse IP et son identifiant `bridgeid`.
- Un ordinateur sur le même réseau, avec Git, Node.js, npm et le [CLI webOS TV de LG](https://webostv.developer.lge.com/develop/tools/cli-dev-guide). Le mode Développeur seul n'a pas été testé avec cette application.

L'adresse IP et l'identifiant du pont peuvent être consultés dans ses informations réseau ou dans l'application Hue. Selon le modèle et sa configuration, `http://ADRESSE_DU_PONT/api/config` peut également retourner un objet contenant `bridgeid`. Cette adresse ne fonctionne pas nécessairement sur tous les ponts. Vérifier l'identifiant avant de l'utiliser pour la vérification TLS ; ne pas partager la réponse complète de configuration.

### 2. Récupérer et configurer le projet

Sur l'ordinateur :

```sh
git clone https://github.com/tollem/ZEN-HUE-LGTV.git
cd ZEN-HUE-LGTV
```

Modifier les deux fichiers suivants dans cette copie locale :

1. Dans `service/com.samuel.huetv.service/bridge.js`, remplacer l'identifiant d'exemple `0000000000000000` de `BRIDGE_ID` par le véritable identifiant hexadécimal du pont, puis l'adresse `192.168.1.100` de `DEFAULT_IP` par l'adresse locale du pont.
2. Dans `frontend/app.js`, remplacer `192.168.1.100` dans le champ `bridge-ip` par la même adresse. Ce champ pourra aussi être modifié lors de l'association sur la TV.

Le service n'accepte que le pont correspondant à `BRIDGE_ID` et vérifie son certificat. Ne pas désactiver ces vérifications. Les modifications contiennent des informations propres au réseau local : ne pas les publier dans un dépôt public.

### 3. Construire le paquet

Si le CLI webOS TV n'est pas encore installé, l'installer une fois sur l'ordinateur :

```sh
npm install -g @webos-tools/cli
```

Depuis le dossier du projet, créer le paquet contenant **l'application et son service** :

```sh
mkdir -p dist
ares-package -o dist frontend service/com.samuel.huetv.service
```

Le fichier créé porte l'extension `.ipk` et se trouve dans `dist/`. Il contient la configuration de votre pont ; ne le partagez pas publiquement.

### 4. Transférer et installer sur la TV

Dans les commandes suivantes, remplacer `ADRESSE_IP_DE_LA_TV` par l'adresse de la TV et le chemin du fichier par celui affiché à l'étape précédente. L'exemple correspond à la version 1.3.3 ; adapter le numéro si nécessaire.

Sur l'ordinateur, transférer le paquet, puis ouvrir une connexion SSH à la TV :

```sh
scp dist/com.samuel.huetv_1.3.3_all.ipk root@ADRESSE_IP_DE_LA_TV:/tmp/lumieres.ipk
ssh root@ADRESSE_IP_DE_LA_TV
```

Sur la TV, lancer l'installation locale, comme dans la [procédure manuelle webOS Homebrew](https://github.com/webosbrew/webos-homebrew-channel#manual) :

```sh
luna-send-pub -i 'luna://com.webos.appInstallService/dev/install' '{"id":"com.ares.defaultName","ipkUrl":"/tmp/lumieres.ipk","subscribe":true}'
```

Attendre le message final de réussite ou d'erreur ; la première réponse ne confirme pas nécessairement que l'installation est terminée. Si la commande reste abonnée après la fin, `Ctrl+C` permet de revenir au terminal. Les étapes de root et de configuration de SSH dépendent du modèle et de la version de webOS ; elles ne sont pas couvertes ici.

Sur la TV testée, l'installation rendait certains fichiers applicatifs accessibles en écriture à d'autres comptes. Les droits ont été resserrés sur les répertoires de l'application, du service et du paquet uniquement, sans modifier leurs répertoires parents. Depuis le terminal de la TV :

```sh
for chemin in \
  /media/developer/apps/usr/palm/applications/com.samuel.huetv \
  /media/developer/apps/usr/palm/services/com.samuel.huetv.service \
  /media/developer/apps/usr/palm/packages/com.samuel.huetv
do
  if [ -d "$chemin" ] && [ ! -L "$chemin" ]; then
    chmod -R go-w "$chemin"
  else
    echo "Répertoire absent ou lien : $chemin ; vérifiez l'installation."
  fi
done
```

Les chemins et le comportement peuvent différer sur d'autres versions de webOS ; ne pas élargir les permissions pour contourner une erreur.

### 5. Associer le pont

Ouvrir **Lumières** depuis la liste des applications de la TV. Vérifier l'adresse du pont, appuyer sur son bouton physique, puis sélectionner **Associer** dans la minute. Les pièces et les lampes devraient ensuite apparaître.

Le service doit pouvoir créer et utiliser un dossier privé pour conserver la clé d'association. Selon la configuration de la TV, une préparation des droits peut être nécessaire. Si l'application indique que le stockage privé est indisponible, vérifier les droits et l'identité du service sur la TV concernée : son identifiant système ne doit pas être copié depuis une autre TV. Ne pas rendre le dossier accessible à tous ni supprimer une association existante pour contourner l'erreur.

## Utilisation

Ouvrir **Lumières** depuis la liste des applications de la TV. Lors de la première association, appuyer sur le bouton physique du pont, puis choisir **Associer** sur la TV. L’adresse peut être modifiée si elle change. Le service accepte uniquement le pont Hue configuré avant la construction.

Pour régler une lampe, ouvrir **Couleur**. Le disque des couleurs apparaît uniquement si la lampe prend en charge les couleurs ; le disque des blancs apparaît lorsqu'elle prend en charge le réglage de température. Avec le pointeur, choisir une position puis **Appliquer** ; avec les flèches, appuyer sur **OK** pour régler le disque, déplacer le curseur et appuyer à nouveau sur **OK**. La lampe suit les déplacements en direct. **Retour** ou **Annuler** rétablit son état précédent ; si l'application est interrompue, elle propose de le rétablir à sa prochaine ouverture. Les couleurs visibles à l'écran restent indicatives et la température est limitée à la plage propre à chaque lampe.

La restauration dépend de la connexion au pont et à la lampe ; l'application signale si elle ne peut pas la confirmer. Depuis l'écran principal, appuyer deux fois sur **Retour** pour afficher la confirmation de sortie.

Les lampes non joignables sont signalées. Une commande générale tente les autres lampes et indique les échecs éventuels. Les scènes existantes peuvent être activées et une nouvelle ambiance statique peut enregistrer l'état des lampes d'une pièce. L'enregistrement est refusé si une lampe est injoignable ou si un effet ne peut pas être conservé ; une scène statique ne reproduit pas les animations dynamiques.

La page Automatisations permet d'activer et de désactiver les routines existantes de catégorie « automation ». Les comportements d'accessoires sont exclus. Les scènes intelligentes programmées ne sont pas incluses, et la création ou la modification des horaires reste à faire dans l'application Hue.

## Confidentialité et sécurité

La communication avec le pont reste sur le réseau local et utilise HTTPS avec validation de la CA Hue et de l'identité du pont. Le service webOS conserve la clé d'association dans `/media/internal/com.samuel.huetv/bridge.json`, avec un dossier de mode 0700 et un fichier de mode 0600 appartenant au compte du service. La clé n'est pas incluse dans le code ou le paquet et n'est pas envoyée à l'interface.

Les droits du système ne protègent pas cette clé d'un accès root. Les services de débogage et les services Homebrew privilégiés accessibles depuis le réseau peuvent exposer la TV et ses données : vérifier leur configuration avant toute utilisation sur un réseau non fiable.

L'installation webOS peut rendre les fichiers applicatifs accessibles en écriture au groupe ou aux autres utilisateurs ; les droits doivent être resserrés après installation et revérifiés après une mise à jour. Les répertoires parents du système restent partagés : la séparation effective entre applications dépend aussi du confinement webOS.

Pour supprimer l'accès au pont, le retirer dans la gestion des applications autorisées de Hue. Désinstaller l'application ne garantit pas la révocation de l'association sur le pont ; les données stockées séparément sur la TV doivent aussi être supprimées si souhaité.

## Développement

`frontend/` contient l'interface et `service/com.samuel.huetv.service/` le service local. Les paquets sont conservés dans `dist/`. Aucun mode de démonstration ne s'active sans le paramètre explicite `?demo=1`.

Tests du service :

```sh
node --test service/tests/bridge.test.js
```

Tests de l’interface en navigateur simulé (Node.js 20 ou plus récent) :

```sh
cd tests
npm ci
npx playwright install chromium
npm test
```

Ces tests utilisent exclusivement le mode de démonstration et un serveur local ; ils ne contactent ni le pont Hue ni la TV. `playwright` est une dépendance de développement isolée dans `tests/` : elle n’est pas incluse dans le paquet TV. Pour utiliser un navigateur Chromium déjà installé, le définir au lieu de télécharger Chromium, par exemple sous macOS :

```sh
HUE_TEST_BROWSER='/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' npm test
```

L'interface inclut la bibliothèque officielle LG webOSTV.js 1.2.13 (licence Apache 2.0, dans `frontend/webOSTVjs/`).
