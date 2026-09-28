import { GetBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { INestApplication } from '@nestjs/common';

describe('bucket CORS at startup', () => {
  let app: INestApplication;
  const origins = ['http://localhost:5173', 'http://localhost:5174'];

  beforeAll(async () => {
    // config is read at import time, so set the env before loading the app
    process.env.S3_CORS_ORIGIN = origins.join(', ');
    const { createApp } = await import('./helpers');
    app = await createApp();
  });
  afterAll(() => app.close());

  it('applies the configured origins to the bucket', async () => {
    const s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
    });
    const res = await s3.send(new GetBucketCorsCommand({ Bucket: process.env.S3_BUCKET }));
    expect(res.CORSRules?.[0]).toMatchObject({ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET', 'HEAD'] });
  });
});
