/**
 * Le tirage d'ouverture, retourné en direct.
 *
 * Les cartes sont tirées au démarrage de la partie (`tirerSiegesEtDonneurInitial`).
 * Chaque joueur retourne ensuite la sienne lui-même, en touchant une carte de
 * l'étalage face cachée ; les autres ne la voient qu'à cet instant. Rien n'est
 * montré d'une carte que son joueur n'a pas encore retournée.
 *
 * En cas d'égalité, le retirage ne s'ouvre qu'une fois la manche précédente
 * retournée par tous : c'est là seulement que l'égalité se voit.
 */
import type { Carte, JoueurId } from '../models/index.js';
import { estJoker } from '../game-engine/index.js';
import type { CarteRetournee, TirageOuvertureFiltre } from './etat-filtre.js';

/** Deux jeux de 52 cartes, quatre jokers et le coucou, étalés face cachée. */
export const TAILLE_ETALAGE = 109;

/** Ce que le serveur a tiré, et qui reste à retourner. */
export interface TirageARetourner {
  readonly ordreTable: readonly JoueurId[];
  readonly donneurInitial: JoueurId;
  readonly cartesTirees: ReadonlyMap<JoueurId, readonly Carte[]>;
}

/** Les places de l'étalage touchées par chaque joueur, dans l'ordre. */
export type Retournements = ReadonlyMap<JoueurId, readonly number[]>;

const placesDe = (retournements: Retournements, joueurId: JoueurId): readonly number[] =>
  retournements.get(joueurId) ?? [];

/** Les joueurs qui peuvent retourner une carte maintenant. */
export const joueursARetourner = (tirage: TirageARetourner, retournements: Retournements): JoueurId[] =>
  [...tirage.cartesTirees].flatMap(([joueurId, cartes]) => {
    const deja = placesDe(retournements, joueurId).length;
    if (deja >= cartes.length) return [];
    if (deja === 0) return [joueurId];
    // Un retirage attend que la manche précédente soit retournée par tous.
    const mancheFinie = [...tirage.cartesTirees].every(
      ([autre, sesCartes]) => placesDe(retournements, autre).length >= Math.min(deja, sesCartes.length),
    );
    return mancheFinie ? [joueurId] : [];
  });

export const tirageComplet = (tirage: TirageARetourner, retournements: Retournements): boolean =>
  [...tirage.cartesTirees].every(([joueurId, cartes]) => placesDe(retournements, joueurId).length >= cartes.length);

/**
 * Retourne la prochaine carte du joueur, à la place qu'il a touchée.
 *
 * @throws si la place n'est pas dans l'étalage ou déjà prise, si le joueur ne
 * prend pas part au tirage, ou si ce n'est pas à lui de retourner une carte.
 */
export const retournerCarte = (
  tirage: TirageARetourner,
  retournements: Retournements,
  joueurId: JoueurId,
  place: unknown,
): Map<JoueurId, number[]> => {
  if (typeof place !== 'number' || !Number.isInteger(place) || place < 0 || place >= TAILLE_ETALAGE) {
    throw new Error("Cette carte n'est pas dans l'etalage");
  }
  const cartes = tirage.cartesTirees.get(joueurId);
  if (cartes === undefined) throw new Error('Vous ne prenez pas part a ce tirage');
  if (!joueursARetourner(tirage, retournements).includes(joueurId)) {
    throw new Error(
      placesDe(retournements, joueurId).length >= cartes.length
        ? 'Votre carte est deja retournee'
        : 'Attendez que chacun ait retourne sa carte',
    );
  }
  if ([...retournements.values()].some((places) => places.includes(place))) {
    throw new Error('Cette carte a deja ete retournee');
  }

  const suite = new Map([...retournements].map(([id, places]) => [id, [...places]]));
  suite.set(joueurId, [...placesDe(retournements, joueurId), place]);
  return suite;
};

/**
 * Le tirage tel que chacun le voit : les seules cartes retournées, à leur
 * place. Sièges, donneur et jokers gardés n'apparaissent qu'une fois tout
 * retourné.
 */
export const filtrerTirage = (tirage: TirageARetourner, retournements: Retournements): TirageOuvertureFiltre => {
  const retournees: Record<JoueurId, CarteRetournee[]> = {};
  for (const [joueurId, cartes] of tirage.cartesTirees) {
    retournees[joueurId] = placesDe(retournements, joueurId).map((place, rang) => ({
      place,
      // Un identifiant propre au tirage : celui du paquet désigne une carte
      // redistribuée depuis, peut-être dans la main d'un autre joueur.
      carte: { ...(cartes[rang] as Carte), id: `tirage-${joueurId}-${String(rang)}` },
    }));
  }

  const complet = tirageComplet(tirage, retournements);
  const jokersConserves: Record<JoueurId, Carte[]> = {};
  if (complet) {
    for (const [joueurId, cartes] of Object.entries(retournees)) {
      jokersConserves[joueurId] = cartes.map((retournee) => retournee.carte).filter(estJoker);
    }
  }

  return {
    joueurs: [...tirage.cartesTirees.keys()],
    retournees,
    aRetourner: joueursARetourner(tirage, retournements),
    complet,
    ordreTable: complet ? [...tirage.ordreTable] : null,
    donneurInitial: complet ? tirage.donneurInitial : null,
    jokersConserves,
  };
};
