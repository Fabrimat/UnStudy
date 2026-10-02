import { INestApplication } from '@nestjs/common';
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import request from 'supertest';
import { appleClientSecret, APPLE_ISS, verifyAppleIdToken } from '../src/auth/apple';

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const keys = [jwk];
const expect_ = { clientId: 'com.test.web', nonce: 'n-123' };
const NOW = 1_800_000_000_000;

function token(claims: object = {}, signer = rsa.privateKey, kid = 'k1') {
  const input = `${b64({ alg: 'RS256', kid })}.${b64({
    iss: APPLE_ISS, aud: expect_.clientId, exp: NOW / 1000 + 600, nonce: expect_.nonce, sub: 'apple-sub', email: 'a@b.com', email_verified: 'true', ...claims,
  })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(signer).toString('base64url')}`;
}
const verify = (t: string) => verifyAppleIdToken(t, keys, expect_, NOW);

describe('apple id_token verification', () => {
  it('accepts a valid token; email_verified may be a string or boolean', () => {
    expect(verify(token())).toEqual({ sub: 'apple-sub', email: 'a@b.com', emailVerified: true });
    expect(verify(token({ email_verified: true })).emailVerified).toBe(true);
    expect(verify(token({ email_verified: 'false' })).emailVerified).toBe(false);
  });

  it('rejects wrong aud, iss, expiry, nonce, kid and signature', () => {
    expect(() => verify(token({ aud: 'other' }))).toThrow('bad aud');
    expect(() => verify(token({ iss: 'https://evil.example' }))).toThrow('bad iss');
    expect(() => verify(token({ exp: NOW / 1000 - 1 }))).toThrow('expired');
    expect(() => verify(token({ nonce: 'nope' }))).toThrow('bad nonce');
    expect(() => verify(token({}, rsa.privateKey, 'unknown'))).toThrow('unknown kid');
    expect(() => verify(token({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey))).toThrow('bad signature');
    const [h, , s] = token().split('.');
    expect(() => verify(`${h}.${b64({ iss: APPLE_ISS, aud: expect_.clientId, exp: NOW / 1000 + 600, nonce: 'n-123', sub: 'evil', email: 'x@y.z' })}.${s}`)).toThrow('bad signature');
  });
});

describe('apple client_secret', () => {
  it('is an ES256 JWT that verifies with the matching public key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const jwt = appleClientSecret({ teamId: 'TEAM', clientId: 'com.test.web', keyId: 'KEY', privateKey: pem }, NOW);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toMatchObject({ alg: 'ES256', kid: 'KEY' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'TEAM', sub: 'com.test.web', aud: APPLE_ISS });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(15_777_000);
    const ok = createVerify('SHA256').update(`${h}.${p}`).verify({ key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('apple login routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.APPLE_CLIENT_ID = 'com.test.web';
    process.env.APPLE_TEAM_ID = 'TEAM';
    process.env.APPLE_KEY_ID = 'KEY';
    process.env.APPLE_PRIVATE_KEY = (generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).replace(/\n/g, '\\n');
    process.env.APPLE_CALLBACK_URL = 'http://localhost:5173/api/auth/apple/callback';
    const { createApp } = await import('./helpers');
    app = await createApp();
  });
  afterAll(() => app.close());

  it('advertises apple and redirects to Apple with state and nonce cookies', async () => {
    expect((await request(app.getHttpServer()).get('/api/auth/providers')).body).toEqual({ google: false, apple: true });
    const res = await request(app.getHttpServer()).get('/api/auth/apple').expect(302);
    const u = new URL(res.headers.location);
    expect(u.origin + u.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code', response_mode: 'form_post', scope: 'name email', client_id: 'com.test.web',
      redirect_uri: 'http://localhost:5173/api/auth/apple/callback',
    });
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.find((c) => c.startsWith(`apple_state=${u.searchParams.get('state')}`))).toContain('Path=/api/auth/apple/callback');
    expect(cookies.find((c) => c.startsWith(`apple_nonce=${u.searchParams.get('nonce')}`))).toMatch(/HttpOnly/);
  });

  it('redirects to the login error when the state does not match (cross-site POST, no Origin check)', async () => {
    for (const cookie of ['apple_state=other; apple_nonce=n', 'apple_nonce=n']) {
      const res = await request(app.getHttpServer())
        .post('/api/auth/apple/callback')
        .set('Origin', 'https://appleid.apple.com')
        .set('Cookie', cookie)
        .type('form')
        .send({ code: 'x', state: 'forged' })
        .expect(302);
      expect(res.headers.location).toBe('http://localhost:5173/login?error=apple');
    }
  });
});
