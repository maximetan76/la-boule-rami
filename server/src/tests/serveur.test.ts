import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { ouvrirTablePleine } from './aide-table.js';
import { c, coucou, recap } from './fixtures.js';
import type { GestionDeconnexion, Minuteur } from '../server/game-room-manager.js';
import { DELAI_DECONNEXION_PAR_DEFAUT_MS } from '../server/game-room-manager.js';
import type { Carte, JoueurId } from '../models/index.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';

/**
 * Test d'intégration : trois joueurs sur une même table, tous les messages
 * reçus par chacun sont interceptés et fouillés. Aucun ne doit jamais contenir
 * une carte de la main d'un autre joueur ni du talon de pioche.
 */

/** Configuration d'authentification des tests : un secret local suffit. */
const SESSION = { secret: secretDepuisTexte('secret-de-test-du-serveur-de-la-boule') };
const APPLE = { clientId: 'fr.tb-formations.laboule' };

/** Les trois joueurs inscrits qui s'assoient dans tous les scénarios. */
const JOUEURS = [
  { id: 'p-ana', pseudo: 'Ana' },
  { id: 'p-bo', pseudo: 'Bo' },
  { id: 'p-cy', pseudo: 'Cy' },
];

/** Aléa déterministe, pour que la partie soit rejouable à l'identique. */
const aleaFixe = (): (() => number) => {
  let graine = 20240909;
  return () => {
    graine = (graine * 1103515245 + 12345) % 2147483648;
    return graine / 2147483648;
  };
};

interface Espion {
  readonly socket: ClientSocket;
  readonly joueurId: JoueurId;
  /** Tout ce que la socket a reçu, tel quel. */
  readonly recus: unknown[];
  dernierEtat: EtatCoupFiltre | null;
  /** Nombre d'états reçus, pour attendre la diffusion complète d'une action. */
  etatsRecus: number;
}

const emettre = async (socket: ClientSocket, evenement: string, payload: unknown) =>
  new Promise<{ ok: boolean; erreur?: string }>((resolve) => {
    socket.emit(evenement, payload, resolve);
  });

const patienter = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Attend que chaque client ait reçu au moins un état. L'acquittement de
 * `rejoindre-table` revient à l'émetteur avant que la diffusion vers les autres
 * sockets ne soit arrivée.
 */
const attendrePremiersEtats = async (espions: readonly Espion[]) => {
  for (let essai = 0; essai < 200; essai += 1) {
    if (espions.every((espion) => espion.etatsRecus > 0)) return;
    await patienter(5);
  }
};

const identifiantsDans = (valeur: unknown): Set<string> =>
  new Set(
    (JSON.stringify(valeur).match(/"id":"([^"]+)"/g) ?? []).map((brut) =>
      brut.slice('"id":"'.length, -1),
    ),
  );

/** Horloge factice : rien ne s'écoule tant que le test ne le décide pas. */
const minuteurFactice = () => {
  const programmes: { callback: () => void; delaiMs: number; annule: boolean }[] = [];
  const minuteur: Minuteur = {
    programmer(callback, delaiMs) {
      const entree = { callback, delaiMs, annule: false };
      programmes.push(entree);
      return () => {
        entree.annule = true;
      };
    },
  };
  /** Fait expirer les minuteurs en attente à cet instant, pas ceux qu'ils arment. */
  const declencher = () => {
    for (const entree of [...programmes]) {
      if (!entree.annule) {
        entree.annule = true;
        entree.callback();
      }
    }
  };
  return { minuteur, programmes, declencher };
};

describe('serveur socket.io', () => {
  let serveur: Serveur;
  let port: number;
  let espions: Espion[];
  let horloge: ReturnType<typeof minuteurFactice>;

  beforeEach(async () => {
    horloge = minuteurFactice();
    serveur = creerServeur({
      minuteur: horloge.minuteur,
      session: SESSION,
      apple: APPLE,
      depot: new DepotMemoire(),
    });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    port = (serveur.httpServer.address() as AddressInfo).port;
    espions = [];
  });

  afterEach(async () => {
    for (const espion of espions) espion.socket.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const connecter = async (tableId: string, joueurId: JoueurId): Promise<Espion> => {
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    const espion: Espion = { socket, joueurId, recus: [], dernierEtat: null, etatsRecus: 0 };

    socket.onAny((_evenement: string, ...args: unknown[]) => {
      espion.recus.push(...args);
    });
    socket.on('etat', (etat: EtatCoupFiltre) => {
      espion.dernierEtat = etat;
      espion.etatsRecus += 1;
    });

    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    const jeton = await signerJetonSession(joueurId, SESSION);
    const reponse = await emettre(socket, 'rejoindre-table', { jeton, tableId });
    expect(reponse.ok).toBe(true);

    espions.push(espion);
    return espion;
  };

  /**
   * Émet une action puis attend que TOUS les clients aient reçu leur état.
   * L'acquittement revient à l'émetteur sans garantir que la diffusion vers les
   * autres sockets soit déjà arrivée.
   */
  const agir = async (espion: Espion, evenement: string, payload: unknown) => {
    const avant = espions.map((autre) => autre.etatsRecus);
    const reponse = await emettre(espion.socket, evenement, payload);
    if (!reponse.ok) return reponse;

    for (let essai = 0; essai < 100; essai += 1) {
      if (espions.every((autre, index) => autre.etatsRecus > (avant[index] as number))) break;
      await patienter(5);
    }
    return reponse;
  };

  const ouvrirTable = async (gestionDeconnexion?: GestionDeconnexion) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, {
      alea: aleaFixe(),
      ...(gestionDeconnexion === undefined ? {} : { gestionDeconnexion }),
    });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    await attendrePremiersEtats(espions);
    return { tableId };
  };

  it('distribue un coup des que tous les joueurs ont rejoint la table', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);

    expect(table.coup).not.toBeNull();
    expect(table.coup?.phase).toBe('annonces');
    for (const espion of espions) {
      expect(espion.dernierEtat?.moi.main).toHaveLength(14);
      expect(espion.dernierEtat?.adversaires).toHaveLength(2);
    }
  });

  it('montre le tirage d ouverture au premier coup, sous des identifiants qui lui sont propres', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);

    for (const espion of espions) {
      const tirage = espion.dernierEtat?.tirageOuverture;
      expect(tirage?.ordreTable).toEqual(table.joueurs.map((joueur) => joueur.id));
      expect(tirage?.donneurInitial).toBe(table.joueurs[0]?.id);
      const tirees = Object.values(tirage?.cartesTirees ?? {}).flat();
      expect(tirees.length).toBeGreaterThanOrEqual(JOUEURS.length);
      expect(tirees.every((carte) => carte.id.startsWith('tirage-'))).toBe(true);
    }
  });

  it('ne laisse jamais fuir la main d un autre joueur ni le talon, sur toute une partie', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    const ordre = table.coup?.ordreJoueurs ?? [];

    // Le premier a parler joue : la phase de jeu s ouvre.
    const premier = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    expect((await agir(premier, 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);

    // Plusieurs tours de table : chacun pioche et defausse.
    for (let tour = 0; tour < 9; tour += 1) {
      const actifId = serveur.manager.table(tableId).coup?.joueurActifId;
      const actif = espions.find((espion) => espion.joueurId === actifId) as Espion;

      expect((await agir(actif, 'piocher', { source: 'pioche' })).ok).toBe(true);
      const aDefausser = actif.dernierEtat?.moi.main.find((carte) => carte.type === 'normale')?.id;
      expect((await agir(actif, 'defausser', { carteId: aDefausser })).ok).toBe(true);
    }

    // Fouille de tout ce qui a transité, par joueur.
    const coup = serveur.manager.table(tableId).coup;
    if (coup === null) throw new Error('coup absent');

    for (const espion of espions) {
      const vus = identifiantsDans(espion.recus);

      // Aucune carte du talon, a aucun moment.
      for (const carte of coup.pioche) {
        expect(vus.has(carte.id)).toBe(false);
      }
      // Aucune carte de la main d un autre joueur.
      for (const [joueurId, main] of Object.entries(coup.mains)) {
        if (joueurId === espion.joueurId) continue;
        for (const carte of main as Carte[]) {
          expect(vus.has(carte.id)).toBe(false);
        }
      }
      // Sa propre main, en revanche, lui est bien parvenue.
      const sienne = (coup.mains[espion.joueurId] ?? []) as Carte[];
      expect(sienne.some((carte) => vus.has(carte.id))).toBe(true);
    }
  });

  it('fait grandir la liste des cartes sorties sans jamais reveler qui les a jetees', async () => {
    const { tableId } = await ouvrirTable();
    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const premier = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    await agir(premier, 'annoncer', { annonce: 'je-joue' });

    const tailles: number[] = [];
    for (let tour = 0; tour < 6; tour += 1) {
      const actifId = serveur.manager.table(tableId).coup?.joueurActifId;
      const actif = espions.find((espion) => espion.joueurId === actifId) as Espion;

      await agir(actif, 'piocher', { source: 'pioche' });
      // Un joker ne se defausse jamais : on jette la premiere carte ordinaire.
      const ordinaire = actif.dernierEtat?.moi.main.find((carte) => carte.type === 'normale');
      await agir(actif, 'defausser', { carteId: ordinaire?.id });

      const vue = espions[0]?.dernierEtat?.defausse;
      tailles.push(vue?.cartesSorties.length ?? 0);
    }

    // La liste grandit d un cran a chaque defausse.
    expect(tailles).toEqual([1, 2, 3, 4, 5, 6]);

    for (const espion of espions) {
      const defausse = espion.dernierEtat?.defausse;
      expect(defausse?.derniereCarte).not.toBeNull();
      // Les cartes sorties ne portent qu une identite de carte, rien d autre.
      for (const carte of defausse?.cartesSorties ?? []) {
        expect(Object.keys(carte).sort()).not.toContain('joueurId');
        expect(Object.keys(carte).sort()).not.toContain('tour');
      }
      // Toutes les vues montrent le meme ensemble, dans le meme ordre canonique.
      expect(defausse?.cartesSorties.map((carte) => carte.id)).toEqual(
        espions[0]?.dernierEtat?.defausse.cartesSorties.map((carte) => carte.id),
      );
    }
  });

  it('rejette une action illegale sans modifier l etat', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    const ordre = table.coup?.ordreJoueurs ?? [];

    const premier = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    const second = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    // Parler hors de son tour.
    const horsTour = await emettre(second.socket, 'annoncer', { annonce: 'je-joue' });
    expect(horsTour.ok).toBe(false);
    expect(horsTour.erreur).toMatch(/parler/i);

    await emettre(premier.socket, 'annoncer', { annonce: 'je-joue' });

    // Piocher la defausse alors qu elle est vide.
    const defausseVide = await emettre(premier.socket, 'piocher', { source: 'defausse' });
    expect(defausseVide.ok).toBe(false);
    expect(defausseVide.erreur).toMatch(/defausse/i);

    // L etat n a pas bouge : personne n a pioche.
    expect(serveur.manager.table(tableId).tourEnCours).toBeNull();
    expect(serveur.manager.table(tableId).coup?.mains[ordre[0] as string]).toHaveLength(14);

    // Defausser une carte qu on n a pas.
    await emettre(premier.socket, 'piocher', { source: 'pioche' });
    const carteInventee = await emettre(premier.socket, 'defausser', { carteId: 'carte-bidon' });
    expect(carteInventee.ok).toBe(false);
    expect(serveur.manager.table(tableId).coup?.defausse).toHaveLength(0);
  });

  /**
   * Réf. docs/REGLES.md § « Conditions pour poser » : la première pose exige 51
   * points et une tierce pure. Le moteur ne le vérifie qu'à la défausse, quand
   * le tour est complet ; sans « annuler-pose », une pose refusee resterait
   * dans le tour et aucune defausse ne pourrait plus le clore.
   */
  it('laisse recomposer apres une pose refusee, sans faire perdre le tour', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    const coup = table.coup;
    if (coup === null) throw new Error('coup absent');

    const premier = coup.ordreJoueurs[0] as JoueurId;
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;

    // Main installee pour le scenario : la tierce coeur 10-V-D-R-A vaut
    // exactement 51 points et elle est pure, le reste ne forme rien.
    const tierce = [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const autres = [
      c('pique', 2), c('trefle', 4), c('carreau', 6), c('pique', 8), c('trefle', 9),
      c('carreau', 3), c('pique', 5), c('trefle', 7), c('carreau', 9),
    ];
    coup.mains[premier] = [...tierce, ...autres];

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });

    // `defausser` remplace le coup par celui que rend le moteur : le relire à
    // chaque fois, sinon on interroge un état périmé.
    const enCours = () => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };

    const talonAvant = enCours().pioche.length;
    const defausseAvant = enCours().defausse.length;
    const cartePiochee = table.tourEnCours?.cartePiochee;

    // Une tierce qui n'en est pas une.
    const bancale = await agir(joueur, 'poser', {
      poses: [{
        type: 'tierce',
        couleur: 'coeur',
        cartes: autres.slice(0, 3).map((carte) => ({ carteId: carte.id })),
      }],
    });
    expect(bancale.ok).toBe(true);

    const refus = await emettre(joueur.socket, 'defausser', { carteId: (autres[3] as Carte).id });
    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('Premiere pose invalide');

    // Le tour est bloque tant que le brouillon reste : c'est ce qu'annuler leve.
    const annulation = await agir(joueur, 'annuler-pose', {});
    expect(annulation.ok).toBe(true);
    expect(table.tourEnCours?.poses).toHaveLength(0);
    expect(table.tourEnCours?.ajouts).toHaveLength(0);

    // Rien d'autre n'a bouge : ni la carte piochee, ni le talon, ni la defausse.
    expect(table.tourEnCours?.cartePiochee).toBe(cartePiochee);
    expect(table.tourEnCours?.joueurId).toBe(premier);
    expect(enCours().pioche).toHaveLength(talonAvant);
    expect(enCours().defausse).toHaveLength(defausseAvant);
    expect(enCours().joueurActifId).toBe(premier);
    expect(enCours().combinaisons).toHaveLength(0);

    // Recomposee autrement, la pose passe.
    const bonne = await agir(joueur, 'poser', {
      poses: [{
        type: 'tierce',
        couleur: 'coeur',
        cartes: tierce.map((carte) => ({ carteId: carte.id })),
      }],
    });
    expect(bonne.ok).toBe(true);

    const clote = await agir(joueur, 'defausser', { carteId: (autres[3] as Carte).id });
    expect(clote.ok).toBe(true);
    expect(enCours().combinaisons).toHaveLength(1);
    expect(enCours().combinaisons[0]?.proprietaireId).toBe(premier);
    expect(enCours().mains[premier]).toHaveLength(9);
    expect(enCours().joueurActifId).not.toBe(premier);
    expect(table.tourEnCours).toBeNull();
    expect(joueur.dernierEtat?.moi.aPose).toBe(true);
  });

  /**
   * Réf. docs/REGLES.md § « Récupération d'un joker posé ». La table de départ :
   * une tierce coeur 10-[coucou en Valet]-D posée par le premier joueur, qui a
   * déjà ouvert son jeu, et en main le vrai Valet de coeur, deux 9 pour
   * accueillir le coucou, et un 3 à jeter.
   */
  const tableAvecJokerARecuperer = async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');

    const premier = table.coup.ordreJoueurs[0] as JoueurId;
    const second = table.coup.ordreJoueurs[1] as JoueurId;
    const coucouEnValet = {
      carte: coucou(),
      remplace: { couleur: 'coeur' as const, valeur: 'V' as const },
    };
    const posee = {
      id: 'comb-joker',
      type: 'tierce' as const,
      proprietaireId: premier,
      tourDePose: 1,
      couleur: 'coeur' as const,
      cartes: [{ carte: c('coeur', 10), remplace: null }, coucouEnValet, { carte: c('coeur', 'D'), remplace: null }],
      pure: false,
    };
    const vraiValet = c('coeur', 'V');
    const neufPique = c('pique', 9);
    const neufCarreau = c('carreau', 9);
    const aJeter = c('pique', 3);
    table.coup.combinaisons = [posee];
    table.coup.mains[premier] = [vraiValet, neufPique, neufCarreau, aJeter];
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });

    const joueur = espions.find((e) => e.joueurId === premier) as Espion;
    const temoin = espions.find((e) => e.joueurId === second) as Espion;

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });

    const enCours = () => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };
    const recuperer = () =>
      agir(joueur, 'recuperer-joker', {
        carteReelleId: vraiValet.id,
        combinaisonId: posee.id,
        carteJokerId: coucouEnValet.carte.id,
      });

    return {
      table, enCours, joueur, temoin, posee, coucou: coucouEnValet.carte,
      vraiValet, neufPique, neufCarreau, aJeter, recuperer,
    };
  };

  it('reprend un joker sans exiger de le replacer aussitot, et ne le montre qu au joueur', async () => {
    const t = await tableAvecJokerARecuperer();
    const vuParLeTemoin = JSON.stringify(t.temoin.dernierEtat);

    expect((await t.recuperer()).ok).toBe(true);

    // Le joueur voit l'échange : la vraie carte sur la table, le coucou à part.
    const chezLui = t.joueur.dernierEtat;
    expect(chezLui?.moi.jokersRecuperes.map((carte) => carte.id)).toEqual([t.coucou.id]);
    expect(chezLui?.moi.main.map((carte) => carte.id)).not.toContain(t.vraiValet.id);
    const tierceChezLui = chezLui?.combinaisons.find((comb) => comb.id === t.posee.id);
    expect(tierceChezLui?.cartes.map((cp) => cp.carte.id)).toContain(t.vraiValet.id);
    expect(tierceChezLui?.cartes.map((cp) => cp.carte.id)).not.toContain(t.coucou.id);

    // Le témoin, lui, ne voit rien bouger — pas plus que la table réelle.
    expect(JSON.stringify(t.temoin.dernierEtat)).toBe(vuParLeTemoin);
    expect(t.enCours().combinaisons[0]?.cartes.map((cp) => cp.carte.id)).toContain(t.coucou.id);
  });

  it('refuse la defausse tant que le joker repris n est pas replace, puis la permet', async () => {
    const t = await tableAvecJokerARecuperer();
    await t.recuperer();

    const refus = await emettre(t.joueur.socket, 'defausser', { carteId: t.aJeter.id });
    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('joker recupere doit etre replace');

    // Le coucou part n'importe où : ici, un brelan de 9 qu'il complète.
    const pose = await agir(t.joueur, 'poser', {
      poses: [{
        type: 'ensemble',
        valeur: 9,
        cartes: [
          { carteId: t.neufPique.id },
          { carteId: t.neufCarreau.id },
          { carteId: t.coucou.id, remplace: { couleur: 'trefle', valeur: 9 } },
        ],
      }],
    });
    expect(pose.ok).toBe(true);

    const clos = await agir(t.joueur, 'defausser', { carteId: t.aJeter.id });
    expect(clos.ok).toBe(true);

    // À la défausse, l'échange devient réel, et le témoin le voit enfin.
    const tierce = t.enCours().combinaisons.find((comb) => comb.id === t.posee.id);
    expect(tierce?.cartes.map((cp) => cp.carte.id)).toContain(t.vraiValet.id);
    expect(t.enCours().combinaisons.some((comb) =>
      comb.cartes.some((cp) => cp.carte.id === t.coucou.id))).toBe(true);
    const tierceChezLeTemoin = t.temoin.dernierEtat?.combinaisons.find((comb) => comb.id === t.posee.id);
    expect(tierceChezLeTemoin?.cartes.map((cp) => cp.carte.id)).toContain(t.vraiValet.id);
  });

  it('annule un echange sans que le temoin en voie jamais rien', async () => {
    const t = await tableAvecJokerARecuperer();
    const vuParLeTemoin = JSON.stringify(t.temoin.dernierEtat);
    const vuParLeJoueur = JSON.stringify(t.joueur.dernierEtat?.combinaisons);

    await t.recuperer();
    expect(JSON.stringify(t.temoin.dernierEtat)).toBe(vuParLeTemoin);

    const annulation = await agir(t.joueur, 'annuler-echange-joker', { carteJokerId: t.coucou.id });
    expect(annulation.ok).toBe(true);

    // Le coucou a retrouvé sa place, le vrai Valet est revenu en main.
    expect(JSON.stringify(t.joueur.dernierEtat?.combinaisons)).toBe(vuParLeJoueur);
    expect(t.joueur.dernierEtat?.moi.jokersRecuperes).toEqual([]);
    expect(t.joueur.dernierEtat?.moi.main.map((carte) => carte.id)).toContain(t.vraiValet.id);
    expect(JSON.stringify(t.temoin.dernierEtat)).toBe(vuParLeTemoin);

    // Et le tour se clôt comme si de rien n'était.
    expect((await agir(t.joueur, 'defausser', { carteId: t.aJeter.id })).ok).toBe(true);
    expect(t.enCours().combinaisons[0]?.cartes.map((cp) => cp.carte.id)).toContain(t.coucou.id);
  });

  it('refuse un echange invalide sans rien laisser derriere lui', async () => {
    const t = await tableAvecJokerARecuperer();
    const vuParLeTemoin = JSON.stringify(t.temoin.dernierEtat);

    const refus = await emettre(t.joueur.socket, 'recuperer-joker', {
      carteReelleId: t.aJeter.id,
      combinaisonId: t.posee.id,
      carteJokerId: t.coucou.id,
    });

    expect(refus.ok).toBe(false);
    expect(t.table.tourEnCours?.echangesJoker).toEqual([]);
    expect(JSON.stringify(t.temoin.dernierEtat)).toBe(vuParLeTemoin);
  });

  it('refuse d annuler un echange quand le joker est deja engage dans une pose', async () => {
    const t = await tableAvecJokerARecuperer();
    await t.recuperer();
    await agir(t.joueur, 'poser', {
      poses: [{
        type: 'ensemble',
        valeur: 9,
        cartes: [
          { carteId: t.neufPique.id },
          { carteId: t.neufCarreau.id },
          { carteId: t.coucou.id, remplace: { couleur: 'trefle', valeur: 9 } },
        ],
      }],
    });

    const refus = await emettre(t.joueur.socket, 'annuler-echange-joker', { carteJokerId: t.coucou.id });

    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('Reprenez d abord la pose');
  });

  /**
   * Réf. docs/REGLES.md § « Règle spéciale : piocher la carte de la défausse » :
   * la carte prise doit servir immédiatement. Sans moyen de la rendre, un
   * joueur qui n'y parvient pas ne peut plus clore son tour.
   */
  /**
   * Réf. docs/REGLES.md § « Fin d'un coup et scoring » : le décompte se lit
   * avant que la donne suivante ne l'efface. La table marque donc un entracte,
   * et n'en sort que lorsque tous les joueurs ont demandé la suite.
   */
  it('attend que tous les joueurs demandent la suite avant de distribuer', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');

    const coupAvant = table.coup;
    const restes = { ...table.coup.mains };
    table.resultatCoup = {
      numero: coupAvant.numero,
      score: {
        gagnantId: JOUEURS[0]?.id as JoueurId,
        typeVictoire: 'simple',
        estFriche: false,
        multiplicateur: 1,
        scores: { 'p-ana': -30, 'p-bo': 12, 'p-cy': 18 },
        croixGagnees: {},
        chocolatId: null,
      },
      mains: restes,
      prets: [],
      derniereCoup: false,
    };
    await agir(espions[0] as Espion, 'pret-pour-suivant', {});

    // Un seul joueur prêt : le coup ne bouge pas, et chacun voit qui a dit oui.
    expect(table.coup).toBe(coupAvant);
    expect(espions[1]?.dernierEtat?.resultat?.prets).toEqual(['p-ana']);
    expect(espions[1]?.dernierEtat?.resultat?.scores['p-bo']).toBe(12);

    // Les mains sont révélées, mais seulement le temps de l'entracte.
    const reveleesChezBo = espions[1]?.dernierEtat?.resultat?.mainsRevelees ?? {};
    expect(Object.keys(reveleesChezBo)).toHaveLength(3);

    await agir(espions[1] as Espion, 'pret-pour-suivant', {});
    expect(table.coup).toBe(coupAvant);

    // Le dernier prêt, et seulement lui, déclenche la donne suivante.
    await agir(espions[2] as Espion, 'pret-pour-suivant', {});
    expect(table.coup).not.toBe(coupAvant);
    expect(table.resultatCoup).toBeNull();
    // L'entracte fini, plus une carte d'autrui ne franchit la frontière.
    expect(espions[1]?.dernierEtat?.resultat).toBeNull();
    for (const espion of espions) expect(espion.dernierEtat?.moi.main).toHaveLength(14);
  });

  it('refuse « pret » quand aucun coup ne vient de se terminer', async () => {
    const { tableId } = await ouvrirTable();
    void tableId;

    const refus = await emettre((espions[0] as Espion).socket, 'pret-pour-suivant', {});

    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('Aucun coup termine');
  });

  it('rend une carte prise en defausse et rouvre le choix de la pioche', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');

    const premier = table.coup.ordreJoueurs[0] as JoueurId;
    const second = table.coup.ordreJoueurs[1] as JoueurId;
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;
    const suivant = espions.find((e) => e.joueurId === second) as Espion;

    // Garnir la defausse : le premier joueur pioche au talon et jette.
    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    const aJeter = joueur.dernierEtat?.moi.carteEnAttente as Carte;
    await agir(joueur, 'defausser', { carteId: aJeter.id });

    const enCours = () => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };
    const sommet = enCours().defausse.at(-1) as Carte;
    const tailleDefausse = enCours().defausse.length;

    await agir(suivant, 'piocher', { source: 'defausse' });
    expect(table.tourEnCours?.cartePiochee.id).toBe(sommet.id);

    // Sans pouvoir la placer, aucune defausse ne passe : le tour est bloque.
    const bloque = await emettre(suivant.socket, 'defausser', { carteId: sommet.id });
    expect(bloque.ok).toBe(false);
    expect(bloque.ok === false && bloque.erreur).toContain('utilisee immediatement');

    const rendue = await agir(suivant, 'annuler-pioche', {});
    expect(rendue.ok).toBe(true);
    expect(table.tourEnCours).toBeNull();
    // La carte n'a jamais quitte la defausse : rien a y remettre.
    expect(enCours().defausse).toHaveLength(tailleDefausse);
    expect(enCours().defausse.at(-1)?.id).toBe(sommet.id);
    expect(enCours().joueurActifId).toBe(second);

    // Le choix de la pioche est rouvert, et le tour se clot normalement.
    const reprise = await agir(suivant, 'piocher', { source: 'pioche' });
    expect(reprise.ok).toBe(true);
    const nouvelle = suivant.dernierEtat?.moi.carteEnAttente as Carte;
    const clot = await agir(suivant, 'defausser', { carteId: nouvelle.id });
    expect(clot.ok).toBe(true);
    expect(enCours().joueurActifId).not.toBe(second);
  });

  it('ne rend jamais une carte prise au talon', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');

    const premier = table.coup.ordreJoueurs[0] as JoueurId;
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;

    const avantToutTour = await emettre(joueur.socket, 'annuler-pioche', {});
    expect(avantToutTour.ok).toBe(false);
    expect(avantToutTour.ok === false && avantToutTour.erreur).toContain('Aucune pioche a annuler');

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });

    // Une carte du talon a ete vue : la rendre reviendrait a regarder le
    // dessus du talon sans rien risquer.
    const refus = await emettre(joueur.socket, 'annuler-pioche', {});
    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('Seule une prise en defausse');
    expect(table.tourEnCours).not.toBeNull();
  });

  it('refuse d annuler quand il n y a pas de pose, ou quand ce n est pas son tour', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    const coup = table.coup;
    if (coup === null) throw new Error('coup absent');

    const premier = coup.ordreJoueurs[0] as JoueurId;
    const second = coup.ordreJoueurs[1] as JoueurId;
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;
    const suivant = espions.find((e) => e.joueurId === second) as Espion;

    const avantToutTour = await emettre(joueur.socket, 'annuler-pose', {});
    expect(avantToutTour.ok).toBe(false);
    expect(avantToutTour.ok === false && avantToutTour.erreur).toContain('Aucun tour en cours');

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });

    const sansPose = await emettre(joueur.socket, 'annuler-pose', {});
    expect(sansPose.ok).toBe(false);
    expect(sansPose.ok === false && sansPose.erreur).toContain('Aucune pose a annuler');

    const horsTour = await emettre(suivant.socket, 'annuler-pose', {});
    expect(horsTour.ok).toBe(false);
    expect(horsTour.ok === false && horsTour.erreur).toContain("Ce n'est pas au tour");

    // Le tour de l'autre joueur n'a pas bouge.
    expect(table.tourEnCours?.joueurId).toBe(premier);
  });

  it('rend sa place et son jeu a un joueur qui se reconnecte', async () => {
    const { tableId } = await ouvrirTable();
    const place = JOUEURS[0] as { id: JoueurId };
    const avant = espions.find((espion) => espion.joueurId === place.id) as Espion;
    const mainAvant = avant.dernierEtat?.moi.main.map((carte) => carte.id);

    avant.socket.disconnect();
    await patienter(50);
    expect(serveur.manager.joueursConnectes(serveur.manager.table(tableId))).toHaveLength(2);

    const revenu = await connecter(tableId, place.id);
    await attendrePremiersEtats([revenu]);
    expect(revenu.dernierEtat?.moi.joueurId).toBe(place.id);
    expect(revenu.dernierEtat?.moi.main.map((carte) => carte.id)).toEqual(mainAvant);
    expect(serveur.manager.joueursConnectes(serveur.manager.table(tableId))).toHaveLength(3);
  });

  it('refuse un jeton de session invalide', async () => {
    const { tableId } = await ouvrirTable();
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });

    const reponse = await emettre(socket, 'rejoindre-table', { jeton: 'pas-un-jeton', tableId });
    expect(reponse.ok).toBe(false);
    expect(reponse.erreur).toMatch(/jeton/i);
    socket.disconnect();
  });

  it('refuse un joueur qui n a pas de place a cette table', async () => {
    const { tableId } = await ouvrirTable();
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });

    const jeton = await signerJetonSession('p-intrus', SESSION);
    const reponse = await emettre(socket, 'rejoindre-table', { jeton, tableId });
    expect(reponse.ok).toBe(false);
    expect(reponse.erreur).toMatch(/place/i);
    socket.disconnect();
  });

  it('rejoue le coup a la meme place quand tout le monde friche', async () => {
    const { tableId } = await ouvrirTable();
    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const donneurAvant = serveur.manager.table(tableId).coup?.donneurId;

    for (const joueurId of ordre) {
      const espion = espions.find((e) => e.joueurId === joueurId) as Espion;
      expect((await agir(espion, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    }

    const table = serveur.manager.table(tableId);
    // Meme numero de coup, meme donneur, Boule pas allongee, un friche de plus.
    expect(table.coup?.numero).toBe(1);
    expect(table.coup?.donneurId).toBe(donneurAvant);
    expect(table.coup?.phase).toBe('annonces');
    expect(table.boule?.nombreCoupsTotal).toBe(9);
    expect(table.boule?.nombreCoupsFriches).toBe(3);
    for (const espion of espions) {
      expect(espion.dernierEtat?.moi.main).toHaveLength(14);
    }
  });
});

describe('gestion des deconnexions', () => {
  let serveur: Serveur;
  let port: number;
  let espions: Espion[];
  let horloge: ReturnType<typeof minuteurFactice>;

  beforeEach(async () => {
    horloge = minuteurFactice();
    serveur = creerServeur({
      minuteur: horloge.minuteur,
      session: SESSION,
      apple: APPLE,
      depot: new DepotMemoire(),
    });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    port = (serveur.httpServer.address() as AddressInfo).port;
    espions = [];
  });

  afterEach(async () => {
    for (const espion of espions) espion.socket.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const connecter = async (tableId: string, joueurId: JoueurId): Promise<Espion> => {
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    const espion: Espion = { socket, joueurId, recus: [], dernierEtat: null, etatsRecus: 0 };
    socket.on('etat', (etat: EtatCoupFiltre) => {
      espion.dernierEtat = etat;
      espion.etatsRecus += 1;
    });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    const jeton = await signerJetonSession(joueurId, SESSION);
    expect((await emettre(socket, 'rejoindre-table', { jeton, tableId })).ok).toBe(true);
    espions.push(espion);
    return espion;
  };

  const preparerTourPioche = async (gestionDeconnexion?: GestionDeconnexion) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, {
      alea: aleaFixe(),
      ...(gestionDeconnexion === undefined ? {} : { gestionDeconnexion }),
    });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    await attendrePremiersEtats(espions);

    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const actif = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    await emettre(actif.socket, 'annoncer', { annonce: 'je-joue' });
    await emettre(actif.socket, 'piocher', { source: 'pioche' });
    await patienter(20);

    const table = serveur.manager.table(tableId);
    return { tableId, ordre, actif, cartePiochee: table.tourEnCours?.cartePiochee };
  };

  /** Amène le joueur actif à son tour, sans qu'il ait encore pioché. */
  const preparerTourSansAction = async (gestionDeconnexion?: GestionDeconnexion) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, {
      alea: aleaFixe(),
      ...(gestionDeconnexion === undefined ? {} : { gestionDeconnexion }),
    });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    await attendrePremiersEtats(espions);

    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    const actif = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    await emettre(actif.socket, 'annoncer', { annonce: 'je-joue' });
    await patienter(20);

    const table = serveur.manager.table(tableId);
    return { tableId, ordre, actif, sommetDuTalon: table.coup?.pioche[0] };
  };

  it('applique un delai de 90 secondes par defaut', async () => {
    const { tableId } = await preparerTourPioche();
    expect(serveur.manager.table(tableId).gestionDeconnexion).toEqual({
      type: 'delai',
      dureeMs: DELAI_DECONNEXION_PAR_DEFAUT_MS,
    });
  });

  it('defausse la carte piochee et passe la main a l expiration du delai', async () => {
    const { tableId, ordre, actif, cartePiochee } = await preparerTourPioche({
      type: 'delai',
      dureeMs: 90000,
    });
    expect(serveur.manager.table(tableId).tourEnCours).not.toBeNull();

    actif.socket.disconnect();
    await patienter(50);

    // Le minuteur est arme, mais rien n a encore bouge.
    expect(horloge.programmes).toHaveLength(1);
    expect(horloge.programmes[0]?.delaiMs).toBe(90000);
    expect(serveur.manager.table(tableId).tourEnCours).not.toBeNull();
    expect(serveur.manager.table(tableId).coup?.joueurActifId).toBe(ordre[0]);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.tourEnCours).toBeNull();
    // La carte piochee avant la deconnexion est celle qui part a la defausse.
    expect(table.coup?.defausse.at(-1)?.id).toBe(cartePiochee?.id);
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
    // Aucune pose n a ete faite en son nom.
    expect(table.coup?.combinaisons).toEqual([]);
    expect(table.coup?.mains[ordre[0] as string]).toHaveLength(14);
  });

  it('garde en main un joker servi par le talon, et defausse une carte ordinaire a sa place', async () => {
    // Un joker ne se defausse jamais, pas meme au nom d un joueur absent.
    const { tableId, ordre, actif } = await preparerTourSansAction({ type: 'delai', dureeMs: 90000 });
    const coup = serveur.manager.table(tableId).coup;
    if (coup === null) throw new Error('coup absent');
    const jokerDuTalon: Carte = { type: 'joker', id: 'joker-du-talon' };
    coup.pioche.unshift(jokerDuTalon);

    actif.socket.disconnect();
    await patienter(50);
    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
    expect(table.coup?.defausse.at(-1)?.type).toBe('normale');
    const main = table.coup?.mains[ordre[0] as string] ?? [];
    expect(main.map((carte) => carte.id)).toContain(jokerDuTalon.id);
    expect(main).toHaveLength(14);
  });

  it('previent les joueurs restants du nouvel etat apres l abandon', async () => {
    const { ordre } = await preparerTourPioche({ type: 'delai', dureeMs: 90000 });
    const actif = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    const temoin = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    actif.socket.disconnect();
    await patienter(50);
    horloge.declencher();
    await patienter(50);

    expect(temoin.dernierEtat?.coup.joueurActifId).toBe(ordre[1]);
    expect(temoin.dernierEtat?.defausse.cartesSorties).toHaveLength(1);
  });

  it('laisse le tour en attente indefiniment en mode illimite', async () => {
    const { tableId, ordre, actif } = await preparerTourPioche({ type: 'illimite' });

    actif.socket.disconnect();
    await patienter(50);

    // Aucun minuteur n est arme, et declencher ne change rien.
    expect(horloge.programmes).toHaveLength(0);
    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.tourEnCours).not.toBeNull();
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
  });

  it('desamorce le minuteur quand le joueur revient a temps', async () => {
    const { tableId, ordre, actif } = await preparerTourPioche({
      type: 'delai',
      dureeMs: 90000,
    });

    actif.socket.disconnect();
    await patienter(50);
    expect(horloge.programmes).toHaveLength(1);

    const revenu = await connecter(tableId, ordre[0] as JoueurId);
    expect(horloge.programmes[0]?.annule).toBe(true);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.tourEnCours).not.toBeNull();
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
    // Il retrouve sa carte piochee.
    expect(revenu.dernierEtat?.moi.carteEnAttente?.id).toBe(table.tourEnCours?.cartePiochee.id);
  });

  it('n arme aucun minuteur pour un joueur dont ce n est pas le tour', async () => {
    const { ordre } = await preparerTourPioche({ type: 'delai', dureeMs: 90000 });
    const inactif = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    inactif.socket.disconnect();
    await patienter(50);

    expect(horloge.programmes).toHaveLength(0);
  });

  it('pioche et defausse pour le joueur parti avant meme d avoir pioche', async () => {
    const { tableId, ordre, actif, sommetDuTalon } = await preparerTourSansAction({
      type: 'delai',
      dureeMs: 90000,
    });
    // Aucun tour n est entame : il n a encore rien fait.
    expect(serveur.manager.table(tableId).tourEnCours).toBeNull();
    const tailleTalon = serveur.manager.table(tableId).coup?.pioche.length ?? 0;

    actif.socket.disconnect();
    await patienter(50);

    // Le minuteur s arme quand meme : c est son tour.
    expect(horloge.programmes).toHaveLength(1);
    expect(horloge.programmes[0]?.delaiMs).toBe(90000);
    expect(serveur.manager.table(tableId).coup?.defausse).toHaveLength(0);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    // Une carte a bien ete piochee au talon, puis defaussee aussitot.
    expect(table.coup?.pioche).toHaveLength(tailleTalon - 1);
    expect(table.coup?.defausse).toHaveLength(1);
    expect(table.coup?.defausse.at(-1)?.id).toBe(sommetDuTalon?.id);
    // Sa main est intacte et rien n a ete pose en son nom.
    expect(table.coup?.mains[ordre[0] as string]).toHaveLength(14);
    expect(table.coup?.combinaisons).toEqual([]);
    // La main passe au suivant.
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
    expect(table.tourEnCours).toBeNull();
  });

  it('laisse le tour bloque en mode illimite, meme avant toute action', async () => {
    const { tableId, ordre, actif } = await preparerTourSansAction({ type: 'illimite' });
    const tailleTalon = serveur.manager.table(tableId).coup?.pioche.length ?? 0;

    actif.socket.disconnect();
    await patienter(50);

    expect(horloge.programmes).toHaveLength(0);
    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
    expect(table.coup?.pioche).toHaveLength(tailleTalon);
  });

  it('desamorce le minuteur si le joueur revient avant d avoir joue', async () => {
    const { tableId, ordre, actif } = await preparerTourSansAction({
      type: 'delai',
      dureeMs: 90000,
    });

    actif.socket.disconnect();
    await patienter(50);
    expect(horloge.programmes).toHaveLength(1);

    await connecter(tableId, ordre[0] as JoueurId);
    expect(horloge.programmes[0]?.annule).toBe(true);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
  });
});

describe('deconnexion pendant la phase d annonces', () => {
  let serveur: Serveur;
  let port: number;
  let espions: Espion[];
  let horloge: ReturnType<typeof minuteurFactice>;

  beforeEach(async () => {
    horloge = minuteurFactice();
    serveur = creerServeur({
      minuteur: horloge.minuteur,
      session: SESSION,
      apple: APPLE,
      depot: new DepotMemoire(),
    });
    await new Promise<void>((resolve) => {
      serveur.httpServer.listen(0, resolve);
    });
    port = (serveur.httpServer.address() as AddressInfo).port;
    espions = [];
  });

  afterEach(async () => {
    for (const espion of espions) espion.socket.disconnect();
    serveur.io.close();
    await new Promise<void>((resolve) => {
      serveur.httpServer.close(() => {
        resolve();
      });
    });
  });

  const connecter = async (tableId: string, joueurId: JoueurId): Promise<Espion> => {
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    const espion: Espion = { socket, joueurId, recus: [], dernierEtat: null, etatsRecus: 0 };
    socket.on('etat', (etat: EtatCoupFiltre) => {
      espion.dernierEtat = etat;
      espion.etatsRecus += 1;
    });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    const jeton = await signerJetonSession(joueurId, SESSION);
    expect((await emettre(socket, 'rejoindre-table', { jeton, tableId })).ok).toBe(true);
    espions.push(espion);
    return espion;
  };

  const ouvrir = async (gestionDeconnexion?: GestionDeconnexion) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, {
      alea: aleaFixe(),
      ...(gestionDeconnexion === undefined ? {} : { gestionDeconnexion }),
    });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    await attendrePremiersEtats(espions);

    const ordre = serveur.manager.table(tableId).coup?.ordreJoueurs ?? [];
    return { tableId, ordre };
  };

  it('friche automatiquement pour le joueur absent et passe la parole', async () => {
    const { tableId, ordre } = await ouvrir({ type: 'delai', dureeMs: 90000 });
    const aParler = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;

    expect(serveur.manager.table(tableId).coup?.phase).toBe('annonces');
    expect(serveur.manager.table(tableId).coup?.annonces).toEqual({});

    aParler.socket.disconnect();
    await patienter(50);

    // Le minuteur s arme sur le joueur attendu, avant meme qu il ait parle.
    expect(horloge.programmes).toHaveLength(1);
    expect(horloge.programmes[0]?.delaiMs).toBe(90000);
    expect(serveur.manager.table(tableId).joueurEnSursis).toBe(ordre[0]);

    horloge.declencher();

    const table = serveur.manager.table(tableId);
    // Une friche a ete enregistree en son nom.
    expect(table.coup?.annonces[ordre[0] as string]).toBe('friche');
    expect(table.coup?.phase).toBe('annonces');
    // La parole est passee au joueur suivant, qui n a pas encore parle.
    expect(table.coup?.annonces[ordre[1] as string]).toBeUndefined();
    // Rien n a ete distribue ni joue.
    expect(table.coup?.defausse).toHaveLength(0);
    expect(table.coup?.mains[ordre[0] as string]).toHaveLength(14);
  });

  it('previent les joueurs restants de la friche automatique', async () => {
    const { ordre } = await ouvrir({ type: 'delai', dureeMs: 90000 });
    const aParler = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    const temoin = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    aParler.socket.disconnect();
    await patienter(50);
    horloge.declencher();
    await patienter(50);

    expect(temoin.dernierEtat?.coup.annonces[ordre[0] as string]).toBe('friche');
  });

  it('laisse le tour de parole en attente en mode illimite', async () => {
    const { tableId, ordre } = await ouvrir({ type: 'illimite' });
    const aParler = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;

    aParler.socket.disconnect();
    await patienter(50);

    expect(horloge.programmes).toHaveLength(0);
    horloge.declencher();

    const table = serveur.manager.table(tableId);
    expect(table.coup?.annonces).toEqual({});
    expect(table.coup?.phase).toBe('annonces');
    expect(table.joueurEnSursis).toBeNull();
  });

  it('desamorce le minuteur quand le joueur revient parler lui-meme', async () => {
    const { tableId, ordre } = await ouvrir({ type: 'delai', dureeMs: 90000 });
    const aParler = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;

    aParler.socket.disconnect();
    await patienter(50);
    expect(horloge.programmes).toHaveLength(1);

    const revenu = await connecter(tableId, ordre[0] as JoueurId);
    expect(horloge.programmes[0]?.annule).toBe(true);
    expect(serveur.manager.table(tableId).joueurEnSursis).toBeNull();

    horloge.declencher();
    expect(serveur.manager.table(tableId).coup?.annonces).toEqual({});

    // Il peut parler normalement a son retour.
    expect((await emettre(revenu.socket, 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    expect(serveur.manager.table(tableId).coup?.phase).toBe('jeu');
  });

  it('reprend un minuteur sur le joueur suivant s il est absent lui aussi', async () => {
    // Sans cela, la table se rebloquerait aussitot apres la friche automatique.
    const { tableId, ordre } = await ouvrir({ type: 'delai', dureeMs: 90000 });
    const premier = espions.find((espion) => espion.joueurId === ordre[0]) as Espion;
    const second = espions.find((espion) => espion.joueurId === ordre[1]) as Espion;

    second.socket.disconnect();
    await patienter(50);
    // Ce n est pas encore son tour de parole : rien n est arme pour lui.
    expect(horloge.programmes).toHaveLength(0);

    premier.socket.disconnect();
    await patienter(50);
    expect(horloge.programmes).toHaveLength(1);

    horloge.declencher();
    // Le reamorcage passe par la publication de l etat, qui est asynchrone.
    await patienter(20);

    const table = serveur.manager.table(tableId);
    expect(table.coup?.annonces[ordre[0] as string]).toBe('friche');
    // La parole revient au second, absent : un nouveau minuteur prend le relais.
    expect(table.joueurEnSursis).toBe(ordre[1]);
    expect(horloge.programmes).toHaveLength(2);
    expect(horloge.programmes[1]?.annule).toBe(false);

    horloge.declencher();
    await patienter(20);
    expect(serveur.manager.table(tableId).coup?.annonces[ordre[1] as string]).toBe('friche');
  });
});
