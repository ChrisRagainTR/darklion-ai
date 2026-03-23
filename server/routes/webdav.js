'use strict';

/**
 * WebDAV Drive — exposes client documents from S3 as a mountable network drive.
 *
 * Folder structure:
 *   /DarkLion/
 *     {Relationship Name}/
 *       {Person or Company Name}/
 *         {Year} - {Category}/
 *           {display_name}.{ext}
 *
 * Auth: HTTP Basic auth — username = email, password = DarkLion password (bcrypt)
 * Validates against firm_users table.
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { getSignedDownloadUrl, uploadFile, deleteFile, buildKey } = require('../services/s3');

const DEFAULT_BUCKET = process.env.S3_BUCKET || 'darklion-documents';

// ─── Auth helper ────────────────────────────────────────────────────────────

/**
 * Parse HTTP Basic auth header and validate against firm_users.
 * Returns { firmId, userId } on success, null on failure.
 */
async function authenticateBasic(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;

  let email, password;
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 0) return null;
    email = decoded.slice(0, colonIdx).trim();
    password = decoded.slice(colonIdx + 1);
  } catch (e) {
    return null;
  }

  if (!email || !password) return null;

  try {
    const { rows } = await pool.query(
      `SELECT fu.id, fu.firm_id, fu.password_hash
       FROM firm_users fu
       WHERE fu.email = $1 AND fu.accepted_at IS NOT NULL
       LIMIT 1`,
      [email]
    );
    if (!rows.length) return null;

    const user = rows[0];
    if (!user.password_hash) return null;

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return null;

    return { firmId: user.firm_id, userId: user.id };
  } catch (err) {
    console.error('[WebDAV] Auth error:', err.message);
    return null;
  }
}

function requireAuth(handler) {
  return async (req, res) => {
    const auth = await authenticateBasic(req);
    if (!auth) {
      res.setHeader('WWW-Authenticate', 'Basic realm="DarkLion Documents"');
      return res.status(401).send('Authentication required');
    }
    req.webdavAuth = auth;
    return handler(req, res);
  };
}

// ─── Path parsing ────────────────────────────────────────────────────────────

/**
 * WebDAV requests come in at /webdav/... but Express strips the prefix.
 * Path segments after stripping leading slash:
 *   []                          → root (list relationships)
 *   [relName]                   → relationship
 *   [relName, entityName]       → entity
 *   [relName, entityName, yc]   → year-category folder
 *   [relName, entityName, yc, filename] → file
 */
function parsePath(reqPath) {
  // Normalize and split
  const clean = decodeURIComponent(reqPath).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!clean) return { level: 'root', parts: [] };
  const parts = clean.split('/');
  // Structure: relationship / entity / year / category / file
  const levels = ['root', 'relationship', 'entity', 'year', 'category', 'file'];
  return { level: levels[Math.min(parts.length, 5)] || 'file', parts };
}

// Categories to hide from the drive (internal/system use only)
const HIDDEN_CATEGORIES = new Set(['message_docs']);

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function getRelationshipByName(firmId, name) {
  const { rows } = await pool.query(
    'SELECT id, name FROM relationships WHERE firm_id=$1 AND name=$2 LIMIT 1',
    [firmId, name]
  );
  return rows[0] || null;
}

async function getEntityByName(firmId, relationshipId, name) {
  // Try person first
  const { rows: people } = await pool.query(
    `SELECT id, (first_name||' '||last_name) AS name, 'person' AS type
     FROM people WHERE firm_id=$1 AND relationship_id=$2 AND (first_name||' '||last_name)=$3 LIMIT 1`,
    [firmId, relationshipId, name]
  );
  if (people.length) return people[0];

  // Try company (column is company_name, not name)
  const { rows: companies } = await pool.query(
    `SELECT id, company_name AS name, 'company' AS type
     FROM companies WHERE firm_id=$1 AND relationship_id=$2 AND company_name=$3 LIMIT 1`,
    [firmId, relationshipId, name]
  );
  return companies[0] || null;
}

async function getDocumentByFilename(firmId, ownerId, ownerType, year, folderCategory, filename) {
  const { rows } = await pool.query(
    `SELECT id, display_name, mime_type, size_bytes, s3_key, s3_bucket
     FROM documents
     WHERE firm_id=$1 AND owner_id=$2 AND owner_type=$3 AND year=$4 AND folder_category=$5
       AND display_name=$6
     LIMIT 1`,
    [firmId, ownerId, ownerType, year, folderCategory, filename]
  );
  return rows[0] || null;
}

// ─── WebDAV XML helpers ───────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function propfindResponse(href, isDir, size, lastModified) {
  const mod = lastModified ? new Date(lastModified).toUTCString() : new Date().toUTCString();
  const contentType = isDir ? 'httpd/unix-directory' : 'application/octet-stream';
  const resourceType = isDir ? '<D:collection/>' : '';
  return `
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${xmlEscape(href.split('/').filter(Boolean).pop() || 'DarkLion')}</D:displayname>
        <D:resourcetype>${resourceType}</D:resourcetype>
        <D:getcontenttype>${contentType}</D:getcontenttype>
        ${!isDir ? `<D:getcontentlength>${size || 0}</D:getcontentlength>` : ''}
        <D:getlastmodified>${mod}</D:getlastmodified>
        <D:creationdate>${mod}</D:creationdate>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function buildMultistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses.join('\n')}
</D:multistatus>`;
}

// Normalize the href base for WebDAV responses
function makeHref(base, ...parts) {
  const encoded = parts.map(p => encodeURIComponent(p).replace(/%20/g, '%20'));
  return base.replace(/\/+$/, '') + '/' + encoded.join('/');
}

// ─── PROPFIND handler ─────────────────────────────────────────────────────────

async function handlePropfind(req, res) {
  const { firmId } = req.webdavAuth;
  const depth = req.headers['depth'] || '1';

  // req.path is relative to /webdav mount
  const { level, parts } = parsePath(req.path);

  // Base href — reconstruct full path for response
  const baseHref = '/webdav' + (req.path === '/' ? '' : req.path);

  try {
    const responses = [];

    if (level === 'root') {
      // Self entry
      responses.push(propfindResponse('/webdav/', true, 0, null));

      if (depth !== '0') {
        const { rows } = await pool.query(
          'SELECT id, name FROM relationships WHERE firm_id=$1 ORDER BY name',
          [firmId]
        );
        for (const rel of rows) {
          responses.push(propfindResponse(makeHref('/webdav', rel.name) + '/', true, 0, null));
        }
      }

    } else if (level === 'relationship') {
      const relName = parts[0];
      responses.push(propfindResponse(baseHref.replace(/\/?$/, '/'), true, 0, null));

      if (depth !== '0') {
        const rel = await getRelationshipByName(firmId, relName);
        if (rel) {
          const { rows: people } = await pool.query(
            `SELECT id, (first_name||' '||last_name) AS name FROM people WHERE firm_id=$1 AND relationship_id=$2 ORDER BY last_name, first_name`,
            [firmId, rel.id]
          );
          const { rows: companies } = await pool.query(
            `SELECT id, company_name AS name FROM companies WHERE firm_id=$1 AND relationship_id=$2 ORDER BY company_name`,
            [firmId, rel.id]
          );
          for (const p of people) {
            responses.push(propfindResponse(makeHref('/webdav', relName, p.name) + '/', true, 0, null));
          }
          for (const c of companies) {
            responses.push(propfindResponse(makeHref('/webdav', relName, c.name) + '/', true, 0, null));
          }
        }
      }

    } else if (level === 'entity') {
      const [relName, entityName] = parts;
      responses.push(propfindResponse(baseHref.replace(/\/?$/, '/'), true, 0, null));

      if (depth !== '0') {
        const rel = await getRelationshipByName(firmId, relName);
        if (rel) {
          const entity = await getEntityByName(firmId, rel.id, entityName);
          if (entity) {
            const { rows: years } = await pool.query(
              `SELECT DISTINCT year FROM documents
               WHERE owner_id=$1 AND owner_type=$2 AND firm_id=$3
                 AND year IS NOT NULL AND year != ''
                 AND folder_category NOT IN ('message_docs')
               ORDER BY year DESC`,
              [entity.id, entity.type, firmId]
            );
            for (const row of years) {
              responses.push(propfindResponse(makeHref('/webdav', relName, entityName, row.year) + '/', true, 0, null));
            }
          }
        }
      }

    } else if (level === 'year') {
      const [relName, entityName, year] = parts;
      responses.push(propfindResponse(baseHref.replace(/\/?$/, '/'), true, 0, null));

      if (depth !== '0') {
        const rel = await getRelationshipByName(firmId, relName);
        if (rel) {
          const entity = await getEntityByName(firmId, rel.id, entityName);
          if (entity) {
            const { rows: cats } = await pool.query(
              `SELECT DISTINCT folder_category FROM documents
               WHERE owner_id=$1 AND owner_type=$2 AND firm_id=$3 AND year=$4
                 AND folder_category NOT IN ('message_docs')
               ORDER BY folder_category`,
              [entity.id, entity.type, firmId, year]
            );
            for (const cat of cats) {
              responses.push(propfindResponse(makeHref('/webdav', relName, entityName, year, cat.folder_category) + '/', true, 0, null));
            }
          }
        }
      }

    } else if (level === 'category') {
      const [relName, entityName, year, category] = parts;
      responses.push(propfindResponse(baseHref.replace(/\/?$/, '/'), true, 0, null));

      if (depth !== '0') {
        const rel = await getRelationshipByName(firmId, relName);
        if (rel) {
          const entity = await getEntityByName(firmId, rel.id, entityName);
          if (entity) {
            const { rows: docs } = await pool.query(
              `SELECT id, display_name, mime_type, size_bytes, created_at
               FROM documents
               WHERE owner_id=$1 AND owner_type=$2 AND firm_id=$3 AND year=$4 AND folder_category=$5
               ORDER BY display_name`,
              [entity.id, entity.type, firmId, year, category]
            );
            for (const doc of docs) {
              const href = makeHref('/webdav', relName, entityName, year, category, doc.display_name);
              responses.push(propfindResponse(href, false, doc.size_bytes, doc.created_at));
            }
          }
        }
      }

    } else if (level === 'file') {
      // Single file stat
      const [relName, entityName, year, category, filename] = parts;
      const rel = await getRelationshipByName(firmId, relName);
      if (rel) {
        const entity = await getEntityByName(firmId, rel.id, entityName);
        if (entity) {
          const doc = await getDocumentByFilename(firmId, entity.id, entity.type, year, category, filename);
          if (doc) {
            responses.push(propfindResponse(baseHref, false, doc.size_bytes, null));
          } else {
            return res.status(404).end();
          }
        }
      }
    }

    res.status(207)
      .setHeader('Content-Type', 'application/xml; charset=utf-8')
      .end(buildMultistatus(responses));

  } catch (err) {
    console.error('[WebDAV] PROPFIND error:', err);
    res.status(500).end();
  }
}

// ─── GET (file download) ──────────────────────────────────────────────────────

async function handleGet(req, res) {
  const { firmId } = req.webdavAuth;
  const { level, parts } = parsePath(req.path);

  if (level === 'file') {
    const [relName, entityName, year, category, filename] = parts;
    try {
      const rel = await getRelationshipByName(firmId, relName);
      if (!rel) return res.status(404).end();

      const entity = await getEntityByName(firmId, rel.id, entityName);
      if (!entity) return res.status(404).end();

      const doc = await getDocumentByFilename(firmId, entity.id, entity.type, year, category, filename);
      if (!doc) return res.status(404).end();

      const signedUrl = await getSignedDownloadUrl({ key: doc.s3_key, bucket: doc.s3_bucket || DEFAULT_BUCKET });

      // Stream from S3 via signed URL
      res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
      if (doc.size_bytes) res.setHeader('Content-Length', doc.size_bytes);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.display_name)}"`);

      const protocol = signedUrl.startsWith('https') ? https : http;
      protocol.get(signedUrl, (s3res) => {
        if (s3res.statusCode !== 200) {
          res.status(502).end();
          return;
        }
        s3res.pipe(res);
      }).on('error', (err) => {
        console.error('[WebDAV] GET stream error:', err);
        res.status(502).end();
      });

    } catch (err) {
      console.error('[WebDAV] GET error:', err);
      res.status(500).end();
    }
  } else {
    // Directory listing as simple HTML (for browser access)
    res.status(200).setHeader('Content-Type', 'text/html').end('<html><body><h2>DarkLion WebDAV Drive</h2><p>Mount this drive using a WebDAV client.</p></body></html>');
  }
}

// ─── PUT (file upload) ────────────────────────────────────────────────────────

async function handlePut(req, res) {
  const { firmId, userId } = req.webdavAuth;
  const { level, parts } = parsePath(req.path);

  if (level !== 'file') return res.status(409).end(); // Can only PUT files, not directories

  const [relName, entityName, year, category, filename] = parts;

  try {
    const rel = await getRelationshipByName(firmId, relName);
    if (!rel) return res.status(409).end();

    const entity = await getEntityByName(firmId, rel.id, entityName);
    if (!entity) return res.status(409).end();

    // Collect body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const mimeType = req.headers['content-type'] || 'application/octet-stream';
    const s3Key = buildKey({
      firmId,
      ownerType: entity.type,
      ownerId: entity.id,
      year,
      docType: category,
      filename,
    });

    await uploadFile({ buffer, key: s3Key, mimeType, bucket: DEFAULT_BUCKET });

    // Upsert document record
    const existing = await getDocumentByFilename(firmId, entity.id, entity.type, year, category, filename);
    if (existing) {
      await pool.query(
        `UPDATE documents SET s3_key=$1, s3_bucket=$2, mime_type=$3, size_bytes=$4 WHERE id=$5`,
        [s3Key, DEFAULT_BUCKET, mimeType, buffer.length, existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO documents (firm_id, owner_type, owner_id, year, folder_category, display_name, s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, uploaded_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'staff', $11)`,
        [firmId, entity.type, entity.id, year, category, filename, DEFAULT_BUCKET, s3Key, mimeType, buffer.length, userId]
      );
    }

    res.status(201).end();
  } catch (err) {
    console.error('[WebDAV] PUT error:', err);
    res.status(500).end();
  }
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

async function handleDelete(req, res) {
  const { firmId } = req.webdavAuth;
  const { level, parts } = parsePath(req.path);

  if (level !== 'file') return res.status(403).end();

  const [relName, entityName, year, category, filename] = parts;

  try {
    const rel = await getRelationshipByName(firmId, relName);
    if (!rel) return res.status(404).end();

    const entity = await getEntityByName(firmId, rel.id, entityName);
    if (!entity) return res.status(404).end();

    const doc = await getDocumentByFilename(firmId, entity.id, entity.type, year, category, filename);
    if (!doc) return res.status(404).end();

    await deleteFile({ key: doc.s3_key, bucket: doc.s3_bucket || DEFAULT_BUCKET });
    await pool.query('DELETE FROM documents WHERE id=$1', [doc.id]);

    res.status(204).end();
  } catch (err) {
    console.error('[WebDAV] DELETE error:', err);
    res.status(500).end();
  }
}

// ─── OPTIONS ─────────────────────────────────────────────────────────────────

function handleOptions(req, res) {
  res.setHeader('DAV', '1, 2');
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL');
  res.setHeader('MS-Author-Via', 'DAV');
  res.status(200).end();
}

// ─── Route dispatcher ─────────────────────────────────────────────────────────

// All WebDAV methods need auth (except OPTIONS for capability discovery)
router.options('*', handleOptions);

// Dispatch all other methods with auth
router.all('*', requireAuth(async (req, res) => {
  const method = req.method.toUpperCase();

  switch (method) {
    case 'PROPFIND':
      return handlePropfind(req, res);
    case 'GET':
    case 'HEAD':
      return handleGet(req, res);
    case 'PUT':
      return handlePut(req, res);
    case 'DELETE':
      return handleDelete(req, res);
    case 'MKCOL':
      // Virtual folders only — MKCOL succeeds silently (Mac Finder creates ._ files etc.)
      return res.status(201).end();
    case 'MOVE':
    case 'COPY':
      return res.status(501).end();
    case 'LOCK':
      // Return a minimal lock response so Mac Finder is happy
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.status(200).end(`<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>opaquelocktoken:webdav-darklion</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`);
      return;
    case 'UNLOCK':
      return res.status(204).end();
    case 'PROPPATCH':
      // Silently accept property patches
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(207).end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`);
    default:
      return res.status(405).end();
  }
}));

module.exports = router;
