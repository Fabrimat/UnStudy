import { INestApplication } from '@nestjs/common';
import request from 'supertest';

describe('google login', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // config is read at import time, so set the env before loading the app
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.GOOGLE_CALLBACK_URL = 'http://localhost:5173/api/auth/google/callback';
    const { createApp } = await import('./helpers');
    app = await createApp();
  });
  afterAll(() => app.close());

  it('advertises google and redirects to the consent screen, binding a state cookie', async () => {
    expect((await request(app.getHttpServer()).get('/api/auth/providers')).body).toEqual({ google: true, apple: false });
    const res = await request(app.getHttpServer()).get('/api/auth/google').expect(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(res.headers.location).toContain('client_id=test-client');
    expect(res.headers.location).toContain(encodeURIComponent('http://localhost:5173/api/auth/google/callback'));

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('oauth_state='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toContain('Path=/api/auth/google');
    const state = cookie.split(';')[0].split('=')[1];
    expect(new URL(res.headers.location).searchParams.get('state')).toBe(state);
  });

  it('rejects the callback when the OAuth state is forged or missing (login CSRF)', async () => {
    // No state cookie at all.
    await request(app.getHttpServer()).get('/api/auth/google/callback?code=x&state=forged').expect(401);
    // Cookie present but doesn't match the state param: state is checked before any token
    // exchange, so this never reaches Google.
    await request(app.getHttpServer())
      .get('/api/auth/google/callback?code=x&state=forged')
      .set('Cookie', 'oauth_state=other')
      .expect(401);
  });
});
