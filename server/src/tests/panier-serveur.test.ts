import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { creerServeur, type Serveur } from '../server/index.js';
import { secretDepuisTexte, signerJetonSession } from '../auth/session.js';
import { DepotMemoire } from '../persistence/depot-memoire.js';
import { ouvrirTablePleine } from './aide-table.js';
import { c, joker } from './fixtures.js';
import { estJoker } from '../game-engine/cartes.js';
import type { Carte, Coup, JoueurId } from '../models/index.js';
import type { EtatCoupFiltre } from '../server/etat-filtre.js';

/**
 * Réf. docs/REGLES.md § « Le panier ». Deux joueurs, une donne construite
 * (13 cartes ordinaires et un joker d'office), aucune pose avant la fin du
 * coup, et un match qui se gagne en manches.
 */

const SESSION = { secret: secretDepuisTexte('secret-de-test-du-panier') };
const APPLE = { clientId: 'fr.tb-formations.laboule' };
const JOUEURS = [
  { id: 'p-ana', pseudo: 'Ana' },
  { id: 'p-bo', pseudo: 'Bo' },
];

interface Espion {
  readonly socket: ClientSocket;
  readonly joueurId: JoueurId;
  dernierEtat: EtatCoupFiltre | null;
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

describe('le panier, par la socket', () => {
  let serveur: Serveur;
  let port: number;
  let espions: Espion[];

  beforeEach(async () => {
    serveur = creerServeur({ session: SESSION, apple: APPLE, depot: new DepotMemoire() });
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
    const espion: Espion = { socket, joueurId, dernierEtat: null, etatsRecus: 0 };
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

  /**
   * Attend que l'état reçu par ce joueur porte le décompte de la manche : la
   * fin d'un coup se publie après un enregistrement asynchrone, et un seul
   * état plus récent ne suffit pas à le garantir.
   */
  const attendreLeDecompte = async (espion: Espion) => {
    for (let essai = 0; essai < 200 && (espion.dernierEtat?.resultat ?? null) === null; essai += 1) {
      await patienter(5);
    }
  };

  const ouvrirPanier = async (options: { manchesAGagner?: number; montant?: number } = {}) => {
    const { tableId } = await ouvrirTablePleine(serveur.manager, JOUEURS, { variante: 'panier', ...options });
    for (const joueur of JOUEURS) await connecter(tableId, joueur.id);
    for (let essai = 0; essai < 200 && !espions.every((e) => e.etatsRecus > 0); essai += 1) await patienter(5);
    const table = serveur.manager.table(tableId);
    const espion = (id: JoueurId) => espions.find((e) => e.joueurId === id) as Espion;
    const coupReel = (): Coup => {
      if (table.coup === null) throw new Error('coup absent');
      return table.coup;
    };
    return { tableId, table, espion, coupReel };
  };

  it('a la creation : deux joueurs, la variante, et les deux reglages', async () => {
    const { table } = await ouvrirPanier({ manchesAGagner: 4, montant: 25 });
    expect(table.variante).toBe('panier');
    expect(table.capacite).toBe(2);
    expect(table.manchesAGagner).toBe(4);
    expect(table.montant).toBe(25);
    // Le match est ouvert, personne n'a rien gagné, et La Boule n'existe pas.
    expect(table.boule).toBeNull();
    expect(table.panier?.manchesGagnees).toEqual({ 'p-ana': 0, 'p-bo': 0 });
  });

  it('le salon annonce la variante : la description qu il remplace ne doit pas la perdre', async () => {
    const createur = { id: 'p-ana', pseudo: 'Ana' };
    const { tableId } = await serveur.manager.creerTable(createur, {
      variante: 'panier',
      manchesAGagner: 2,
      montant: 15,
    });
    const socket = clientIo(`http://localhost:${String(port)}`, { transports: ['websocket'] });
    espions.push({ socket, joueurId: 'p-ana', dernierEtat: null, etatsRecus: 0 });
    const salon = new Promise<Record<string, unknown>>((resolve) => {
      socket.on('salon', (donnees: Record<string, unknown>) => {
        resolve(donnees);
      });
    });
    await new Promise<void>((resolve) => {
      socket.on('connect', () => {
        resolve();
      });
    });
    const jeton = await signerJetonSession('p-ana', SESSION);
    expect((await emettre(socket, 'rejoindre-table', { jeton, tableId })).ok).toBe(true);
    expect(await salon).toMatchObject({ variante: 'panier', manchesAGagner: 2, montant: 15 });
  });

  it('refuse un panier a trois joueurs, des manches hors bornes et un montant nul', async () => {
    const createur = { id: 'p-cy', pseudo: 'Cy' };
    await expect(serveur.manager.creerTable(createur, { variante: 'panier', capacite: 3 })).rejects.toThrow(/deux/);
    await expect(serveur.manager.creerTable(createur, { variante: 'panier', manchesAGagner: 0 })).rejects.toThrow(/manches/);
    await expect(serveur.manager.creerTable(createur, { variante: 'panier', manchesAGagner: 99 })).rejects.toThrow(/manches/);
    await expect(serveur.manager.creerTable(createur, { variante: 'panier', montant: 0 })).rejects.toThrow(/montant/i);
  });

  it('la donne : 14 cartes chacun dont un seul joker, aucun joker ni coucou au talon', async () => {
    const { coupReel } = await ouvrirPanier();
    const coup = coupReel();

    expect(coup.variante).toBe('panier');
    for (const joueurId of coup.ordreJoueurs) {
      const main = coup.mains[joueurId] ?? [];
      expect(main).toHaveLength(14);
      expect(main.filter(estJoker)).toHaveLength(1);
      expect(main.some((carte) => carte.type === 'coucou')).toBe(false);
    }
    expect(coup.pioche.some((carte) => carte.type === 'joker' || carte.type === 'coucou')).toBe(false);
    expect(coup.pioche).toHaveLength(106 - 28);
    // Au panier, aucun coup ne compte double.
    expect(coup.estFriche).toBe(false);
  });

  it('l autre joueur que le donneur parle en premier', async () => {
    const { coupReel } = await ouvrirPanier();
    const coup = coupReel();
    expect(coup.aParler).not.toBe(coup.donneurId);
    expect(coup.phase).toBe('annonces');
  });

  it('personne ne voit le joker de l autre : la main adverse ne fuit jamais', async () => {
    const { coupReel, espion } = await ouvrirPanier();
    const coup = coupReel();
    const [premier, second] = coup.ordreJoueurs as [JoueurId, JoueurId];
    const jokerDeLAutre = (coup.mains[second] ?? []).find(estJoker);
    expect(jokerDeLAutre).toBeDefined();
    const vuParLePremier = JSON.stringify(espion(premier).dernierEtat);
    expect(vuParLePremier).not.toContain((jokerDeLAutre as Carte).id);
  });

  it('les deux frichent : redistribution complete, un joker neuf offert a chacun, meme manche', async () => {
    const { coupReel, espion, table } = await ouvrirPanier();
    const avant = coupReel();
    const [premier, second] = avant.ordreJoueurs as [JoueurId, JoueurId];
    const idsJokersAvant = new Set(
      avant.ordreJoueurs.flatMap((id) => (avant.mains[id] ?? []).filter(estJoker).map((carte) => carte.id)),
    );

    expect((await agir(espion(premier), 'annoncer', { annonce: 'friche' })).ok).toBe(true);
    expect((await agir(espion(second), 'annoncer', { annonce: 'friche' })).ok).toBe(true);

    const apres = coupReel();
    // Même manche, même donneur : la friche générale rejoue à la même place.
    expect(apres.numero).toBe(avant.numero);
    expect(apres.donneurId).toBe(avant.donneurId);
    expect(apres.phase).toBe('annonces');
    expect(apres.aParler).toBe(premier);
    for (const joueurId of apres.ordreJoueurs) {
      const main = apres.mains[joueurId] ?? [];
      expect(main).toHaveLength(14);
      // Rien de spécial à conserver : chacun a, de nouveau, exactement un joker.
      expect(main.filter(estJoker)).toHaveLength(1);
    }
    // Les deux jokers du paquet sont les seuls qui existent : ce sont les mêmes.
    const idsJokersApres = new Set(
      apres.ordreJoueurs.flatMap((id) => (apres.mains[id] ?? []).filter(estJoker).map((carte) => carte.id)),
    );
    expect(idsJokersApres).toEqual(idsJokersAvant);
    // La manche n'a pas avancé, et personne n'a gagné quoi que ce soit.
    expect(table.panier?.historique).toHaveLength(0);
    expect(table.panier?.manchesGagnees).toEqual({ 'p-ana': 0, 'p-bo': 0 });
  });

  /**
   * La main gagnante : trois brelans, dont un avec le joker, et une suite de 5.
   * Quatorze cartes, aucune tierce franche exigée, aucun seuil de points.
   */
  const mainGagnante = () => {
    const deux = [c('pique', 2), c('coeur', 2), c('trefle', 2)];
    const trois = [c('pique', 3), c('coeur', 3), c('trefle', 3)];
    const jokerDuPanier = joker();
    const sept = [c('pique', 7), c('coeur', 7)];
    const suite = [c('carreau', 5), c('carreau', 6), c('carreau', 7), c('carreau', 8), c('carreau', 9)];
    const ids = (cartes: readonly Carte[]) => cartes.map((carte) => ({ carteId: carte.id }));
    return {
      main: [...deux, ...trois, ...sept, jokerDuPanier, ...suite],
      poses: [
        { type: 'ensemble', valeur: 2, cartes: ids(deux) },
        { type: 'ensemble', valeur: 3, cartes: ids(trois) },
        { type: 'ensemble', valeur: 7, cartes: ids([...sept, jokerDuPanier]) },
        { type: 'tierce', couleur: 'carreau', cartes: ids(suite) },
      ],
    };
  };

  it('finir un coup : les 14 cartes en combinaisons, sans 51 points ni tierce franche', async () => {
    const { coupReel, espion, table } = await ouvrirPanier({ manchesAGagner: 2 });
    const coup = coupReel();
    const [premier, second] = coup.ordreJoueurs as [JoueurId, JoueurId];
    const gagnante = mainGagnante();
    coup.mains[premier] = gagnante.main;

    expect((await agir(espion(premier), 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    expect((await agir(espion(premier), 'piocher', { source: 'pioche' })).ok).toBe(true);
    const piochee = table.tourEnCours?.cartePiochee;
    if (piochee === undefined) throw new Error('carte piochee absente');

    // Poser la main entiere d un coup : accepte en brouillon, tranche a la defausse.
    expect((await emettre(espion(premier).socket, 'poser', { poses: gagnante.poses })).ok).toBe(true);
    expect(await agir(espion(premier), 'defausser', { carteId: piochee.id })).toEqual({ ok: true });

    // La manche est gagnee : entracte, avec le score du match.
    await attendreLeDecompte(espion(second));
    const resultat = espion(second).dernierEtat?.resultat;
    expect(resultat?.gagnantId).toBe(premier);
    expect(resultat?.matchPanier).toMatchObject({
      manchesGagnees: { [premier]: 1, [second]: 0 },
      manchesAGagner: 2,
      vainqueurId: null,
    });
    expect(resultat?.derniereCoup).toBe(false);
    // Aucun point, aucune croix : le decompte de La Boule ne s applique pas.
    expect(Object.values(resultat?.scores ?? {}).every((points) => points === 0)).toBe(true);
    expect(Object.values(resultat?.croixGagnees ?? {}).every((croix) => croix === 0)).toBe(true);
    expect(table.panier?.historique).toHaveLength(1);
  });

  it('en fin de manche, la main du perdant se montre dans le rangement qu il lui avait donne', async () => {
    const { coupReel, espion, table } = await ouvrirPanier();
    const coup = coupReel();
    const [premier, second] = coup.ordreJoueurs as [JoueurId, JoueurId];
    const gagnante = mainGagnante();
    coup.mains[premier] = gagnante.main;

    // Le perdant range sa main a l envers, en ne citant que la moitie des cartes.
    const sesCartes = (coup.mains[second] ?? []).map((carte) => carte.id);
    const cite = [...sesCartes].reverse().slice(0, 7);
    expect((await emettre(espion(second).socket, 'ordre-main', { ordre: [...cite, 'inconnue'] })).ok).toBe(true);
    const attendu = [...cite, ...sesCartes.filter((id) => !cite.includes(id))];

    expect((await agir(espion(premier), 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    expect((await agir(espion(premier), 'piocher', { source: 'pioche' })).ok).toBe(true);
    const piochee = table.tourEnCours?.cartePiochee;
    if (piochee === undefined) throw new Error('carte piochee absente');
    expect((await emettre(espion(premier).socket, 'poser', { poses: gagnante.poses })).ok).toBe(true);
    expect(await agir(espion(premier), 'defausser', { carteId: piochee.id })).toEqual({ ok: true });

    await attendreLeDecompte(espion(premier));
    const revelees = espion(premier).dernierEtat?.resultat?.mainsRevelees[second] ?? [];
    expect(revelees.map((carte) => carte.id)).toEqual(attendu);
  });

  it('une pose partielle est refusee : on ne pose qu en finissant', async () => {
    const { coupReel, espion, table } = await ouvrirPanier();
    const coup = coupReel();
    const [premier] = coup.ordreJoueurs as [JoueurId, JoueurId];
    const gagnante = mainGagnante();
    coup.mains[premier] = gagnante.main;

    expect((await agir(espion(premier), 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    expect((await agir(espion(premier), 'piocher', { source: 'pioche' })).ok).toBe(true);
    const piochee = table.tourEnCours?.cartePiochee;
    if (piochee === undefined) throw new Error('carte piochee absente');

    // Un seul brelan : la main n est pas placee, refuse a la defausse.
    expect((await emettre(espion(premier).socket, 'poser', { poses: [gagnante.poses[0]] })).ok).toBe(true);
    const refus = await agir(espion(premier), 'defausser', { carteId: piochee.id });
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toMatch(/toute sa main pour finir/);
    expect(table.panier?.historique).toHaveLength(0);
  });

  it('on prend la defausse librement, sans etre oblige de la poser', async () => {
    const { coupReel, espion, table } = await ouvrirPanier();
    const coup = coupReel();
    const [premier, second] = coup.ordreJoueurs as [JoueurId, JoueurId];
    const cinq = c('coeur', 5);
    const aJeter = (coup.mains[premier] ?? []).find((carte) => carte.type === 'normale') as Carte;
    coup.defausse = [cinq];

    expect((await agir(espion(premier), 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
    // Prendre la defausse : permis, et rien n oblige a s en servir.
    expect((await agir(espion(premier), 'piocher', { source: 'defausse' })).ok).toBe(true);
    expect(await agir(espion(premier), 'defausser', { carteId: aJeter.id })).toEqual({ ok: true });

    expect(coupReel().mains[premier]?.some((carte) => carte.id === cinq.id)).toBe(true);
    expect(table.panier?.historique).toHaveLength(0);
    // Le tour passe a l autre joueur, qui n est jamais interroge.
    expect(coupReel()).toMatchObject({ phase: 'jeu', joueurActifId: second, aParler: null });
  });

  it('un match se gagne au nombre de manches, sans qu elles se suivent, puis la partie se clot', async () => {
    const { coupReel, espion, table } = await ouvrirPanier({ manchesAGagner: 2 });

    /** Fait gagner la manche courante à `gagnant`, puis chacun demande la suite. */
    const gagnerLaManche = async (gagnant: JoueurId) => {
      const coup = coupReel();
      const parleur = coup.aParler as JoueurId;
      const autre = coup.ordreJoueurs.find((id) => id !== parleur) as JoueurId;
      const gagnante = mainGagnante();
      coup.mains[gagnant] = gagnante.main;

      // Celui qui doit parler dit « je joue » ; puis on joue jusqu'à ce que
      // ce soit au tour du gagnant.
      expect((await agir(espion(parleur), 'annoncer', { annonce: 'je-joue' })).ok).toBe(true);
      for (let tour = 0; tour < 4 && coupReel().joueurActifId !== gagnant; tour += 1) {
        const actif = coupReel().joueurActifId;
        expect((await agir(espion(actif), 'piocher', { source: 'pioche' })).ok).toBe(true);
        const aJeter = espion(actif).dernierEtat?.moi.main.find((carte) => carte.type === 'normale')?.id;
        expect(await agir(espion(actif), 'defausser', { carteId: aJeter })).toEqual({ ok: true });
      }
      void autre;
      expect((await agir(espion(gagnant), 'piocher', { source: 'pioche' })).ok).toBe(true);
      const piochee = table.tourEnCours?.cartePiochee as Carte;
      expect((await emettre(espion(gagnant).socket, 'poser', { poses: gagnante.poses })).ok).toBe(true);
      expect(await agir(espion(gagnant), 'defausser', { carteId: piochee.id })).toEqual({ ok: true });
    };
    const demanderLaSuite = async (numero: number) => {
      for (const joueur of JOUEURS) {
        expect((await agir(espion(joueur.id), 'pret-pour-suivant', { numero })).ok).toBe(true);
      }
    };

    // Ana gagne la manche 1, Bo la 2 : « de suite » n a aucun sens, seul le cumul compte.
    await gagnerLaManche('p-ana');
    expect(table.panier?.manchesGagnees).toEqual({ 'p-ana': 1, 'p-bo': 0 });
    await demanderLaSuite(1);
    // Manche 2 : le donneur a change, comme d une manche à l autre à La Boule.
    expect(coupReel().numero).toBe(2);

    await gagnerLaManche('p-bo');
    expect(table.panier?.manchesGagnees).toEqual({ 'p-ana': 1, 'p-bo': 1 });
    expect(table.panier?.vainqueurId).toBeNull();
    await demanderLaSuite(2);
    expect(coupReel().numero).toBe(3);

    // Ana gagne sa deuxième manche : elle atteint l objectif, le match est fini.
    await gagnerLaManche('p-ana');
    expect(table.panier?.manchesGagnees).toEqual({ 'p-ana': 2, 'p-bo': 1 });
    expect(table.panier?.vainqueurId).toBe('p-ana');
    await attendreLeDecompte(espion('p-bo'));
    const resultat = espion('p-bo').dernierEtat?.resultat;
    expect(resultat?.derniereCoup).toBe(true);
    expect(resultat?.matchPanier).toMatchObject({ vainqueurId: 'p-ana', montant: 10, manchesAGagner: 2 });

    // Les archives : la partie figure dans « Mes parties » avec son score et le
    // temps de chacun, et son historique donne les manches une à une.
    // L'API des parties ne connaît que les comptes inscrits.
    for (const joueur of JOUEURS) (serveur.depot as DepotMemoire).inscrire(joueur.id, joueur.pseudo);
    const jeton = await signerJetonSession('p-ana', SESSION);
    const lire = async (chemin: string) =>
      (await (
        await fetch(`http://localhost:${String(port)}${chemin}`, { headers: { authorization: `Bearer ${jeton}` } })
      ).json()) as Record<string, unknown>;
    const ligneDeLaListe = async () => {
      const liste = (await lire('/tables'))['parties'] as Record<string, unknown>[];
      return liste.find((partie) => partie['tableId'] === table.id) as Record<string, unknown>;
    };

    // Encore vivante, en entracte : le score du match est déjà là.
    expect((await ligneDeLaListe())['panier']).toMatchObject({
      manchesGagnees: { 'p-ana': 2, 'p-bo': 1 },
      vainqueurId: 'p-ana',
    });

    // Le dernier « Continuer » clôt la partie : elle passe aux archives.
    expect((await agir(espion('p-bo'), 'pret-pour-suivant', { numero: 3 })).ok).toBe(true);
    for (let essai = 0; essai < 200 && (await ligneDeLaListe())['statut'] !== 'terminee'; essai += 1) {
      await patienter(5);
    }
    const archivee = await ligneDeLaListe();
    expect(archivee['statut']).toBe('terminee');
    expect(archivee).toMatchObject({ variante: 'panier', manchesAGagner: 2, montant: 10 });
    expect(archivee['panier']).toMatchObject({
      manchesGagnees: { 'p-ana': 2, 'p-bo': 1 },
      manchesAGagner: 2,
      montant: 10,
      vainqueurId: 'p-ana',
    });
    expect(Object.keys(archivee['tempsDeJeu'] as object).length).toBeGreaterThan(0);

    const historique = await lire(`/tables/${table.id}/historique`);
    expect(historique['variante']).toBe('panier');
    const manches = (historique['panier'] as { manches: { gagnantId: string }[] }).manches;
    expect(manches.map((manche) => manche.gagnantId)).toEqual(['p-ana', 'p-bo', 'p-ana']);
  });
});
