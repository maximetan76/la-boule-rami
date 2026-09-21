import { DELAIS_PAR_DEFAUT } from '../persistence/depot.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { publierTable } from '../server/handlers.js';
import { ouvrirTablePleine } from './aide-table.js';
import { c, coucou, ensemble, joker, recap, tierce } from './fixtures.js';
import type { DelaisDeJeu, GestionDeconnexion, Minuteur } from '../server/game-room-manager.js';
import { DELAI_DECONNEXION_PAR_DEFAUT_MS, DELAI_INACTIVITE_MS } from '../server/game-room-manager.js';
import type { Carte, Combinaison, Coup, JoueurId } from '../models/index.js';
import { compterCroix } from '../game-engine/croix.js';
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
  let depot: DepotMemoire;

  beforeEach(async () => {
    horloge = minuteurFactice();
    depot = new DepotMemoire();
    serveur = creerServeur({
      minuteur: horloge.minuteur,
      session: SESSION,
      apple: APPLE,
      depot,
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

  it('laisse un joueur a deux tables : sa connexion ne suit que la derniere rejointe', async () => {
    const { tableId: premiere } = await ouvrirTable();
    const { tableId: seconde } = await ouvrirTablePleine(serveur.manager, JOUEURS, { alea: aleaFixe() });
    const [ana, bo] = espions as [Espion, Espion, Espion];

    const jeton = await signerJetonSession(ana.joueurId, SESSION);
    expect((await emettre(ana.socket, 'rejoindre-table', { jeton, tableId: seconde })).ok).toBe(true);
    await patienter(30);

    // Sa place a la premiere table est gardee, mais sans connexion.
    const tablePremiere = serveur.manager.table(premiere);
    expect(tablePremiere.connexions.has(ana.joueurId)).toBe(true);
    expect(tablePremiere.connexions.get(ana.joueurId)).toBeNull();

    // La premiere table ne lui envoie plus rien ; les autres la suivent toujours.
    const recusAvant = ana.recus.length;
    const etatsDeBo = bo.etatsRecus;
    publierTable(serveur.io, serveur.manager, tablePremiere);
    await patienter(30);
    const venusDeLaPremiere = ana.recus
      .slice(recusAvant)
      .filter((message) => (message as { tableId?: string } | null)?.tableId === premiere);
    expect(venusDeLaPremiere).toEqual([]);
    expect(bo.etatsRecus).toBeGreaterThan(etatsDeBo);
  });

  it('previent clairement un joueur encore connecte a une table supprimee pour inactivite', async () => {
    const { tableId } = await ouvrirTable();
    const [ana] = espions as [Espion, Espion, Espion];
    const fermetures: unknown[] = [];
    ana.socket.on('table-fermee', (charge: unknown) => {
      fermetures.push(charge);
    });

    // La donne est faite, mais personne n'a joué : trois heures plus tard, la table disparaît.
    expect(await serveur.nettoyerTablesInactives(new Date(Date.now() + DELAI_INACTIVITE_MS + 60_000))).toBe(1);
    for (let essai = 0; essai < 100 && fermetures.length === 0; essai += 1) await patienter(5);

    expect(fermetures).toEqual([
      { tableId, motif: 'inactivite', message: 'Cette partie a été fermée pour inactivité' },
    ]);
    expect(serveur.manager.tableVivante(tableId)).toBeNull();
    // Une action sur la table disparue est refusée, pas ignorée en silence.
    expect((await emettre(ana.socket, 'piocher', { source: 'pioche' })).ok).toBe(false);
  });

  /**
   * Réf. docs/REGLES.md § « Bonus quinte flush royale ». Le premier joueur a
   * déjà ouvert : sa suite V-D-R-A de cœur est sur la table, et le second a
   * posé 5-[coucou en 6]-7 de trèfle.
   */
  const tablePourLesCroix = async (main: Carte[]) => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const premier = table.coup.ordreJoueurs[0] as JoueurId;
    const second = table.coup.ordreJoueurs[1] as JoueurId;

    const coucouEnSix = { carte: coucou(), remplace: { couleur: 'trefle' as const, valeur: 6 as const } };
    const quatre = {
      id: 'comb-quatre',
      type: 'tierce' as const,
      proprietaireId: premier,
      tourDePose: 1,
      couleur: 'coeur' as const,
      cartes: [c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')].map((carte) => ({ carte, remplace: null })),
      pure: true,
    };
    const ailleurs = {
      id: 'comb-ailleurs',
      type: 'tierce' as const,
      proprietaireId: second,
      tourDePose: 1,
      couleur: 'trefle' as const,
      cartes: [{ carte: c('trefle', 5), remplace: null }, coucouEnSix, { carte: c('trefle', 7), remplace: null }],
      pure: false,
    };
    table.coup.combinaisons = [quatre, ailleurs];
    table.coup.mains[premier] = main;
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });

    const joueur = espions.find((e) => e.joueurId === premier) as Espion;
    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    const coupReel = (): Coup => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };
    return { joueur, premier, quatre, coucouEnSix, coupReel };
  };

  it('croix, scenario rapporte : coucou recupere ailleurs et place en 10 sur A-R-D-V de coeur, aucune croix', async () => {
    const six = c('trefle', 6);
    const aJeter = c('pique', 3);
    const t = await tablePourLesCroix([six, aJeter, c('carreau', 9)]);

    const reprise = await emettre(t.joueur.socket, 'recuperer-joker', {
      carteReelleId: six.id,
      combinaisonId: 'comb-ailleurs',
      carteJokerId: t.coucouEnSix.carte.id,
    });
    expect(reprise.ok).toBe(true);
    const ajout = await emettre(t.joueur.socket, 'poser', {
      ajouts: [{ combinaisonId: t.quatre.id, cartes: [{ carteId: t.coucouEnSix.carte.id, remplace: { couleur: 'coeur', valeur: 10 } }] }],
    });
    expect(ajout.ok).toBe(true);
    expect(await emettre(t.joueur.socket, 'defausser', { carteId: aJeter.id })).toEqual({ ok: true });

    const quinte = t.coupReel().combinaisons.find((combinaison) => combinaison.id === t.quatre.id);
    expect(quinte?.cartes).toHaveLength(5);
    expect(compterCroix(t.coupReel(), t.premier)).toBe(0);
  });

  it('croix, cas legitime : la quinte royale posee d un coup rapporte ses 2 croix', async () => {
    const quinte = [c('pique', 10), c('pique', 'V'), c('pique', 'D'), c('pique', 'R'), c('pique', 'A')];
    const aJeter = c('trefle', 3);
    const t = await tablePourLesCroix([...quinte, aJeter, c('carreau', 9)]);

    const pose = await emettre(t.joueur.socket, 'poser', {
      poses: [{ type: 'tierce', couleur: 'pique', cartes: quinte.map((carte) => ({ carteId: carte.id })) }],
    });
    expect(pose.ok).toBe(true);
    expect(await emettre(t.joueur.socket, 'defausser', { carteId: aJeter.id })).toEqual({ ok: true });
    expect(compterCroix(t.coupReel(), t.premier)).toBe(2);
  });

  it('banc : reprendre un joker chez un adversaire avant d ouvrir puis tout poser d un coup reste un double', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const [premier, second] = table.coup.ordreJoueurs as [JoueurId, JoueurId];
    const jokerEnSix = { carte: joker(), remplace: { couleur: 'trefle' as const, valeur: 6 as const } };
    const chezLeSecond = {
      id: 'comb-du-second', type: 'tierce' as const, proprietaireId: second, tourDePose: 1, couleur: 'trefle' as const, pure: false,
      cartes: [{ carte: c('trefle', 5), remplace: null }, jokerEnSix, { carte: c('trefle', 7), remplace: null }],
    };
    const six = c('trefle', 6);
    const coeur = ([10, 'V', 'D', 'R', 'A'] as const).map((valeur) => c('coeur', valeur));
    const pique = ([2, 3, 4, 5, 6] as const).map((valeur) => c('pique', valeur));
    const sept = [c('carreau', 7), c('pique', 7), c('trefle', 7)];
    const aJeter = c('coeur', 8);
    table.coup.combinaisons = [chezLeSecond];
    table.coup.mains[premier] = [six, ...coeur, ...pique, ...sept];
    table.coup.pioche.unshift(aJeter);
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [] });
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    expect((await emettre(joueur.socket, 'recuperer-joker', {
      carteReelleId: six.id, combinaisonId: chezLeSecond.id, carteJokerId: jokerEnSix.carte.id,
    })).ok).toBe(true);
    expect((await emettre(joueur.socket, 'poser', {
      poses: [
        { type: 'tierce', couleur: 'coeur', cartes: coeur.map((carte) => ({ carteId: carte.id })) },
        { type: 'tierce', couleur: 'pique', cartes: pique.map((carte) => ({ carteId: carte.id })) },
        { type: 'ensemble', valeur: 7, cartes: [...sept.map((carte) => ({ carteId: carte.id })), { carteId: jokerEnSix.carte.id, remplace: { couleur: 'coeur', valeur: 7 } }] },
      ],
    })).ok).toBe(true);
    expect(await agir(joueur, 'defausser', { carteId: aJeter.id })).toEqual({ ok: true });

    expect(table.resultatCoup?.score.gagnantId).toBe(premier);
    expect(table.resultatCoup?.score.typeVictoire).toBe('double');
  });

  it('banc : un joker ajoute a une suite sans declaration est refuse a la defausse', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const premier = table.coup.ordreJoueurs[0] as JoueurId;
    const suite = tierce('pique', [c('pique', 5), c('pique', 6), c('pique', 7)], premier);
    const jokerEnMain = joker();
    const aJeter = c('trefle', 3);
    table.coup.combinaisons = [suite];
    table.coup.mains[premier] = [jokerEnMain, aJeter, c('carreau', 9)];
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    await emettre(joueur.socket, 'poser', { ajouts: [{ combinaisonId: suite.id, cartes: [{ carteId: jokerEnMain.id }] }] });
    const refus = await emettre(joueur.socket, 'defausser', { carteId: aJeter.id });
    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('Joker non declare');
    expect(table.coup.combinaisons[0]?.cartes).toHaveLength(3);
  });

  /** Un joueur qui n'a pas ouvert, avec ce qu'il faut sur la table pour y reprendre des jokers. */
  const tableJokerFrais = async (
    surLaTable: (second: JoueurId, troisieme: JoueurId) => Combinaison[],
    main: Carte[],
    carteDuTalon?: Carte,
  ) => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const [premier, second, troisieme] = table.coup.ordreJoueurs as [JoueurId, JoueurId, JoueurId];
    table.coup.combinaisons = surLaTable(second, troisieme);
    table.coup.mains[premier] = main;
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [] });
    if (carteDuTalon !== undefined) table.coup.pioche.unshift(carteDuTalon);
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;
    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    return { table, joueur, premier };
  };
  const identifiants = (cartes: Carte[]) => cartes.map((carte) => ({ carteId: carte.id }));

  it('banc joker frais : vraie carte chez un adversaire avant d ouvrir, AKQ + 789 + 333 + 6-[joker]-8 passe', async () => {
    const jokerEnSix = { carte: joker(), remplace: { couleur: 'trefle' as const, valeur: 6 as const } };
    const six = c('trefle', 6);
    const coeur = [c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const pique = [c('pique', 7), c('pique', 8), c('pique', 9)];
    const trois = [c('pique', 3), c('carreau', 3), c('trefle', 3)];
    const sixCarreau = c('carreau', 6);
    const huitCarreau = c('carreau', 8);
    const aJeter = c('trefle', 2);
    const t = await tableJokerFrais(
      (second) => [tierce('trefle', [c('trefle', 5), jokerEnSix, c('trefle', 7)], second)],
      [six, ...coeur, ...pique, ...trois, sixCarreau, huitCarreau, aJeter],
    );
    const surLaTable = t.table.coup?.combinaisons[0] as Combinaison;

    expect((await emettre(t.joueur.socket, 'recuperer-joker', { carteReelleId: six.id, combinaisonId: surLaTable.id, carteJokerId: jokerEnSix.carte.id })).ok).toBe(true);
    expect((await emettre(t.joueur.socket, 'poser', {
      poses: [
        { type: 'tierce', couleur: 'coeur', cartes: identifiants(coeur) },
        { type: 'tierce', couleur: 'pique', cartes: identifiants(pique) },
        { type: 'ensemble', valeur: 3, cartes: identifiants(trois) },
        { type: 'tierce', couleur: 'carreau', cartes: [{ carteId: sixCarreau.id }, { carteId: jokerEnSix.carte.id, remplace: { couleur: 'carreau', valeur: 7 } }, { carteId: huitCarreau.id }] },
      ],
    })).ok).toBe(true);
    expect(await agir(t.joueur, 'defausser', { carteId: aJeter.id })).toEqual({ ok: true });
    expect(t.joueur.dernierEtat?.moi.aPose).toBe(true);
  });

  it('banc joker frais : AKQ + 7-[joker]-9 est refuse a la defausse avec un message clair', async () => {
    const jokerEnSix = { carte: joker(), remplace: { couleur: 'trefle' as const, valeur: 6 as const } };
    const six = c('trefle', 6);
    const coeur = [c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const sept = c('carreau', 7);
    const neuf = c('carreau', 9);
    const aJeter = c('trefle', 2);
    const t = await tableJokerFrais(
      (second) => [tierce('trefle', [c('trefle', 5), jokerEnSix, c('trefle', 7)], second)],
      [six, ...coeur, sept, neuf, aJeter],
    );
    const surLaTable = t.table.coup?.combinaisons[0] as Combinaison;

    await emettre(t.joueur.socket, 'recuperer-joker', { carteReelleId: six.id, combinaisonId: surLaTable.id, carteJokerId: jokerEnSix.carte.id });
    await emettre(t.joueur.socket, 'poser', {
      poses: [
        { type: 'tierce', couleur: 'coeur', cartes: identifiants(coeur) },
        { type: 'tierce', couleur: 'carreau', cartes: [{ carteId: sept.id }, { carteId: jokerEnSix.carte.id, remplace: { couleur: 'carreau', valeur: 8 } }, { carteId: neuf.id }] },
      ],
    });
    const refus = await emettre(t.joueur.socket, 'defausser', { carteId: aJeter.id });
    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('joker tout juste recupere ne peut pas servir a ouvrir');
  });

  it('banc joker frais : fin de coup avec ses 14 cartes et deux jokers frais, sans 51 points ni tierce, passe', async () => {
    const jokerEnSix = { carte: joker(), remplace: { couleur: 'trefle' as const, valeur: 6 as const } };
    const coucouEnQuatre = { carte: coucou(), remplace: { couleur: 'coeur' as const, valeur: 4 as const } };
    const six = c('trefle', 6);
    const quatre = c('coeur', 4);
    const deux = [c('pique', 2), c('carreau', 2)];
    const trois = [c('pique', 3), c('carreau', 3), c('trefle', 3), c('coeur', 3)];
    const quatres = [c('pique', 4), c('carreau', 4), c('trefle', 4)];
    const cinq = [c('pique', 5), c('carreau', 5), c('trefle', 5)];
    const aJeter = c('coeur', 9);
    const t = await tableJokerFrais(
      (second, troisieme) => [
        tierce('trefle', [c('trefle', 5), jokerEnSix, c('trefle', 7)], second),
        tierce('coeur', [c('coeur', 3), coucouEnQuatre, c('coeur', 5)], troisieme),
      ],
      [six, quatre, ...deux, ...trois, ...quatres, ...cinq],
      aJeter,
    );
    const [chezSecond, chezTroisieme] = t.table.coup?.combinaisons as [Combinaison, Combinaison];

    expect((await emettre(t.joueur.socket, 'recuperer-joker', { carteReelleId: six.id, combinaisonId: chezSecond.id, carteJokerId: jokerEnSix.carte.id })).ok).toBe(true);
    expect((await emettre(t.joueur.socket, 'recuperer-joker', { carteReelleId: quatre.id, combinaisonId: chezTroisieme.id, carteJokerId: coucouEnQuatre.carte.id })).ok).toBe(true);
    expect((await emettre(t.joueur.socket, 'poser', {
      poses: [
        { type: 'ensemble', valeur: 2, cartes: [...identifiants(deux), { carteId: jokerEnSix.carte.id, remplace: { couleur: 'coeur', valeur: 2 } }] },
        { type: 'ensemble', valeur: 3, cartes: identifiants(trois) },
        { type: 'ensemble', valeur: 4, cartes: identifiants(quatres) },
        { type: 'ensemble', valeur: 5, cartes: [...identifiants(cinq), { carteId: coucouEnQuatre.carte.id, remplace: { couleur: 'coeur', valeur: 5 } }] },
      ],
    })).ok).toBe(true);
    expect(await agir(t.joueur, 'defausser', { carteId: aJeter.id })).toEqual({ ok: true });
    expect(t.table.resultatCoup?.score.gagnantId).toBe(t.premier);
  });

  it('banc brelan : 3♥ 3♣ et un joker ambigu, 3♠ ajoute, puis le 3♦ reprend le joker au tour suivant', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const [premier, second, troisieme] = table.coup.ordreJoueurs as [JoueurId, JoueurId, JoueurId];
    const jokerNu = joker();
    const brelan = ensemble(3, [c('coeur', 3), c('trefle', 3), jokerNu], troisieme);
    const troisCarreauPremier = c('carreau', 3);
    const troisPique = c('pique', 3);
    const aJeterPremier = c('trefle', 9);
    const troisCarreauSecond = c('carreau', 3);
    const huitPique = c('pique', 8);
    const huitCarreau = c('carreau', 8);
    const aJeterSecond = c('coeur', 9);
    table.coup.combinaisons = [brelan];
    table.coup.mains[premier] = [troisCarreauPremier, troisPique, aJeterPremier, c('pique', 'R')];
    table.coup.mains[second] = [troisCarreauSecond, huitPique, huitCarreau, aJeterSecond, c('pique', 'D')];
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });
    table.coup.recapitulatifs[second] = recap({ toursAvecPose: [1] });
    const joueurPremier = espions.find((e) => e.joueurId === premier) as Espion;
    const joueurSecond = espions.find((e) => e.joueurId === second) as Espion;

    await agir(joueurPremier, 'annoncer', { annonce: 'je-joue' });
    await agir(joueurPremier, 'piocher', { source: 'pioche' });
    // Deux couleurs restent possibles : le 3♦ ne reprend rien.
    const ambigu = await emettre(joueurPremier.socket, 'recuperer-joker', {
      carteReelleId: troisCarreauPremier.id, combinaisonId: brelan.id, carteJokerId: jokerNu.id,
    });
    expect(ambigu.ok).toBe(false);
    expect(ambigu.ok === false && ambigu.erreur).toContain('plusieurs couleurs restent possibles');
    // Le 3♠ rejoint le groupe : il ne reste que le carreau.
    await emettre(joueurPremier.socket, 'poser', { ajouts: [{ combinaisonId: brelan.id, cartes: [{ carteId: troisPique.id }] }] });
    expect(await agir(joueurPremier, 'defausser', { carteId: aJeterPremier.id })).toEqual({ ok: true });
    expect(table.coup.combinaisons[0]?.type).toBe('carre');

    await agir(joueurSecond, 'piocher', { source: 'pioche' });
    expect(await emettre(joueurSecond.socket, 'recuperer-joker', {
      carteReelleId: troisCarreauSecond.id, combinaisonId: brelan.id, carteJokerId: jokerNu.id,
    })).toEqual({ ok: true });
    expect((await emettre(joueurSecond.socket, 'poser', {
      poses: [{ type: 'ensemble', valeur: 8, cartes: [{ carteId: huitPique.id }, { carteId: huitCarreau.id }, { carteId: jokerNu.id }] }],
    })).ok).toBe(true);
    expect(await agir(joueurSecond, 'defausser', { carteId: aJeterSecond.id })).toEqual({ ok: true });

    const carre = table.coup.combinaisons.find((combinaison) => combinaison.id === brelan.id);
    expect(carre?.cartes.map((cp) => cp.carte.id)).toContain(troisCarreauSecond.id);
    expect(carre?.cartes.some((cp) => cp.carte.id === jokerNu.id)).toBe(false);
    expect(table.coup.combinaisons.some((combinaison) =>
      combinaison.proprietaireId === second && combinaison.cartes.some((cp) => cp.carte.id === jokerNu.id))).toBe(true);
  });

  it('banc croix : quinte et 7-8-9 poses le meme tour, puis 9 ajoute par un autre joueur, les 2 croix restent', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const [premier, second] = table.coup.ordreJoueurs as [JoueurId, JoueurId];
    const quinte = [c('pique', 10), c('pique', 'V'), c('pique', 'D'), c('pique', 'R'), c('pique', 'A')];
    const suite = [c('pique', 7), c('pique', 8), c('pique', 9)];
    const aJeterPremier = c('trefle', 3);
    const autreNeuf = c('pique', 9);
    const aJeterSecond = c('coeur', 3);
    table.coup.combinaisons = [];
    table.coup.mains[premier] = [...quinte, ...suite, aJeterPremier, c('carreau', 'R')];
    table.coup.mains[second] = [autreNeuf, aJeterSecond, c('carreau', 'D')];
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });
    table.coup.recapitulatifs[second] = recap({ toursAvecPose: [1] });
    const joueurPremier = espions.find((e) => e.joueurId === premier) as Espion;
    const joueurSecond = espions.find((e) => e.joueurId === second) as Espion;

    await agir(joueurPremier, 'annoncer', { annonce: 'je-joue' });
    await agir(joueurPremier, 'piocher', { source: 'pioche' });
    expect((await emettre(joueurPremier.socket, 'poser', {
      poses: [
        { type: 'tierce', couleur: 'pique', cartes: quinte.map((carte) => ({ carteId: carte.id })) },
        { type: 'tierce', couleur: 'pique', cartes: suite.map((carte) => ({ carteId: carte.id })) },
      ],
    })).ok).toBe(true);
    expect(await agir(joueurPremier, 'defausser', { carteId: aJeterPremier.id })).toEqual({ ok: true });
    expect(compterCroix(table.coup, premier)).toBe(2);

    await agir(joueurSecond, 'piocher', { source: 'pioche' });
    const laQuinte = table.coup.combinaisons.find((combinaison) =>
      combinaison.cartes.some((cp) => cp.carte.id === quinte[0]?.id)) as Combinaison;
    expect((await emettre(joueurSecond.socket, 'poser', {
      ajouts: [{ combinaisonId: laQuinte.id, cartes: [{ carteId: autreNeuf.id }] }],
    })).ok).toBe(true);
    expect(await agir(joueurSecond, 'defausser', { carteId: aJeterSecond.id })).toEqual({ ok: true });

    expect(table.coup.combinaisons.find((combinaison) => combinaison.id === laQuinte.id)?.cartes).toHaveLength(6);
    expect(compterCroix(table.coup, premier)).toBe(2);
  });

  /** Une table aux délais choisis, tous les joueurs présents. */
  const ouvrirTableMinutee = async (delais: DelaisDeJeu) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, { alea: aleaFixe(), delais });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    await attendrePremiersEtats(espions);
    const table = serveur.manager.table(tableId);
    const ordre = table.coup?.ordreJoueurs ?? [];
    const espion = (joueurId: JoueurId | undefined) => espions.find((autre) => autre.joueurId === joueurId) as Espion;
    return { table, ordre, espion };
  };
  const minuteursActifs = () => horloge.programmes.filter((programme) => !programme.annule).map((p) => p.delaiMs);

  it('fait friche d office quand le delai d annonce expire, joueur present', async () => {
    const { table, ordre } = await ouvrirTableMinutee({ annonceMs: 30000, jeuMs: null, prolongationMs: null });
    expect(minuteursActifs()).toEqual([30000]);
    // Chacun voit l'échéance : qui est attendu, pour quoi, et ce qu'il reste.
    for (const espion of espions) {
      const echeance = espion.dernierEtat?.echeance;
      expect(echeance?.joueurId).toBe(ordre[0]);
      expect(echeance?.nature).toBe('annonce');
      expect(echeance?.dureeMs).toBe(30000);
      expect(echeance?.restantMs).toBeGreaterThan(29000);
      expect(echeance?.restantMs).toBeLessThanOrEqual(30000);
    }

    horloge.declencher();
    expect(table.coup?.annonces[ordre[0] as string]).toBe('friche');
    await patienter(20);
    // Le suivant a son propre délai.
    expect(minuteursActifs()).toEqual([30000]);
  });

  it('n arme aucun minuteur a une table aux delais par defaut : ni friche ni defausse d office', async () => {
    const { table, ordre, espion } = await ouvrirTableMinutee(DELAIS_PAR_DEFAUT);
    expect(minuteursActifs()).toEqual([]);
    for (const autre of espions) expect(autre.dernierEtat?.echeance).toBeNull();

    // Annonces puis jeu : rien ne s'arme, le joueur peut prendre son temps.
    const premier = espion(ordre[0]);
    await agir(premier, 'annoncer', { annonce: 'je-joue' });
    await agir(premier, 'piocher', { source: 'pioche' });
    expect(minuteursActifs()).toEqual([]);
    horloge.declencher();
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(table.tourEnCours?.joueurId).toBe(ordre[0]);
    expect(table.coup?.defausse).toHaveLength(0);
  });

  it('n envoie aucune echeance a une table sans delai', async () => {
    await ouvrirTable();
    for (const espion of espions) expect(espion.dernierEtat?.echeance).toBeNull();
  });

  it('defausse la carte piochee quand le delai de jeu expire', async () => {
    const { table, ordre, espion } = await ouvrirTableMinutee({ annonceMs: null, jeuMs: 45000, prolongationMs: null });
    const premier = espion(ordre[0]);
    await agir(premier, 'annoncer', { annonce: 'je-joue' });
    await agir(premier, 'piocher', { source: 'pioche' });
    const piochee = table.tourEnCours?.cartePiochee;
    // Piocher ne relance pas le délai : il couvre tout le tour.
    expect(minuteursActifs()).toEqual([45000]);

    horloge.declencher();
    expect(table.coup?.defausse.at(-1)?.id).toBe(piochee?.id);
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
  });

  it('pioche et defausse pour le joueur qui n a rien fait de son tour', async () => {
    const { table, ordre, espion } = await ouvrirTableMinutee({ annonceMs: null, jeuMs: 45000, prolongationMs: null });
    await agir(espion(ordre[0]), 'annoncer', { annonce: 'je-joue' });

    horloge.declencher();
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
    expect(table.coup?.mains[ordre[0] as string]).toHaveLength(14);
    expect(table.coup?.defausse).toHaveLength(1);
  });

  it('accorde une fois la prolongation a qui a commence a composer', async () => {
    const { table, ordre, espion } = await ouvrirTableMinutee({ annonceMs: null, jeuMs: 45000, prolongationMs: 20000 });
    const premier = espion(ordre[0]);
    await agir(premier, 'annoncer', { annonce: 'je-joue' });
    await agir(premier, 'piocher', { source: 'pioche' });
    expect((await emettre(espion(ordre[1]).socket, 'composition-commencee', {})).ok).toBe(false);
    expect((await emettre(premier.socket, 'composition-commencee', {})).ok).toBe(true);

    horloge.declencher();
    expect(table.coup?.joueurActifId).toBe(ordre[0]);
    expect(minuteursActifs()).toEqual([20000]);
    // La prolongation se voit aussitôt : un nouvel état part.
    await patienter(30);
    expect(premier.dernierEtat?.echeance?.nature).toBe('prolongation');
    expect(premier.dernierEtat?.echeance?.dureeMs).toBe(20000);

    horloge.declencher();
    expect(table.coup?.joueurActifId).toBe(ordre[1]);
  });

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

  it('retourne le tirage d ouverture en direct : une carte n apparait qu une fois retournee par son joueur', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    const [premier, second] = espions as [Espion, Espion, Espion];

    // Au départ, rien de retourné, et chacun peut toucher sa carte.
    for (const espion of espions) {
      const tirage = espion.dernierEtat?.tirageOuverture;
      expect(Object.values(tirage?.retournees ?? {}).flat()).toEqual([]);
      expect(tirage?.aRetourner).toHaveLength(JOUEURS.length);
      expect(tirage?.ordreTable).toBeNull();
    }

    // Le premier retourne la sienne : tous la voient, rien des autres.
    expect((await agir(premier, 'retourner-carte-tirage', { place: 7 })).ok).toBe(true);
    for (const espion of espions) {
      const retournees = espion.dernierEtat?.tirageOuverture?.retournees ?? {};
      expect(retournees[premier.joueurId]?.map((retournee) => retournee.place)).toEqual([7]);
      expect(retournees[second.joueurId]).toEqual([]);
    }
    expect((await emettre(second.socket, 'retourner-carte-tirage', { place: 7 })).ok).toBe(false);

    // Chacun retourne les siennes, retirages compris, jusqu'au bout.
    let place = 20;
    for (let manche = 0; manche < 20 && premier.dernierEtat?.tirageOuverture?.complet !== true; manche += 1) {
      for (const joueurId of premier.dernierEtat?.tirageOuverture?.aRetourner ?? []) {
        const espion = espions.find((autre) => autre.joueurId === joueurId) as Espion;
        place += 1;
        expect((await agir(espion, 'retourner-carte-tirage', { place })).ok).toBe(true);
      }
    }

    for (const espion of espions) {
      const tirage = espion.dernierEtat?.tirageOuverture;
      expect(tirage?.complet).toBe(true);
      expect(tirage?.ordreTable).toEqual(table.joueurs.map((joueur) => joueur.id));
      expect(tirage?.donneurInitial).toBe(table.joueurs[0]?.id);
      const cartes = Object.values(tirage?.retournees ?? {}).flat().map((retournee) => retournee.carte);
      expect(cartes.every((carte) => carte.id.startsWith('tirage-'))).toBe(true);
    }
  });

  /**
   * Réf. docs/REGLES.md § « Phase Friche / Je joue » : la parole tourne tant
   * que personne n'a posé. Trois joueurs, dans l'ordre de la table P1, P2, P3.
   */
  const tableDeParole = async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const ordre = [...table.coup.ordreJoueurs] as [JoueurId, JoueurId, JoueurId];
    const [p1, p2, p3] = ordre.map((id) => espions.find((e) => e.joueurId === id) as Espion) as [Espion, Espion, Espion];
    const coupReel = (): Coup => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };
    const jouerSonTour = async (espion: Espion) => {
      expect((await agir(espion, 'piocher', { source: 'pioche' })).ok).toBe(true);
      const aJeter = espion.dernierEtat?.moi.main.find((carte) => carte.type === 'normale')?.id;
      expect(await agir(espion, 'defausser', { carteId: aJeter })).toEqual({ ok: true });
    };
    return { table, ordre, p1, p2, p3, coupReel, jouerSonTour };
  };

  it('parole : friche, je joue, tour force, puis l engage seul est re-interroge', async () => {
    const t = await tableDeParole();
    const entete = () => t.p3.dernierEtat?.coup;

    expect((await agir(t.p1, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    expect(entete()).toMatchObject({ phase: 'annonces', aParler: t.p2.joueurId, enAttente: [t.p1.joueurId], engageId: null });
    // P2 a la parole mais pas la main : toucher la pioche ne vaut rien.
    expect((await emettre(t.p2.socket, 'piocher', { source: 'pioche' })).ok).toBe(false);
    // P1 a friché : il attend, il ne peut ni parler ni jouer avant un « je joue ».
    expect((await emettre(t.p1.socket, 'piocher', { source: 'pioche' })).ok).toBe(false);

    expect((await agir(t.p2, 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    expect(entete()).toMatchObject({ phase: 'jeu', joueurActifId: t.p1.joueurId, engageId: t.p2.joueurId });
    await t.jouerSonTour(t.p1);

    // L'engagé est re-interrogé : toucher la pioche vaut « je continue ».
    expect(entete()).toMatchObject({ phase: 'annonces', aParler: t.p2.joueurId, engageId: t.p2.joueurId, enAttente: [] });
    await t.jouerSonTour(t.p2);

    // P3 n'est pas interrogé : la rotation continue, il joue.
    expect(entete()).toMatchObject({ phase: 'jeu', joueurActifId: t.p3.joueurId, aParler: null });
    expect((await emettre(t.p3.socket, 'annoncer', { annonce: 'friche' })).ok).toBe(false);
    await t.jouerSonTour(t.p3);
    await t.jouerSonTour(t.p1);
    // Le tour de l'engagé revient : lui seul est interrogé de nouveau.
    expect(entete()).toMatchObject({ phase: 'annonces', aParler: t.p2.joueurId, engageId: t.p2.joueurId });
  });

  it('parole : l engage qui friche rouvre les annonces, et la file complete redistribue', async () => {
    const t = await tableDeParole();
    const numero = t.coupReel().numero;
    const donneur = t.coupReel().donneurId;
    const frichesAvant = t.table.boule?.frichesGeneralisees ?? 0;
    const jokerTire: Carte = { type: 'joker', id: 'joker-tire-en-route' };
    t.coupReel().pioche.unshift(jokerTire);

    expect((await agir(t.p1, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    expect((await agir(t.p2, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    expect((await agir(t.p3, 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);

    // P1 pioche le joker pendant son tour forcé, et le garde en main.
    await t.jouerSonTour(t.p1);
    expect(t.p1.dernierEtat?.moi.main.map((carte) => carte.id)).toContain(jokerTire.id);
    await t.jouerSonTour(t.p2);

    // L'engagé friche à son tour : il n'est plus engagé, et P1 est interrogé.
    expect(t.coupReel()).toMatchObject({ phase: 'annonces', aParler: t.p3.joueurId, engageId: t.p3.joueurId });
    expect((await agir(t.p3, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    expect(t.coupReel()).toMatchObject({ aParler: t.p1.joueurId, engageId: null, enAttente: [t.p3.joueurId] });
    expect((await agir(t.p1, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    expect((await agir(t.p2, 'annoncer', { annonce: 'friche' })).ok).toBe(true);

    // La file compte tout le monde : le coup est redistribué à la même place.
    const coup = t.coupReel();
    expect(coup.numero).toBe(numero);
    expect(coup.donneurId).toBe(donneur);
    expect(coup).toMatchObject({ phase: 'annonces', annonces: {}, aParler: t.p1.joueurId, enAttente: [], engageId: null });
    expect(t.table.boule?.frichesGeneralisees).toBe(frichesAvant + 1);
    expect(t.p1.dernierEtat?.moi.main.map((carte) => carte.id)).toContain(jokerTire.id);
    expect(t.p1.dernierEtat?.moi.main).toHaveLength(14);
  });

  it('parole : une pose pendant le tour force clot la friche, meme pour l engage', async () => {
    const t = await tableDeParole();
    const quinte = [c('coeur', 10), c('coeur', 'V'), c('coeur', 'D'), c('coeur', 'R'), c('coeur', 'A')];
    const aJeter = c('pique', 3);
    t.coupReel().mains[t.p1.joueurId] = [...quinte, aJeter, c('carreau', 9)];

    expect((await agir(t.p1, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    expect((await agir(t.p2, 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);

    // P1 rattrape son tour forcé et ouvre.
    expect((await agir(t.p1, 'piocher', { source: 'pioche' })).ok).toBe(true);
    const pose = await emettre(t.p1.socket, 'poser', {
      poses: [{ type: 'tierce', couleur: 'coeur', cartes: quinte.map((carte) => ({ carteId: carte.id })) }],
    });
    expect(pose.ok).toBe(true);
    expect(await agir(t.p1, 'defausser', { carteId: aJeter.id })).toEqual({ ok: true });

    // Plus personne n'est interrogé, l'engagé pas davantage que les autres.
    expect(t.p3.dernierEtat?.coup).toMatchObject({ phase: 'jeu', aParler: null, enAttente: [], joueurActifId: t.p2.joueurId });
    expect((await emettre(t.p2.socket, 'annoncer', { annonce: 'friche' })).ok).toBe(false);
    await t.jouerSonTour(t.p2);
    expect((await emettre(t.p3.socket, 'annoncer', { annonce: 'friche' })).ok).toBe(false);
    await t.jouerSonTour(t.p3);
    expect(t.p1.dernierEtat?.coup).toMatchObject({ phase: 'jeu', joueurActifId: t.p1.joueurId, aParler: null });
    expect(t.coupReel().engageId).toBe(t.p2.joueurId);
  });

  it('fin de coup geste par geste : un ajout chez un adversaire en premier, puis le reste, tout passe a la defausse', async () => {
    // Réf. docs/REGLES.md § « Fin de coup automatique sans les conditions
    // normales ». Le premier joueur n'a jamais ouvert ; il tient quatre
    // brelans (42 points, aucune tierce) et le 9♦ et le 10♦ d'une suite adverse.
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const [premier, second] = table.coup.ordreJoueurs as [JoueurId, JoueurId];
    const brelans = [
      [c('pique', 2), c('coeur', 2), c('trefle', 2)],
      [c('pique', 3), c('coeur', 3), c('trefle', 3)],
      [c('pique', 4), c('coeur', 4), c('trefle', 4)],
      [c('pique', 5), c('coeur', 5), c('trefle', 5)],
    ];
    const neuf = c('carreau', 9);
    const dix = c('carreau', 10);
    const suite = tierce('carreau', [c('carreau', 6), c('carreau', 7), c('carreau', 8)], second);
    table.coup.combinaisons = [suite];
    table.coup.mains[premier] = [...brelans.flat(), neuf, dix];
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [] });
    const joueur = espions.find((e) => e.joueurId === premier) as Espion;

    expect((await agir(joueur, 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    expect((await agir(joueur, 'piocher', { source: 'pioche' })).ok).toBe(true);
    const quinzieme = table.tourEnCours?.cartePiochee;
    if (quinzieme === undefined) throw new Error('carte piochee absente');

    // Premier geste : un ajout chez l'adversaire, sans jeu ouvert. Accepté en brouillon.
    const ajout = (carte: Carte) => ({ ajouts: [{ combinaisonId: suite.id, cartes: [{ carteId: carte.id }] }] });
    expect((await emettre(joueur.socket, 'poser', ajout(neuf))).ok).toBe(true);
    // Second geste sur la même suite, puis les quatre brelans.
    expect((await emettre(joueur.socket, 'poser', ajout(dix))).ok).toBe(true);
    for (const [rang, brelan] of brelans.entries()) {
      const pose = { poses: [{ type: 'ensemble', valeur: rang + 2, cartes: brelan.map((carte) => ({ carteId: carte.id })) }] };
      expect((await emettre(joueur.socket, 'poser', pose)).ok).toBe(true);
    }

    // La défausse de la 15e carte tranche : 14 cartes posées, le coup est fini.
    expect(await agir(joueur, 'defausser', { carteId: quinzieme.id })).toEqual({ ok: true });
    expect(table.resultatCoup?.score.gagnantId).toBe(premier);
    expect(table.coup?.mains[premier]).toEqual([]);
  });

  it('un joueur sans pseudo choisi s assoit sous « Joueur N », selon son rang d arrivee, jamais sous son identifiant', async () => {
    const sansPseudo = (id: string) => ({
      id,
      identifiantApple: `local:${id}`,
      pseudo: 'Joueur',
      pseudoChoisi: false,
      creeLe: new Date(),
    });
    const { tableId, codeInvitation } = await serveur.manager.creerTable(sansPseudo('p-un'), { capacite: 3 });
    await serveur.manager.rejoindreParCode(codeInvitation, { id: 'p-ana', pseudo: 'Ana' });
    await serveur.manager.rejoindreParCode(codeInvitation, sansPseudo('p-trois'));
    const nom = (id: string) => serveur.manager.table(tableId).joueurs.find((joueur) => joueur.id === id)?.nom;

    // Deux joueurs sans pseudo ne se confondent pas ; Ana garde le sien.
    expect([nom('p-un'), nom('p-ana'), nom('p-trois')]).toEqual(['Joueur 1', 'Ana', 'Joueur 3']);
    // Dès qu'il en choisit un, il remplace le défaut.
    serveur.manager.renommerDansLesTables('p-trois', 'Maxime');
    expect(nom('p-trois')).toBe('Maxime');
  });

  it('le dernier arrive au salon : ceux qui attendaient recoivent son pseudo avec le premier etat', async () => {
    // Le salon se remplit : Ana et Bo attendent, connectés.
    const { tableId, codeInvitation } = await serveur.manager.creerTable(
      { id: 'p-ana', pseudo: 'Ana' },
      { capacite: 3, alea: aleaFixe() },
    );
    await serveur.manager.rejoindreParCode(codeInvitation, { id: 'p-bo', pseudo: 'Bo' });
    const ana = await connecter(tableId, 'p-ana');
    await connecter(tableId, 'p-bo');

    // Cy prend la dernière place. La table pleine ne se décrit plus par
    // l'événement « salon » : l'app d'Ana passe à la partie avec la liste du
    // salon, où Cy manquait, et affichait son identifiant technique.
    await serveur.manager.rejoindreParCode(codeInvitation, { id: 'p-cy', pseudo: 'Cy' });
    publierTable(serveur.io, serveur.manager, serveur.manager.table(tableId));
    await connecter(tableId, 'p-cy');

    for (let essai = 0; essai < 100 && ana.dernierEtat === null; essai += 1) await patienter(5);
    // L'état porte désormais la liste complète : Cy a son pseudo chez Ana.
    expect(ana.dernierEtat?.pseudos).toEqual({ 'p-ana': 'Ana', 'p-bo': 'Bo', 'p-cy': 'Cy' });
  });

  it('un pseudo change en pleine partie arrive aussitot a tous les joueurs de la table', async () => {
    const { tableId } = await ouvrirTable();
    for (const joueur of JOUEURS) depot.inscrire(joueur.id, joueur.pseudo);
    const table = serveur.manager.table(tableId);

    // Le pseudo part avec chaque état, pour chacun : personne n'attend d'être
    // ressorti de la table pour le lire.
    for (const espion of espions) {
      expect(espion.dernierEtat?.pseudos).toEqual({ 'p-ana': 'Ana', 'p-bo': 'Bo', 'p-cy': 'Cy' });
    }

    const avant = espions.map((espion) => espion.etatsRecus);
    const jeton = await signerJetonSession('p-bo', SESSION);
    const reponse = await fetch(`http://localhost:${String(port)}/joueur/pseudo`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ pseudo: 'Bobinette' }),
    });
    expect(reponse.status).toBe(200);

    // Chacun reçoit un état neuf, sans avoir rien fait.
    for (let essai = 0; essai < 100; essai += 1) {
      if (espions.every((espion, rang) => espion.etatsRecus > (avant[rang] as number))) break;
      await patienter(5);
    }
    for (const espion of espions) {
      expect(espion.dernierEtat?.pseudos['p-bo']).toBe('Bobinette');
    }
    // La table elle-même le retient, pour les prochains états comme pour l'API.
    expect(table.joueurs.find((joueur) => joueur.id === 'p-bo')?.nom).toBe('Bobinette');
  });

  it('signale les jokers gardes d une friche generalisee a celui qui les tient, et a lui seul', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const ordre = table.coup.ordreJoueurs;
    const detenteur = ordre[0] as JoueurId;
    const jokerGarde: Carte = { type: 'joker', id: 'joker-garde' };
    const main = table.coup.mains[detenteur] as Carte[];
    table.coup.pioche.push(main[0] as Carte);
    main[0] = jokerGarde;

    for (const joueurId of ordre) {
      const espion = espions.find((e) => e.joueurId === joueurId) as Espion;
      expect((await agir(espion, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    }

    for (const espion of espions) {
      const gardes = espion.dernierEtat?.moi.jokersGardes ?? [];
      const estDetenteur = espion.joueurId === detenteur;
      expect(gardes.includes(jokerGarde.id)).toBe(estDetenteur);
      expect(identifiantsDans(espion.recus).has(jokerGarde.id)).toBe(estDetenteur);
    }
    const chezLui = espions.find((e) => e.joueurId === detenteur)?.dernierEtat;
    expect(chezLui?.moi.main.map((carte) => carte.id)).toContain(jokerGarde.id);
    expect(chezLui?.moi.main).toHaveLength(14);
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
   * points et une tierce franche. Le moteur ne le vérifie qu'à la défausse, quand
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
    // exactement 51 points et elle est franche, le reste ne forme rien.
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
   * Réf. docs/REGLES.md § « Récupération d'un joker posé » : le scénario
   * rapporté. Le premier joueur n'a pas encore ouvert ; sur la table, le
   * 5-[joker en 6]-7 de trèfle du second. Il tient de quoi poser la quinte
   * 10-[coucou]-D-R-A de cœur, le vrai 6 de trèfle, deux 8 et un 3 à jeter.
   */
  const tableAvantPremierePose = async (main: (reprise: { jokerId: string }) => Carte[]) => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');

    const premier = table.coup.ordreJoueurs[0] as JoueurId;
    const second = table.coup.ordreJoueurs[1] as JoueurId;
    const jokerEnSix = { carte: joker(), remplace: { couleur: 'trefle' as const, valeur: 6 as const } };
    const surLaTable = {
      id: 'comb-du-second',
      type: 'tierce' as const,
      proprietaireId: second,
      tourDePose: 1,
      couleur: 'trefle' as const,
      cartes: [{ carte: c('trefle', 5), remplace: null }, jokerEnSix, { carte: c('trefle', 7), remplace: null }],
      pure: false,
    };
    const sixTrefle = c('trefle', 6);
    table.coup.combinaisons = [surLaTable];
    table.coup.mains[premier] = [sixTrefle, ...main({ jokerId: jokerEnSix.carte.id })];
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [] });

    const joueur = espions.find((e) => e.joueurId === premier) as Espion;
    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });

    const recuperer = () =>
      emettre(joueur.socket, 'recuperer-joker', {
        carteReelleId: sixTrefle.id,
        combinaisonId: surLaTable.id,
        carteJokerId: jokerEnSix.carte.id,
      });
    return { table, joueur, jokerId: jokerEnSix.carte.id, recuperer };
  };

  it('recupere un joker avant la premiere pose, puis pose 10-[coucou]-D-R-A : aucun blocage a aucune etape', async () => {
    const dix = c('coeur', 10);
    const coucouEnMain = coucou();
    const dame = c('coeur', 'D');
    const roi = c('coeur', 'R');
    const as = c('coeur', 'A');
    const huitPique = c('pique', 8);
    const huitCarreau = c('carreau', 8);
    const aJeter = c('pique', 3);
    const t = await tableAvantPremierePose(() => [dix, coucouEnMain, dame, roi, as, huitPique, huitCarreau, aJeter]);

    // La quinte d'abord, encore au brouillon : c'est là que l'échange butait.
    const quinte = await emettre(t.joueur.socket, 'poser', {
      poses: [{
        type: 'tierce',
        couleur: 'coeur',
        cartes: [
          { carteId: dix.id },
          { carteId: coucouEnMain.id, remplace: { couleur: 'coeur', valeur: 'V' } },
          { carteId: dame.id },
          { carteId: roi.id },
          { carteId: as.id },
        ],
      }],
    });
    expect(quinte.ok).toBe(true);

    const reprise = await t.recuperer();
    expect(reprise).toEqual({ ok: true });

    const brelan = await emettre(t.joueur.socket, 'poser', {
      poses: [{
        type: 'ensemble',
        valeur: 8,
        cartes: [
          { carteId: huitPique.id },
          { carteId: huitCarreau.id },
          { carteId: t.jokerId, remplace: { couleur: 'trefle', valeur: 8 } },
        ],
      }],
    });
    expect(brelan.ok).toBe(true);

    const clos = await emettre(t.joueur.socket, 'defausser', { carteId: aJeter.id });
    expect(clos).toEqual({ ok: true });
    expect(t.table.coup?.combinaisons).toHaveLength(3);
    expect(t.joueur.dernierEtat?.moi.aPose).toBe(true);
  });

  it('refuse clairement une premiere pose qui n atteint 51 points que grace au joker repris', async () => {
    const dix = c('coeur', 10);
    const valet = c('coeur', 'V');
    const dame = c('coeur', 'D');
    const huitPique = c('pique', 8);
    const huitCarreau = c('carreau', 8);
    const aJeter = c('pique', 3);
    const t = await tableAvantPremierePose(() => [dix, valet, dame, huitPique, huitCarreau, aJeter]);

    expect((await t.recuperer()).ok).toBe(true);
    const pose = await emettre(t.joueur.socket, 'poser', {
      poses: [
        { type: 'tierce', couleur: 'coeur', cartes: [{ carteId: dix.id }, { carteId: valet.id }, { carteId: dame.id }] },
        {
          type: 'ensemble',
          valeur: 8,
          cartes: [
            { carteId: huitPique.id },
            { carteId: huitCarreau.id },
            { carteId: t.jokerId, remplace: { couleur: 'trefle', valeur: 8 } },
          ],
        },
      ],
    });
    expect(pose.ok).toBe(true);

    const refus = await emettre(t.joueur.socket, 'defausser', { carteId: aJeter.id });
    expect(refus.ok).toBe(false);
    expect(refus.ok === false && refus.erreur).toContain('joker tout juste recupere ne peut pas servir a ouvrir');
    expect(t.table.coup?.combinaisons).toHaveLength(1);
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
  it('montre, a la fin du coup, les cartes que le gagnant vient d engager pour finir', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const [premier, second] = table.coup.ordreJoueurs as [JoueurId, JoueurId, JoueurId];
    const joueur = espions.find((espion) => espion.joueurId === premier) as Espion;

    // Le premier a déjà posé et ne tient plus que le 10♥ ; la tierce 7-8-9♥ de
    // l'autre l'attend. Le talon lui sert une carte ordinaire à jeter.
    const suite = tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)], second);
    const dix = c('coeur', 10);
    const aJeter = c('pique', 2);
    table.coup.combinaisons = [suite];
    table.coup.mains[premier] = [dix];
    table.coup.pioche.unshift(aJeter);
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    expect(
      (await emettre(joueur.socket, 'poser', { ajouts: [{ combinaisonId: suite.id, cartes: [{ carteId: dix.id }] }] })).ok,
    ).toBe(true);
    expect((await agir(joueur, 'defausser', { carteId: aJeter.id })).ok).toBe(true);

    for (const espion of espions) {
      const resultat = espion.dernierEtat?.resultat;
      expect(resultat?.gagnantId).toBe(premier);
      expect(resultat?.poseFinale).toEqual([dix.id]);
      // Et la carte qu'il a jetée pour finir.
      expect(resultat?.carteDefaussee?.id).toBe(aJeter.id);
    }
    // Et l'historique la garde, pour y revenir plus tard.
    expect(serveur.manager.table(tableId).boule?.historique[0]?.poseFinale).toEqual([dix.id]);
  });

  /** Mène une table au dernier entracte : Boule d'un seul coup, gagné par le premier joueur. */
  const finirLaBoule = async (options: { coupsFrichesDepart?: number; frichesAjoutees?: number } = {}) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, {
      alea: aleaFixe(),
      ...(options.coupsFrichesDepart === undefined ? {} : { coupsFrichesDepart: options.coupsFrichesDepart }),
    });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    await attendrePremiersEtats(espions);
    const table = serveur.manager.table(tableId);
    if (table.coup === null || table.boule === null) throw new Error('coup absent');
    // Les friches généralisées ajoutées en route, simulées sur le compteur.
    table.boule = {
      ...table.boule,
      nombreCoupsTotal: 1,
      nombreCoupsFriches: table.coupsFrichesDepart + (options.frichesAjoutees ?? 0),
      frichesGeneralisees: options.frichesAjoutees ?? 0,
    };
    const [premier, second] = table.coup.ordreJoueurs as [JoueurId, JoueurId, JoueurId];
    const suite = tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)], second);
    const dix = c('coeur', 10);
    const aJeter = c('pique', 2);
    table.coup.combinaisons = [suite];
    table.coup.mains[premier] = [dix];
    table.coup.pioche.unshift(aJeter);
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });
    const joueur = espions.find((espion) => espion.joueurId === premier) as Espion;
    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    await emettre(joueur.socket, 'poser', { ajouts: [{ combinaisonId: suite.id, cartes: [{ carteId: dix.id }] }] });
    await agir(joueur, 'defausser', { carteId: aJeter.id });
    expect(table.resultatCoup?.derniereCoup).toBe(true);
    return { table, numero: table.resultatCoup?.numero };
  };
  const annonceDeNouvelleTable = (espion: Espion) =>
    espion.recus.find((recu) => typeof recu === 'object' && recu !== null && 'ancienneTableId' in recu) as
      | { ancienneTableId: string; table: { tableId: string; statut: string; coupsFrichesDepart: number } }
      | undefined;

  it('rejoue une Boule avec le meme groupe quand tous confirment, sans report quand rien n a deborde', async () => {
    const { table, numero } = await finirLaBoule({ coupsFrichesDepart: 1 });
    const [ana, bo, cy] = espions as [Espion, Espion, Espion];

    expect((await agir(ana, 'rejouer', { numero })).ok).toBe(true);
    // Rien ne se passe tant que tous n'ont pas confirmé, et chacun voit qui l'a fait.
    expect(table.statut).toBe('en-cours');
    expect(bo.dernierEtat?.resultat?.rejouer).toEqual(['p-ana']);
    expect((await agir(bo, 'rejouer', { numero })).ok).toBe(true);
    expect(annonceDeNouvelleTable(ana)).toBeUndefined();

    expect((await emettre(cy.socket, 'rejouer', { numero })).ok).toBe(true);
    await patienter(30);
    expect(table.statut).toBe('terminee');

    const annonces = espions.map(annonceDeNouvelleTable);
    const nouvelleId = annonces[0]?.table.tableId as string;
    for (const annonce of annonces) {
      expect(annonce?.ancienneTableId).toBe(table.id);
      expect(annonce?.table.tableId).toBe(nouvelleId);
    }
    const nouvelle = serveur.manager.table(nouvelleId);
    expect(nouvelle.joueurs.map((joueur) => joueur.id).sort()).toEqual(['p-ana', 'p-bo', 'p-cy']);
    expect(nouvelle.statut).toBe('en-cours');
    expect(nouvelle.delais).toEqual(table.delais);
    expect(nouvelle.createurId).toBe(table.createurId);
    // Aucune friche généralisée n'a débordé : la base configurée, sans report.
    expect(nouvelle.coupsFrichesDepart).toBe(1);
    expect(nouvelle.boule?.nombreCoupsFriches).toBe(1);
    expect(nouvelle.coupsFrichesConfigures).toBe(1);
    expect(nouvelle.excedentDeFriches).toBe(0);
  });

  /**
   * Réf. docs/REGLES.md § « Structure d'une Boule » : le report suivi friche
   * généralisée par friche généralisée, sur de vraies parties. Chaque friche est
   * annoncée par tous les joueurs, au coup voulu ; chaque coup est gagné pour
   * de bon ; chaque « Rejouer » est confirmé par tous.
   */
  it('report de friches sur une chaine de deux Rejouer, friches annoncees au coup voulu', async () => {
    const frichePourTous = async (table: ReturnType<typeof serveur.manager.table>) => {
      const coup = table.coup;
      if (coup === null) throw new Error('coup absent');
      for (;;) {
        const enCours = table.coup as Coup;
        const parleur = enCours.ordreJoueurs.find((id) => enCours.annonces[id] === undefined);
        if (parleur === undefined) throw new Error('personne ne parle');
        const espion = espions.find((e) => e.joueurId === parleur) as Espion;
        const avant = enCours.ordreJoueurs.length - Object.keys(enCours.annonces).length;
        expect((await agir(espion, 'annoncer', { annonce: 'friche' })).ok).toBe(true);
        // Le dernier à friche relance la donne : plus personne n'a parlé.
        if (avant === 1) return;
      }
    };
    const gagnerLeCoup = async (table: ReturnType<typeof serveur.manager.table>) => {
      const coup = table.coup as Coup;
      const [premier, second] = coup.ordreJoueurs as [JoueurId, JoueurId];
      const suite = tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)], second);
      const dix = c('coeur', 10);
      const aJeter = c('pique', 2);
      coup.combinaisons = [suite];
      coup.mains[premier] = [dix];
      coup.pioche.unshift(aJeter);
      coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });
      const joueur = espions.find((espion) => espion.joueurId === premier) as Espion;
      await agir(joueur, 'annoncer', { annonce: 'je-joue' });
      await agir(joueur, 'piocher', { source: 'pioche' });
      await emettre(joueur.socket, 'poser', { ajouts: [{ combinaisonId: suite.id, cartes: [{ carteId: dix.id }] }] });
      await agir(joueur, 'defausser', { carteId: aJeter.id });
      const resultat = table.resultatCoup;
      if (resultat === null) throw new Error('coup non termine');
      if (resultat.derniereCoup) return resultat.numero;
      for (const espion of espions) await agir(espion, 'pret-pour-suivant', { numero: resultat.numero });
      return resultat.numero;
    };
    const rejouer = async (table: ReturnType<typeof serveur.manager.table>, numero: number) => {
      for (const espion of espions) expect((await agir(espion, 'rejouer', { numero })).ok).toBe(true);
      await patienter(30);
      const suivante = serveur.manager.table(table.relanceeVers as string);
      // Chacun bascule sur la nouvelle table, comme l'app à « nouvelle-table ».
      for (const espion of espions.splice(0)) espion.socket.disconnect();
      for (const joueur of JOUEURS) await connecter(suivante.id, joueur.id);
      await attendrePremiersEtats(espions);
      return suivante;
    };

    // Boule A : 3 coups, 1 coup friché configuré.
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, {
      alea: aleaFixe(),
      nombreCoups: 3,
      coupsFrichesDepart: 1,
    });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    await attendrePremiersEtats(espions);
    const a = serveur.manager.table(tableId);

    await gagnerLeCoup(a);
    // Deux friches au coup 2 : 2 coups restants. La première fait K = 2, la
    // seconde en voudrait 3 : K reste à 2, 1 part au report.
    await frichePourTous(a);
    expect(a.boule?.nombreCoupsFriches).toBe(2);
    expect(a.boule?.reportDeFriches).toBe(0);
    await frichePourTous(a);
    expect(a.boule?.nombreCoupsFriches).toBe(2);
    expect(a.boule?.reportDeFriches).toBe(1);
    await gagnerLeCoup(a);
    // Une friche au coup 3 : 3 voulus pour 1 coup restant, 2 de plus au report.
    await frichePourTous(a);
    expect(a.boule?.nombreCoupsFriches).toBe(1);
    expect(a.boule?.reportDeFriches).toBe(3);
    const finA = await gagnerLeCoup(a);
    const reportA = a.boule?.reportDeFriches as number;

    // Boule B, premier Rejouer : 1 configuré + 3 = 4 voulus pour 3 coups.
    const b = await rejouer(a, finA);
    expect(b.coupsFrichesDepart).toBe(3);
    expect(b.excedentDeFriches).toBe(1);
    expect(b.boule?.nombreCoupsFriches).toBe(3);
    expect(b.boule?.reportDeFriches).toBe(1);
    // G = 2 friches au coup 1 de B, dont chacune déborde les 3 coups restants.
    const g = 2;
    await frichePourTous(b);
    await frichePourTous(b);
    await gagnerLeCoup(b);
    await gagnerLeCoup(b);
    const finB = await gagnerLeCoup(b);
    const reportB = b.boule?.reportDeFriches as number;
    // (base + R_A + G) - M : il croît, il ne se tronque pas.
    expect(reportB).toBe(1 + reportA + g - 3);
    expect(reportB).toBe(3);

    // Boule C, deuxième Rejouer depuis B : son report hérité est celui de B.
    const c3 = await rejouer(b, finB);
    expect(c3.coupsFrichesDepart).toBe(Math.min(1 + reportB, 3));
    expect(c3.excedentDeFriches).toBe(1 + reportB - 3);
    expect(c3.boule?.nombreCoupsFriches).toBe(3);
    expect(c3.boule?.reportDeFriches).toBe(1);
  }, 60_000);

  it('laisse un joueur terminer seul : la Boule se clot aussitot, nul ne la rejoue, les autres gardent le decompte', async () => {
    const { table, numero } = await finirLaBoule();
    const [ana, bo, cy] = espions as [Espion, Espion, Espion];

    expect((await agir(ana, 'rejouer', { numero })).ok).toBe(true);
    // Bo termine : sans attendre ni Ana ni Cy.
    expect((await agir(bo, 'pret-pour-suivant', { numero })).ok).toBe(true);
    expect(table.statut).toBe('terminee');
    expect(table.resultatCoup).toBeNull();

    // Cy, qui n'a rien confirmé, voit encore le décompte de la Boule, et plus
    // de résultat où rejouer.
    expect(cy.dernierEtat?.finDeBoule).not.toBeNull();
    expect(cy.dernierEtat?.resultat).toBeNull();
    const refus = await emettre(cy.socket, 'rejouer', { numero });
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toMatch(/la Boule est close/);
    expect(espions.map(annonceDeNouvelleTable).every((annonce) => annonce === undefined)).toBe(true);

    // Son propre « Terminer », arrivé après, est sans effet.
    expect((await emettre(cy.socket, 'pret-pour-suivant', { numero })).ok).toBe(true);
  });

  it('refuse la defausse a qui a deja pose et ne tient plus qu une carte, pas le talon', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const premier = table.coup.ordreJoueurs[0] as JoueurId;
    const joueur = espions.find((espion) => espion.joueurId === premier) as Espion;
    table.coup.mains[premier] = [c('coeur', 10)];
    table.coup.defausse = [c('pique', 5)];
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });

    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    const refus = await emettre(joueur.socket, 'piocher', { source: 'defausse' });
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toMatch(/Une seule carte en main apres avoir pose/);
    expect(table.tourEnCours).toBeNull();
    expect((await agir(joueur, 'piocher', { source: 'pioche' })).ok).toBe(true);
  });

  it('traite un double appui sur « Continuer » sans rien casser, avant comme apres la donne suivante', async () => {
    const { tableId } = await ouvrirTable();
    const table = serveur.manager.table(tableId);
    if (table.coup === null) throw new Error('coup absent');
    const [premier, second] = table.coup.ordreJoueurs as [JoueurId, JoueurId, JoueurId];
    const espion = (joueurId: JoueurId) => espions.find((autre) => autre.joueurId === joueurId) as Espion;
    const joueur = espion(premier);

    // Un vrai coup gagné : le premier finit en ajoutant le 10♥ à une tierce.
    const suite = tierce('coeur', [c('coeur', 7), c('coeur', 8), c('coeur', 9)], second);
    const dix = c('coeur', 10);
    const aJeter = c('pique', 2);
    table.coup.combinaisons = [suite];
    table.coup.mains[premier] = [dix];
    table.coup.pioche.unshift(aJeter);
    table.coup.recapitulatifs[premier] = recap({ toursAvecPose: [1] });
    await agir(joueur, 'annoncer', { annonce: 'je-joue' });
    await agir(joueur, 'piocher', { source: 'pioche' });
    await emettre(joueur.socket, 'poser', { ajouts: [{ combinaisonId: suite.id, cartes: [{ carteId: dix.id }] }] });
    await agir(joueur, 'defausser', { carteId: aJeter.id });
    const numero = table.resultatCoup?.numero;
    expect(numero).toBe(1);

    // Deux appuis en rafale : les deux sont acquittés, un seul compte.
    const [un, deux] = await Promise.all([
      emettre(joueur.socket, 'pret-pour-suivant', { numero }),
      emettre(joueur.socket, 'pret-pour-suivant', { numero }),
    ]);
    expect(un.ok).toBe(true);
    expect(deux.ok).toBe(true);
    expect(table.resultatCoup?.prets).toEqual([premier]);

    // Les autres confirment : le coup suivant part normalement.
    for (const autre of espions.filter((e) => e.joueurId !== premier)) {
      expect((await agir(autre, 'pret-pour-suivant', { numero })).ok).toBe(true);
    }
    expect(table.resultatCoup).toBeNull();
    expect(table.coup?.numero).toBe(2);

    // Un doublon tardif, arrivé après la donne : acquitté, sans effet.
    const tardif = await emettre(joueur.socket, 'pret-pour-suivant', { numero });
    expect(tardif.ok).toBe(true);
    expect(table.coup?.numero).toBe(2);
    expect(table.coup?.phase).toBe('annonces');
  });

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
      rejouer: [],
      rejouerAnnulePar: null,
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
