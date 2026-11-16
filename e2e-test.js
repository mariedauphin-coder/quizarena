/* In-process end-to-end test: requires the server, then drives it. */
process.env.PORT = '3599';
process.env.DATA_DIR = '/tmp/qa-test-data';
delete process.env.AI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
require('fs').rmSync('/tmp/qa-test-data', { recursive: true, force: true });

const { io } = require('socket.io-client');
const http = require('http');
require('./server'); // starts listening on 3599

const BASE = 'localhost', PORT = 3599, URL = `http://localhost:${PORT}`;
function api(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: BASE, port: PORT, path, method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { let parsed = null; try { parsed = b ? JSON.parse(b) : null; } catch (_e) { parsed = { raw: b }; } resolve({ status: res.statusCode, headers: res.headers, body: parsed }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); cond ? pass++ : fail++; }

(async () => {
  await wait(400);
  const login = await api('POST', '/api/auth/login', { identifier: 'teacher@demo.edu', password: 'demo1234' });
  check('teacher login', login.status === 200 && login.body.user.role === 'teacher');
  const cookie = login.headers['set-cookie'][0].split(';')[0];

  const sess = await api('POST', '/api/quizzes/1/sessions', {}, cookie);
  const session = sess.body.session;
  check('live session created with join code', !!(session && session.join_code));

  const host = io(URL); await new Promise((r) => host.on('connect', r));
  await new Promise((r) => host.emit('host:open', { sessionId: session.id }, r));
  let hostViolation = null; host.on('host:violation', (v) => (hostViolation = v));

  const stu = io(URL); await new Promise((r) => stu.on('connect', r));
  const joinRes = await new Promise((r) => stu.emit('student:join', { code: session.join_code, studentId: '2417260', name: 'Dauphin' }, r));
  check('student joins lobby by numeric ID', joinRes && joinRes.ok);

  // reject non-numeric ID
  const stu2 = io(URL); await new Promise((r) => stu2.on('connect', r));
  const badJoin = await new Promise((r) => stu2.emit('student:join', { code: session.join_code, studentId: 'abc', name: 'x' }, r));
  check('non-numeric student ID rejected', badJoin && !!badJoin.error);
  stu2.close();

  let started = null; stu.on('quiz:start', (p) => (started = p));
  host.emit('host:start', { sessionId: session.id });
  await wait(300);
  check('student receives quiz:start with questions', !!(started && started.quiz.questions.length === 4));

  // late joiner blocked
  const stu3 = io(URL); await new Promise((r) => stu3.on('connect', r));
  const lateJoin = await new Promise((r) => stu3.emit('student:join', { code: session.join_code, studentId: '999', name: 'late' }, r));
  check('late joiner blocked after start', lateJoin && !!lateJoin.error);
  stu3.close();

  const q1 = started.quiz.questions.find((q) => q.prompt.includes('idempotent'));
  stu.emit('student:answer', { questionId: q1.id, value: q1.options.indexOf('GET') });
  await wait(100);

  let failed = null; stu.on('quiz:failed', (f) => (failed = f));
  stu.emit('student:violation', { reason: 'Switched away from the exam tab' });
  await wait(400);
  check('violation triggers auto-F for student', !!(failed && failed.grade === 'F'));
  check('host is notified of the violation', !!(hostViolation && hostViolation.failed === true));

  const results = await api('GET', `/api/quizzes/sessions/${session.id}/results`, null, cookie);
  const att = results.body.attempts.find((a) => a.student_id === '2417260');
  check('flagged attempt recorded as F in results', !!(att && att.status === 'flagged' && att.grade === 'F' && att.violations === 1));

  /* ---- clipboard flow: flag → teacher confirms/dismisses (no auto-F) ---- */
  const sess2 = await api('POST', '/api/quizzes/1/sessions', {}, cookie);
  const session2 = sess2.body.session;
  let review = null; const reviewCounts = []; host.on('host:review', (r) => { review = r; reviewCounts.push(r.violations); });
  await new Promise((r) => host.emit('host:open', { sessionId: session2.id }, r));

  const cstu = io(URL); await new Promise((r) => cstu.on('connect', r));
  const cj = await new Promise((r) => cstu.emit('student:join', { code: session2.join_code, studentId: '3001', name: 'Clip' }, r));
  let cStarted = null, cFailed = null, cDismissed = null, cWarn = null;
  cstu.on('quiz:start', (p) => (cStarted = p));
  cstu.on('quiz:failed', (f) => (cFailed = f));
  cstu.on('quiz:flag_dismissed', (d) => (cDismissed = d));
  cstu.on('quiz:warning', (w) => (cWarn = w));
  host.emit('host:start', { sessionId: session2.id });
  await wait(300);

  // paste attempt → should NOT auto-fail; should raise a review + pendingReview warning
  cstu.emit('student:violation', { reason: 'Paste attempted (Ctrl+V)', kind: 'clipboard' });
  await wait(300);
  check('clipboard violation does NOT auto-fail the student', cFailed === null);
  check('clipboard violation warns student as pending review', !!(cWarn && cWarn.pendingReview === true));
  check('teacher receives a review request for the flag', !!(review && review.student_id === '3001'));

  // repeated attempts should raise the count the teacher sees
  cstu.emit('student:violation', { reason: 'Paste attempted (Ctrl+V)', kind: 'clipboard' });
  await wait(150);
  cstu.emit('student:violation', { reason: 'Paste attempted (Ctrl+V)', kind: 'clipboard' });
  await wait(200);
  check('attempt count climbs across repeated tries', reviewCounts.length >= 3 && reviewCounts[reviewCounts.length - 1] >= 3);

  // teacher dismisses the first flag → student continues
  host.emit('host:dismiss_flag', { attemptId: cj.attemptId });
  await wait(250);
  check('dismiss lets the student continue (no F)', !!(cDismissed && cFailed === null));

  // second attempt → teacher confirms the F
  cstu.emit('student:violation', { reason: 'Copy attempted (Ctrl+C)', kind: 'clipboard' });
  await wait(250);
  host.emit('host:confirm_fail', { attemptId: cj.attemptId, reason: 'Copy confirmed' });
  await wait(300);
  check('teacher-confirmed F fails the flagged student', !!(cFailed && cFailed.grade === 'F'));
  const r2 = await api('GET', `/api/quizzes/sessions/${session2.id}/results`, null, cookie);
  const catt = r2.body.attempts.find((a) => a.student_id === '3001');
  check('confirmed clipboard F recorded in results', !!(catt && catt.grade === 'F' && catt.status === 'flagged'));
  cstu.close();

  // practice flow: publish quiz, take & submit
  await api('PUT', '/api/quizzes/1', { published: true }, cookie);
  // register a student to take practice
  const reg = await api('POST', '/api/auth/register', { role: 'student', full_name: 'Prac', student_id: '5551234', password: 'pw1234' });
  const scookie = reg.headers['set-cookie'][0].split(';')[0];
  const take = await api('GET', '/api/quizzes/1/take', null, scookie);
  check('practice take strips correct answers', take.body.quiz.questions.every((q) => q.correct === undefined));
  const resp = {};
  for (const q of take.body.quiz.questions) {
    if (q.type === 'mcq') resp[q.id] = q.options.indexOf('GET') >= 0 ? q.options.indexOf('GET') : 0;
    else resp[q.id] = 'TCP is reliable, connection oriented and ordered; UDP is connectionless and faster.';
  }
  const sub = await api('POST', '/api/quizzes/1/submit', { responses: resp }, scookie);
  check('practice submit returns a grade', !!(sub.body.result && sub.body.result.grade));
  check('written answer flags attempt for review', sub.body.result.needsReview === true);

  /* ---- any-subject + AI endpoints ---- */
  const fl = await api('GET', '/api/quizzes/fields');
  check('subjects span beyond computer science', fl.body.fields.some((f) => f.category === 'Natural Sciences') && fl.body.fields.length >= 20);
  const nf = await api('POST', '/api/quizzes/fields', { name: 'Organic Chemistry II' }, cookie);
  check('teacher can add a custom subject', nf.status === 200 && nf.body.field.slug === 'organic-chemistry-ii');
  const nfS = await api('POST', '/api/quizzes/fields', { name: 'Hack' }, scookie);
  check('students cannot add subjects', nfS.status === 403);
  const ais = await api('GET', '/api/ai/status', null, cookie);
  check('AI status reports disabled without a key', ais.status === 200 && ais.body.enabled === false);
  const aig = await api('POST', '/api/ai/generate', { subject: 'Physics' }, cookie);
  check('AI generate refuses cleanly without a key', aig.status === 503);
  const aigS = await api('POST', '/api/ai/generate', { subject: 'Physics' }, scookie);
  check('students cannot use the AI generator', aigS.status === 403);

  host.close(); stu.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
