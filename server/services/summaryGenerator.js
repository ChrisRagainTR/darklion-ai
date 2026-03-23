'use strict';
const { pool } = require('../db');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateDailySummary(firmId, date) {
  // date is a Date object or 'YYYY-MM-DD' string
  const dateStr = typeof date === 'string' ? date : date.toISOString().slice(0, 10);

  // Get all threads with activity on this date (client messages only, non-system)
  const { rows: activeThreads } = await pool.query(`
    SELECT DISTINCT mt.id, mt.subject, mt.staff_user_id,
      p.first_name || ' ' || p.last_name as client_name,
      fu.name as staff_name
    FROM messages m
    JOIN message_threads mt ON mt.id = m.thread_id
    JOIN people p ON p.id = mt.person_id
    JOIN firm_users fu ON fu.id = mt.staff_user_id
    WHERE mt.firm_id = $1
      AND m.sender_type = 'client'
      AND m.is_system_message = false
      AND m.is_internal = false
      AND DATE(m.created_at AT TIME ZONE 'America/New_York') = $2
  `, [firmId, dateStr]);

  if (!activeThreads.length) {
    // No activity — store empty summary
    await pool.query(`
      INSERT INTO conversation_summaries (firm_id, summary_date, summary_json)
      VALUES ($1, $2, $3)
      ON CONFLICT (firm_id, summary_date) DO UPDATE SET summary_json = EXCLUDED.summary_json, generated_at = NOW()
    `, [firmId, dateStr, JSON.stringify({ threads: [], thread_count: 0, generated_at: new Date().toISOString() })]);
    return { date: dateStr, thread_count: 0, by_staff: [] };
  }

  // For each thread, get the day's messages
  const threadSummaries = [];

  for (const thread of activeThreads) {
    const { rows: msgs } = await pool.query(`
      SELECT m.body, m.sender_type, m.is_internal, m.created_at,
        COALESCE(fu.name, 'Client') as sender_name
      FROM messages m
      LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
      WHERE m.thread_id = $1
        AND m.is_system_message = false
        AND DATE(m.created_at AT TIME ZONE 'America/New_York') = $2
      ORDER BY m.created_at ASC
    `, [thread.id, dateStr]);

    if (!msgs.length) continue;

    // Build conversation text for Claude
    const convoText = msgs.map(m => {
      const role = m.is_internal ? '[Internal Note]' : (m.sender_type === 'client' ? thread.client_name : m.sender_name);
      return `${role}: ${m.body}`;
    }).join('\n');

    // Ask Claude to summarize
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Summarize this client conversation in 2-4 bullet points. Be concise. Focus on: what the client asked/discussed, any action items or follow-ups needed, and key outcomes. Do NOT include internal notes in the summary.

Client: ${thread.client_name}
Staff: ${thread.staff_name}

Conversation:
${convoText}

Reply with bullet points only, starting each with "•". No preamble.`
        }]
      });

      threadSummaries.push({
        thread_id: thread.id,
        client_name: thread.client_name,
        staff_name: thread.staff_name,
        staff_user_id: thread.staff_user_id,
        subject: thread.subject,
        bullets: response.content[0].text.trim(),
        message_count: msgs.length,
      });
    } catch (e) {
      console.error(`[summaryGenerator] Claude error for thread ${thread.id}:`, e.message);
      // Fallback — include without AI summary
      threadSummaries.push({
        thread_id: thread.id,
        client_name: thread.client_name,
        staff_name: thread.staff_name,
        staff_user_id: thread.staff_user_id,
        subject: thread.subject,
        bullets: `• ${msgs.length} message(s) exchanged`,
        message_count: msgs.length,
      });
    }
  }

  // Group by staff member
  const byStaff = {};
  for (const t of threadSummaries) {
    const key = t.staff_user_id;
    if (!byStaff[key]) byStaff[key] = { staff_name: t.staff_name, staff_user_id: t.staff_user_id, threads: [] };
    byStaff[key].threads.push(t);
  }

  const summaryJson = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    by_staff: Object.values(byStaff),
    thread_count: threadSummaries.length,
  };

  await pool.query(`
    INSERT INTO conversation_summaries (firm_id, summary_date, summary_json)
    VALUES ($1, $2, $3)
    ON CONFLICT (firm_id, summary_date) DO UPDATE SET summary_json = EXCLUDED.summary_json, generated_at = NOW()
  `, [firmId, dateStr, JSON.stringify(summaryJson)]);

  console.log(`[summaryGenerator] Generated summary for firm ${firmId} on ${dateStr}: ${threadSummaries.length} threads`);
  return summaryJson;
}

module.exports = { generateDailySummary };
