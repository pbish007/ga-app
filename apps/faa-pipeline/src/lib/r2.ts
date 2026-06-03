import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "./config.js";

export interface R2Client {
  headObject(key: string): Promise<{ etag: string; bytes: number } | null>;
  putObject(key: string, body: Buffer, contentType?: string): Promise<string>;
}

export function makeR2Client(config: Config): R2Client {
  const s3 = new S3Client({
    region: "auto",
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  const bucket = config.r2.bucket;

  return {
    async headObject(key) {
      try {
        const out = await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          etag: stripEtag(out.ETag ?? ""),
          bytes: Number(out.ContentLength ?? 0),
        };
      } catch (err: unknown) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async putObject(key, body, contentType) {
      const out = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType ?? "text/plain",
          ContentLength: body.length,
        }),
      );
      return stripEtag(out.ETag ?? "");
    },
  };
}

export function stripEtag(etag: string): string {
  return etag.replace(/^"+|"+$/g, "");
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NotFound" ||
    e.name === "NoSuchKey" ||
    e.$metadata?.httpStatusCode === 404
  );
}
