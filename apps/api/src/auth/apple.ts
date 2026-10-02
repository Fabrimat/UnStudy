import { createPrivateKey, createPublicKey, createSign, createVerify, JsonWebKey, timingSafeEqual } from 'node:crypto';

export const APPLE_ISS = 'https://appleid.apple.com';
const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

// ES256 JWT Apple wants as the OAuth client_secret (max 6 months; we use 5 minutes, minted per login).
export function appleClientSecret(a: { teamId: string; clientId: string; keyId: string; privateKey: string }, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const input = `${b64({ alg: 'ES256', kid: a.keyId, typ: 'JWT' })}.${b64({ iss: a.teamId, iat, exp: iat + 300, aud: APPLE_ISS, sub: a.clientId })}`;
  const sig = createSign('SHA256').update(input).sign({ key: createPrivateKey(a.privateKey), dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

export type AppleKey = JsonWebKey & { kid?: string };
export type AppleIdentity = { sub: string; email: string; emailVerified: boolean };

// Pure: throws on any invalid token. `keys` = Apple's JWKS keys.
export function verifyAppleIdToken(idToken: string, keys: AppleKey[], expect: { clientId: string; nonce: string }, now = Date.now()): AppleIdentity {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('unknown kid');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (c.iss !== APPLE_ISS) throw new Error('bad iss');
  if (c.aud !== expect.clientId) throw new Error('bad aud');
  if (typeof c.exp !== 'number' || c.exp * 1000 <= now) throw new Error('expired');
  const a = Buffer.from(String(c.nonce ?? ''));
  const b = Buffer.from(expect.nonce);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad nonce');
  if (typeof c.sub !== 'string' || !c.sub) throw new Error('no sub');
  if (typeof c.email !== 'string' || !c.email) throw new Error('no email');
  return { sub: c.sub, email: c.email, emailVerified: c.email_verified === true || c.email_verified === 'true' };
}
