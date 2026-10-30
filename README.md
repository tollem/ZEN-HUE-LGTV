# ZEN HUE LGTV — Lumières pour webOS

Application locale pour commander un pont Philips Hue Bridge Pro depuis une TV LG webOS. Elle affiche les pièces, les lampes et les scènes existantes ; elle permet de changer l'état, la luminosité, la couleur et le blanc des lampes compatibles. L'interface fonctionne à la télécommande et au pointeur.

## Utilisation

Ouvrir **Lumières** depuis la liste des applications de la TV. Lors de la première association, appuyer sur le bouton physique du pont, puis choisir **Associer** sur la TV. L’adresse peut être modifiée si elle change. Le service accepte uniquement le pont Hue configuré avant la construction.

Pour régler une lampe, ouvrir **Couleur**. Le disque des couleurs apparaît uniquement si la lampe prend en charge les couleurs ; le disque des blancs apparaît lorsqu'elle prend en charge le réglage de température. Avec le pointeur, choisir une position puis **Appliquer** ; avec les flèches, appuyer sur **OK** pour régler le disque, déplacer le curseur et appuyer à nouveau sur **OK**. La lampe suit les déplacements en direct. **Retour** ou **Annuler** rétablit son état précédent ; si l'application est interrompue, elle propose de le rétablir à sa prochaine ouverture. Les couleurs visibles à l'écran restent indicatives et la température est limitée à la plage propre à chaque lampe.

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

### Configurer le pont avant la construction

Cette copie ne contient pas les informations du pont de l'installation d'origine. Avant de créer un paquet :

1. Dans `service/com.samuel.huetv.service/bridge.js`, remplacer l'identifiant d'exemple `0000000000000000` dans `BRIDGE_ID` par le véritable identifiant de 16 caractères hexadécimaux du pont, puis remplacer l'adresse d'exemple `192.168.1.100` dans `DEFAULT_IP` par son adresse locale.
2. Dans `frontend/app.js`, remplacer la valeur d'exemple `192.168.1.100` dans le champ `bridge-ip` par la même adresse locale. Cette valeur est modifiable depuis l'écran d'association.

Pour obtenir l'identifiant de façon locale, consulter `http://ADRESSE_DU_PONT/api/config` et relever le champ `bridgeid`. Vérifier indépendamment cet identifiant avant de l'utiliser : il sert à valider l'identité TLS du pont et à refuser les autres ponts. Ne pas désactiver la vérification du certificat. Ne pas publier les informations de connexion ou le fichier privé `bridge.json`.

Créer un paquet avec le CLI officiel webOS :

```sh
ares-package -o dist frontend service/com.samuel.huetv.service
```

Le service est limité à l'identité du pont renseignée dans `bridge.js`.

L'interface inclut la bibliothèque officielle LG webOSTV.js 1.2.13 (licence Apache 2.0, dans `frontend/webOSTVjs/`).
