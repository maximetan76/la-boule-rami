/**
 * Endpoints HTTP d'authentification.
 *
 * L'app iOS obtient un jeton d'identité auprès d'Apple, le poste ici, et reçoit
 * en échange un jeton de session applicatif — celui qu'elle présentera ensuite
 * à `rejoindre-table`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifierJetonApple, type ConfigApple } from '../auth/apple.js';
import { renouvelerJetonSession, signerJetonSession, type ConfigSession } from '../auth/session.js';
import type { Depot } from '../persistence/depot.js';

/** Au-delà, la requête est rejetée : un jeton d'identité tient largement dedans. */
const TAILLE_CORPS_MAX = 16 * 1024;

export interface DependancesHttp {
  readonly depot: Depot;
  readonly session: ConfigSession;
  readonly apple: ConfigApple;
}

const lireCorps = async (requete: IncomingMessage): Promise<unknown> => {
  const morceaux: Buffer[] = [];
  let taille = 0;

  for await (const morceau of requete) {
    const bloc = morceau as Buffer;
    taille += bloc.length;
    if (taille > TAILLE_CORPS_MAX) throw new Error('Corps de requete trop volumineux');
    morceaux.push(bloc);
  }

  if (morceaux.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8')) as unknown;
  } catch {
    throw new Error('Corps de requete illisible');
  }
};

const repondreJson = (reponse: ServerResponse, code: number, corps: unknown): void => {
  const charge = JSON.stringify(corps);
  reponse.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(charge),
  });
  reponse.end(charge);
};

const texteOuNull = (valeur: unknown): string | null =>
  typeof valeur === 'string' && valeur.length > 0 ? valeur : null;

/**
 * Ouvre une session à partir d'un jeton d'identité Apple.
 *
 * Apple ne transmet le nom qu'à la toute première connexion : l'app le joint
 * quand elle l'a, et le pseudo déjà enregistré sert ensuite.
 */
const ouvrirSession = async (
  corps: unknown,
  deps: DependancesHttp,
): Promise<{ jetonSession: string; joueur: { id: string; pseudo: string } }> => {
  const charge = (corps ?? {}) as Record<string, unknown>;
  const jetonIdentite = texteOuNull(charge['jetonIdentite']);
  if (jetonIdentite === null) throw new Error("Jeton d'identite Apple manquant");

  const identite = await verifierJetonApple(jetonIdentite, deps.apple);
  const pseudo = texteOuNull(charge['pseudo']) ?? 'Joueur';
  const joueur = await deps.depot.trouverOuCreerJoueurApple(identite.identifiantApple, pseudo);

  return {
    jetonSession: await signerJetonSession(joueur.id, deps.session),
    joueur: { id: joueur.id, pseudo: joueur.pseudo },
  };
};

/**
 * Gestionnaire de requêtes, à brancher sur le serveur HTTP que socket.io
 * partage. Les erreurs remontent en 400 avec un message court : rien de ce que
 * dit `jose` sur l'échec de vérification n'est renvoyé tel quel.
 */
export const gererRequeteHttp =
  (deps: DependancesHttp) =>
  (requete: IncomingMessage, reponse: ServerResponse): void => {
    const chemin = (requete.url ?? '').split('?')[0];

    if (requete.method === 'GET' && chemin === '/sante') {
      repondreJson(reponse, 200, { ok: true });
      return;
    }

    if (requete.method === 'POST' && chemin === '/auth/apple') {
      lireCorps(requete)
        .then((corps) => ouvrirSession(corps, deps))
        .then((resultat) => {
          repondreJson(reponse, 200, resultat);
        })
        .catch(() => {
          repondreJson(reponse, 401, { erreur: 'Authentification Apple refusee' });
        });
      return;
    }

    if (requete.method === 'POST' && chemin === '/auth/renouveler') {
      lireCorps(requete)
        .then(async (corps) => {
          const jeton = texteOuNull((corps as Record<string, unknown>)['jeton']);
          if (jeton === null) throw new Error('Jeton manquant');
          return renouvelerJetonSession(jeton, deps.session);
        })
        .then((jetonSession) => {
          repondreJson(reponse, 200, { jetonSession });
        })
        .catch(() => {
          repondreJson(reponse, 401, { erreur: 'Jeton de session refuse' });
        });
      return;
    }

    repondreJson(reponse, 404, { erreur: 'Ressource inconnue' });
  };
