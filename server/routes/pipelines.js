'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const { executeStageActions } = require('../services/pipelineActions');

const router = Router();

// Helper: verify template belongs to firm
async function getTemplate(firmId, templateId) {
  const { rows } = await pool.query(
    'SELECT * FROM pipeline_templates WHERE id = $1 AND firm_id = $2',
    [templateId, firmId]
  );
  return rows[0] || null;
}

// Helper: verify instance belongs to firm
async function getInstance(firmId, instanceId) {
  const { rows } = await pool.query(
    'SELECT * FROM pipeline_instances WHERE id = $1 AND firm_id = $2',
    [instanceId, firmId]
  );
  return rows[0] || null;
}

// Helper: verify job belongs to firm (via instance)
async function getJob(firmId, jobId) {
  const { rows } = await pool.query(
    `SELECT pj.* FROM pipeline_jobs pj
     JOIN pipeline_instances pi ON pi.id = pj.instance_id
     WHERE pj.id = $1 AND pi.firm_id = $2`,
    [jobId, firmId]
  );
  return rows[0] || null;
}

// Helper: resolve entity name from a job row
async function resolveEntityName(job) {
  try {
    if (job.entity_type === 'company') {
      const { rows } = await pool.query('SELECT company_name FROM companies WHERE id = $1', [job.entity_id]);
      return rows[0]?.company_name || `Company #${job.entity_id}`;
    } else if (job.entity_type === 'person') {
      const { rows } = await pool.query(
        "SELECT first_name || ' ' || last_name AS name FROM people WHERE id = $1",
        [job.entity_id]
      );
      return rows[0]?.name || `Person #${job.entity_id}`;
    } else if (job.entity_type === 'relationship') {
      const { rows } = await pool.query('SELECT name FROM relationships WHERE id = $1', [job.entity_id]);
      return rows[0]?.name || `Relationship #${job.entity_id}`;
    }
  } catch (_) {}
  return `Entity #${job.entity_id}`;
}

// ─────────────────────────────────────────────
// TEMPLATE ENDPOINTS
// ─────────────────────────────────────────────

// GET /templates
router.get('/templates', async (req, res) => {
  try {
    const showArchived = req.query.archived === 'true';
    const { rows } = await pool.query(
      `SELECT pt.*, COUNT(ps.id)::int AS stage_count
       FROM pipeline_templates pt
       LEFT JOIN pipeline_stages ps ON ps.template_id = pt.id
       WHERE pt.firm_id = $1 AND pt.status = $2
       GROUP BY pt.id
       ORDER BY pt.created_at ASC`,
      [req.firm.id, showArchived ? 'archived' : 'active']
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /templates error:', e);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// POST /templates
router.post('/templates', async (req, res) => {
  try {
    const { name = '', entity_type = 'company', description = '' } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO pipeline_templates (firm_id, name, entity_type, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.firm.id, name, entity_type, description]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /templates error:', e);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// GET /templates/:id
router.get('/templates/:id', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { rows: stages } = await pool.query(
      `SELECT ps.*, fu.display_name AS auto_assign_name, fu.name AS auto_assign_full_name
       FROM pipeline_stages ps
       LEFT JOIN firm_users fu ON fu.id = ps.auto_assign_to
       WHERE ps.template_id = $1
       ORDER BY ps.position ASC, ps.id ASC`,
      [tmpl.id]
    );
    res.json({ ...tmpl, stages });
  } catch (e) {
    console.error('GET /templates/:id error:', e);
    res.status(500).json({ error: 'Failed to load template' });
  }
});

// PUT /templates/:id
router.put('/templates/:id', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { name = tmpl.name, description = tmpl.description, entity_type = tmpl.entity_type, default_year = tmpl.default_year } = req.body;
    const { rows } = await pool.query(
      `UPDATE pipeline_templates SET name=$1, description=$2, entity_type=$3, default_year=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, description, entity_type, default_year || null, tmpl.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /templates/:id error:', e);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /templates/:id
router.delete('/templates/:id', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { rows: instances } = await pool.query(
      'SELECT id FROM pipeline_instances WHERE template_id = $1 LIMIT 1',
      [tmpl.id]
    );
    if (instances.length > 0) {
      return res.status(409).json({ error: 'Cannot delete template with existing instances' });
    }

    await pool.query('DELETE FROM pipeline_templates WHERE id = $1', [tmpl.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /templates/:id error:', e);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// POST /templates/:id/stages
router.post('/templates/:id/stages', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { name = '', position = 0, color = '#c9a84c', is_terminal = false } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO pipeline_stages (template_id, name, position, color, is_terminal)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tmpl.id, name, position, color, is_terminal]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /templates/:id/stages error:', e);
    res.status(500).json({ error: 'Failed to add stage' });
  }
});

// PUT /templates/:id/stages/reorder  — must come BEFORE /:stageId
router.put('/templates/:id/stages/reorder', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { stageIds } = req.body;
    if (!Array.isArray(stageIds)) return res.status(400).json({ error: 'stageIds must be an array' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < stageIds.length; i++) {
        await client.query(
          'UPDATE pipeline_stages SET position = $1 WHERE id = $2 AND template_id = $3',
          [i, stageIds[i], tmpl.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const { rows: stages } = await pool.query(
      'SELECT * FROM pipeline_stages WHERE template_id = $1 ORDER BY position ASC, id ASC',
      [tmpl.id]
    );
    res.json(stages);
  } catch (e) {
    console.error('PUT /templates/:id/stages/reorder error:', e);
    res.status(500).json({ error: 'Failed to reorder stages' });
  }
});

// PUT /templates/:id/stages/:stageId
router.put('/templates/:id/stages/:stageId', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { rows: existing } = await pool.query(
      'SELECT * FROM pipeline_stages WHERE id = $1 AND template_id = $2',
      [req.params.stageId, tmpl.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Stage not found' });

    const s = existing[0];
    const {
      name = s.name,
      position = s.position,
      color = s.color,
      is_terminal = s.is_terminal,
      auto_assign_to = s.auto_assign_to,
      auto_message = s.auto_message,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE pipeline_stages SET name=$1, position=$2, color=$3, is_terminal=$4, auto_assign_to=$5, auto_message=$6
       WHERE id=$7 RETURNING *`,
      [name, position, color, is_terminal, auto_assign_to || null, auto_message || '', s.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /templates/:id/stages/:stageId error:', e);
    res.status(500).json({ error: 'Failed to update stage' });
  }
});

// DELETE /templates/:id/stages/:stageId
router.delete('/templates/:id/stages/:stageId', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { rows: existing } = await pool.query(
      'SELECT * FROM pipeline_stages WHERE id = $1 AND template_id = $2',
      [req.params.stageId, tmpl.id]
    );
    if (!existing[0]) return res.status(404).json({ error: 'Stage not found' });

    const deletedPos = existing[0].position;
    // Clean up dependent records first
    await pool.query('DELETE FROM pipeline_stage_triggers WHERE stage_id = $1', [existing[0].id]);
    await pool.query('DELETE FROM pipeline_stage_actions WHERE stage_id = $1', [existing[0].id]);
    await pool.query('DELETE FROM pipeline_stages WHERE id = $1', [existing[0].id]);

    // Reorder remaining stages
    await pool.query(
      `UPDATE pipeline_stages SET position = position - 1
       WHERE template_id = $1 AND position > $2`,
      [tmpl.id, deletedPos]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /templates/:id/stages/:stageId error:', e);
    res.status(500).json({ error: 'Failed to delete stage' });
  }
});

// ─────────────────────────────────────────────
// INSTANCE ENDPOINTS
// ─────────────────────────────────────────────

// POST /templates/:templateId/ensure-instance
// Returns an existing instance for template+year, or creates one silently.
router.post('/templates/:templateId/ensure-instance', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.templateId);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { year } = req.body;
    if (!year) return res.status(400).json({ error: 'year is required' });

    // Look for an existing instance with this template + tax_year
    const { rows: existing } = await pool.query(
      `SELECT * FROM pipeline_instances
       WHERE template_id = $1 AND firm_id = $2 AND tax_year = $3
       LIMIT 1`,
      [tmpl.id, req.firm.id, String(year)]
    );
    if (existing[0]) return res.json(existing[0]);

    // Create a new one
    const name = `${tmpl.name} ${year}`;
    const { rows } = await pool.query(
      `INSERT INTO pipeline_instances (firm_id, template_id, name, tax_year)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.firm.id, tmpl.id, name, String(year)]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /templates/:templateId/ensure-instance error:', e);
    res.status(500).json({ error: 'Failed to ensure instance' });
  }
});

// POST /templates/:id/clone
router.post('/templates/:id/clone', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    const { rows: [newTmpl] } = await pool.query(
      `INSERT INTO pipeline_templates (firm_id, name, entity_type, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.firm.id, tmpl.name + ' (Copy)', tmpl.entity_type, tmpl.description]
    );
    const { rows: stages } = await pool.query(
      'SELECT * FROM pipeline_stages WHERE template_id = $1 ORDER BY position ASC', [tmpl.id]
    );
    for (const s of stages) {
      await pool.query(
        `INSERT INTO pipeline_stages (template_id, name, position, color, is_terminal) VALUES ($1,$2,$3,$4,$5)`,
        [newTmpl.id, s.name, s.position, s.color, s.is_terminal]
      );
    }
    res.status(201).json(newTmpl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates/:id/archive
router.post('/templates/:id/archive', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    await pool.query('UPDATE pipeline_templates SET status=$1 WHERE id=$2', ['archived', tmpl.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /templates/:id/unarchive
router.post('/templates/:id/unarchive', async (req, res) => {
  try {
    const tmpl = await getTemplate(req.firm.id, req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    await pool.query('UPDATE pipeline_templates SET status=$1 WHERE id=$2', ['active', tmpl.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /instances
router.get('/instances', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pi.*, pt.name AS template_name, pt.entity_type,
        COUNT(pj.id)::int AS job_count
       FROM pipeline_instances pi
       LEFT JOIN pipeline_templates pt ON pt.id = pi.template_id
       LEFT JOIN pipeline_jobs pj ON pj.instance_id = pi.id
       WHERE pi.firm_id = $1
       GROUP BY pi.id, pt.name, pt.entity_type
       ORDER BY pi.created_at DESC`,
      [req.firm.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /instances error:', e);
    res.status(500).json({ error: 'Failed to load instances' });
  }
});

// POST /instances
router.post('/instances', async (req, res) => {
  try {
    const { template_id, name = '', tax_year = '' } = req.body;
    if (!template_id) return res.status(400).json({ error: 'template_id required' });

    const tmpl = await getTemplate(req.firm.id, template_id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });

    const { rows } = await pool.query(
      `INSERT INTO pipeline_instances (firm_id, template_id, name, tax_year)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.firm.id, template_id, name, tax_year]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('POST /instances error:', e);
    res.status(500).json({ error: 'Failed to create instance' });
  }
});

// GET /instances/:id
router.get('/instances/:id', async (req, res) => {
  try {
    const inst = await getInstance(req.firm.id, req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });

    // Get template + stages
    const { rows: [tmpl] } = await pool.query(
      'SELECT * FROM pipeline_templates WHERE id = $1',
      [inst.template_id]
    );
    const { rows: stages } = await pool.query(
      'SELECT * FROM pipeline_stages WHERE template_id = $1 ORDER BY position ASC, id ASC',
      [inst.template_id]
    );

    // Get jobs with entity names (job_status included via pj.*)
    const { rows: jobs } = await pool.query(
      `SELECT pj.*, fu.display_name AS assigned_name, fu.name AS assigned_full_name
       FROM pipeline_jobs pj
       LEFT JOIN firm_users fu ON fu.id = pj.assigned_to
       WHERE pj.instance_id = $1
       ORDER BY pj.created_at ASC`,
      [inst.id]
    );

    // Resolve entity names + recent updates (last 3 per job)
    const jobIds = jobs.map(j => j.id);
    let updatesMap = {};
    if (jobIds.length > 0) {
      const { rows: updates } = await pool.query(
        `SELECT u.id, u.job_id, u.body, u.created_at,
                COALESCE(fu.display_name, fu.name, fu.email) AS author_name
         FROM pipeline_job_updates u
         LEFT JOIN firm_users fu ON fu.id = u.author_id
         WHERE u.job_id = ANY($1)
         ORDER BY u.job_id, u.created_at DESC`,
        [jobIds]
      );
      for (const u of updates) {
        if (!updatesMap[u.job_id]) updatesMap[u.job_id] = [];
        updatesMap[u.job_id].push(u);
      }
    }

    for (const job of jobs) {
      job.entity_name = await resolveEntityName(job);
      job.recent_updates = (updatesMap[job.id] || []).slice(0, 3);
      // Resolve CRM entity subtype for pill labels
      try {
        if (job.entity_type === 'company') {
          const { rows } = await pool.query('SELECT entity_type FROM companies WHERE id = $1', [job.entity_id]);
          job.crm_entity_type = rows[0]?.entity_type || null;
        } else if (job.entity_type === 'person') {
          job.crm_entity_type = 'individual';
        } else if (job.entity_type === 'relationship') {
          job.crm_entity_type = 'relationship';
        }
      } catch(_) {}
    }

    res.json({ ...inst, template: tmpl, stages, jobs });
  } catch (e) {
    console.error('GET /instances/:id error:', e);
    res.status(500).json({ error: 'Failed to load instance' });
  }
});

// PUT /instances/:id
router.put('/instances/:id', async (req, res) => {
  try {
    const inst = await getInstance(req.firm.id, req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });

    const { name = inst.name, tax_year = inst.tax_year, status = inst.status } = req.body;
    const { rows } = await pool.query(
      `UPDATE pipeline_instances SET name=$1, tax_year=$2, status=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [name, tax_year, status, inst.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('PUT /instances/:id error:', e);
    res.status(500).json({ error: 'Failed to update instance' });
  }
});

// DELETE /instances/:id
router.delete('/instances/:id', async (req, res) => {
  try {
    const inst = await getInstance(req.firm.id, req.params.id);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });

    const { rows: jobs } = await pool.query(
      'SELECT id FROM pipeline_jobs WHERE instance_id = $1 LIMIT 1',
      [inst.id]
    );
    if (jobs.length > 0) {
      return res.status(409).json({ error: 'Cannot delete instance with existing jobs' });
    }

    await pool.query('DELETE FROM pipeline_instances WHERE id = $1', [inst.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /instances/:id error:', e);
    res.status(500).json({ error: 'Failed to delete instance' });
  }
});

// ─────────────────────────────────────────────
// JOB ENDPOINTS
// ─────────────────────────────────────────────

// GET /jobs — list all active pipeline jobs across all instances (Viktor + dashboard)
router.get('/jobs', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(`
      SELECT pj.id, pj.job_status AS status, pj.entity_type, pj.entity_id,
             pj.current_stage_id, ps.name AS stage_name, ps.position AS stage_position,
             pt.id AS template_id, pt.name AS template_name,
             pi.id AS instance_id,
             pj.assigned_to, pj.priority, pj.due_date, pj.notes,
             c.company_name,
             p.first_name || ' ' || p.last_name AS person_name,
             r.name AS relationship_name, r.id AS relationship_id,
             pj.created_at, pj.updated_at
      FROM pipeline_jobs pj
      JOIN pipeline_instances pi ON pi.id = pj.instance_id
      JOIN pipeline_templates pt ON pt.id = pi.template_id
      LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
      LEFT JOIN companies c ON c.id = pj.entity_id AND pj.entity_type = 'company'
      LEFT JOIN people p ON p.id = pj.entity_id AND pj.entity_type = 'person'
      LEFT JOIN relationships r ON r.id = COALESCE(c.relationship_id, p.relationship_id)
      WHERE pi.firm_id = $1 AND pj.job_status NOT IN ('complete', 'archived')
      ORDER BY ps.position ASC NULLS LAST, pj.updated_at DESC
      LIMIT 200
    `, [firmId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /pipelines/jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch pipeline jobs' });
  }
});

// GET /templates/:id/stages — list stages for a pipeline template
router.get('/templates/:id/stages', async (req, res) => {
  const firmId = req.firm.id;
  const templateId = parseInt(req.params.id);
  try {
    // Verify template belongs to firm
    const { rows: tmpl } = await pool.query(
      'SELECT id FROM pipeline_templates WHERE id = $1 AND firm_id = $2',
      [templateId, firmId]
    );
    if (!tmpl[0]) return res.status(404).json({ error: 'Template not found' });
    const { rows } = await pool.query(
      'SELECT id, name, position, color FROM pipeline_stages WHERE template_id = $1 ORDER BY position ASC',
      [templateId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /pipelines/templates/:id/stages error:', err);
    res.status(500).json({ error: 'Failed to fetch stages' });
  }
});

// GET /instances/:instanceId/jobs
router.get('/instances/:instanceId/jobs', async (req, res) => {
  try {
    const inst = await getInstance(req.firm.id, req.params.instanceId);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });

    const { rows: jobs } = await pool.query(
      `SELECT pj.*, fu.display_name AS assigned_name, fu.name AS assigned_full_name
       FROM pipeline_jobs pj
       LEFT JOIN firm_users fu ON fu.id = pj.assigned_to
       WHERE pj.instance_id = $1
       ORDER BY pj.created_at ASC`,
      [inst.id]
    );

    for (const job of jobs) {
      job.entity_name = await resolveEntityName(job);
    }

    res.json(jobs);
  } catch (e) {
    console.error('GET /instances/:instanceId/jobs error:', e);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
});

// POST /instances/:instanceId/jobs
router.post('/instances/:instanceId/jobs', async (req, res) => {
  try {
    const inst = await getInstance(req.firm.id, req.params.instanceId);
    if (!inst) return res.status(404).json({ error: 'Instance not found' });

    const { entity_type = 'company', entity_id, notes = '', assigned_to = null, due_date = null, priority = 'normal' } = req.body;
    if (!entity_id) return res.status(400).json({ error: 'entity_id required' });

    // Default to first stage
    const { rows: stages } = await pool.query(
      'SELECT id FROM pipeline_stages WHERE template_id = $1 ORDER BY position ASC, id ASC LIMIT 1',
      [inst.template_id]
    );
    const defaultStageId = stages[0]?.id || null;

    const { rows } = await pool.query(
      `INSERT INTO pipeline_jobs (instance_id, entity_type, entity_id, current_stage_id, assigned_to, notes, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [inst.id, entity_type, entity_id, defaultStageId, assigned_to || null, notes, priority, due_date || null]
    );

    const job = rows[0];
    job.entity_name = await resolveEntityName(job);
    res.status(201).json(job);
  } catch (e) {
    console.error('POST /instances/:instanceId/jobs error:', e);
    res.status(500).json({ error: 'Failed to add job' });
  }
});

// PUT /jobs/:jobId
router.put('/jobs/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.firm.id, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const {
      notes = job.notes,
      assigned_to = job.assigned_to,
      due_date = job.due_date,
      priority = job.priority,
      current_stage_id = job.current_stage_id,
      job_status = job.job_status || 'active',
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE pipeline_jobs SET notes=$1, assigned_to=$2, due_date=$3, priority=$4, current_stage_id=$5, job_status=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [notes, assigned_to || null, due_date || null, priority, current_stage_id, job_status, job.id]
    );

    const updated = rows[0];
    updated.entity_name = await resolveEntityName(updated);
    res.json(updated);
  } catch (e) {
    console.error('PUT /jobs/:jobId error:', e);
    res.status(500).json({ error: 'Failed to update job' });
  }
});

// DELETE /jobs/:jobId
router.delete('/jobs/:jobId', async (req, res) => {
  try {
    const job = await getJob(req.firm.id, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    await pool.query('DELETE FROM pipeline_jobs WHERE id = $1', [job.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /jobs/:jobId error:', e);
    res.status(500).json({ error: 'Failed to delete job' });
  }
});

// POST /jobs/:jobId/move
router.post('/jobs/:jobId/move', async (req, res) => {
  try {
    const job = await getJob(req.firm.id, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { stage_id, note = '' } = req.body;
    if (!stage_id) return res.status(400).json({ error: 'stage_id required' });

    // Verify stage belongs to this job's instance's template
    const { rows: stageCheck } = await pool.query(
      `SELECT ps.id FROM pipeline_stages ps
       JOIN pipeline_instances pi ON pi.template_id = ps.template_id
       WHERE ps.id = $1 AND pi.id = $2`,
      [stage_id, job.instance_id]
    );
    if (!stageCheck[0]) {
      return res.status(400).json({ error: 'Stage does not belong to this pipeline' });
    }

    const moverId = req.firm.userId || null;

    await pool.query(
      `INSERT INTO pipeline_job_history (job_id, from_stage_id, to_stage_id, moved_by, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [job.id, job.current_stage_id, stage_id, moverId, note]
    );

    // Fetch new stage details for automation
    const { rows: newStageRows } = await pool.query(
      'SELECT * FROM pipeline_stages WHERE id = $1',
      [stage_id]
    );
    const newStage = newStageRows[0];

    // Auto-assign if configured
    if (newStage && newStage.auto_assign_to) {
      await pool.query(
        'UPDATE pipeline_jobs SET assigned_to = $1 WHERE id = $2',
        [newStage.auto_assign_to, job.id]
      );
    }

    const { rows } = await pool.query(
      `UPDATE pipeline_jobs SET current_stage_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [stage_id, job.id]
    );

    const updated = rows[0];
    updated.entity_name = await resolveEntityName(updated);

    // ── Terminal stage: archive job + record completion ────────────────────
    if (newStage && newStage.is_terminal) {
      try {
        // Get firm_id and pipeline info
        const { rows: instRows } = await pool.query(
          `SELECT pi.firm_id, pi.name AS instance_name, pi.tax_year,
                  pt.name AS template_name
           FROM pipeline_instances pi
           JOIN pipeline_templates pt ON pt.id = pi.template_id
           WHERE pi.id = $1`,
          [job.instance_id]
        );
        const inst = instRows[0];
        if (inst) {
          // Archive the job
          await pool.query(
            `UPDATE pipeline_jobs SET job_status = 'archived', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );

          // Record completion (for person or company entity type only)
          if (job.entity_type === 'person' || job.entity_type === 'company') {
            const taxYearInt = inst.tax_year ? parseInt(inst.tax_year) : null;
            await pool.query(
              `INSERT INTO pipeline_completions
                 (firm_id, entity_type, entity_id, pipeline_instance_id, pipeline_name, tax_year, job_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [inst.firm_id, job.entity_type, job.entity_id, job.instance_id,
               inst.instance_name || inst.template_name, taxYearInt, job.id]
            );
          }
          updated.job_status = 'archived';
        }
      } catch (termErr) {
        console.error('[pipelines] terminal stage archival error (non-fatal):', termErr);
      }
    }

    // Auto-message if configured
    if (newStage && newStage.auto_message && newStage.auto_message.trim()) {
      try {
        // Get the firm's instance to find firm_id
        const { rows: instRows } = await pool.query(
          'SELECT firm_id FROM pipeline_instances WHERE id = $1',
          [job.instance_id]
        );
        const firmId = instRows[0]?.firm_id;
        if (firmId) {
          // Get firm owner
          const { rows: ownerRows } = await pool.query(
            `SELECT id FROM firm_users WHERE firm_id = $1 AND role = 'owner' LIMIT 1`,
            [firmId]
          );
          const senderId = ownerRows[0]?.id;
          if (senderId) {
            // Resolve person IDs from job entity
            let personIds = [];
            if (job.entity_type === 'person') {
              personIds = [job.entity_id];
            } else if (job.entity_type === 'company') {
              const { rows: pca } = await pool.query(
                'SELECT person_id FROM person_company_access WHERE company_id = $1',
                [job.entity_id]
              );
              personIds = pca.map(r => r.person_id);
            }

            for (const personId of personIds) {
              // Find or create an open thread for this person
              const { rows: threadRows } = await pool.query(
                `SELECT id FROM message_threads WHERE firm_id = $1 AND person_id = $2 AND status = 'open' ORDER BY last_message_at DESC LIMIT 1`,
                [firmId, personId]
              );
              let threadId;
              if (threadRows.length > 0) {
                threadId = threadRows[0].id;
              } else {
                const { rows: newThread } = await pool.query(
                  `INSERT INTO message_threads (firm_id, person_id, subject, status, category, last_message_at)
                   VALUES ($1, $2, 'Pipeline Update', 'open', 'general', NOW()) RETURNING id`,
                  [firmId, personId]
                );
                threadId = newThread[0].id;
              }
              // Insert auto-message
              await pool.query(
                `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
                 VALUES ($1, 'staff', $2, $3, false)`,
                [threadId, senderId, newStage.auto_message.trim()]
              );
              // Update thread last_message_at
              await pool.query(
                'UPDATE message_threads SET last_message_at = NOW() WHERE id = $1',
                [threadId]
              );
            }
          }
        }
      } catch (autoMsgErr) {
        console.error('Auto-message error (non-fatal):', autoMsgErr);
      }
    }

    // ── Fire pipeline stage actions (non-blocking) ──────────────────────────
    try {
      const { rows: instInfoRows } = await pool.query(
        `SELECT pi.firm_id, pi.name AS instance_name, pi.tax_year, pt.name AS template_name
         FROM pipeline_instances pi
         JOIN pipeline_templates pt ON pt.id = pi.template_id
         WHERE pi.id = $1`,
        [job.instance_id]
      );
      const instInfo = instInfoRows[0];
      console.log(`[pipelines] move job ${job.id} to stage ${stage_id}, instance ${job.instance_id}, instInfo found: ${!!instInfo}`);
      if (instInfo) {
        executeStageActions(
          instInfo.firm_id,
          stage_id,
          job.instance_id,
          updated.entity_type,
          updated.entity_id,
          {
            pipeline_name: instInfo.instance_name || instInfo.template_name,
            tax_year: instInfo.tax_year || '',
            stage_name: newStage ? newStage.name : '',
            triggered_by_user_id: req.firm.userId || null,
            job_id: job.id,
          }
        ).catch(e => console.error('[actions] non-fatal:', e));
      }
    } catch (actErr) {
      console.error('[actions] setup error (non-fatal):', actErr);
    }

    res.json(updated);
  } catch (e) {
    console.error('POST /jobs/:jobId/move error:', e);
    res.status(500).json({ error: 'Failed to move job' });
  }
});

// PUT /stages/:stageId/terminal — mark/unmark a stage as terminal
router.put('/stages/:stageId/terminal', async (req, res) => {
  try {
    const { is_terminal = false } = req.body;
    // Verify the stage belongs to a template owned by this firm
    const { rows } = await pool.query(
      `SELECT ps.id FROM pipeline_stages ps
       JOIN pipeline_templates pt ON pt.id = ps.template_id
       WHERE ps.id = $1 AND pt.firm_id = $2`,
      [req.params.stageId, req.firm.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Stage not found' });

    if (is_terminal) {
      // Clear terminal from all other stages in the same template first
      await pool.query(
        `UPDATE pipeline_stages SET is_terminal = false
         WHERE template_id = (SELECT template_id FROM pipeline_stages WHERE id = $1)
           AND id != $1`,
        [req.params.stageId]
      );
    }

    const { rows: updated } = await pool.query(
      'UPDATE pipeline_stages SET is_terminal = $1 WHERE id = $2 RETURNING *',
      [is_terminal, req.params.stageId]
    );
    res.json(updated[0]);
  } catch (e) {
    console.error('PUT /stages/:stageId/terminal error:', e);
    res.status(500).json({ error: 'Failed to update stage' });
  }
});

// GET /completions — pipeline completion history for an entity or relationship
router.get('/completions', async (req, res) => {
  try {
    const firmId = req.firm.id;
    const { entity_type, entity_id, relationship_id } = req.query;

    if (relationship_id) {
      // Get all people and companies in this relationship
      const { rows: people } = await pool.query(
        'SELECT id FROM people WHERE firm_id = $1 AND relationship_id = $2',
        [firmId, parseInt(relationship_id)]
      );
      const { rows: companies } = await pool.query(
        'SELECT id FROM companies WHERE firm_id = $1 AND relationship_id = $2',
        [firmId, parseInt(relationship_id)]
      );

      const completions = [];
      const activeJobs = [];

      // Completions for all people
      for (const p of people) {
        const { rows } = await pool.query(
          `SELECT pc.*, 'person' AS entity_type FROM pipeline_completions pc
           WHERE pc.firm_id = $1 AND pc.entity_type = 'person' AND pc.entity_id = $2
             AND pc.completed_at > NOW() - INTERVAL '2 years'
           ORDER BY pc.completed_at DESC`,
          [firmId, p.id]
        );
        completions.push(...rows);

        const { rows: jobs } = await pool.query(
          `SELECT pj.id, pj.entity_type, pj.entity_id,
                  pt.name AS pipeline_name, pi.tax_year,
                  ps.name AS current_stage_name
           FROM pipeline_jobs pj
           JOIN pipeline_instances pi ON pi.id = pj.instance_id
           JOIN pipeline_templates pt ON pt.id = pi.template_id
           LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
           WHERE pi.firm_id = $1 AND pj.entity_type = 'person' AND pj.entity_id = $2
             AND pj.job_status NOT IN ('complete', 'archived')`,
          [firmId, p.id]
        );
        activeJobs.push(...jobs);
      }

      // Completions for all companies
      for (const c of companies) {
        const { rows } = await pool.query(
          `SELECT pc.*, 'company' AS entity_type FROM pipeline_completions pc
           WHERE pc.firm_id = $1 AND pc.entity_type = 'company' AND pc.entity_id = $2
             AND pc.completed_at > NOW() - INTERVAL '2 years'
           ORDER BY pc.completed_at DESC`,
          [firmId, c.id]
        );
        completions.push(...rows);

        const { rows: jobs } = await pool.query(
          `SELECT pj.id, pj.entity_type, pj.entity_id,
                  pt.name AS pipeline_name, pi.tax_year,
                  ps.name AS current_stage_name
           FROM pipeline_jobs pj
           JOIN pipeline_instances pi ON pi.id = pj.instance_id
           JOIN pipeline_templates pt ON pt.id = pi.template_id
           LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
           WHERE pi.firm_id = $1 AND pj.entity_type = 'company' AND pj.entity_id = $2
             AND pj.job_status NOT IN ('complete', 'archived')`,
          [firmId, c.id]
        );
        activeJobs.push(...jobs);
      }

      // Sort completions newest first
      completions.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
      return res.json({ completions, active_jobs: activeJobs });
    }

    if (!entity_type || !entity_id) {
      return res.status(400).json({ error: 'entity_type and entity_id (or relationship_id) required' });
    }

    const { rows: completions } = await pool.query(
      `SELECT * FROM pipeline_completions
       WHERE firm_id = $1 AND entity_type = $2 AND entity_id = $3
       ORDER BY completed_at DESC`,
      [firmId, entity_type, parseInt(entity_id)]
    );

    const { rows: activeJobs } = await pool.query(
      `SELECT pj.id, pj.entity_type, pj.entity_id,
              pt.name AS pipeline_name, pi.tax_year,
              ps.name AS current_stage_name
       FROM pipeline_jobs pj
       JOIN pipeline_instances pi ON pi.id = pj.instance_id
       JOIN pipeline_templates pt ON pt.id = pi.template_id
       LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
       WHERE pi.firm_id = $1 AND pj.entity_type = $2 AND pj.entity_id = $3
         AND pj.job_status NOT IN ('complete', 'archived')`,
      [firmId, entity_type, parseInt(entity_id)]
    );

    res.json({ completions, active_jobs: activeJobs });
  } catch (e) {
    console.error('GET /completions error:', e);
    res.status(500).json({ error: 'Failed to load completions' });
  }
});

// GET /jobs/:jobId/history
router.get('/jobs/:jobId/history', async (req, res) => {
  try {
    const job = await getJob(req.firm.id, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { rows } = await pool.query(
      `SELECT h.*,
        fs.name AS from_stage_name,
        ts.name AS to_stage_name,
        fu.display_name AS moved_by_name,
        fu.name AS moved_by_full_name
       FROM pipeline_job_history h
       LEFT JOIN pipeline_stages fs ON fs.id = h.from_stage_id
       LEFT JOIN pipeline_stages ts ON ts.id = h.to_stage_id
       LEFT JOIN firm_users fu ON fu.id = h.moved_by
       WHERE h.job_id = $1
       ORDER BY h.moved_at ASC`,
      [job.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /jobs/:jobId/history error:', e);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// --- GET /entity-jobs?entity_type=company&entity_id=123 ---
// Returns all pipeline jobs for a given entity, grouped with pipeline/stage info
router.get('/entity-jobs', async (req, res) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) return res.status(400).json({ error: 'entity_type and entity_id required' });

    const { rows } = await pool.query(
      `SELECT
         pj.id, pj.entity_type, pj.entity_id, pj.job_status, pj.priority,
         pj.assigned_to, pj.due_date, pj.created_at,
         ps.name AS stage_name, ps.color AS stage_color,
         pt.name AS pipeline_name, pt.id AS template_id,
         pi.tax_year,
         COALESCE(fu.display_name, fu.name) AS assigned_name,
         (SELECT body FROM pipeline_job_updates u WHERE u.job_id = pj.id ORDER BY u.created_at DESC LIMIT 1) AS last_update,
         (SELECT created_at FROM pipeline_job_updates u WHERE u.job_id = pj.id ORDER BY u.created_at DESC LIMIT 1) AS last_update_at,
         (SELECT COALESCE(fu2.display_name, fu2.name) FROM pipeline_job_updates u JOIN firm_users fu2 ON fu2.id = u.author_id WHERE u.job_id = pj.id ORDER BY u.created_at DESC LIMIT 1) AS last_update_author
       FROM pipeline_jobs pj
       JOIN pipeline_instances pi ON pi.id = pj.instance_id
       JOIN pipeline_templates pt ON pt.id = pi.template_id
       JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
       LEFT JOIN firm_users fu ON fu.id = pj.assigned_to
       WHERE pi.firm_id = $1 AND pj.entity_type = $2 AND pj.entity_id = $3
       ORDER BY pt.name ASC, pi.tax_year DESC`,
      [req.firm.id, entity_type, parseInt(entity_id)]
    );
    res.json(rows);
  } catch (e) {
    console.error('GET /entity-jobs error:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- GET /jobs/:jobId/updates ---
router.get('/jobs/:jobId/updates', async (req, res) => {
  try {
    const job = await getJob(req.firm.id, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { rows } = await pool.query(
      `SELECT u.id, u.body, u.created_at,
              COALESCE(fu.display_name, fu.name, fu.email) AS author_name
       FROM pipeline_job_updates u
       LEFT JOIN firm_users fu ON fu.id = u.author_id
       WHERE u.job_id = $1
       ORDER BY u.created_at DESC`,
      [job.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- POST /jobs/:jobId/updates ---
router.post('/jobs/:jobId/updates', async (req, res) => {
  try {
    const job = await getJob(req.firm.id, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Body is required' });
    const { rows } = await pool.query(
      `INSERT INTO pipeline_job_updates (job_id, author_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, body, created_at`,
      [job.id, req.firm.userId, body.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- DELETE /jobs/:jobId/updates/:updateId ---
router.delete('/jobs/:jobId/updates/:updateId', async (req, res) => {
  try {
    const job = await getJob(req.firm.id, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await pool.query(
      'DELETE FROM pipeline_job_updates WHERE id = $1 AND job_id = $2',
      [req.params.updateId, job.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
