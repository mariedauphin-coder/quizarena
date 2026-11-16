/* ============================ Landing ============================ */
function pageLanding() {
  const node = h(`<div class="container">
    <section class="hero">
      <span class="pill">Proctored online exams · built for universities</span>
      <h1>Run real, <span class="grad">cheat-resistant</span> quizzes<br/>for computer science.</h1>
      <p>Students practice by field, then sit live exams that lock the screen, watch for tab-switching,
         and grade instantly. Teachers build quizzes, set the rules, and host the room.</p>
      <div class="row" style="justify-content:center">
        <a class="btn lg" href="#/join">🎓 Join a live quiz</a>
        <a class="btn lg secondary" href="#/login">Teacher sign in</a>
      </div>
      <p class="muted" style="margin-top:14px;font-size:13px">Demo teacher: <b>teacher@demo.edu</b> / <b>demo1234</b></p>
    </section>

    <section class="grid cols-3 feature-grid">
      <div class="card feature"><div class="ic">🧭</div><h3>Field-based practice</h3>
        <p class="muted">Ten CS domains — algorithms, AI/ML, computer vision, cybersecurity, DBMS, networking and more.</p></div>
      <div class="card feature"><div class="ic">🔒</div><h3>Lockdown exam mode</h3>
        <p class="muted">Fullscreen enforced. Tab-switch, window-blur or screen-shrink is flagged instantly.</p></div>
      <div class="card feature"><div class="ic">⌨️</div><h3>Controlled input</h3>
        <p class="muted">MCQs accept only <span class="kbd">Enter</span> and arrow keys; written answers type normally.</p></div>
      <div class="card feature"><div class="ic">🆔</div><h3>Join by student ID</h3>
        <p class="muted">Students enter a numeric ID and wait in the lobby until the teacher starts.</p></div>
      <div class="card feature"><div class="ic">⚡</div><h3>Instant grading</h3>
        <p class="muted">MCQs auto-scored; written answers pre-scored and flagged for teacher review.</p></div>
      <div class="card feature"><div class="ic">🚩</div><h3>Auto-fail on cheating</h3>
        <p class="muted">Break a proctoring rule and the exam ends with an automatic F, logged for the teacher.</p></div>
    </section>
  </div>`);
  mount(node);
}

/* ============================ Auth ============================ */
function pageLogin() {
  const node = h(`<div class="container narrow">
    <div class="card">
      <h2>Sign in</h2>
      <p class="muted">Teachers use email; students use their numeric ID.</p>
      <form id="loginForm">
        <label>Email or Student ID</label>
        <input name="identifier" autocomplete="username" required />
        <label>Password</label>
        <input name="password" type="password" autocomplete="current-password" required />
        <button class="btn block mt" type="submit">Sign in</button>
      </form>
      <hr class="sep" />
      <p class="center muted">No account? <a href="#/register">Create one</a></p>
    </div>
  </div>`);
  mount(node);
  el('#loginForm', node).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const d = await API.post('/api/auth/login', { identifier: f.get('identifier'), password: f.get('password') });
      Store.user = d.user;
      toast('Welcome back!', 'ok');
      location.hash = d.user.role === 'teacher' ? '#/teacher' : '#/dashboard';
    } catch (err) { toast(err.message, 'err'); }
  };
}

function pageRegister() {
  const node = h(`<div class="container narrow">
    <div class="card">
      <h2>Create account</h2>
      <form id="regForm">
        <label>I am a…</label>
        <select name="role" id="roleSel">
          <option value="student">Student</option>
          <option value="teacher">Teacher</option>
        </select>
        <label>Full name</label>
        <input name="full_name" required />
        <div id="studentField">
          <label>Student ID (digits only)</label>
          <input name="student_id" inputmode="numeric" pattern="\\d*" />
        </div>
        <div id="emailField" class="hidden">
          <label>Email</label>
          <input name="email" type="email" />
        </div>
        <label>Institution (optional)</label>
        <input name="institution" />
        <label>Password (min 6 characters)</label>
        <input name="password" type="password" required />
        <button class="btn block mt" type="submit">Create account</button>
      </form>
      <hr class="sep" />
      <p class="center muted">Already registered? <a href="#/login">Sign in</a></p>
    </div>
  </div>`);
  mount(node);
  const roleSel = el('#roleSel', node);
  const toggle = () => {
    const teacher = roleSel.value === 'teacher';
    el('#emailField', node).classList.toggle('hidden', !teacher);
    el('#studentField', node).classList.toggle('hidden', teacher);
  };
  roleSel.onchange = toggle; toggle();

  el('#regForm', node).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const payload = {
      role: f.get('role'), full_name: f.get('full_name'),
      password: f.get('password'), institution: f.get('institution'),
    };
    if (f.get('role') === 'teacher') payload.email = f.get('email');
    else payload.student_id = f.get('student_id');
    try {
      const d = await API.post('/api/auth/register', payload);
      Store.user = d.user;
      toast('Account created!', 'ok');
      location.hash = d.user.role === 'teacher' ? '#/teacher' : '#/dashboard';
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ==================== Student dashboard ==================== */
async function pageDashboard() {
  if (!Store.user) return (location.hash = '#/login');
  const node = h(`<div class="container">
    <div class="row between wrap">
      <div><h1>Choose a field</h1><p class="muted">Pick a computer-science domain to practice, or join a live exam.</p></div>
      <a class="btn" href="#/join">Join a live quiz →</a>
    </div>
    <div class="grid cols-auto mt2" id="fields"><p class="muted">Loading…</p></div>
  </div>`);
  mount(node);
  try {
    const { fields } = await API.get('/api/quizzes/fields');
    const wrap = el('#fields', node);
    wrap.innerHTML = '';
    for (const f of fields) {
      const c = h(`<div class="card field-card">
        <div class="row between"><span class="icon">${esc(f.icon || '📚')}</span>
          <span class="badge ${f.quiz_count ? 'g' : 'n'}">${f.quiz_count} quiz${f.quiz_count === 1 ? '' : 'zes'}</span></div>
        <h3 class="mt">${esc(f.name)}</h3>
        <p class="muted" style="font-size:13px">${esc(f.blurb || '')}</p>
      </div>`);
      c.onclick = () => (location.hash = `#/field/${f.slug}`);
      wrap.appendChild(c);
    }
  } catch (err) { toast(err.message, 'err'); }
}

async function pageField(slug) {
  if (!Store.user) return (location.hash = '#/login');
  const node = h(`<div class="container"><a href="#/dashboard" class="muted">← All fields</a>
    <div id="body" class="mt"><p class="muted">Loading…</p></div></div>`);
  mount(node);
  try {
    const { field, quizzes } = await API.get(`/api/quizzes/fields/${slug}/quizzes`);
    const body = el('#body', node);
    body.innerHTML = `<h1>${esc(field.icon)} ${esc(field.name)}</h1><p class="muted">${esc(field.blurb || '')}</p>`;
    if (!quizzes.length) {
      body.appendChild(h(`<div class="info mt2">No published practice quizzes here yet. Ask your teacher to publish one.</div>`));
      return;
    }
    const grid = h(`<div class="grid cols-2 mt2"></div>`);
    for (const q of quizzes) {
      const c = h(`<div class="card">
        <h3>${esc(q.title)}</h3>
        <p class="muted" style="font-size:13px">${esc(q.description || '')}</p>
        <div class="row wrap mt"><span class="badge n">${q.question_count} questions</span>
          <span class="badge n">${q.duration_min} min</span>
          <span class="badge n">pass ${q.pass_pct}%</span></div>
        <button class="btn block mt" data-id="${q.id}">Start practice</button>
      </div>`);
      el('button', c).onclick = () => startPractice(q.id);
      grid.appendChild(c);
    }
    body.appendChild(grid);
  } catch (err) { toast(err.message, 'err'); }
}

/* ==================== Teacher console ==================== */
async function pageTeacher() {
  if (!Store.user || Store.user.role !== 'teacher') return (location.hash = '#/login');
  const node = h(`<div class="container">
    <div class="row between wrap">
      <div><h1>Teacher console</h1><p class="muted">Build quizzes, set proctoring rules, and host live exams.</p></div>
      <button class="btn" id="newQuiz">+ New quiz</button>
    </div>
    <div id="list" class="grid mt2"><p class="muted">Loading…</p></div>
  </div>`);
  mount(node);
  el('#newQuiz', node).onclick = () => openQuizEditor(null);
  await renderTeacherList(node);
}

async function renderTeacherList(node) {
  const list = el('#list', node);
  const [{ quizzes }, { fields }] = await Promise.all([
    API.get('/api/quizzes/mine'),
    API.get('/api/quizzes/fields'),
  ]);
  window.__fields = fields;
  list.innerHTML = '';
  if (!quizzes.length) list.appendChild(h(`<div class="info">No quizzes yet. Click “New quiz” to begin.</div>`));
  for (const q of quizzes) {
    const c = h(`<div class="card">
      <div class="row between wrap">
        <div>
          <div class="row wrap" style="gap:8px">
            <h3 style="margin:0">${esc(q.title)}</h3>
            <span class="badge ${q.mode === 'live' ? 'w' : 'n'}">${q.mode}</span>
            <span class="badge ${q.published ? 'g' : 'n'}">${q.published ? 'published' : 'draft'}</span>
          </div>
          <p class="muted" style="font-size:13px;margin:6px 0 0">${esc(q.field_name || 'No field')} ·
            ${q.question_count} questions · ${q.duration_min} min ·
            ${q.fail_on_violation ? `auto-F after ${q.max_violations} violation(s)` : 'violations logged only'}</p>
        </div>
        <div class="row wrap">
          <button class="btn secondary" data-edit>Edit</button>
          ${q.mode === 'live' ? '<button class="btn good" data-host>Host live</button>' : ''}
          <button class="btn ghost" data-del>Delete</button>
        </div>
      </div>
    </div>`);
    el('[data-edit]', c).onclick = () => openQuizEditor(q.id);
    const hostBtn = el('[data-host]', c);
    if (hostBtn) hostBtn.onclick = () => hostLive(q.id);
    el('[data-del]', c).onclick = async () => {
      if (!confirm(`Delete “${q.title}”? This removes its questions and results.`)) return;
      await API.del(`/api/quizzes/${q.id}`); toast('Deleted', 'ok'); renderTeacherList(node);
    };
    list.appendChild(c);
  }
}

async function openQuizEditor(id) {
  let quiz = null;
  const fields = window.__fields || (await API.get('/api/quizzes/fields')).fields;
  if (id) quiz = (await API.get(`/api/quizzes/${id}`)).quiz;

  const q = quiz || { title: '', description: '', mode: 'live', field_id: fields[0] && fields[0].id,
    duration_min: 20, shuffle_q: 1, shuffle_opts: 1, max_violations: 0, fail_on_violation: 1, pass_pct: 50, published: 0, questions: [] };

  const fieldOpts = fields.map((f) => `<option value="${f.id}" ${f.id === q.field_id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');

  const node = h(`<div class="container">
    <a href="#/teacher" class="muted">← Back to console</a>
    <div class="grid cols-2 mt" style="align-items:start">
      <div class="card">
        <h2>${id ? 'Edit quiz' : 'New quiz'}</h2>
        <label>Title</label><input id="qtitle" value="${esc(q.title)}" />
        <label>Description</label><textarea id="qdesc" rows="2">${esc(q.description || '')}</textarea>
        <div class="grid cols-2">
          <div><label>Field</label><select id="qfield">${fieldOpts}</select></div>
          <div><label>Mode</label><select id="qmode">
            <option value="live" ${q.mode === 'live' ? 'selected' : ''}>Live (proctored exam)</option>
            <option value="practice" ${q.mode === 'practice' ? 'selected' : ''}>Practice (self-paced)</option>
          </select></div>
        </div>
        <div class="grid cols-2">
          <div><label>Duration (minutes)</label><input id="qdur" type="number" min="1" value="${q.duration_min}" /></div>
          <div><label>Pass mark (%)</label><input id="qpass" type="number" min="0" max="100" value="${q.pass_pct}" /></div>
        </div>

        <h3 class="mt2">Proctoring rules</h3>
        <div class="grid cols-2">
          <label class="row" style="gap:8px"><input type="checkbox" id="qfail" style="width:auto" ${q.fail_on_violation ? 'checked' : ''}/> Auto-fail on violation</label>
          <div><label>Violations allowed before F</label><input id="qmaxv" type="number" min="0" max="10" value="${q.max_violations}" /></div>
        </div>
        <div class="grid cols-2 mt">
          <label class="row" style="gap:8px"><input type="checkbox" id="qsq" style="width:auto" ${q.shuffle_q ? 'checked' : ''}/> Shuffle questions</label>
          <label class="row" style="gap:8px"><input type="checkbox" id="qso" style="width:auto" ${q.shuffle_opts ? 'checked' : ''}/> Shuffle options</label>
        </div>
        <label class="row mt" style="gap:8px"><input type="checkbox" id="qpub" style="width:auto" ${q.published ? 'checked' : ''}/> Published (visible to students)</label>
        <button class="btn block mt2" id="saveQuiz">${id ? 'Save changes' : 'Create quiz'}</button>
      </div>

      <div class="card" id="qcol">
        ${id ? '' : '<div class="info">Save the quiz first, then add questions here.</div>'}
      </div>
    </div>
  </div>`);
  mount(node);

  el('#saveQuiz', node).onclick = async () => {
    const payload = {
      title: el('#qtitle', node).value.trim(),
      description: el('#qdesc', node).value.trim(),
      field_id: Number(el('#qfield', node).value),
      mode: el('#qmode', node).value,
      duration_min: Number(el('#qdur', node).value),
      pass_pct: Number(el('#qpass', node).value),
      fail_on_violation: el('#qfail', node).checked,
      max_violations: Number(el('#qmaxv', node).value),
      shuffle_q: el('#qsq', node).checked,
      shuffle_opts: el('#qso', node).checked,
      published: el('#qpub', node).checked,
    };
    if (!payload.title) return toast('Give the quiz a title.', 'err');
    try {
      let saved;
      if (id) saved = (await API.put(`/api/quizzes/${id}`, payload)).quiz;
      else saved = (await API.post('/api/quizzes', payload)).quiz;
      toast('Saved', 'ok');
      location.hash = `#/edit/${saved.id}`;
      if (id) renderQuestions(node, saved);
    } catch (err) { toast(err.message, 'err'); }
  };

  if (id) renderQuestions(node, q);
}

function renderQuestions(node, quiz) {
  const col = el('#qcol', node);
  col.innerHTML = `<div class="row between"><h3 style="margin:0">Questions (${quiz.questions.length})</h3></div>`;
  const listWrap = h('<div class="mt"></div>');
  for (const qq of quiz.questions) {
    const meta = qq.type === 'mcq'
      ? `MCQ · ${(qq.options || []).length} options · ${qq.points} pt`
      : `Written · ${qq.points} pt`;
    const item = h(`<div class="card" style="padding:14px;margin-bottom:10px;background:var(--panel-2)">
      <div class="row between"><span class="tag">${esc(meta)}</span>
        <button class="btn ghost" style="padding:5px 10px" data-del>✕</button></div>
      <p style="margin:8px 0 0">${esc(qq.prompt)}</p></div>`);
    el('[data-del]', item).onclick = async () => {
      await API.del(`/api/quizzes/${quiz.id}/questions/${qq.id}`);
      quiz.questions = quiz.questions.filter((x) => x.id !== qq.id);
      renderQuestions(node, quiz);
    };
    listWrap.appendChild(item);
  }
  col.appendChild(listWrap);

  // add-question form
  const form = h(`<div class="mt2">
    <h3>Add a question</h3>
    <label>Type</label>
    <select id="nqtype"><option value="mcq">Multiple choice (MCQ)</option><option value="detailed">Written / detailed answer</option></select>
    <label>Prompt</label><textarea id="nqprompt" rows="2"></textarea>
    <div id="mcqBox">
      <label>Options (one per line — mark the correct one with * at the start)</label>
      <textarea id="nqopts" rows="4" placeholder="*The correct option\nAnother option\nYet another"></textarea>
    </div>
    <div id="detBox" class="hidden">
      <label>Grading keywords (comma-separated — used for provisional auto-score)</label>
      <input id="nqkw" placeholder="reliable, ordered, connectionless" />
    </div>
    <label>Points</label><input id="nqpts" type="number" min="1" value="1" />
    <button class="btn block mt" id="addQ">Add question</button>
  </div>`);
  col.appendChild(form);

  const typeSel = el('#nqtype', form);
  typeSel.onchange = () => {
    const mcq = typeSel.value === 'mcq';
    el('#mcqBox', form).classList.toggle('hidden', !mcq);
    el('#detBox', form).classList.toggle('hidden', mcq);
  };

  el('#addQ', form).onclick = async () => {
    const type = typeSel.value;
    const prompt = el('#nqprompt', form).value.trim();
    if (!prompt) return toast('Enter a prompt.', 'err');
    const points = Number(el('#nqpts', form).value) || 1;
    const payload = { type, prompt, points };
    if (type === 'mcq') {
      const lines = el('#nqopts', form).value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length < 2) return toast('Add at least two options.', 'err');
      let correct = -1;
      const options = lines.map((l, i) => { if (l.startsWith('*')) { correct = i; return l.slice(1).trim(); } return l; });
      if (correct < 0) return toast('Mark the correct option with * at the start.', 'err');
      payload.options = options; payload.correct = correct;
    } else {
      payload.keywords = el('#nqkw', form).value.split(',').map((s) => s.trim()).filter(Boolean);
    }
    try {
      const { question } = await API.post(`/api/quizzes/${quiz.id}/questions`, payload);
      question.options = question.options ? JSON.parse(question.options) : null;
      quiz.questions.push(question);
      renderQuestions(node, quiz);
      toast('Question added', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}
