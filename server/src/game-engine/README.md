# `src/game-engine`

Logique **pure** du jeu, sans aucune dépendance réseau et entièrement testable
unitairement : validation des poses (51 points + tierce pure), calcul des
points, gestion des tours, friche généralisée, carte collante / sous-collante,
récupération de joker, détection double / triple / croix, scoring de fin de
Boule.

Toute règle implémentée ici doit renvoyer explicitement à la section
correspondante de [`docs/REGLES.md`](../../../docs/REGLES.md), qui est la
référence unique du jeu.
