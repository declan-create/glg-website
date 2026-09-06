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

// Var-by-var diagnostic for the admin dashboard — storageEnabled() above only
// gives a yes/no, which made a single missing/mistyped variable
// indistinguishable from nothing being configured at all. This names exactly
// which of the 4 is missing, so "why aren't clips saving" doesn't turn into a
// guessing game against the Railway variables tab.
function storageDiagnostics() {
  const vars = [
    { key: 'R2_ACCOUNT_ID', set: !!process.env.R2_ACCOUNT_ID },
    { key: 'R2_ACCESS_KEY_ID', set: !!process.env.R2_ACCESS_KEY_ID },
    { key: 'R2_SECRET_ACCESS_KEY', set: !!process.env.R2_SECRET_ACCESS_KEY },
    { key: 'R2_BUCKET', set: !!process.env.R2_BUCKET, value: process.env.R2_BUCKET || null },
  ];
  return { enabled: storageEnabled(), vars };
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

// Retention: R2 doesn't auto-expire anything on its own, and match recordings
// accumulate weekly, so left alone this bucket just grows forever. Built into
// the app itself (rather than a Cloudflare-side lifecycle rule) so it works
// the same way regardless of which storage account is behind it, and so the
// DB row and the R2 object are always cleaned up together, never one without
// the other.
//
//   RECORDING_RETENTION_DAYS   how long to keep clips before deleting them.
//                              Unset or 0 = keep forever (no cleanup runs).
function retentionDays() {
  const n = parseInt(process.env.RECORDING_RETENTION_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function cleanupExpiredRecordings(db) {
  const days = retentionDays();
  if (!days) return { checked: false, deleted: 0 }; // retention disabled — keep everything
  if (!storageEnabled()) return { checked: false, deleted: 0 }; // nothing uploaded anywhere yet, nothing to clean up

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const expired = db.prepare('SELECT id, video_key FROM recordings WHERE created_at < ?').all(cutoff);

  let deleted = 0;
  for (const rec of expired) {
    try {
      await deleteRecording(rec.video_key);
      db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);
      deleted++;
    } catch (e) {
      // Leave the DB row in place if the R2 delete fails (e.g. transient
      // network issue) — better to retry next run than to lose the metadata
      // for a clip that's still actually sitting in the bucket.
      console.error(`[wedgetail retention] failed to delete recording ${rec.id} (${rec.video_key}):`, e.message);
    }
  }
  return { checked: true, deleted, days };
}

module.exports = { storageEnabled, storageDiagnostics, uploadRecording, getPlaybackUrl, deleteRecording, cleanupExpiredRecordings, retentionDays };
