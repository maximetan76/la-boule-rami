/**
 * Phase « Friche / Je joue » en début de coup.
 *
 * Réf. `docs/REGLES.md` § « Phase Friche / Je joue en début de coup » :
 * le joueur à la gauche du donneur parle en premier, puis on tourne à chaque
 * friche. Dès qu'un joueur annonce « je joue », c'est systématiquement le
 * joueur à la gauche du DONNEUR qui commence à jouer, quel que soit l'auteur
 * de l'annonce. Si tous frichent, le coup est redistribué.
 */
import type { Annonce, JoueurId } from '../models/index.js';

export type ResultatAnnonces =
  | { readonly joueurCommence: JoueurId }
  | { readonly toutLeMondeAFriche: true };

/**
 * Déroule le tour de parole.
 *
 * @param joueurs joueurs assis, dans le sens du jeu.
 * @param donneurIndex position du donneur dans `joueurs`.
 * @param demanderAnnonce interroge un joueur. Il n'est appelé que tant que
 * personne n'a annoncé « je joue » : le tour de parole s'arrête là.
 */
export const orchestrerPhaseFricheOuJoue = (
  joueurs: readonly JoueurId[],
  donneurIndex: number,
  demanderAnnonce: (joueurId: JoueurId) => Annonce,
): ResultatAnnonces => {
  if (joueurs.length === 0) {
    throw new Error('Aucun joueur autour de la table');
  }
  if (donneurIndex < 0 || donneurIndex >= joueurs.length) {
    throw new Error(`Donneur hors de la table : index ${String(donneurIndex)}`);
  }

  const premierIndex = (donneurIndex + 1) % joueurs.length;
  const premierJoueur = joueurs[premierIndex] as JoueurId;

  for (let decalage = 0; decalage < joueurs.length; decalage += 1) {
    const joueurId = joueurs[(premierIndex + decalage) % joueurs.length] as JoueurId;
    if (demanderAnnonce(joueurId) === 'je-joue') {
      // Peu importe qui a annoncé : le premier à jouer est toujours celui à la
      // gauche du donneur.
      return { joueurCommence: premierJoueur };
    }
  }

  return { toutLeMondeAFriche: true };
};
