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

  it('advertises google and redirects to the consent screen', async () => {
    expect((await request(app.getHttpServer()).get('/api/auth/providers')).body).toEqual({ google: true });
    const res = await request(app.getHttpServer()).get('/api/auth/google').expect(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(res.headers.location).toContain('client_id=test-client');
    expect(res.headers.location).toContain(encodeURIComponent('http://localhost:5173/api/auth/google/callback'));
  });
});
