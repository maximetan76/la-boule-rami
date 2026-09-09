/**
 * Détection du multiplicateur de fin de coup.
 *
 * Réf. `docs/REGLES.md` § « Fin d'un coup et scoring » :
 * - « double » : le gagnant a fini toutes ses cartes d'un coup, en une seule
 *   fois, SANS l'aide des combinaisons visibles des autres joueurs ;
 * - « triple » : un double réalisé sans aucun joker normal dans ses
 *   combinaisons — le coucou est autorisé et ne remet pas en cause le triple.
 *
 * Le doublement d'un coup friché est un facteur distinct, appliqué au moment
 * du scoring (§ « Structure d'une Boule ») et hors du périmètre de ce module.
 */
import type { Coup, JoueurId, TypeVictoire } from '../models/index.js';

export const detecterDoubleOuTriple = (coup: Coup, joueurGagnantId: JoueurId): TypeVictoire => {
  const recap = coup.recapitulatifs[joueurGagnantId];
  if (recap === undefined) {
    throw new Error(`Aucun recapitulatif pour le joueur ${joueurGagnantId} dans ce coup`);
  }

  const aFiniEnUneFois = recap.toursAvecPose.length === 1;
  if (!aFiniEnUneFois || recap.aAjouteSurCombinaisonAutrui) return 'simple';

  const combinaisonsDuGagnant = coup.combinaisons.filter(
    (combinaison) => combinaison.proprietaireId === joueurGagnantId,
  );
  const utiliseUnJokerNormal = combinaisonsDuGagnant.some((combinaison) =>
    combinaison.cartes.some((cp) => cp.carte.type === 'joker'),
  );

  return utiliseUnJokerNormal ? 'double' : 'triple';
};
