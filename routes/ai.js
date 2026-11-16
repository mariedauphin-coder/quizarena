'use strict';

/**
 * AI question generation.
 *
 * POST /api/ai/generate  (teacher only)
 *   body: { subject, topic, count, type: 'mcq'|'detailed'|'mixed', difficulty }
 *   -> { questions: [ ... ] }  (NOT yet saved; the teacher reviews and adds)
 *
 * Uses the Anthropic Messages API via the built-in fetch (Node 18+).
 * Configure with environment variables:
 *   AI_API_KEY   - your Anthropic API key (required to enable the feature)
 *   AI_MODEL     - optional, defaults to a fast, inexpensive model
 *
 * If AI_API_KEY is not set, the endpoint reports that AI generation is
 * disabled, and the rest of the app keeps working normally.
 */

const express = require('express');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const API_KEY = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';

/* Is the feature switched on? The front-end asks this to show/hide the button. */
router.get('/status', requireRole('teacher', 'admin'), (_req, res) => {
  res.json({ enabled: Boolean(API_KEY), model: API_KEY ? MODEL : null });
});

router.post('/generate', requireRole('teacher', 'admin'), async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      error: 'AI generation is not configured. Set AI_API_KEY on the server to enable it.',
    });
  }

  const b = req.body || {};
  const subject = String(b.subject || '').trim() || 'General knowledge';
  const topic = String(b.topic || '').trim();
  const count = Math.min(10, Math.max(1, parseInt(b.count, 10) || 5));
  const type = ['mcq', 'detailed', 'mixed'].includes(b.type) ? b.type : 'mcq';
  const difficulty = ['easy', 'medium', 'hard'].includes(b.difficulty) ? b.difficulty : 'medium';

  const typeInstruction =
    type === 'mcq'
      ? 'All questions must be multiple-choice ("mcq") with exactly 4 options.'
      : type === 'detailed'
      ? 'All questions must be open/written ("detailed") questions with no options.'
      : 'Mix multiple-choice ("mcq", 4 options each) and written ("detailed") questions.';

  const prompt = [
    `You are helping a teacher build an exam. Generate ${count} ${difficulty} quiz questions`,
    `for the subject "${subject}"${topic ? ` focused on the topic "${topic}"` : ''}.`,
    typeInstruction,
    '',
    'Return ONLY a JSON array (no prose, no markdown fences). Each element is an object:',
    'For an MCQ: {"type":"mcq","prompt":"...","options":["A","B","C","D"],"correct":<index 0-3>,"points":1}',
    'For a written question: {"type":"detailed","prompt":"...","keywords":["key","terms","for","grading"],"points":3}',
    'Make exactly one option correct for each MCQ. Keep prompts clear and unambiguous.',
  ].join('\n');

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[ai] API error', resp.status, detail.slice(0, 300));
      return res.status(502).json({ error: `AI service error (${resp.status}). Check the API key and model.` });
    }

    const data = await resp.json();
    const text = (data.content || []).map((p) => p.text || '').join('').trim();
    const questions = parseQuestions(text);
    if (!questions.length) {
      return res.status(502).json({ error: 'The AI returned no usable questions. Try again.' });
    }
    res.json({ questions });
  } catch (e) {
    console.error('[ai] request failed', e.message);
    res.status(502).json({ error: 'Could not reach the AI service.' });
  }
});

/* Pull a clean question array out of the model's reply, tolerating stray text or fences. */
function parseQuestions(text) {
  let raw = text;
  // strip markdown code fences if present
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1];
  // grab the outermost array
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  let arr;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch (_e) {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const clean = [];
  for (const q of arr) {
    if (!q || typeof q.prompt !== 'string') continue;
    const type = q.type === 'detailed' ? 'detailed' : 'mcq';
    const points = Math.min(100, Math.max(1, parseInt(q.points, 10) || (type === 'detailed' ? 3 : 1)));
    if (type === 'mcq') {
      if (!Array.isArray(q.options) || q.options.length < 2) continue;
      const options = q.options.map((o) => String(o)).slice(0, 6);
      let correct = parseInt(q.correct, 10);
      if (Number.isNaN(correct) || correct < 0 || correct >= options.length) correct = 0;
      clean.push({ type, prompt: String(q.prompt), options, correct, points });
    } else {
      const keywords = Array.isArray(q.keywords) ? q.keywords.map((k) => String(k)).slice(0, 12) : [];
      clean.push({ type, prompt: String(q.prompt), keywords, points });
    }
  }
  return clean.slice(0, 10);
}

module.exports = router;
