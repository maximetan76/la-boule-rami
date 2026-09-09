# `src/server`

Handlers WebSocket (socket.io) exposant le moteur de jeu aux clients.

Contrainte de sécurité : aucune information cachée (main des autres joueurs,
contenu de la pioche, ordre du talon) ne doit jamais être envoyée à un client
qui n'y a pas droit. Chaque état émis est filtré par joueur avant envoi.
