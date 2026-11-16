'use strict';

/**
 * Realtime engine for LIVE proctored quizzes (Socket.IO).
 *
 * Rooms:
 *   host:<sessionId>     — the teacher hosting
 *   session:<sessionId>  — all students in that session
 *
 * Flow:
 *   student -> student:join {code, studentId, name}
 *   host    -> host:open {sessionId}
 *   host    -> host:start {sessionId}   → server emits quiz:start with questions
 *   student -> student:answer {questionId, value}   (autosaved)
 *   student -> student:violation {reason}  → server records; if fail_on_violation → quiz:failed
 *   student -> student:submit            → server grades → quiz:result
 *   host    -> host:end {sessionId}
 */

const db = require('../db');
const { gradeAttempt } = require('../grading');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQuizPayload(quiz) {
  let questions = db
    .prepare('SELECT id, ordinal, type, prompt, options, points FROM questions WHERE quiz_id = ? ORDER BY ordinal')
    .all(quiz.id)
    .map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      points: q.points,
      options: q.options ? JSON.parse(q.options) : null,
    }));
  if (quiz.shuffle_q) questions = shuffle(questions);
  if (quiz.shuffle_opts) {
    for (const q of questions) if (q.options) q.options = shuffle([...q.options]);
  }
  return {
    id: quiz.id,
    title: quiz.title,
    duration_min: quiz.duration_min,
    fail_on_violation: quiz.fail_on_violation,
    max_violations: quiz.max_violations,
    questions,
  };
}

function rosterFor(sessionId) {
  return db
    .prepare(
      `SELECT id, student_id, display_name, status, violations, grade, score, max_score
         FROM attempts WHERE session_id = ? ORDER BY started_at`
    )
    .all(sessionId);
}

module.exports = function attachLive(io) {
  io.on('connection', (socket) => {
    /* ---------------- Teacher hosting ---------------- */
    socket.on('host:open', ({ sessionId }, cb) => {
      const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
      if (!session) return cb && cb({ error: 'Session not found.' });
      socket.join(`host:${sessionId}`);
      socket.data.hostSession = sessionId;
      cb && cb({ session, roster: rosterFor(sessionId) });
    });

    socket.on('host:start', ({ sessionId }) => {
      const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
      if (!session) return;
      const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(session.quiz_id);
      db.prepare("UPDATE live_sessions SET status='running', started_at=datetime('now') WHERE id=?").run(sessionId);
      // Each student may get shuffled order, so build per-socket on emit:
      const room = io.sockets.adapter.rooms.get(`session:${sessionId}`) || new Set();
      for (const sid of room) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit('quiz:start', { quiz: buildQuizPayload(quiz), startedAt: Date.now() });
      }
      io.to(`host:${sessionId}`).emit('host:started', { roster: rosterFor(sessionId) });
    });

    socket.on('host:end', ({ sessionId }) => {
      const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
      if (!session) return;
      db.prepare("UPDATE live_sessions SET status='ended', ended_at=datetime('now') WHERE id=?").run(sessionId);
      // auto-submit anyone still in progress
      const open = db.prepare("SELECT id FROM attempts WHERE session_id=? AND status='in_progress'").all(sessionId);
      for (const a of open) gradeAttempt(db, a.id, false);
      io.to(`session:${sessionId}`).emit('quiz:ended', {});
      io.to(`host:${sessionId}`).emit('host:ended', { roster: rosterFor(sessionId) });
    });

    /* ---------------- Student ---------------- */
    socket.on('student:join', ({ code, studentId, name }, cb) => {
      code = String(code || '').trim().toUpperCase();
      studentId = String(studentId || '').trim();
      if (!/^\d+$/.test(studentId))
        return cb && cb({ error: 'Student ID must be digits only.' });

      const session = db
        .prepare("SELECT * FROM live_sessions WHERE join_code = ? AND status != 'ended'")
        .get(code);
      if (!session) return cb && cb({ error: 'No active session with that code.' });
      if (session.status === 'running')
        return cb && cb({ error: 'This quiz has already started — you can no longer join.' });

      // one attempt per student per session
      let attempt = db
        .prepare('SELECT * FROM attempts WHERE session_id = ? AND student_id = ?')
        .get(session.id, studentId);
      if (!attempt) {
        const linked = db.prepare('SELECT id FROM users WHERE student_id = ?').get(studentId);
        const info = db
          .prepare(
            `INSERT INTO attempts (quiz_id, session_id, user_id, student_id, display_name, status)
             VALUES (?, ?, ?, ?, ?, 'in_progress')`
          )
          .run(session.quiz_id, session.id, linked ? linked.id : null, studentId, name || `#${studentId}`);
        attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(info.lastInsertRowid);
      }

      socket.join(`session:${session.id}`);
      socket.data.sessionId = session.id;
      socket.data.attemptId = attempt.id;
      socket.data.studentId = studentId;

      cb && cb({ ok: true, sessionId: session.id, attemptId: attempt.id, status: session.status });
      io.to(`host:${session.id}`).emit('host:roster', { roster: rosterFor(session.id) });
    });

    socket.on('student:answer', ({ questionId, value }) => {
      const attemptId = socket.data.attemptId;
      if (!attemptId) return;
      const att = db.prepare("SELECT status FROM attempts WHERE id=?").get(attemptId);
      if (!att || att.status !== 'in_progress') return;
      const valid = db.prepare('SELECT 1 FROM questions WHERE id = ? AND quiz_id = (SELECT quiz_id FROM attempts WHERE id=?)').get(questionId, attemptId);
      if (!valid) return;
      db.prepare(
        'INSERT OR REPLACE INTO answers (attempt_id, question_id, response) VALUES (?,?,?)'
      ).run(attemptId, questionId, JSON.stringify(value));
    });

    /* The heart of the anti-cheat contract: a reported violation.
       kind 'clipboard' (copy/cut/paste) is flagged but NOT auto-failed —
       the teacher must confirm the F. All other kinds follow the auto-F rule. */
    socket.on('student:violation', ({ reason, kind }) => {
      const attemptId = socket.data.attemptId;
      const sessionId = socket.data.sessionId;
      if (!attemptId) return;
      const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt || attempt.status !== 'in_progress') return;
      const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(attempt.quiz_id);

      const violations = attempt.violations + 1;
      db.prepare('UPDATE attempts SET violations = ? WHERE id = ?').run(violations, attemptId);

      if (kind === 'clipboard') {
        // Needs teacher validation — do not fail automatically.
        socket.emit('quiz:warning', {
          reason: reason || 'Copy/paste attempted',
          violations,
          allowed: quiz.max_violations,
          pendingReview: true,
        });
        io.to(`host:${sessionId}`).emit('host:roster', { roster: rosterFor(sessionId) });
        io.to(`host:${sessionId}`).emit('host:review', {
          attempt_id: attempt.id,
          student_id: attempt.student_id,
          display_name: attempt.display_name,
          reason: reason || 'Copy/paste attempted',
          violations,
        });
        return;
      }

      const exceeded = violations > quiz.max_violations;
      if (quiz.fail_on_violation && exceeded) {
        gradeAttempt(db, attemptId, true); // force F
        socket.emit('quiz:failed', {
          reason: reason || 'Proctoring rule violated',
          grade: 'F',
        });
      } else {
        socket.emit('quiz:warning', {
          reason: reason || 'Proctoring rule violated',
          violations,
          allowed: quiz.max_violations,
        });
      }
      io.to(`host:${sessionId}`).emit('host:roster', { roster: rosterFor(sessionId) });
      io.to(`host:${sessionId}`).emit('host:violation', {
        student_id: attempt.student_id,
        reason,
        violations,
        failed: quiz.fail_on_violation && exceeded,
      });
    });

    /* Teacher confirms the F on a flagged (clipboard) attempt. */
    socket.on('host:confirm_fail', ({ attemptId, reason }) => {
      const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt || attempt.status !== 'in_progress') return;
      gradeAttempt(db, attemptId, true); // force F
      io.to(`session:${attempt.session_id}`).emit('quiz:failed', {
        attemptId: attempt.id,
        reason: reason || 'Copy/paste violation confirmed by your teacher',
        grade: 'F',
      });
      io.to(`host:${attempt.session_id}`).emit('host:roster', { roster: rosterFor(attempt.session_id) });
    });

    /* Teacher dismisses a flag — the student continues. */
    socket.on('host:dismiss_flag', ({ attemptId }) => {
      const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt) return;
      io.to(`session:${attempt.session_id}`).emit('quiz:flag_dismissed', { attemptId: attempt.id });
    });

    socket.on('student:submit', (_data, cb) => {
      const attemptId = socket.data.attemptId;
      const sessionId = socket.data.sessionId;
      if (!attemptId) return cb && cb({ error: 'No attempt.' });
      const attempt = db.prepare('SELECT status FROM attempts WHERE id = ?').get(attemptId);
      if (!attempt || attempt.status !== 'in_progress')
        return cb && cb({ error: 'Attempt already closed.' });
      const result = gradeAttempt(db, attemptId, false);
      socket.emit('quiz:result', result);
      cb && cb({ result });
      io.to(`host:${sessionId}`).emit('host:roster', { roster: rosterFor(sessionId) });
    });

    socket.on('disconnect', () => {
      const sessionId = socket.data.sessionId;
      if (sessionId) io.to(`host:${sessionId}`).emit('host:roster', { roster: rosterFor(sessionId) });
    });
  });
};
