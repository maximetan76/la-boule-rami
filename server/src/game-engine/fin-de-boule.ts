/**
 * Décompte de fin de Boule.
 *
 * Réf. `docs/REGLES.md` § « Fin de la Boule (tous les coups joués) » :
 * - le score total le plus bas gagne la Boule et reçoit -100 points si ce
 *   score est positif ou nul, -200 s'il est négatif ; en cas d'ex æquo, ce
 *   bonus est partagé à parts égales entre les joueurs à égalité ;
 * - on applique ensuite -100 points par croix accumulée, après le bonus ;
 * - on calcule enfin l'écart entre chaque paire de joueurs, base d'un enjeu
 *   financier optionnel.
 */
import type { Boule, JoueurId, ResultatBoule } from '../models/index.js';

/**
 * Bonus de victoire de Boule quand le score du gagnant est positif ou nul.
 * En cas d'ex æquo, ce montant est divisé entre les joueurs à égalité.
 */
export const BONUS_VICTOIRE_SCORE_POSITIF = -100;
/** Bonus de victoire de Boule quand le score du gagnant est négatif. */
export const BONUS_VICTOIRE_SCORE_NEGATIF = -200;
/** Valeur d'une croix, appliquée à la toute fin de la Boule. */
export const POINTS_PAR_CROIX = -100;

export const calculerFinDeBoule = (boule: Boule): ResultatBoule => {
  const joueursIds = Object.keys(boule.scoresCumules);
  if (joueursIds.length === 0) {
    throw new Error('Impossible de clore une Boule sans joueur');
  }

  const scoreDe = (id: JoueurId): number => boule.scoresCumules[id] ?? 0;
  const meilleurScore = Math.min(...joueursIds.map(scoreDe));

  const gagnantsIds = joueursIds.filter((id) => scoreDe(id) === meilleurScore);

  // Le bonus de victoire est un montant unique, partagé à parts égales entre
  // les ex æquo : -50 chacun à deux, -100/3 chacun à trois. La division n'est
  // pas arrondie, pour que la somme des bonus attribués reste exactement le
  // bonus total ; c'est à l'affichage d'arrondir s'il le faut.
  const bonusTotal =
    meilleurScore < 0 ? BONUS_VICTOIRE_SCORE_NEGATIF : BONUS_VICTOIRE_SCORE_POSITIF;
  const bonusParGagnant = bonusTotal / gagnantsIds.length;

  const bonusVictoire: Record<JoueurId, number> = {};
  const penalitesCroix: Record<JoueurId, number> = {};
  const scoresFinaux: Record<JoueurId, number> = {};

  for (const id of joueursIds) {
    // Un score de 0 pile compte comme positif : bonus de -100.
    const bonus = gagnantsIds.includes(id) ? bonusParGagnant : 0;
    const croix = boule.croix[id] ?? 0;

    bonusVictoire[id] = bonus;
    // Les croix s'appliquent APRÈS le bonus de victoire et n'influencent donc
    // pas la détermination du gagnant de la Boule.
    // `croix === 0` court-circuite le -0 que produirait la multiplication.
    penalitesCroix[id] = croix === 0 ? 0 : croix * POINTS_PAR_CROIX;
    scoresFinaux[id] = scoreDe(id) + bonus + penalitesCroix[id];
  }

  const ecarts: Record<JoueurId, Record<JoueurId, number>> = {};
  for (const a of joueursIds) {
    const ligne: Record<JoueurId, number> = {};
    for (const b of joueursIds) {
      if (a === b) continue;
      ligne[b] = (scoresFinaux[b] ?? 0) - (scoresFinaux[a] ?? 0);
    }
    ecarts[a] = ligne;
  }

  return {
    scoresCumules: { ...boule.scoresCumules },
    gagnantsIds,
    bonusVictoire,
    penalitesCroix,
    scoresFinaux,
    ecarts,
  };
};
