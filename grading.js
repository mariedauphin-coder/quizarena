'use strict';

/**
 * Grading helpers.
 * - MCQ questions are auto-graded (exact match on the chosen index).
 * - Detailed questions get a provisional keyword-overlap score so students
 *   see an immediate result, but they are marked for teacher review
 *   (teachers can override any score in the results view).
 */

function letterGrade(pct) {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

function gradeDetailed(responseText, correctSpec) {
  const text = String(responseText || '').toLowerCase();
  if (!text.trim()) return 0;
  let keywords = [];
  try {
    const spec = typeof correctSpec === 'string' ? JSON.parse(correctSpec) : correctSpec;
    keywords = (spec && spec.keywords) || [];
  } catch (_e) {
    keywords = [];
  }
  if (keywords.length === 0) return 0.5; // no rubric → provisional half credit pending review
  const hits = keywords.filter((k) => text.includes(String(k).toLowerCase())).length;
  return Math.min(1, hits / Math.ceil(keywords.length / 2)); // fraction 0..1
}

/**
 * Grade a full attempt.
 * @param {object} db
 * @param {number} attemptId
 * @param {boolean} forceFail  when true (proctor violation) → score 0, grade 'F'
 */
function gradeAttempt(db, attemptId, forceFail = false) {
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!attempt) return null;

  const questions = db
    .prepare('SELECT * FROM questions WHERE quiz_id = ?')
    .all(attempt.quiz_id);
  const answers = db
    .prepare('SELECT * FROM answers WHERE attempt_id = ?')
    .all(attemptId);
  const byQ = new Map(answers.map((a) => [a.question_id, a]));

  let maxScore = 0;
  let score = 0;
  let needsReview = false;

  const updateAnswer = db.prepare(
    'UPDATE answers SET is_correct = ?, awarded = ? WHERE id = ?'
  );

  for (const q of questions) {
    maxScore += q.points;
    const a = byQ.get(q.id);
    if (!a) continue;

    if (forceFail) {
      updateAnswer.run(0, 0, a.id);
      continue;
    }

    if (q.type === 'mcq') {
      let chosen = null;
      try { chosen = JSON.parse(a.response); } catch (_e) {}
      let correctIdx = null;
      try { correctIdx = JSON.parse(q.correct); } catch (_e) {}
      const ok = chosen !== null && chosen === correctIdx;
      const awarded = ok ? q.points : 0;
      updateAnswer.run(ok ? 1 : 0, awarded, a.id);
      score += awarded;
    } else {
      needsReview = true;
      let respText = a.response;
      try { respText = JSON.parse(a.response); } catch (_e) {}
      const frac = gradeDetailed(respText, q.correct);
      const awarded = Math.round(frac * q.points * 100) / 100;
      updateAnswer.run(null, awarded, a.id); // is_correct null = pending review
      score += awarded;
    }
  }

  let finalScore = forceFail ? 0 : Math.round(score * 100) / 100;
  const pct = maxScore > 0 ? (finalScore / maxScore) * 100 : 0;
  const grade = forceFail ? 'F' : letterGrade(pct);
  const status = forceFail ? 'flagged' : needsReview ? 'submitted' : 'graded';

  db.prepare(
    `UPDATE attempts
       SET score = ?, max_score = ?, grade = ?, status = ?, submitted_at = datetime('now')
     WHERE id = ?`
  ).run(finalScore, maxScore, grade, status, attemptId);

  return { score: finalScore, maxScore, pct: Math.round(pct * 10) / 10, grade, status, needsReview };
}

module.exports = { letterGrade, gradeDetailed, gradeAttempt };
