/**
 * La parole « Friche / Je joue », tant que personne n'a posé.
 *
 * Réf. docs/REGLES.md § « Phase Friche / Je joue ». On joue toujours dans
 * l'ordre de la table ; seule la parole peut prendre de l'avance sur le jeu.
 *
 * - Le joueur dont c'est le tour de parler annonce « friche » ou « je joue ».
 * - « Friche » : il rejoint la file d'attente, et la parole passe au suivant.
 *   Quand la file compte tous les joueurs, le coup est redistribué.
 * - « Je joue » : ceux de la file jouent chacun leur tour, dans l'ordre ;
 *   puis celui qui a dit « je joue » parle de nouveau — il peut refricher.
 *   Sans personne en attente, il joue son tour aussitôt.
 * - Après chaque tour joué, la parole revient au joueur suivant.
 * - Dès qu'une combinaison est posée, la friche est close pour tout le coup :
 *   on joue sans plus rien annoncer.
 *
 * Un tour joué depuis la file est un tour ordinaire, sans restriction : seule
 * l'annonce lui a été ôtée.
 */
import type { Annonce, Coup, JoueurId } from '../models/index.js';

const suivant = (coup: Coup, joueurId: JoueurId): JoueurId => {
  const rang = coup.ordreJoueurs.indexOf(joueurId);
  return coup.ordreJoueurs[(rang + 1) % coup.ordreJoueurs.length] as JoueurId;
};

/** On peut encore fricher tant que personne n'a posé. */
export const frichePossible = (coup: Coup): boolean => coup.combinaisons.length === 0;

/** Le joueur dont on attend l'annonce, ou `null` hors des annonces. */
export const joueurQuiParle = (coup: Coup): JoueurId | null => {
  if (coup.phase !== 'annonces') return null;
  return coup.aParler ?? coup.joueurActifId;
};

export interface ResultatAnnonce {
  readonly coup: Coup;
  /** Tous ont friché d'affilée : le coup est à redistribuer. */
  readonly toutLeMondeAFriche: boolean;
}

/** Une annonce, faite par le joueur dont c'est le tour de parler. */
export const annoncer = (coup: Coup, joueurId: JoueurId, annonce: Annonce): ResultatAnnonce => {
  if (coup.phase !== 'annonces') throw new Error("Ce n'est pas le moment d'annoncer");
  if (joueurQuiParle(coup) !== joueurId) throw new Error(`Ce n'est pas a ${joueurId} de parler`);

  const annonces = { ...coup.annonces, [joueurId]: annonce };
  const file = coup.enAttente ?? [];

  if (annonce === 'friche') {
    const enAttente = [...file, joueurId];
    if (enAttente.length >= coup.ordreJoueurs.length) {
      return { coup: { ...coup, annonces, enAttente, aParler: null }, toutLeMondeAFriche: true };
    }
    return {
      coup: { ...coup, annonces, enAttente, aParler: suivant(coup, joueurId) },
      toutLeMondeAFriche: false,
    };
  }

  // « Je joue » : la file d'abord, dans l'ordre ; sans file, lui.
  return {
    coup: {
      ...coup,
      annonces,
      phase: 'jeu',
      aParler: null,
      enAttente: [...file],
      dernierJeJoue: joueurId,
      joueurActifId: file[0] ?? joueurId,
    },
    toutLeMondeAFriche: false,
  };
};

/**
 * Ce qui suit un tour joué par `joueurId` : le joueur actif est déjà le
 * suivant de la table ; reste à savoir s'il doit d'abord parler.
 */
export const apresTour = (coup: Coup, joueurId: JoueurId): Coup => {
  if (coup.phase === 'termine') return coup;
  // Une combinaison est posée : la friche est close pour le reste du coup.
  // Ceux qui restaient en attente sont justement les suivants : ils jouent
  // leur tour sans rien annoncer, comme tout le monde désormais.
  if (!frichePossible(coup)) return { ...coup, phase: 'jeu', aParler: null, enAttente: [] };

  const file = (coup.enAttente ?? []).filter((id) => id !== joueurId);
  if (file.length > 0) return { ...coup, phase: 'jeu', aParler: null, enAttente: file };
  return { ...coup, phase: 'annonces', aParler: coup.joueurActifId, enAttente: [] };
};
