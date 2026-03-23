'use strict';
const { Router } = require('express');
const { pool } = require('../db');
const Anthropic = require('@anthropic-ai/sdk');
const { getFirmContext } = require('./viktor');

const router = Router();

const VIKTOR_SYSTEM_PROMPT = `You are Viktor, the AI intelligence assistant for Sentinel Wealth & Tax, a CPA firm specializing in retirement planning and tax services in Bonita Springs/Naples, Florida. You work alongside the firm's staff — Christopher Ragain (CPA/PFS, founder) and Nick Boyd (CPA).

You have full access to the firm's CRM system, pipeline, client messages, tax deliveries, proposals, and engagement letters through DarkLion AI. You can read and write data via the API.

Your role:
- Serve as a proactive firm intelligence assistant
- Prioritize tasks for staff based on urgency and deadlines
- Draft client communications when asked
- Identify at-risk clients, stalled pipelines, and missed follow-ups
- Answer questions about firm data accurately using the context provided
- Be concise, professional, and actionable — this is a busy CPA firm

Tone: Confident, direct, knowledgeable. You're a trusted team member, not a generic chatbot. Reference specific client names and situations when you have the data.

When presenting a morning briefing or task list, use this format:
- Use numbered lists for prioritized tasks
- Bold client names and key amounts
- Group by urgency: 🔴 Urgent, 🟡 Today, 🟢 This Week
- Always end with a summary count

You have access to real-time firm data provided in the user message context.`;

// Build system prompt — injects Viktor's stored context if available
async function buildSystemPrompt(firmId) {
  try {
    const { rows } = await pool.query(
      'SELECT context, updated_at FROM viktor_context WHERE firm_id = $1',
      [firmId]
    );
    if (rows[0]?.context) {
      const updatedAt = rows[0].updated_at ? new Date(rows[0].updated_at).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'unknown';
      return `${VIKTOR_SYSTEM_PROMPT}

<firm_context updated="${updatedAt} EST">
${rows[0].context}
</firm_context>

Use the firm context above to answer staff questions accurately and specifically. Reference real client names, pipeline stages, and task priorities from the context when relevant. If a question falls outside what's covered in the context, answer as best you can from general knowledge and suggest they ask Viktor directly for deeper analysis.`;
    }
  } catch(e) { /* fall through to base prompt */ }
  return VIKTOR_SYSTEM_PROMPT;
}

// GET /api/viktor-chat/session — get or create today's session
router.get('/session', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  if (!userId) return res.status(400).json({ error: 'User ID required — must be authenticated as a staff user' });

  try {
    const today = new Date().toISOString().split('T')[0];

    // Purge sessions older than 3 days (non-blocking)
    pool.query('DELETE FROM viktor_sessions WHERE created_at < NOW() - INTERVAL \'3 days\'').catch(() => {});

    let { rows } = await pool.query(
      `INSERT INTO viktor_sessions (firm_id, user_id, session_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (firm_id, user_id, session_date) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [firmId, userId, today]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[viktor-chat] GET /session error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// POST /api/viktor-chat/briefing — generate morning briefing if not done today
router.post('/briefing', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  try {
    const today = new Date().toISOString().split('T')[0];

    // Check if briefing already generated today
    const { rows: existing } = await pool.query(
      'SELECT * FROM viktor_sessions WHERE firm_id = $1 AND user_id = $2 AND session_date = $3',
      [firmId, userId, today]
    );
    if (existing[0]?.briefing_generated) {
      return res.json({ already_generated: true, messages: existing[0].messages });
    }

    // Fetch firm context directly (no HTTP round-trip)
    const context = await getFirmContext(firmId).catch(() => ({}));

    // Build briefing prompt
    const contextSummary = buildContextSummary(context);
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: await buildSystemPrompt(firmId),
      messages: [{
        role: 'user',
        content: `${greeting}. Generate my daily briefing for today (${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}).\n\nCurrent firm data:\n${contextSummary}\n\nProvide a concise, actionable morning briefing with prioritized tasks. Be specific — use real client names and numbers from the data above.`
      }]
    });

    const briefingText = response.content[0]?.text || 'Unable to generate briefing.';

    // Store in session
    const messages = [
      { role: 'assistant', content: briefingText, timestamp: new Date().toISOString() }
    ];

    const { rows } = await pool.query(
      `INSERT INTO viktor_sessions (firm_id, user_id, session_date, messages, briefing_generated)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (firm_id, user_id, session_date)
       DO UPDATE SET messages = $4, briefing_generated = TRUE, updated_at = NOW()
       RETURNING *`,
      [firmId, userId, today, JSON.stringify(messages)]
    );

    res.json({ messages: rows[0].messages });
  } catch (err) {
    console.error('[viktor-chat] POST /briefing error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate briefing' });
  }
});

// POST /api/viktor-chat/message — store user message, let real Viktor respond via reply-for
// If message starts with "Hey Claude" or "Claude:" — skip Viktor wait and answer immediately with Claude
router.post('/message', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  try {
    const today = new Date().toISOString().split('T')[0];

    const { rows: sessions } = await pool.query(
      'SELECT * FROM viktor_sessions WHERE firm_id = $1 AND user_id = $2 AND session_date = $3',
      [firmId, userId, today]
    );
    const session = sessions[0];
    const history = session ? (session.messages || []) : [];

    const userMsg = { role: 'user', content: message.trim(), timestamp: new Date().toISOString(), pending_reply: true };
    const newMessages = [...history, userMsg];

    // Check if user is explicitly asking for Claude
    const askingClaude = /^(hey claude|claude:|@claude)\b/i.test(message.trim());

    if (askingClaude) {
      // Direct Claude response — strip the "Hey Claude" prefix for the actual query
      const cleanMsg = message.trim().replace(/^(hey claude|claude:|@claude)\s*/i, '');
      const context = await getFirmContext(firmId).catch(() => ({}));
      const contextSummary = buildContextSummary(context);
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
      const client = new Anthropic({ apiKey });
      const recentHistory = history.slice(-20).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      recentHistory.push({ role: 'user', content: `[Current firm context]\n${contextSummary}\n\n---\n\n${cleanMsg}` });
      const response = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, system: await buildSystemPrompt(firmId), messages: recentHistory });
      const replyText = (response.content[0]?.text || 'I encountered an error.') + '\n\n*— Claude (fallback)*';
      const claudeMsg = { role: 'assistant', content: replyText, timestamp: new Date().toISOString(), from: 'claude' };
      userMsg.pending_reply = false;
      const finalMessages = [...history, userMsg, claudeMsg];
      await pool.query(`INSERT INTO viktor_sessions (firm_id, user_id, session_date, messages) VALUES ($1,$2,$3,$4) ON CONFLICT (firm_id, user_id, session_date) DO UPDATE SET messages=$4, updated_at=NOW()`, [firmId, userId, today, JSON.stringify(finalMessages)]);
      return res.json({ reply: replyText, messages: finalMessages, source: 'claude' });
    }

    // Normal flow: store user message, Viktor polls and replies via reply-for
    // Set a 120s Claude fallback timer (non-blocking)
    await pool.query(`INSERT INTO viktor_sessions (firm_id, user_id, session_date, messages) VALUES ($1,$2,$3,$4) ON CONFLICT (firm_id, user_id, session_date) DO UPDATE SET messages=$4, updated_at=NOW()`, [firmId, userId, today, JSON.stringify(newMessages)]);

    // Schedule Claude fallback after 120 seconds if Viktor hasn't replied
    setImmediate(async () => {
      const FALLBACK_MS = 120000;
      await new Promise(r => setTimeout(r, FALLBACK_MS));
      try {
        const { rows: cur } = await pool.query('SELECT messages FROM viktor_sessions WHERE firm_id=$1 AND user_id=$2 AND session_date=$3', [firmId, userId, today]);
        if (!cur[0]) return;
        const msgs = cur[0].messages || [];
        const lastMsg = msgs[msgs.length - 1];
        // Only fallback if the last message is still the user's (Viktor hasn't replied)
        if (!lastMsg || lastMsg.role !== 'user' || !lastMsg.pending_reply) return;
        const context = await getFirmContext(firmId).catch(() => ({}));
        const contextSummary = buildContextSummary(context);
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return;
        const client = new Anthropic({ apiKey });
        const recentHistory = msgs.slice(-20).filter(m => !m.pending_reply).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
        recentHistory.push({ role: 'user', content: `[Current firm context]\n${contextSummary}\n\n---\n\n${message.trim()}` });
        const response = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, system: await buildSystemPrompt(firmId), messages: recentHistory });
        const replyText = "*(Viktor is busy — Claude stepping in)*\n\n" + (response.content[0]?.text || 'I encountered an error.');
        const claudeMsg = { role: 'assistant', content: replyText, timestamp: new Date().toISOString(), from: 'claude_fallback' };
        const { rows: fresh } = await pool.query('SELECT messages FROM viktor_sessions WHERE firm_id=$1 AND user_id=$2 AND session_date=$3', [firmId, userId, today]);
        if (!fresh[0]) return;
        const freshMsgs = (fresh[0].messages || []).map(m => m.pending_reply ? { ...m, pending_reply: false } : m);
        const withFallback = [...freshMsgs, claudeMsg];
        await pool.query('UPDATE viktor_sessions SET messages=$1, updated_at=NOW() WHERE firm_id=$2 AND user_id=$3 AND session_date=$4', [JSON.stringify(withFallback), firmId, userId, today]);
      } catch(e) { console.error('[viktor-chat] Claude fallback error:', e.message); }
    });

    res.json({ stored: true, pending_reply: true, messages: newMessages });
  } catch (err) {
    console.error('[viktor-chat] POST /message error:', err);
    res.status(500).json({ error: err.message || 'Failed to send message' });
  }
});

// Helper: build a concise text summary of context for Claude
function buildContextSummary(ctx) {
  if (!ctx || !ctx.firm_summary) return 'No firm data available.';
  const s = ctx.firm_summary;
  let summary = `FIRM OVERVIEW: ${s.total_relationships || 0} relationships, ${s.total_people || 0} people, ${s.total_companies || 0} companies. Open threads: ${s.open_threads || 0}. Signed MRR: $${parseFloat(s.signed_mrr || 0).toLocaleString()}.\n\n`;

  const urgent = ctx.urgent || {};
  if (urgent.unsigned_tax_returns?.length) {
    summary += `UNSIGNED TAX RETURNS (${urgent.unsigned_tax_returns.length}):\n`;
    urgent.unsigned_tax_returns.slice(0, 10).forEach(r => {
      summary += `- ${r.company_name || r.person_name || 'Unknown'} — ${r.tax_year} return, ${r.days_waiting} days waiting (status: ${r.status})\n`;
    });
    summary += '\n';
  }

  if (urgent.stalled_messages?.length) {
    summary += `STALLED MESSAGES (${urgent.stalled_messages.length} threads with no reply 48h+):\n`;
    urgent.stalled_messages.slice(0, 5).forEach(m => {
      summary += `- ${m.person_name || 'Unknown'}: "${m.subject}" — ${m.days_since} days since last message\n`;
    });
    summary += '\n';
  }

  if (urgent.open_proposals?.length) {
    summary += `OPEN PROPOSALS (${urgent.open_proposals.length}):\n`;
    urgent.open_proposals.slice(0, 5).forEach(p => {
      summary += `- ${p.client_name} — ${p.engagement_type} proposal, ${p.days_old} days old (${p.status})\n`;
    });
    summary += '\n';
  }

  const pipeline = ctx.pipeline || {};
  if (pipeline.total_active) {
    summary += `PIPELINE: ${pipeline.total_active} active jobs\n`;
    const stages = pipeline.by_stage || {};
    Object.entries(stages).slice(0, 8).forEach(([stage, jobs]) => {
      summary += `- ${stage}: ${jobs.length} jobs`;
      const names = jobs.slice(0, 3).map(j => j.company_name || j.person_name || 'Unknown').join(', ');
      if (names) summary += ` (${names}${jobs.length > 3 ? '...' : ''})`;
      summary += '\n';
    });
    summary += '\n';
  }

  const needs = ctx.needs_attention || {};
  if (needs.birthdays_this_month?.length) {
    const today = needs.birthdays_this_month.filter(b => b.is_today);
    if (today.length) summary += `BIRTHDAYS TODAY: ${today.map(b => b.name).join(', ')}\n\n`;
  }

  if (needs.new_clients_no_pipeline?.length) {
    summary += `NEW CLIENTS WITHOUT PIPELINE (${needs.new_clients_no_pipeline.length}): ${needs.new_clients_no_pipeline.map(r => r.name).join(', ')}\n\n`;
  }

  summary += `\nNOTE: For engagement letter/billing details on a specific client, call GET /api/viktor/relationship/:id or GET /api/viktor/engagement-letters. For full message history, call GET /api/viktor/messages/:threadId.`;

  return summary;
}

// GET /api/viktor-chat/session-for/:userId — Viktor reads a staff member's current session and messages
router.get('/session-for/:userId', async (req, res) => {
  const firmId = req.firm.id;
  const targetUserId = parseInt(req.params.userId);
  if (!targetUserId) return res.status(400).json({ error: 'userId is required' });

  try {
    const { rows: userRows } = await pool.query(
      'SELECT id, name FROM firm_users WHERE id = $1 AND firm_id = $2 AND accepted_at IS NOT NULL',
      [targetUserId, firmId]
    );
    if (!userRows[0]) return res.status(404).json({ error: 'Staff user not found' });

    const today = new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      'SELECT * FROM viktor_sessions WHERE firm_id = $1 AND user_id = $2 AND session_date = $3',
      [firmId, targetUserId, today]
    );

    res.json({
      user: userRows[0].name,
      user_id: targetUserId,
      session_date: today,
      messages: rows[0]?.messages || [],
      briefing_generated: rows[0]?.briefing_generated || false,
    });
  } catch (err) {
    console.error('[viktor-chat] GET /session-for error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// POST /api/viktor-chat/reply-for/:userId — Viktor injects a reply into a staff member's chat
router.post('/reply-for/:userId', async (req, res) => {
  const firmId = req.firm.id;
  const targetUserId = parseInt(req.params.userId);
  if (!targetUserId) return res.status(400).json({ error: 'userId is required' });

  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });

  try {
    const { rows: userRows } = await pool.query(
      'SELECT id, name FROM firm_users WHERE id = $1 AND firm_id = $2 AND accepted_at IS NOT NULL',
      [targetUserId, firmId]
    );
    if (!userRows[0]) return res.status(404).json({ error: 'Staff user not found' });

    const today = new Date().toISOString().split('T')[0];

    // Get existing session messages
    const { rows: sessions } = await pool.query(
      'SELECT * FROM viktor_sessions WHERE firm_id = $1 AND user_id = $2 AND session_date = $3',
      [firmId, targetUserId, today]
    );
    const history = sessions[0]?.messages || [];

    const newMsg = { role: 'assistant', content: message.trim(), timestamp: new Date().toISOString(), from: 'viktor' };
    const newMessages = [...history, newMsg];

    await pool.query(
      `INSERT INTO viktor_sessions (firm_id, user_id, session_date, messages)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firm_id, user_id, session_date)
       DO UPDATE SET messages = $4, updated_at = NOW()`,
      [firmId, targetUserId, today, JSON.stringify(newMessages)]
    );

    res.json({ ok: true, user: userRows[0].name, message_count: newMessages.length });
  } catch (err) {
    console.error('[viktor-chat] POST /reply-for error:', err);
    res.status(500).json({ error: 'Failed to inject reply' });
  }
});

// POST /api/viktor-chat/briefing-for/:userId — Viktor pushes a briefing into a specific staff member's session
// Accepts API token auth (Viktor can call this with his dlk_ token)
// userId is the firm_users.id of the staff member to brief
router.post('/briefing-for/:userId', async (req, res) => {
  const firmId = req.firm.id;
  const targetUserId = parseInt(req.params.userId);
  if (!targetUserId) return res.status(400).json({ error: 'userId is required' });

  try {
    // Verify the target user belongs to this firm
    const { rows: userRows } = await pool.query(
      'SELECT id, name FROM firm_users WHERE id = $1 AND firm_id = $2 AND accepted_at IS NOT NULL',
      [targetUserId, firmId]
    );
    if (!userRows[0]) return res.status(404).json({ error: 'Staff user not found' });
    const targetUser = userRows[0];

    const today = new Date().toISOString().split('T')[0];

    // Check if already generated today for this user
    const { rows: existing } = await pool.query(
      'SELECT * FROM viktor_sessions WHERE firm_id = $1 AND user_id = $2 AND session_date = $3',
      [firmId, targetUserId, today]
    );
    if (existing[0]?.briefing_generated) {
      return res.json({ already_generated: true, messages: existing[0].messages, user: targetUser.name });
    }

    // Fetch firm context directly (no HTTP round-trip)
    const context = await getFirmContext(firmId).catch(() => ({}));
    const contextSummary = buildContextSummary(context);

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: await buildSystemPrompt(firmId),
      messages: [{
        role: 'user',
        content: `${greeting}, ${targetUser.name}. Generate a personalized daily briefing for today (${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}).\n\nYou are briefing: ${targetUser.name}\n\nCurrent firm data:\n${contextSummary}\n\nProvide a concise, actionable morning briefing with prioritized tasks for ${targetUser.name}. Be specific — use real client names and numbers from the data above.`
      }]
    });

    const briefingText = response.content[0]?.text || 'Unable to generate briefing.';
    const messages = [
      { role: 'assistant', content: briefingText, timestamp: new Date().toISOString() }
    ];

    await pool.query(
      `INSERT INTO viktor_sessions (firm_id, user_id, session_date, messages, briefing_generated)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (firm_id, user_id, session_date)
       DO UPDATE SET messages = $4, briefing_generated = TRUE, updated_at = NOW()`,
      [firmId, targetUserId, today, JSON.stringify(messages)]
    );

    res.json({ ok: true, user: targetUser.name, messages });
  } catch (err) {
    console.error('[viktor-chat] POST /briefing-for error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate briefing' });
  }
});

// ===================== VIKTOR CONTEXT PROMPT =====================

// PUT /api/viktor-chat/context — Viktor pushes the firm context prompt (API token auth)
router.put('/context', async (req, res) => {
  const firmId = req.firm.id;
  const { context, updated_at } = req.body;
  if (!context || !context.trim()) return res.status(400).json({ error: 'context is required' });
  try {
    await pool.query(
      `INSERT INTO viktor_context (firm_id, context, updated_at, updated_by)
       VALUES ($1, $2, $3, 'viktor')
       ON CONFLICT (firm_id)
       DO UPDATE SET context = $2, updated_at = $3, updated_by = 'viktor'`,
      [firmId, context.trim(), updated_at || new Date().toISOString()]
    );
    res.json({ ok: true, updated_at: updated_at || new Date().toISOString() });
  } catch (err) {
    console.error('[viktor-chat] PUT /context error:', err);
    res.status(500).json({ error: 'Failed to store context' });
  }
});

// GET /api/viktor-chat/context — Viktor reads back what's live (API token auth)
router.get('/context', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      'SELECT context, updated_at, updated_by FROM viktor_context WHERE firm_id = $1',
      [firmId]
    );
    if (!rows[0]) return res.json({ context: null, updated_at: null });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch context' });
  }
});

module.exports = router;
