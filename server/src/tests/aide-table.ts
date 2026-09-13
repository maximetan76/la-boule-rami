/** Aide de test : ouvre un salon et le remplit jusqu'à ce que la partie démarre. */
import type { DelaisDeJeu, GestionDeconnexion } from '../persistence/depot.js';
import type { GameRoomManager, TableId } from '../server/game-room-manager.js';

export interface JoueurDeTest {
  readonly id: string;
  readonly pseudo: string;
}

export const ouvrirTablePleine = async (
  manager: GameRoomManager,
  joueurs: readonly JoueurDeTest[],
  options: {
    readonly gestionDeconnexion?: GestionDeconnexion;
    readonly delais?: DelaisDeJeu;
    readonly alea?: () => number;
  } = {},
): Promise<{ tableId: TableId; codeInvitation: string }> => {
  const createur = joueurs[0] as JoueurDeTest;
  const { tableId, codeInvitation } = await manager.creerTable(createur, {
    capacite: joueurs.length,
    ...options,
  });

  for (const joueur of joueurs.slice(1)) {
    await manager.rejoindreParCode(codeInvitation, joueur);
  }
  return { tableId, codeInvitation };
};
