# La Boule — serveur

Backend Node.js / TypeScript du jeu de cartes **La Boule**.

Les règles complètes et faisant autorité sont dans
[`../docs/REGLES.md`](../docs/REGLES.md) : c'est la référence unique de toute
la logique de jeu.

## Scripts

- `npm run dev` — serveur en développement (rechargement à chaud)
- `npm run build` — compilation TypeScript vers `dist/`
- `npm test` — tests unitaires (vitest)

## Structure

| Dossier | Rôle |
| --- | --- |
| `src/models/` | Types (Carte, Joueur, Combinaison, Coup, Boule, Partie) |
| `src/game-engine/` | Logique pure du jeu, sans réseau |
| `src/server/` | Handlers WebSocket (socket.io) |
| `src/tests/` | Tests unitaires du moteur |
