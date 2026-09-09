import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import {
  EMETTEUR_APPLE,
  JetonAppleInvalideError,
  verifierJetonApple,
} from '../auth/apple.js';
import {
  DUREE_SESSION_JOURS,
  JetonSessionInvalideError,
  renouvelerJetonSession,
  secretDepuisTexte,
  signerJetonSession,
  verifierJetonSession,
} from '../auth/session.js';
import { decodeJwt } from 'jose';

/**
 * La vérification Apple est testée sans réseau : on fabrique une paire de clés
 * locale, on signe des jetons comme le ferait Apple, et on injecte la clé
 * publique à la place du JWKS distant.
 */

const CLIENT_ID = 'fr.tb-formations.laboule';

const fauxApple = async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const cles: JWTVerifyGetKey = () => Promise.resolve(publicKey);

  const signer = async (
    charge: Record<string, unknown>,
    options: { emetteur?: string; audience?: string; expiration?: string; sujet?: string } = {},
  ) => {
    let jeton = new SignJWT(charge)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(options.emetteur ?? EMETTEUR_APPLE)
      .setAudience(options.audience ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(options.expiration ?? '10m');
    if (options.sujet !== undefined) jeton = jeton.setSubject(options.sujet);
    return jeton.sign(privateKey);
  };

  return { cles, signer, publicKey };
};

describe('verifierJetonApple', () => {
  it('accepte un jeton signe par Apple et en tire l identifiant de compte', async () => {
    const { cles, signer } = await fauxApple();
    const jeton = await signer({ email: 'ana@example.com', email_verified: 'true' }, {
      sujet: '001234.abcdef',
    });

    const identite = await verifierJetonApple(jeton, { clientId: CLIENT_ID, cles });

    expect(identite.identifiantApple).toBe('001234.abcdef');
    expect(identite.email).toBe('ana@example.com');
    // Apple sérialise parfois email_verified en chaine.
    expect(identite.emailVerifie).toBe(true);
  });

  it('accepte un jeton sans adresse e-mail', async () => {
    const { cles, signer } = await fauxApple();
    const jeton = await signer({}, { sujet: '001234.abcdef' });

    const identite = await verifierJetonApple(jeton, { clientId: CLIENT_ID, cles });
    expect(identite.email).toBeNull();
    expect(identite.emailVerifie).toBe(false);
  });

  it('refuse un jeton destine a une autre application', async () => {
    const { cles, signer } = await fauxApple();
    const jeton = await signer({}, { sujet: '001234.abcdef', audience: 'fr.autre.app' });

    await expect(verifierJetonApple(jeton, { clientId: CLIENT_ID, cles })).rejects.toThrow(
      JetonAppleInvalideError,
    );
  });

  it('refuse un jeton dont l emetteur n est pas Apple', async () => {
    const { cles, signer } = await fauxApple();
    const jeton = await signer({}, { sujet: '001234.abcdef', emetteur: 'https://exemple.test' });

    // jose refuse sur le claim « iss ».
    await expect(verifierJetonApple(jeton, { clientId: CLIENT_ID, cles })).rejects.toThrow(
      /"iss"/,
    );
  });

  it('refuse un jeton expire', async () => {
    const { cles, signer } = await fauxApple();
    const jeton = await signer({}, { sujet: '001234.abcdef', expiration: '-1m' });

    await expect(verifierJetonApple(jeton, { clientId: CLIENT_ID, cles })).rejects.toThrow(
      JetonAppleInvalideError,
    );
  });

  it('refuse un jeton signe par une autre cle', async () => {
    const { signer } = await fauxApple();
    const autre = await fauxApple();
    const jeton = await signer({}, { sujet: '001234.abcdef' });

    // Le jeton est valide, mais verifie contre la mauvaise cle publique.
    await expect(
      verifierJetonApple(jeton, { clientId: CLIENT_ID, cles: autre.cles }),
    ).rejects.toThrow(JetonAppleInvalideError);
  });

  it('refuse un jeton sans identifiant de compte', async () => {
    const { cles, signer } = await fauxApple();
    const jeton = await signer({});

    await expect(verifierJetonApple(jeton, { clientId: CLIENT_ID, cles })).rejects.toThrow(
      /identifiant de compte/i,
    );
  });

  it('refuse un jeton qui n en est pas un', async () => {
    const { cles } = await fauxApple();
    await expect(
      verifierJetonApple('pas-un-jeton', { clientId: CLIENT_ID, cles }),
    ).rejects.toThrow(JetonAppleInvalideError);
  });
});

describe('jeton de session', () => {
  const secret = secretDepuisTexte('secret-de-test-suffisamment-long-pour-hs256');

  it('signe puis relit l identifiant du joueur', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret });
    expect(await verifierJetonSession(jeton, { secret })).toEqual({ joueurId: 'joueur-42' });
  });

  it('vaut 30 jours par defaut', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret });
    const { exp, iat } = decodeJwt(jeton);

    const jours = ((exp as number) - (iat as number)) / 86400;
    expect(jours).toBe(DUREE_SESSION_JOURS);
  });

  it('accepte une duree de vie explicite', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret, dureeJours: 7 });
    const { exp, iat } = decodeJwt(jeton);
    expect(((exp as number) - (iat as number)) / 86400).toBe(7);
  });

  it('refuse un jeton signe avec un autre secret', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret });
    const autre = secretDepuisTexte('un-tout-autre-secret-de-signature-serveur');

    await expect(verifierJetonSession(jeton, { secret: autre })).rejects.toThrow(
      JetonSessionInvalideError,
    );
  });

  it('refuse un jeton expire', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret, dureeJours: -1 });
    await expect(verifierJetonSession(jeton, { secret })).rejects.toThrow(
      JetonSessionInvalideError,
    );
  });

  it('refuse un jeton emis pour une autre application', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret, emetteur: 'autre-service' });
    await expect(verifierJetonSession(jeton, { secret })).rejects.toThrow(
      JetonSessionInvalideError,
    );
  });

  it('renouvelle un jeton encore valide sans repasser par Apple', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret, dureeJours: 1 });
    const renouvele = await renouvelerJetonSession(jeton, { secret });

    expect(await verifierJetonSession(renouvele, { secret })).toEqual({ joueurId: 'joueur-42' });
    const { exp } = decodeJwt(renouvele);
    const { exp: expAncien } = decodeJwt(jeton);
    expect(exp as number).toBeGreaterThan(expAncien as number);
  });

  it('refuse de renouveler un jeton expire', async () => {
    const jeton = await signerJetonSession('joueur-42', { secret, dureeJours: -1 });
    await expect(renouvelerJetonSession(jeton, { secret })).rejects.toThrow(
      JetonSessionInvalideError,
    );
  });
});
