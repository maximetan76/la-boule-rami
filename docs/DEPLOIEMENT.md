# Déploiement sur Render

Procédure à suivre depuis ton compte Render. Rien ici ne suppose d'accès
particulier : tout se fait depuis l'interface web et le dépôt Git.

## 1. Préparer le dépôt

Le serveur vit dans `server/`. Render doit donc être configuré avec ce
sous-répertoire comme racine, sans quoi il ne trouvera pas `package.json`.

Vérifie avant de pousser :

```bash
cd server && npm run typecheck && npm test && npm run build
```

## 2. Créer la base PostgreSQL

1. Dans le tableau de bord Render : **New** → **Postgres**.
2. Nom : `la-boule-db`. Région : la même que le service web (sinon la latence
   entre les deux double, et l'« Internal Database URL » n'est pas utilisable).
3. Plan : le gratuit suffit pour commencer. Attention, un plan gratuit est
   supprimé après 30 jours d'inactivité — passer en payant avant la mise en
   service réelle.
4. Une fois la base créée, relève l'**Internal Database URL**. C'est celle-ci
   qu'il faut utiliser, pas l'externe : elle reste dans le réseau privé de
   Render et ne traverse pas l'Internet public.

## 3. Créer le service web

1. **New** → **Web Service**, puis connecte le dépôt Git.
2. Réglages :
   - **Root Directory** : `server`
   - **Runtime** : Node
   - **Build Command** : `npm ci && npm run build && npm run db:migrate`
   - **Start Command** : `npm start`
   - **Health Check Path** : `/sante`
3. Instance : le plan gratuit s'endort après inactivité, ce qui coupe les
   WebSocket ouvertes. Pour une partie réelle, prendre au minimum le premier
   plan payant.

`npm run build` lance `prisma generate` avant la compilation TypeScript :
le client Prisma est régénéré à chaque déploiement, il n'a pas à être commité.
`npm run db:migrate` applique les migrations en attente (`prisma migrate
deploy`), sans jamais rien détruire.

## 4. Variables d'environnement

Dans **Environment** du service web, ajoute :

| Variable | Valeur |
| --- | --- |
| `DATABASE_URL` | l'*Internal Database URL* de l'étape 2 |
| `JWT_SECRET` | un secret aléatoire long, par ex. `openssl rand -base64 48` |
| `APPLE_CLIENT_ID` | le Bundle ID de l'app iOS, ou le Services ID Apple |

`JWT_SECRET` est **obligatoire en production** : le serveur refuse de démarrer
sans lui, faute de quoi les sessions ne seraient pas vérifiables d'un
déploiement à l'autre. En développement, son absence fait tirer un secret
éphémère, avec un avertissement.

`APPLE_CLIENT_ID` est **optionnel** : sans lui le serveur démarre normalement,
avertit dans les journaux que l'authentification Apple est désactivée, et
`POST /auth/apple` répond 503 avec un message explicite. Tout le reste — les
autres routes et le WebSocket — fonctionne. C'est ce qui permet de développer
et de déployer avant que l'app iOS et son identifiant Apple n'existent.
| `CORS_ORIGIN` | `*` tant que le seul client est l'app iOS |

`DATABASE_URL_TEST` n'a **rien à faire ici** : elle ne sert qu'aux tests sur ton
poste, et pointe une base jetable qui est vidée à chaque exécution.

Ne définis **pas** `PORT` : Render l'injecte lui-même et le serveur le lit.

Voir `server/.env.example` pour le détail de chaque variable.

Changer `JWT_SECRET` invalide toutes les sessions ouvertes : les joueurs
devront se reconnecter via Apple. C'est le levier à utiliser en cas de fuite.

## 5. Première migration

Tant qu'aucune migration n'existe dans `server/prisma/migrations/`, il faut en
créer une depuis ta machine, une seule fois :

```bash
cd server
DATABASE_URL="<External Database URL>" npx prisma migrate dev --name initial
```

Commite le dossier `prisma/migrations/` produit. Les déploiements suivants se
contenteront de `prisma migrate deploy`, qui applique ce qui manque.

## 6. Côté Apple

1. Sur le portail développeur Apple, active **Sign in with Apple** pour l'App
   ID de l'application.
2. `APPLE_CLIENT_ID` doit valoir exactement l'audience que l'app iOS demande —
   son Bundle ID dans le cas d'une app native. Une valeur qui ne correspond pas
   fait échouer toutes les authentifications en 401, sans autre symptôme.

Le serveur n'a besoin d'aucune clé privée Apple : il ne fait que vérifier la
signature des jetons d'identité avec les clés publiques publiées par Apple, qu'il
récupère et met en cache tout seul.

## 7. L'API en bref

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `POST` | `/auth/apple` | échange un jeton d'identité Apple contre un jeton de session |
| `POST` | `/auth/renouveler` | prolonge un jeton de session encore valide |
| `GET` | `/tables/moi` | où en est le joueur : salon, partie en cours, partie abandonnée, ou rien |
| `POST` | `/tables` | ouvre un salon et rend son code d'invitation |
| `POST` | `/tables/rejoindre` | rejoint un salon par son code |
| `POST` | `/tables/:id/quitter` | libère sa place dans un salon pas encore démarré |
| `POST` | `/tables/:id/abandonner` | clôt définitivement une partie interrompue |
| `PATCH` | `/joueur/pseudo` | change le pseudo du joueur |
| `DELETE` | `/joueur/compte` | supprime le compte du joueur, par anonymisation |
| `GET` | `/sante` | sonde de disponibilité |

Toutes sauf `/auth/*` et `/sante` attendent l'en-tête
`Authorization: Bearer <jeton de session>`.

Le jeu lui-même passe par les WebSocket, jamais par HTTP. Deux événements
sortent du serveur en dehors du jeu proprement dit : `salon`, chaque fois que la
composition d'une table change, et `partie-abandonnee`, poussé aux joueurs
encore connectés au moment où l'un d'eux abandonne.

`quitter` et `abandonner` ne se confondent pas : on quitte un salon qui n'a pas
démarré, en laissant la table vivre sans soi ; on abandonne une partie
commencée, ce qui la clôt pour tout le monde.

`DELETE /joueur/compte` n'efface aucune partie : une partie en cours est
d'abord abandonnée au nom du joueur, un salon quitté ; puis le compte perd son
identifiant Apple et son pseudo (« Joueur supprimé »), ses sessions sont
refusées partout — HTTP, renouvellement, WebSocket — et ses connexions ouvertes
coupées. Une nouvelle connexion avec le même identifiant Apple ouvre un compte
neuf. Les parties archivées restent lisibles par les autres joueurs.

`GET /tables/moi` est le point d'entrée d'un client qui n'a gardé que son jeton
de session — après un redémarrage du serveur ou une réinstallation de l'app. Il
répond `salon`, `en-cours` (avec l'état filtré du joueur si la donne a eu lieu),
`abandonnee` si la partie a été close par un autre joueur en son absence, ou
`aucune`.

## 8. Vérifier

```bash
curl https://<service>.onrender.com/sante
```

Doit répondre `{"ok":true}`.

Les journaux du service affichent `Parties reprises : N` au démarrage lorsqu'il
restait des parties en cours — c'est la reprise décrite ci-dessous.

## Lancer le test PostgreSQL depuis ton poste

La suite de tests tourne sans base : la persistance y est couverte par un dépôt
en mémoire, un client Prisma simulé, et des tests de sérialisation. Reste un
test qui parle vraiment à PostgreSQL — création de salon, places, upsert de
Boule, rechargement, filtre des parties terminées. Il est **ignoré tant que
`DATABASE_URL_TEST` n'est pas défini**.

Pour le lancer :

```bash
cd server
DATABASE_URL_TEST="postgresql://user:pass@localhost:5432/laboule_test" npm test
```

**Cette base est vidée à chaque exécution.** Le test commence par
`prisma db push --force-reset`, qui supprime et recrée toutes les tables. Ne
jamais y pointer une base de développement ni, évidemment, la base Render :
utilise une base dédiée, créée pour l'occasion.

Deux façons simples d'en obtenir une :

- **En local**, avec un PostgreSQL déjà installé :

  ```bash
  createdb laboule_test
  ```

- **Sur Render**, en créant une seconde base `la-boule-db-test` sur le plan
  gratuit et en utilisant son *External Database URL*. Plus lent, mais utile si
  tu n'as pas PostgreSQL en local.

Sans cette variable, `npm test` affiche simplement ces cas comme ignorés.

## Ce qu'un redémarrage coûte

L'état de jeu vit en mémoire et n'est écrit en base qu'à la fin de chaque coup
et à la fin de chaque Boule. Un redémarrage — déploiement, mise en veille,
incident — reprend donc chaque partie au dernier coup terminé : scores cumulés,
croix, ordre de table et coups joués sont intacts, seul le coup en cours est
perdu et redistribué.

Conséquence pratique : un déploiement en pleine partie fait recommencer la donne
en cours aux joueurs. Déployer entre deux parties reste préférable.
