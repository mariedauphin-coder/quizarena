'use strict';

const express = require('express');
const { customAlphabet } = require('nanoid');
const db = require('../db');
const { requireRole, requireAuth } = require('../middleware/auth');

const router = express.Router();
const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

/* -------- Public: list CS fields (for the student dashboard) -------- */
router.get('/fields', (_req, res) => {
  const fields = db.prepare('SELECT * FROM fields ORDER BY name').all();
  // attach a count of published practice quizzes per field
  const counts = db
    .prepare(
      `SELECT field_id, COUNT(*) n FROM quizzes
        WHERE published = 1 GROUP BY field_id`
    )
    .all();
  const map = new Map(counts.map((c) => [c.field_id, c.n]));
  res.json({ fields: fields.map((f) => ({ ...f, quiz_count: map.get(f.id) || 0 })) });
});

/* -------- Public: published practice quizzes in a field -------- */
router.get('/fields/:slug/quizzes', (req, res) => {
  const field = db.prepare('SELECT * FROM fields WHERE slug = ?').get(req.params.slug);
  if (!field) return res.status(404).json({ error: 'Unknown field.' });
  const quizzes = db
    .prepare(
      `SELECT q.id, q.title, q.description, q.duration_min, q.pass_pct,
              (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count
         FROM quizzes q
        WHERE q.field_id = ? AND q.published = 1
        ORDER BY q.created_at DESC`
    )
    .all(field.id);
  res.json({ field, quizzes });
});

/* ================= Teacher: manage quizzes ================= */

router.get('/mine', requireRole('teacher', 'admin'), (req, res) => {
  const quizzes = db
    .prepare(
      `SELECT q.*, f.name AS field_name,
              (SELECT COUNT(*) FROM questions WHERE quiz_id = q.id) AS question_count
         FROM quizzes q LEFT JOIN fields f ON f.id = q.field_id
        WHERE q.owner_id = ? ORDER BY q.created_at DESC`
    )
    .all(req.user.id);
  res.json({ quizzes });
});

router.post('/', requireRole('teacher', 'admin'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'A title is required.' });
  const info = db
    .prepare(
      `INSERT INTO quizzes
        (owner_id, field_id, title, description, mode, duration_min,
         shuffle_q, shuffle_opts, max_violations, fail_on_violation, pass_pct, published)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      req.user.id,
      b.field_id || null,
      b.title,
      b.description || '',
      b.mode === 'live' ? 'live' : 'practice',
      clampInt(b.duration_min, 1, 300, 20),
      b.shuffle_q ? 1 : 0,
      b.shuffle_opts ? 1 : 0,
      clampInt(b.max_violations, 0, 10, 0),
      b.fail_on_violation === false ? 0 : 1,
      clampInt(b.pass_pct, 0, 100, 50),
      b.published ? 1 : 0
    );
  res.json({ quiz: getFullQuiz(info.lastInsertRowid) });
});

router.get('/:id', requireAuth, (req, res) => {
  const quiz = getFullQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
  // teachers see the full quiz incl. answers; others must not hit this route for taking
  if (req.user.role === 'student' && quiz.owner_id !== req.user.id) {
    stripAnswers(quiz);
  }
  res.json({ quiz });
});

router.put('/:id', requireRole('teacher', 'admin'), (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz || quiz.owner_id !== req.user.id)
    return res.status(404).json({ error: 'Quiz not found.' });
  const b = req.body || {};
  db.prepare(
    `UPDATE quizzes SET
       field_id=?, title=?, description=?, mode=?, duration_min=?,
       shuffle_q=?, shuffle_opts=?, max_violations=?, fail_on_violation=?, pass_pct=?, published=?
     WHERE id=?`
  ).run(
    b.field_id ?? quiz.field_id,
    b.title ?? quiz.title,
    b.description ?? quiz.description,
    b.mode === 'live' ? 'live' : b.mode === 'practice' ? 'practice' : quiz.mode,
    clampInt(b.duration_min, 1, 300, quiz.duration_min),
    b.shuffle_q != null ? (b.shuffle_q ? 1 : 0) : quiz.shuffle_q,
    b.shuffle_opts != null ? (b.shuffle_opts ? 1 : 0) : quiz.shuffle_opts,
    b.max_violations != null ? clampInt(b.max_violations, 0, 10, 0) : quiz.max_violations,
    b.fail_on_violation != null ? (b.fail_on_violation ? 1 : 0) : quiz.fail_on_violation,
    b.pass_pct != null ? clampInt(b.pass_pct, 0, 100, 50) : quiz.pass_pct,
    b.published != null ? (b.published ? 1 : 0) : quiz.published,
    quiz.id
  );
  res.json({ quiz: getFullQuiz(quiz.id) });
});

router.delete('/:id', requireRole('teacher', 'admin'), (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz || quiz.owner_id !== req.user.id)
    return res.status(404).json({ error: 'Quiz not found.' });
  db.prepare('DELETE FROM quizzes WHERE id = ?').run(quiz.id);
  res.json({ ok: true });
});

/* -------- Questions -------- */
router.post('/:id/questions', requireRole('teacher', 'admin'), (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz || quiz.owner_id !== req.user.id)
    return res.status(404).json({ error: 'Quiz not found.' });
  const b = req.body || {};
  if (!['mcq', 'detailed'].includes(b.type))
    return res.status(400).json({ error: 'Invalid question type.' });
  if (!b.prompt) return res.status(400).json({ error: 'Question prompt required.' });

  const ord =
    (db.prepare('SELECT MAX(ordinal) m FROM questions WHERE quiz_id = ?').get(quiz.id).m || 0) + 1;

  let options = null;
  let correct = null;
  if (b.type === 'mcq') {
    if (!Array.isArray(b.options) || b.options.length < 2)
      return res.status(400).json({ error: 'MCQ needs at least two options.' });
    if (typeof b.correct !== 'number' || b.correct < 0 || b.correct >= b.options.length)
      return res.status(400).json({ error: 'Select which option is correct.' });
    options = JSON.stringify(b.options);
    correct = JSON.stringify(b.correct);
  } else {
    correct = JSON.stringify({ model: b.model || '', keywords: b.keywords || [] });
  }

  const info = db
    .prepare(
      `INSERT INTO questions (quiz_id, ordinal, type, prompt, options, correct, points)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(quiz.id, ord, b.type, b.prompt, options, correct, clampInt(b.points, 1, 100, 1));
  res.json({ question: db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid) });
});

router.delete('/:id/questions/:qid', requireRole('teacher', 'admin'), (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz || quiz.owner_id !== req.user.id)
    return res.status(404).json({ error: 'Quiz not found.' });
  db.prepare('DELETE FROM questions WHERE id = ? AND quiz_id = ?').run(req.params.qid, quiz.id);
  res.json({ ok: true });
});

/* ================= Live sessions ================= */

router.post('/:id/sessions', requireRole('teacher', 'admin'), (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz || quiz.owner_id !== req.user.id)
    return res.status(404).json({ error: 'Quiz not found.' });
  if (db.prepare('SELECT COUNT(*) c FROM questions WHERE quiz_id = ?').get(quiz.id).c === 0)
    return res.status(400).json({ error: 'Add at least one question before starting a live session.' });

  let code;
  do { code = makeCode(); }
  while (db.prepare("SELECT 1 FROM live_sessions WHERE join_code = ? AND status != 'ended'").get(code));

  const info = db
    .prepare(
      `INSERT INTO live_sessions (quiz_id, host_id, join_code, status)
       VALUES (?, ?, ?, 'lobby')`
    )
    .run(quiz.id, req.user.id, code);
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(info.lastInsertRowid);
  res.json({ session });
});

/* Results for a live session (teacher). */
router.get('/sessions/:sid/results', requireRole('teacher', 'admin'), (req, res) => {
  const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(req.params.sid);
  if (!session || session.host_id !== req.user.id)
    return res.status(404).json({ error: 'Session not found.' });
  const attempts = db
    .prepare(
      `SELECT id, student_id, display_name, status, violations, score, max_score, grade,
              started_at, submitted_at
         FROM attempts WHERE session_id = ? ORDER BY grade, display_name`
    )
    .all(session.id);
  res.json({ session, attempts });
});

/* Teacher override of a single answer's awarded points, then re-total. */
router.post('/attempts/:aid/regrade', requireRole('teacher', 'admin'), (req, res) => {
  const { answers } = req.body || {}; // [{answer_id, awarded}]
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(req.params.aid);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  const upd = db.prepare('UPDATE answers SET awarded = ?, is_correct = ? WHERE id = ? AND attempt_id = ?');
  const tx = db.transaction(() => {
    for (const a of answers || []) {
      upd.run(Number(a.awarded) || 0, a.awarded > 0 ? 1 : 0, a.answer_id, attempt.id);
    }
  });
  tx();
  const total = db
    .prepare('SELECT COALESCE(SUM(awarded),0) s FROM answers WHERE attempt_id = ?')
    .get(attempt.id).s;
  const { letterGrade } = require('../grading');
  const pct = attempt.max_score ? (total / attempt.max_score) * 100 : 0;
  const grade = attempt.status === 'flagged' ? 'F' : letterGrade(pct);
  db.prepare('UPDATE attempts SET score = ?, grade = ?, status = ? WHERE id = ?')
    .run(Math.round(total * 100) / 100, grade, attempt.status === 'flagged' ? 'flagged' : 'graded', attempt.id);
  res.json({ ok: true, score: total, grade });
});

/* Detailed answers of one attempt (for review). */
router.get('/attempts/:aid', requireRole('teacher', 'admin'), (req, res) => {
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(req.params.aid);
  if (!attempt) return res.status(404).json({ error: 'Attempt not found.' });
  const rows = db
    .prepare(
      `SELECT a.id AS answer_id, a.response, a.is_correct, a.awarded,
              q.prompt, q.type, q.points, q.options, q.correct
         FROM answers a JOIN questions q ON q.id = a.question_id
        WHERE a.attempt_id = ? ORDER BY q.ordinal`
    )
    .all(attempt.id);
  res.json({ attempt, answers: rows });
});

/* ================= Practice attempts ================= */

/* Start / fetch a practice quiz (answers stripped). */
router.get('/:id/take', requireAuth, (req, res) => {
  const quiz = getFullQuiz(req.params.id);
  if (!quiz || !quiz.published)
    return res.status(404).json({ error: 'Quiz not available.' });
  stripAnswers(quiz);
  if (quiz.shuffle_q) shuffle(quiz.questions);
  if (quiz.shuffle_opts) {
    for (const q of quiz.questions) if (q.options) shuffleOptions(q);
  }
  res.json({ quiz });
});

/* Submit a practice attempt. */
router.post('/:id/submit', requireAuth, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(req.params.id);
  if (!quiz || !quiz.published) return res.status(404).json({ error: 'Quiz not available.' });
  const responses = (req.body && req.body.responses) || {}; // {questionId: value}

  const attemptInfo = db
    .prepare(
      `INSERT INTO attempts (quiz_id, user_id, student_id, display_name, status)
       VALUES (?, ?, ?, ?, 'in_progress')`
    )
    .run(quiz.id, req.user.id, req.user.student_id || null, req.user.name);
  const attemptId = attemptInfo.lastInsertRowid;

  const ins = db.prepare(
    'INSERT OR REPLACE INTO answers (attempt_id, question_id, response) VALUES (?,?,?)'
  );
  const questions = db.prepare('SELECT id FROM questions WHERE quiz_id = ?').all(quiz.id);
  const valid = new Set(questions.map((q) => q.id));
  for (const [qid, val] of Object.entries(responses)) {
    if (valid.has(Number(qid))) ins.run(attemptId, Number(qid), JSON.stringify(val));
  }

  const { gradeAttempt } = require('../grading');
  const result = gradeAttempt(db, attemptId, false);
  res.json({ result, attempt_id: attemptId });
});

/* ---------- helpers ---------- */
function getFullQuiz(id) {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id);
  if (!quiz) return null;
  quiz.questions = db
    .prepare('SELECT * FROM questions WHERE quiz_id = ? ORDER BY ordinal')
    .all(quiz.id)
    .map((q) => ({ ...q, options: q.options ? JSON.parse(q.options) : null }));
  return quiz;
}
function stripAnswers(quiz) {
  for (const q of quiz.questions || []) delete q.correct;
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
function shuffleOptions(q) {
  // keep options only (correct index stripped already for takers)
  shuffle(q.options);
}

module.exports = router;
module.exports.getFullQuiz = getFullQuiz;
