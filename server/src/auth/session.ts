/**
 * Jeton de session applicatif.
 *
 * Émis après une authentification Apple réussie, c'est lui que le client
 * présente ensuite — notamment pour `rejoindre-table`. Il porte l'identifiant
 * du joueur en base, et rien d'autre : aucune donnée de jeu n'y transite.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { JoueurId } from '../models/index.js';

/** Durée de vie par défaut d'un jeton de session. */
export const DUREE_SESSION_JOURS = 30;

const EMETTEUR_PAR_DEFAUT = 'la-boule';

export interface ConfigSession {
  /** Clé de signature du serveur (HMAC). */
  readonly secret: Uint8Array;
  readonly emetteur?: string;
  readonly dureeJours?: number;
}

export interface SessionJoueur {
  readonly joueurId: JoueurId;
}

export class JetonSessionInvalideError extends Error {
  constructor(detail: string) {
    super(`Jeton de session invalide : ${detail}`);
    this.name = 'JetonSessionInvalideError';
  }
}

export const secretDepuisTexte = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export const signerJetonSession = async (
  joueurId: JoueurId,
  config: ConfigSession,
): Promise<string> => {
  const duree = config.dureeJours ?? DUREE_SESSION_JOURS;
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(joueurId)
    .setIssuer(config.emetteur ?? EMETTEUR_PAR_DEFAUT)
    .setIssuedAt()
    .setExpirationTime(`${String(duree)}d`)
    .sign(config.secret);
};

/**
 * Vérifie signature, émetteur et expiration.
 *
 * @throws JetonSessionInvalideError pour tout jeton douteux — le message reste
 * volontairement générique côté client.
 */
export const verifierJetonSession = async (
  jeton: string,
  config: ConfigSession,
): Promise<SessionJoueur> => {
  try {
    const { payload } = await jwtVerify(jeton, config.secret, {
      issuer: config.emetteur ?? EMETTEUR_PAR_DEFAUT,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new JetonSessionInvalideError('sujet absent');
    }
    return { joueurId: payload.sub };
  } catch (erreur) {
    if (erreur instanceof JetonSessionInvalideError) throw erreur;
    throw new JetonSessionInvalideError(
      erreur instanceof Error ? erreur.message : 'verification impossible',
    );
  }
};

/** Renouvelle un jeton encore valide, sans repasser par Apple. */
export const renouvelerJetonSession = async (
  jeton: string,
  config: ConfigSession,
): Promise<string> => {
  const { joueurId } = await verifierJetonSession(jeton, config);
  return signerJetonSession(joueurId, config);
};
