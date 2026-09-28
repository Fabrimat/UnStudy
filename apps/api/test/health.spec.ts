import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp, ORIGIN } from './helpers';

describe('health and origin check', () => {
  let app: INestApplication;
  beforeAll(async () => (app = await createApp()));
  afterAll(() => app.close());

  it('reports ok with a working database', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects mutations without the web origin', async () => {
    await request(app.getHttpServer()).post('/api/health').expect(403);
    await request(app.getHttpServer()).post('/api/health').set('Origin', 'https://evil.example').expect(403);
  });

  it('lets mutations from the web origin reach routing', async () => {
    await request(app.getHttpServer()).post('/api/health').set('Origin', ORIGIN).expect(404);
  });
});
