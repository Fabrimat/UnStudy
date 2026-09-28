import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { config } from '../config';

// RFC 5987 encoding; encodeURIComponent leaves ' ( ) * unescaped.
const rfc5987 = (value: string) =>
  encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

@Injectable()
export class StorageService {
  private bucket = config.s3.bucket;
  private s3 = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });

  // Presigned PUT (not POST: R2 has no POST policies). Content-Length is signed, and confirm re-checks it with HEAD.
  uploadUrl(key: string, sizeBytes: number) {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: 'application/pdf', ContentLength: sizeBytes }),
      { expiresIn: 15 * 60, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0 };
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  downloadUrl(key: string, filename: string) {
    const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(filename)}`,
      }),
      { expiresIn: 5 * 60 },
    );
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
}
