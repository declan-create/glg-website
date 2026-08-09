// Object storage for Wedgetail recordings, via Cloudflare R2 (S3-compatible
// API — no egress fees, which matters here since coaches will be *watching*
// clips repeatedly, not just uploading them once).
//
// Configured entirely through environment variables, same pattern as
// mailer.js — runs in a safe no-op mode if unset (local dev/tests) so the
// rest of the app doesn't break before the bucket exists.
//
//   R2_ACCOUNT_ID          Cloudflare account ID
//   R2_ACCESS_KEY_ID       R2 API token access key
//   R2_SECRET_ACCESS_KEY   R2 API token secret
//   R2_BUCKET              bucket name, e.g. glg-wedgetail-recordings

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function getClient() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
}

function storageEnabled() {
  return !!getClient() && !!process.env.R2_BUCKET;
}

async function uploadRecording({ key, buffer, contentType }) {
  const client = getClient();
  if (!client) throw new Error('Video storage is not configured (R2 env vars missing).');
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'video/webm',
  }));
  return key;
}

// Recordings hold athletes' likenesses, so playback URLs are short-lived
// presigned links rather than a public bucket — the bucket itself stays
// private no matter who has the link.
async function getPlaybackUrl(key, expiresInSeconds = 3600) {
  const client = getClient();
  if (!client) return null;
  const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
  return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
}

async function deleteRecording(key) {
  const client = getClient();
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
}

module.exports = { storageEnabled, uploadRecording, getPlaybackUrl, deleteRecording };
