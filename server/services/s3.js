'use strict';

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { randomUUID } = require('crypto');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Sanitize a filename: strip special chars, convert spaces to underscores.
 */
function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Build an S3 key for an upload.
 * Format: {firmId}/{ownerType}/{ownerId}/{year}/{docType}/{uuid}-{filename}
 */
function buildKey({ firmId, ownerType, ownerId, year, docType, filename }) {
  const safe = sanitizeFilename(filename || 'file');
  const uuid = randomUUID();
  const yr = year || 'unknown';
  const dt = docType || 'other';
  return `${firmId}/${ownerType}/${ownerId}/${yr}/${dt}/${uuid}-${safe}`;
}

/**
 * Upload a file buffer to S3.
 * @param {Object} opts
 * @param {Buffer} opts.buffer
 * @param {string} opts.key
 * @param {string} opts.mimeType
 * @param {string} opts.bucket
 * @returns {{ key: string, bucket: string }}
 */
async function uploadFile({ buffer, key, mimeType, bucket }) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream',
    }));
    return { key, bucket };
  } catch (err) {
    console.error('S3 upload error:', err);
    throw new Error(`Failed to upload file to S3: ${err.message}`);
  }
}

/**
 * Generate a signed download URL (15 minute expiry).
 * @param {Object} opts
 * @param {string} opts.key
 * @param {string} opts.bucket
 * @returns {Promise<string>} signed URL
 */
async function getSignedDownloadUrl({ key, bucket }) {
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes
  } catch (err) {
    console.error('S3 signed URL error:', err);
    throw new Error(`Failed to generate download URL: ${err.message}`);
  }
}

/**
 * Delete a file from S3.
 * @param {Object} opts
 * @param {string} opts.key
 * @param {string} opts.bucket
 */
async function deleteFile({ key, bucket }) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.error('S3 delete error:', err);
    throw new Error(`Failed to delete file from S3: ${err.message}`);
  }
}

module.exports = { uploadFile, getSignedDownloadUrl, deleteFile, buildKey, sanitizeFilename };
