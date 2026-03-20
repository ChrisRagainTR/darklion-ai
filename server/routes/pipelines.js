'use strict';

const { Router } = require('express');
const { pool } = require('../db');

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
    const { rows } = await pool.query(
      `SELECT pt.*, COUNT(ps.id)::int AS stage_count
       FROM pipeline_templates pt
       LEFT JOIN pipeline_stages ps ON ps.template_id = pt.id
       WHERE pt.firm_id = $1
       GROUP BY pt.id
       ORDER BY pt.created_at ASC`,
      [req.firm.id]
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
      'SELECT * FROM pipeline_stages WHERE template_id = $1 ORDER BY position ASC, id ASC',
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

    const { name = tmpl.name, description = tmpl.description, entity_type = tmpl.entity_type } = req.body;
    const { rows } = await pool.query(
      `UPDATE pipeline_templates SET name=$1, description=$2, entity_type=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [name, description, entity_type, tmpl.id]
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
    const { name = s.name, position = s.position, color = s.color, is_terminal = s.is_terminal } = req.body;
    const { rows } = await pool.query(
      `UPDATE pipeline_stages SET name=$1, position=$2, color=$3, is_terminal=$4
       WHERE id=$5 RETURNING *`,
      [name, position, color, is_terminal, s.id]
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

    // Get jobs with entity names
    const { rows: jobs } = await pool.query(
      `SELECT pj.*, fu.display_name AS assigned_name, fu.name AS assigned_full_name
       FROM pipeline_jobs pj
       LEFT JOIN firm_users fu ON fu.id = pj.assigned_to
       WHERE pj.instance_id = $1
       ORDER BY pj.created_at ASC`,
      [inst.id]
    );

    // Resolve entity names
    for (const job of jobs) {
      job.entity_name = await resolveEntityName(job);
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
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE pipeline_jobs SET notes=$1, assigned_to=$2, due_date=$3, priority=$4, current_stage_id=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [notes, assigned_to || null, due_date || null, priority, current_stage_id, job.id]
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

    const { rows } = await pool.query(
      `UPDATE pipeline_jobs SET current_stage_id=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [stage_id, job.id]
    );

    const updated = rows[0];
    updated.entity_name = await resolveEntityName(updated);
    res.json(updated);
  } catch (e) {
    console.error('POST /jobs/:jobId/move error:', e);
    res.status(500).json({ error: 'Failed to move job' });
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

module.exports = router;
