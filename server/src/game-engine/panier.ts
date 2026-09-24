/**
 * Orchestration d'un match du « Panier » : composition de la table manche
 * après manche, et cumul des manches gagnées jusqu'au vainqueur.
 *
 * Réf. docs/REGLES.md § « Le panier ». Le tour de table est celui de
 * `determinerJoueursAssis`, réutilisé tel quel : à deux joueurs, personne
 * n'est jamais sur le côté, et le donneur avance d'un siège à chaque manche —
 * l'alternance naturelle entre les deux joueurs.
 */
import type { Joueur, JoueurId, MatchPanier, ResultatManche } from '../models/index.js';
import type { CompositionCoup } from './boule.js';
import { determinerJoueursAssis } from './boule.js';

/** Ce que rend `enregistrerResultatManche` pour une friche générale. */
export interface FricheGeneraliseePanier {
  readonly toutLeMondeAFriche: true;
}

const estFricheGeneralisee = (
  resultat: Omit<ResultatManche, 'numero'> | FricheGeneraliseePanier,
): resultat is FricheGeneraliseePanier => 'toutLeMondeAFriche' in resultat;

/** Ouvre un match : personne n'a encore gagné de manche. */
export const initialiserMatchPanier = (
  joueurs: readonly Joueur[],
  manchesAGagner: number,
  montant: number,
): MatchPanier => {
  if (joueurs.length !== 2) {
    throw new Error(`Le panier se joue a deux : ${String(joueurs.length)} joueurs recus`);
  }
  const manchesGagnees: Record<JoueurId, number> = {};
  for (const { id } of joueurs) manchesGagnees[id] = 0;

  return {
    ordreTable: joueurs.map((joueur) => joueur.id),
    manchesAGagner,
    montant,
    manchesGagnees,
    historique: [],
    vainqueurId: null,
  };
};

/** Composition de la table pour une manche donnée : donneur, ordre de jeu. */
export const composerManche = (match: MatchPanier, numeroManche: number): CompositionCoup =>
  determinerJoueursAssis(match, numeroManche);

/**
 * Numéro de la manche à jouer. N'avance qu'une fois la manche effectivement
 * jouée et enregistrée : une friche générale le laisse en place, avec le
 * donneur et la composition de la table.
 */
export const numeroMancheCourant = (match: MatchPanier): number => match.historique.length + 1;

/** Le match est-il gagné ? */
export const estMatchTermine = (match: MatchPanier): boolean => match.vainqueurId !== null;

/**
 * Enregistre l'issue d'une manche.
 *
 * Cas normal : la manche rejoint l'historique, et le vainqueur du match est
 * déclaré dès que ses manches gagnées atteignent l'objectif.
 *
 * Friche générale : comme à La Boule, la manche est rejouée à la même place,
 * avec le même donneur — rien n'est enregistré. Contrairement à La Boule, une
 * redistribution du panier ne conserve aucun joker : chacun en reçoit un
 * nouveau d'office (§ « Le panier »).
 */
export const enregistrerResultatManche = (
  match: MatchPanier,
  numeroManche: number,
  resultat: Omit<ResultatManche, 'numero'> | FricheGeneraliseePanier,
): MatchPanier => {
  const attendu = match.historique.length + 1;
  if (numeroManche !== attendu) {
    throw new Error(`Manche ${String(numeroManche)} enregistree hors de son rang (attendu : ${String(attendu)})`);
  }
  if (estFricheGeneralisee(resultat)) return match;

  const manchesGagnees: Record<JoueurId, number> = { ...match.manchesGagnees };
  manchesGagnees[resultat.gagnantId] = (manchesGagnees[resultat.gagnantId] ?? 0) + 1;

  const historique = [...match.historique, { numero: numeroManche, ...resultat }];
  const vainqueurId =
    (manchesGagnees[resultat.gagnantId] as number) >= match.manchesAGagner ? resultat.gagnantId : null;

  return { ...match, manchesGagnees, historique, vainqueurId };
};
