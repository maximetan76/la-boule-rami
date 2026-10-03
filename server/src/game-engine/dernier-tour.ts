/**
 * Ce qu'un tour vient de changer sur la table, pour que chacun le voie.
 *
 * Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la défausse »
 * et § « Récupération d'un joker posé » : une prise en défausse, un joker
 * repris se disent aux autres joueurs, jusqu'au premier geste du suivant.
 *
 * L'app le déduisait de la différence entre deux états reçus à la suite. Elle
 * est reprise ici, à l'identique, là où l'on connaît les deux : un joueur qui
 * se connecte après coup n'a pas d'état d'avant, le serveur, si.
 */
import type { Carte, Combinaison, Coup, DernierTour, JoueurId } from '../models/index.js';
import { carteRepresentee } from './combinaisons.js';
import { estJoker } from './cartes.js';

/**
 * Un carré fermé : quatre cartes réelles, sans joker ni coucou. Lu sur les
 * cartes, pas sur `pure` : ce champ est figé à la pose, et un joker ajouté à
 * un brelan franc, ou repris d'un carré, ne le met pas à jour.
 */
export const estCarreFerme = (combinaison: Combinaison): boolean =>
  combinaison.type === 'carre' &&
  combinaison.cartes.length === 4 &&
  combinaison.cartes.every((posee) => !estJoker(posee.carte));

const idsDesCartes = (combinaisons: readonly Combinaison[]): Set<string> =>
  new Set(combinaisons.flatMap((combinaison) => combinaison.cartes.map((posee) => posee.carte.id)));

/**
 * Les jokers qui ont quitté leur combinaison au profit de la vraie carte qu'ils
 * représentaient, et qu'on retrouve sur la table : un joker repris puis gardé
 * en main ne se dit pas. Deux jokers repris dans le même tour font deux
 * reprises.
 */
const reprises = (
  avant: readonly Combinaison[],
  apres: readonly Combinaison[],
): { joker: Carte; carteFournie: Carte }[] => {
  const surLaTableApres = idsDesCartes(apres);
  const trouvees: { joker: Carte; carteFournie: Carte }[] = [];

  for (const ancienne of avant) {
    const nouvelle = apres.find((combinaison) => combinaison.id === ancienne.id);
    if (nouvelle === undefined) continue;
    const avantIds = new Set(ancienne.cartes.map((posee) => posee.carte.id));
    const apresIds = new Set(nouvelle.cartes.map((posee) => posee.carte.id));
    const dejaFournies = new Set<string>();

    for (const posee of ancienne.cartes) {
      if (!estJoker(posee.carte) || apresIds.has(posee.carte.id) || !surLaTableApres.has(posee.carte.id)) continue;
      const representee = carteRepresentee(ancienne, posee);
      if (representee === null) continue;
      const fournie = nouvelle.cartes.find(
        (arrivee) =>
          !avantIds.has(arrivee.carte.id) &&
          !dejaFournies.has(arrivee.carte.id) &&
          arrivee.carte.type === 'normale' &&
          arrivee.carte.couleur === representee.couleur &&
          arrivee.carte.valeur === representee.valeur,
      );
      if (fournie === undefined) continue;
      dejaFournies.add(fournie.carte.id);
      trouvees.push({ joker: posee.carte, carteFournie: fournie.carte });
    }
  }
  return trouvees;
};

/**
 * Ce que le tour de `tour.joueurId` a changé entre `avant` et `apres` ; `undefined` si rien
 * ne s'en montre.
 *
 * @param tour `source` et `cartePiochee` disent si la carte prise est celle de la
 * défausse : à ce stade le moteur l'a validée, elle ne peut plus être rendue.
 */
export const decrireDernierTour = (
  avant: Coup,
  apres: Coup,
  tour: { readonly id: string; readonly joueurId: JoueurId; readonly source: 'pioche' | 'defausse'; readonly cartePiochee: Carte },
): DernierTour | undefined => {
  const priseEnDefausse = tour.source === 'defausse' ? tour.cartePiochee : null;
  const jokersRepris = reprises(avant.combinaisons, apres.combinaisons);

  const dejaFermes = new Set(avant.combinaisons.filter(estCarreFerme).map((combinaison) => combinaison.id));
  const carresFermes = apres.combinaisons
    .filter((combinaison) => estCarreFerme(combinaison) && !dejaFermes.has(combinaison.id))
    .map((combinaison) => combinaison.id);

  const avantIds = idsDesCartes(avant.combinaisons);
  const cartesPosees = [...idsDesCartes(apres.combinaisons)].filter((id) => !avantIds.has(id));

  if (priseEnDefausse === null && jokersRepris.length === 0 && carresFermes.length === 0 && cartesPosees.length === 0) {
    return undefined;
  }
  return { id: tour.id, joueurId: tour.joueurId, priseEnDefausse, jokersRepris, carresFermes, cartesPosees };
};

/** Le coup, avec ce dernier tour — ou sans, quand rien ne s'en montre. */
export const avecDernierTour = (coup: Coup, dernierTour: DernierTour | undefined): Coup => {
  const { dernierTour: _ancien, ...reste } = coup;
  return dernierTour === undefined ? reste : { ...reste, dernierTour };
};
