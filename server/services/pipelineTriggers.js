'use strict';

/**
 * pipelineTriggers.js
 * Core service for Smart Pipeline Stages.
 *
 * fireTrigger(firmId, triggerKey, personId, context)
 *   - Looks up all stage configs for this firm + triggerKey
 *   - For each config: finds the person's active pipeline_job in that pipeline
 *   - Moves the job to the configured target stage
 *   - Logs the move
 *   - Returns array of move results
 *
 * IMPORTANT: fireTrigger is non-blocking safe — callers should wrap in:
 *   fireTrigger(...).catch(e => console.error('[trigger] non-fatal:', e));
 */

const { pool } = require('../db');

/**
 * @param {number} firmId
 * @param {string} triggerKey  e.g. 'tax_return_deployed'
 * @param {number} personId
 * @param {object} [context={}]  extra metadata stored in the log
 * @returns {Promise<Array<{pipeline: string, from_stage: string|null, to_stage: string}>>}
 */
async function fireTrigger(firmId, triggerKey, personId, context = {}) {
  const moved = [];

  // 1. Find all stage configs for this firm + trigger
  const { rows: configs } = await pool.query(
    `SELECT pst.id, pst.pipeline_instance_id, pst.stage_id,
            pi.name AS pipeline_name,
            ps.name AS stage_name
     FROM pipeline_stage_triggers pst
     JOIN pipeline_instances pi ON pi.id = pst.pipeline_instance_id
     JOIN pipeline_stages ps ON ps.id = pst.stage_id
     WHERE pst.firm_id = $1 AND pst.trigger_key = $2`,
    [firmId, triggerKey]
  );

  if (!configs.length) return moved;

  for (const cfg of configs) {
    try {
      // 2. Find the person's active pipeline_job in this pipeline instance
      const { rows: jobRows } = await pool.query(
        `SELECT pj.id, pj.current_stage_id, ps.name AS from_stage_name
         FROM pipeline_jobs pj
         LEFT JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
         WHERE pj.instance_id = $1
           AND pj.entity_type = 'person'
           AND pj.entity_id = $2
           AND pj.job_status NOT IN ('complete', 'archived')
         LIMIT 1`,
        [cfg.pipeline_instance_id, personId]
      );

      if (!jobRows[0]) continue;
      const job = jobRows[0];

      // Skip if already in the target stage
      if (job.current_stage_id === cfg.stage_id) continue;

      // 3. Move the job
      await pool.query(
        `UPDATE pipeline_jobs SET current_stage_id = $1, updated_at = NOW() WHERE id = $2`,
        [cfg.stage_id, job.id]
      );

      // 4. Log the history
      await pool.query(
        `INSERT INTO pipeline_job_history (job_id, from_stage_id, to_stage_id, moved_by, note)
         VALUES ($1, $2, $3, NULL, $4)`,
        [job.id, job.current_stage_id, cfg.stage_id, `Auto-moved: trigger "${triggerKey}"`]
      );

      // 5. Write to trigger log
      await pool.query(
        `INSERT INTO pipeline_trigger_log
           (firm_id, trigger_key, person_id, pipeline_instance_id, from_stage_id, to_stage_id, job_id, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [firmId, triggerKey, personId, cfg.pipeline_instance_id,
         job.current_stage_id, cfg.stage_id, job.id, JSON.stringify(context)]
      );

      moved.push({
        pipeline: cfg.pipeline_name,
        from_stage: job.from_stage_name || null,
        to_stage: cfg.stage_name,
      });
    } catch (err) {
      console.error(`[pipelineTriggers] fireTrigger error for config ${cfg.id}:`, err);
    }
  }

  return moved;
}

module.exports = { fireTrigger };
