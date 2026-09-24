/**
 * La parole « Friche / Je joue », tant que personne n'a posé.
 *
 * Réf. docs/REGLES.md § « Phase Friche / Je joue ». On joue toujours dans
 * l'ordre de la table ; seule la parole peut prendre de l'avance sur le jeu.
 *
 * Il y a au plus un joueur « engagé » à la fois : le dernier à avoir dit « je
 * joue ». Tout tient dans la différence entre deux interrogations.
 *
 * - Tour d'annonce : personne n'est engagé. L'interrogé dit « friche » — il
 *   entre dans la file et son suivant est interrogé — ou « je joue » : il
 *   devient l'engagé. La file complète, le coup est redistribué.
 * - L'engagé interrogé : il continue — il joue son tour — ou friche, et alors
 *   il n'est plus engagé, il entre dans la file, et son suivant est interrogé.
 *
 * Quand quelqu'un dit « je joue », la file joue d'abord ses tours forcés, dans
 * l'ordre ; sans file, il joue aussitôt. Ensuite la rotation continue et
 * personne n'est interrogé, sauf l'engagé quand son tour revient.
 *
 * La file est toujours une suite consécutive de la rotation qui s'arrête juste
 * avant celui qui a dit « je joue » : une fois ses tours forcés joués, le
 * suivant dans la rotation est donc exactement l'engagé. Les deux chemins qui
 * mènent à « l'engagé est interrogé » n'en font ainsi qu'un seul.
 *
 * Un tour joué depuis la file est un tour ordinaire, sans restriction : seule
 * l'annonce lui a été ôtée. Dès qu'une combinaison est posée, la friche est
 * close pour tout le coup : on joue sans plus rien annoncer.
 */
import type { Annonce, Coup, JoueurId } from '../models/index.js';
import { reglesDe } from './variantes.js';

const suivant = (coup: Coup, joueurId: JoueurId): JoueurId => {
  const rang = coup.ordreJoueurs.indexOf(joueurId);
  return coup.ordreJoueurs[(rang + 1) % coup.ordreJoueurs.length] as JoueurId;
};

/** On peut encore fricher tant que personne n'a posé. */
export const frichePossible = (coup: Coup): boolean => coup.combinaisons.length === 0;

/** Le joueur dont on attend la décision, ou `null` hors des annonces. */
export const joueurQuiParle = (coup: Coup): JoueurId | null => {
  if (coup.phase !== 'annonces') return null;
  return coup.aParler ?? coup.joueurActifId;
};

/**
 * L'interrogé est-il l'engagé ? Il choisit alors entre continuer — piocher ou
 * prendre la défausse — et fricher ; « je joue » ne lui est pas proposé,
 * puisqu'il l'a déjà dit.
 */
export const engageInterroge = (coup: Coup): boolean => {
  const parle = joueurQuiParle(coup);
  return parle !== null && parle === (coup.engageId ?? null);
};

export interface ResultatAnnonce {
  readonly coup: Coup;
  /** Tous ont friché d'affilée : le coup est à redistribuer. */
  readonly toutLeMondeAFriche: boolean;
}

/**
 * Une décision, prise par le joueur interrogé.
 *
 * « je-joue » de l'engagé vaut « je continue » : il joue son tour. C'est ce
 * que fait déjà, sans mot dire, celui qui touche la pioche ou la défausse.
 */
export const annoncer = (coup: Coup, joueurId: JoueurId, annonce: Annonce): ResultatAnnonce => {
  if (coup.phase !== 'annonces') throw new Error("Ce n'est pas le moment d'annoncer");
  if (joueurQuiParle(coup) !== joueurId) throw new Error(`Ce n'est pas a ${joueurId} de parler`);

  const annonces = { ...coup.annonces, [joueurId]: annonce };
  const file = coup.enAttente ?? [];
  const engageId = coup.engageId ?? null;

  if (annonce === 'friche') {
    // L'engagé qui friche cesse de l'être : plus personne n'est engagé tant
    // que quelqu'un n'a pas dit « je joue ».
    const enAttente = [...file, joueurId];
    const apres = {
      ...coup,
      annonces,
      enAttente,
      engageId: engageId === joueurId ? null : engageId,
    };
    if (enAttente.length >= coup.ordreJoueurs.length) {
      return { coup: { ...apres, aParler: null }, toutLeMondeAFriche: true };
    }
    return {
      coup: { ...apres, aParler: suivant(coup, joueurId), joueurActifId: enAttente[0] as JoueurId },
      toutLeMondeAFriche: false,
    };
  }

  // L'engagé qui continue joue son tour ; un autre devient l'engagé, et la
  // file joue d'abord ses tours forcés, dans l'ordre.
  return {
    coup: {
      ...coup,
      annonces,
      phase: 'jeu',
      aParler: null,
      enAttente: [...file],
      engageId: joueurId,
      joueurActifId: file[0] ?? joueurId,
    },
    toutLeMondeAFriche: false,
  };
};

/**
 * Ce qui suit un tour joué par `joueurId` : qui joue ensuite, et faut-il
 * l'interroger.
 *
 * Personne n'est interrogé après un tour ordinaire — sauf l'engagé, quand son
 * tour revient : lui seul peut encore fricher.
 */
export const apresTour = (coup: Coup, joueurId: JoueurId): Coup => {
  if (coup.phase === 'termine') return coup;
  // Une combinaison est posée : la friche est close pour le reste du coup.
  // Ceux qui restaient en attente sont justement les suivants : ils jouent
  // leur tour sans rien annoncer, comme tout le monde désormais.
  if (!frichePossible(coup)) return { ...coup, phase: 'jeu', aParler: null, enAttente: [] };

  const file = (coup.enAttente ?? []).filter((id) => id !== joueurId);
  if (file.length > 0) {
    return { ...coup, phase: 'jeu', aParler: null, enAttente: file, joueurActifId: file[0] as JoueurId };
  }

  const prochain = suivant(coup, joueurId);
  // Réf. § « Le panier » : la parole ne fait qu'un tour, chacun répond une
  // fois ; l'engagé n'est jamais réinterrogé, même quand son tour revient.
  const reglesDuCoup = reglesDe(coup.variante);
  if (!reglesDuCoup.parolePremierTourSeulement && prochain === (coup.engageId ?? null)) {
    return { ...coup, phase: 'annonces', aParler: prochain, enAttente: [], joueurActifId: prochain };
  }
  return { ...coup, phase: 'jeu', aParler: null, enAttente: [], joueurActifId: prochain };
};
