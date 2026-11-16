/* ================= PRACTICE (self-paced, no lockdown) ================= */
async function startPractice(quizId) {
  let quiz;
  try { quiz = (await API.get(`/api/quizzes/${quizId}/take`)).quiz; }
  catch (err) { return toast(err.message, 'err'); }

  const responses = {};
  let idx = 0;
  const node = h(`<div class="container narrow"><div class="card" id="pc"></div></div>`);
  mount(node);

  function render() {
    const pc = el('#pc', node);
    const q = quiz.questions[idx];
    const total = quiz.questions.length;
    pc.innerHTML = `<div class="row between"><span class="tag">Question ${idx + 1} / ${total}</span>
      <span class="badge n">${q.points} pt</span></div><h2 class="mt">${esc(q.prompt)}</h2>`;
    if (q.type === 'mcq') {
      const box = h('<div class="mt"></div>');
      q.options.forEach((opt, i) => {
        const sel = responses[q.id] === i;
        const o = h(`<div class="opt ${sel ? 'selected' : ''}"><span class="key">${String.fromCharCode(65 + i)}</span><span>${esc(opt)}</span></div>`);
        o.onclick = () => { responses[q.id] = i; render(); };
        box.appendChild(o);
      });
      pc.appendChild(box);
    } else {
      const ta = h(`<textarea class="mt" rows="6" placeholder="Type your answer…">${esc(responses[q.id] || '')}</textarea>`);
      ta.oninput = () => { responses[q.id] = ta.value; };
      pc.appendChild(ta);
    }
    const nav = h(`<div class="row between mt2">
      <button class="btn ghost" ${idx === 0 ? 'disabled' : ''} id="prev">← Prev</button>
      ${idx < total - 1 ? '<button class="btn" id="next">Next →</button>' : '<button class="btn good" id="submit">Submit</button>'}
    </div>`);
    const prev = el('#prev', nav); if (prev) prev.onclick = () => { idx--; render(); };
    const next = el('#next', nav); if (next) next.onclick = () => { idx++; render(); };
    const sub = el('#submit', nav); if (sub) sub.onclick = submit;
    pc.appendChild(nav);
  }
  async function submit() {
    try {
      const { result } = await API.post(`/api/quizzes/${quizId}/submit`, { responses });
      showResultOverlay(result, () => (location.hash = '#/dashboard'));
    } catch (err) { toast(err.message, 'err'); }
  }
  render();
}

/* ================= JOIN a live quiz (student) ================= */
function pageJoin() {
  const node = h(`<div class="container narrow">
    <div class="card">
      <h2>Join a live quiz</h2>
      <p class="muted">Enter the code from your teacher and your student ID.</p>
      <label>Join code</label>
      <input id="jcode" style="text-transform:uppercase;letter-spacing:3px;font-weight:700" maxlength="6" placeholder="ABC123" />
      <label>Student ID (digits only)</label>
      <input id="jsid" inputmode="numeric" placeholder="2417260" />
      <label>Display name (optional)</label>
      <input id="jname" placeholder="e.g. Dauphin" />
      <button class="btn block mt2" id="joinBtn">Enter lobby</button>
      <div class="notice mt2">Once you join and the quiz starts, your screen will be locked to fullscreen.
        Leaving fullscreen, switching tabs, shrinking the window, or copy/paste will be flagged and may end your exam with an F.</div>
    </div>
  </div>`);
  mount(node);
  el('#joinBtn', node).onclick = () => {
    const code = el('#jcode', node).value.trim().toUpperCase();
    const sid = el('#jsid', node).value.trim();
    const name = el('#jname', node).value.trim();
    if (!code) return toast('Enter the join code.', 'err');
    if (!/^\d+$/.test(sid)) return toast('Student ID must be digits only.', 'err');
    liveStudent(code, sid, name);
  };
}

/* The student live experience: lobby → exam → result. */
function liveStudent(code, studentId, name) {
  const socket = io();
  let myAttemptId = null;
  socket.on('connect', () => {
    socket.emit('student:join', { code, studentId, name }, (res) => {
      if (res && res.error) { toast(res.error, 'err'); socket.disconnect(); location.hash = '#/join'; return; }
      myAttemptId = res.attemptId;
      showLobby();
    });
  });

  function showLobby() {
    const node = h(`<div class="container narrow"><div class="card center">
      <div style="font-size:40px">⏳</div>
      <h2>You're in the lobby</h2>
      <p class="muted">Student ID <b>${esc(studentId)}</b> · code <b>${esc(code)}</b></p>
      <div class="info mt">Waiting for your teacher to start the quiz. Keep this tab open and don't refresh.</div>
    </div></div>`);
    mount(node);
  }

  socket.on('quiz:start', ({ quiz, startedAt }) => {
    runLockedExam(socket, quiz, startedAt, myAttemptId);
  });
  socket.on('quiz:ended', () => {
    toast('The teacher ended the session.', '');
  });
  window.__liveSocket = socket;
}

/* ================= HOST a live quiz (teacher) ================= */
async function hostLive(quizId) {
  let session;
  try { session = (await API.post(`/api/quizzes/${quizId}/sessions`)).session; }
  catch (err) { return toast(err.message, 'err'); }

  const socket = io();
  const node = h(`<div class="container">
    <a href="#/teacher" class="muted">← Console</a>
    <div class="grid cols-2 mt" style="align-items:start">
      <div class="card center">
        <span class="tag">Students join at this code</span>
        <div class="joincode mt">${esc(session.join_code)}</div>
        <p class="muted mt">They go to <b>${location.host}</b> → “Join a live quiz”.</p>
        <div class="row mt2" style="justify-content:center">
          <button class="btn good lg" id="startBtn">▶ Start quiz</button>
          <button class="btn danger" id="endBtn">■ End</button>
        </div>
        <p class="muted mt" id="statusLine">Status: lobby — students can join.</p>
      </div>
      <div class="card">
        <div class="row between"><h3 style="margin:0">Live roster</h3><span class="pill" id="count">0 joined</span></div>
        <div class="chips mt" id="roster"><span class="muted">No one yet…</span></div>
        <hr class="sep" />
        <div id="log" style="max-height:220px;overflow:auto;font-size:13px"></div>
      </div>
    </div>
    <div class="card mt" id="reviewCard" style="display:none;border-color:var(--warn)">
      <div class="row between"><h3 style="margin:0">🚩 Flags awaiting your decision</h3>
        <span class="pill" id="reviewCount">0</span></div>
      <p class="muted" style="font-size:13px;margin:6px 0 0">Copy/paste attempts are flagged here. Confirm the F or dismiss it — the student stays in the exam until you decide.</p>
      <div id="reviews" class="mt"></div>
    </div>
    <div class="card mt" id="resultsCard" style="display:none">
      <h3>Results</h3><div id="results"></div>
    </div>
  </div>`);
  mount(node);

  const roster = el('#roster', node), count = el('#count', node), log = el('#log', node);
  function paintRoster(list) {
    count.textContent = `${list.length} joined`;
    roster.innerHTML = list.length ? '' : '<span class="muted">No one yet…</span>';
    for (const a of list) {
      const cls = a.status === 'flagged' ? 'flagged' : (a.status === 'graded' || a.status === 'submitted') ? 'done' : '';
      const tag = a.status === 'flagged' ? ' 🚩F' : (a.grade ? ` ${a.grade}` : '');
      roster.appendChild(h(`<span class="chip ${cls}">${esc(a.display_name || ('#' + a.student_id))}${tag}</span>`));
    }
  }
  function addLog(msg, bad) {
    log.prepend(h(`<div style="padding:5px 0;border-bottom:1px solid var(--border);${bad ? 'color:var(--bad)' : ''}">${esc(msg)}</div>`));
  }

  socket.on('connect', () => {
    socket.emit('host:open', { sessionId: session.id }, (res) => {
      if (res && res.roster) paintRoster(res.roster);
    });
  });
  socket.on('host:roster', ({ roster }) => paintRoster(roster));
  socket.on('host:violation', ({ student_id, reason, failed }) => {
    addLog(`⚠ ${student_id}: ${reason}${failed ? ' → auto-F' : ''}`, true);
  });
  socket.on('host:started', () => { el('#statusLine', node).textContent = 'Status: running — lobby closed.'; });

  // Clipboard flags that the teacher must confirm. One card per student,
  // with a live count of attempts so the teacher can tell a one-off slip
  // from repeated, deliberate copy/paste.
  const reviews = el('#reviews', node), reviewCard = el('#reviewCard', node), reviewCount = el('#reviewCount', node);
  const resolved = new Set();        // attempts already actioned this session
  const flagState = new Map();       // attempt_id -> { count, row }

  function intentHint(n) {
    if (n >= 4) return { text: `${n} attempts — repeated, likely deliberate`, cls: 'b' };
    if (n >= 2) return { text: `${n} attempts — repeated`, cls: 'w' };
    return { text: `1 attempt — could be accidental`, cls: 'n' };
  }

  socket.on('host:review', ({ attempt_id, student_id, display_name, reason }) => {
    addLog(`🚩 ${student_id}: ${reason} — needs your decision`, true);
    if (resolved.has(attempt_id)) return;

    let st = flagState.get(attempt_id);
    if (st) {
      // repeat attempt by the same student → bump the count on the existing card
      st.count++;
      const hint = intentHint(st.count);
      el('[data-count]', st.row).textContent = st.count;
      const b = el('[data-hint]', st.row); b.textContent = hint.text; b.className = `badge ${hint.cls}`;
      el('[data-reason]', st.row).textContent = `Latest: ${reason}`;
      st.row.animate([{ background: 'rgba(248,81,73,.25)' }, { background: 'rgba(210,153,34,.1)' }], { duration: 500 });
      return;
    }

    reviewCard.style.display = '';
    const hint = intentHint(1);
    const row = h(`<div class="notice wrap" data-att="${attempt_id}" style="margin-bottom:10px">
      <div class="row between wrap">
        <span><b>${esc(display_name || ('#' + student_id))}</b> (ID ${esc(student_id)})
          — <b data-count>1</b> copy/paste attempt(s)</span>
        <span class="row"><button class="btn danger" data-fail>Confirm F</button>
          <button class="btn ghost" data-dismiss>Dismiss</button></span>
      </div>
      <div class="row wrap mt" style="gap:8px">
        <span class="badge ${hint.cls}" data-hint>${hint.text}</span>
        <span class="muted" style="font-size:12px" data-reason>Latest: ${esc(reason)}</span>
      </div></div>`);
    el('[data-fail]', row).onclick = () => {
      const n = (flagState.get(attempt_id) || { count: 1 }).count;
      socket.emit('host:confirm_fail', { attemptId: attempt_id, reason: `Copy/paste (${n} attempt(s)) — confirmed by teacher` });
      finishReview(attempt_id, 'Confirmed F');
    };
    el('[data-dismiss]', row).onclick = () => {
      socket.emit('host:dismiss_flag', { attemptId: attempt_id });
      finishReview(attempt_id, 'Dismissed');
    };
    reviews.prepend(row);
    flagState.set(attempt_id, { count: 1, row });
    reviewCount.textContent = flagState.size;
  });

  function finishReview(attemptId, label) {
    const st = flagState.get(attemptId);
    if (st) st.row.remove();
    flagState.delete(attemptId);
    resolved.add(attemptId);
    reviewCount.textContent = flagState.size;
    if (flagState.size === 0) reviewCard.style.display = 'none';
    addLog(`${label} for a flagged student.`);
    toast(label, 'ok');
  }

  el('#startBtn', node).onclick = () => {
    if (!confirm('Start the quiz for everyone in the lobby? No new students can join after this.')) return;
    socket.emit('host:start', { sessionId: session.id });
    toast('Quiz started', 'ok');
  };
  el('#endBtn', node).onclick = async () => {
    if (!confirm('End the session and grade everyone still in progress?')) return;
    socket.emit('host:end', { sessionId: session.id });
    setTimeout(() => showHostResults(node, session.id), 700);
  };
}

async function showHostResults(node, sessionId) {
  try {
    const { attempts } = await API.get(`/api/quizzes/sessions/${sessionId}/results`);
    const card = el('#resultsCard', node); card.style.display = '';
    const box = el('#results', node);
    box.innerHTML = `<table><thead><tr><th>Student ID</th><th>Name</th><th>Status</th><th>Violations</th><th>Score</th><th>Grade</th></tr></thead><tbody></tbody></table>`;
    const tb = el('tbody', box);
    for (const a of attempts) {
      const g = a.grade === 'F' ? 'b' : (a.grade === 'A' || a.grade === 'B') ? 'g' : 'w';
      tb.appendChild(h(`<tr>
        <td>${esc(a.student_id || '')}</td><td>${esc(a.display_name || '')}</td>
        <td>${esc(a.status)}</td><td>${a.violations}</td>
        <td>${a.score == null ? '—' : a.score + '/' + a.max_score}</td>
        <td><span class="badge ${g}">${esc(a.grade || '—')}</span></td></tr>`));
    }
  } catch (err) { toast(err.message, 'err'); }
}

/* ================= Shared result overlay ================= */
function showResultOverlay(result, onClose) {
  const pass = result.grade !== 'F' && result.pct >= 0;
  const kind = result.grade === 'F' ? 'fail' : 'pass';
  const ov = h(`<div class="overlay ${kind}">
    <div class="box">
      <span class="tag">${result.grade === 'F' ? 'Result' : 'Your score'}</span>
      <div class="big">${esc(result.grade)}</div>
      <p class="muted">${result.score} / ${result.maxScore} points · ${result.pct}%</p>
      ${result.needsReview ? '<div class="info mt">Some written answers are pending your teacher\'s review — this score may change.</div>' : ''}
      <button class="btn block mt2" id="ovClose">Close</button>
    </div></div>`);
  document.body.appendChild(ov);
  el('#ovClose', ov).onclick = () => { ov.remove(); onClose && onClose(); };
}

/* ================================================================
 * runLockedExam — the proctored, locked-down live exam.
 *  - Enforces fullscreen; exiting it is a violation.
 *  - Detects tab-switch (visibilitychange), window blur, and
 *    window shrink (resize) → reports student:violation.
 *  - MCQ questions: ONLY Enter + arrow keys are accepted.
 *  - Detailed questions: normal typing (letters/digits/symbols).
 *  - On quiz:failed → exam stops with an F overlay.
 * ================================================================ */
function runLockedExam(socket, quiz, startedAt, myAttemptId) {
  let idx = 0;
  let ended = false;
  let lastViolation = 0;
  const responses = {};
  const selected = {}; // mcq highlight index per question

  // Build the locked shell (replaces the whole page).
  const shell = h(`<div class="exam-shell">
    <div class="exam-head">
      <div class="logo"><span class="mark">◆</span> ${esc(quiz.title)}</div>
      <div class="row">
        <span class="viol muted" id="violLine"></span>
        <span class="timer" id="timer">--:--</span>
      </div>
    </div>
    <div class="exam-body"><div class="exam-q" id="qbox"></div></div>
    <div class="exam-foot">
      <div class="qnav" id="qnav"></div>
      <span class="spacer"></span>
      <button class="btn ghost" id="prevBtn">← Prev</button>
      <button class="btn" id="nextBtn">Next →</button>
      <button class="btn good" id="submitBtn">Submit exam</button>
    </div>
  </div>`);
  document.body.innerHTML = '';
  document.body.appendChild(shell);
  const toastLayer = h('<div id="toast"></div>'); document.body.appendChild(toastLayer);

  /* ---------- Fullscreen + lock wiring ---------- */
  async function enterFS() {
    try { if (!document.fullscreenElement) await shell.requestFullscreen({ navigationUI: 'hide' }); }
    catch (_e) { /* some browsers require a gesture; the start button provided it */ }
  }
  enterFS();

  function reportViolation(reason, kind) {
    if (ended) return;
    const now = Date.now();
    if (now - lastViolation < 800) return; // debounce paired events
    lastViolation = now;
    socket.emit('student:violation', { reason, kind: kind || 'focus' });
  }

  const onVis = () => { if (document.hidden) reportViolation('Switched away from the exam tab'); };
  const onBlur = () => reportViolation('Exam window lost focus');
  const onFsChange = () => {
    if (!document.fullscreenElement && !ended) {
      reportViolation('Exited fullscreen');
      // try to re-enter so an accidental Esc doesn't hand the screen away
      setTimeout(enterFS, 200);
    }
  };
  let baseW = window.innerWidth, baseH = window.innerHeight;
  const onResize = () => {
    if (ended) return;
    if (window.innerWidth < baseW - 80 || window.innerHeight < baseH - 80) {
      reportViolation('Window was resized / shrunk');
    }
    baseW = Math.max(baseW, window.innerWidth); baseH = Math.max(baseH, window.innerHeight);
  };
  const onCtx = (e) => e.preventDefault();
  // Copy / cut / paste are disabled during the exam. Any attempt is blocked and
  // flagged for the teacher, who confirms the F (it does NOT auto-fail).
  const onCopy = (e) => { e.preventDefault(); reportViolation('Copy attempted', 'clipboard'); };
  const onCut = (e) => { e.preventDefault(); reportViolation('Cut attempted', 'clipboard'); };
  const onPaste = (e) => { e.preventDefault(); reportViolation('Paste attempted', 'clipboard'); };
  const onBeforeUnload = (e) => { if (!ended) { e.preventDefault(); e.returnValue = ''; } };

  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onBlur);
  document.addEventListener('fullscreenchange', onFsChange);
  window.addEventListener('resize', onResize);
  document.addEventListener('contextmenu', onCtx);
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
  window.addEventListener('beforeunload', onBeforeUnload);

  /* ---------- Keyboard rules ---------- */
  const onKeyDown = (e) => {
    if (ended) return;
    const q = quiz.questions[idx];

    // Block browser/OS shortcut combos everywhere (new tab, refresh, devtools, etc.)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      // Ctrl/Cmd + C / X / V are copy/cut/paste attempts → flag for teacher to confirm the F.
      const k = e.key.toLowerCase();
      if (k === 'c') reportViolation('Copy attempted (Ctrl+C)', 'clipboard');
      else if (k === 'x') reportViolation('Cut attempted (Ctrl+X)', 'clipboard');
      else if (k === 'v') reportViolation('Paste attempted (Ctrl+V)', 'clipboard');
      return;
    }
    if (['F5', 'F11', 'F12'].includes(e.key)) { e.preventDefault(); return; }

    if (q.type === 'mcq') {
      // ONLY Enter + arrow keys are allowed on MCQ questions.
      const allowed = ['Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (!allowed.includes(e.key)) { e.preventDefault(); return; }
      e.preventDefault();
      const n = q.options.length;
      let cur = selected[q.id] == null ? -1 : selected[q.id];
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') cur = (cur + 1 + n) % n;
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') cur = (cur - 1 + n) % n;
      else if (e.key === 'Enter') {
        if (cur < 0) cur = 0;
        responses[q.id] = cur;
        selected[q.id] = cur;
        socket.emit('student:answer', { questionId: q.id, value: cur });
        // Enter confirms and advances
        if (idx < quiz.questions.length - 1) { idx++; render(); return; }
        renderQ(); return;
      }
      selected[q.id] = cur;
      renderQ();
    } else {
      // Detailed: normal typing allowed. Enter inserts a newline in the textarea.
      // (No special key needed — letters, digits and symbols pass through.)
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  function cleanup() {
    ended = true;
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('fullscreenchange', onFsChange);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('contextmenu', onCtx);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('beforeunload', onBeforeUnload);
    clearInterval(timerInt);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  /* ---------- Timer ---------- */
  const totalSec = quiz.duration_min * 60;
  const timerEl = el('#timer', shell);
  const timerInt = setInterval(() => {
    const left = totalSec - Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent = fmtClock(left);
    timerEl.classList.toggle('low', left <= 60);
    if (left <= 0) { clearInterval(timerInt); submit(); }
  }, 500);

  /* ---------- Rendering ---------- */
  function renderNav() {
    const nav = el('#qnav', shell); nav.innerHTML = '';
    quiz.questions.forEach((q, i) => {
      const answered = responses[q.id] != null && responses[q.id] !== '';
      const d = h(`<button class="qdot ${answered ? 'answered' : ''} ${i === idx ? 'active' : ''}">${i + 1}</button>`);
      d.onclick = () => { idx = i; render(); };
      nav.appendChild(d);
    });
  }
  function renderQ() {
    const q = quiz.questions[idx];
    const box = el('#qbox', shell);
    box.innerHTML = `<div class="row between"><span class="tag">Question ${idx + 1} / ${quiz.questions.length} · ${q.points} pt</span>
      <span class="tag">${q.type === 'mcq' ? '⌨ Use ↑ ↓ then Enter' : '⌨ Type your answer'}</span></div>
      <h2 class="mt">${esc(q.prompt)}</h2>`;
    if (q.type === 'mcq') {
      const cur = selected[q.id];
      const wrap = h('<div class="mt"></div>');
      q.options.forEach((opt, i) => {
        const o = h(`<div class="opt ${cur === i ? 'selected' : ''}"><span class="key">${String.fromCharCode(65 + i)}</span><span>${esc(opt)}</span></div>`);
        o.onclick = () => { // mouse also allowed for accessibility
          selected[q.id] = i; responses[q.id] = i;
          socket.emit('student:answer', { questionId: q.id, value: i });
          renderQ();
        };
        wrap.appendChild(o);
      });
      box.appendChild(wrap);
      box.appendChild(h(`<p class="muted mt">Only <span class="kbd">Enter</span> and the <span class="kbd">↑</span><span class="kbd">↓</span> arrow keys work here. Enter confirms and moves on.</p>`));
    } else {
      const ta = h(`<textarea class="mt" rows="8" placeholder="Type your answer — letters, digits and symbols all work.">${esc(responses[q.id] || '')}</textarea>`);
      ta.oninput = () => {
        responses[q.id] = ta.value;
        socket.emit('student:answer', { questionId: q.id, value: ta.value });
      };
      box.appendChild(ta);
      setTimeout(() => ta.focus(), 30);
    }
    renderNav();
    el('#prevBtn', shell).disabled = idx === 0;
    el('#nextBtn', shell).disabled = idx === quiz.questions.length - 1;
  }
  function render() { renderQ(); }

  el('#prevBtn', shell).onclick = () => { if (idx > 0) { idx--; render(); } };
  el('#nextBtn', shell).onclick = () => { if (idx < quiz.questions.length - 1) { idx++; render(); } };
  el('#submitBtn', shell).onclick = () => { if (confirm('Submit your exam now?')) submit(); };

  function submit() {
    if (ended) return;
    socket.emit('student:submit', {}, () => {});
  }

  /* ---------- Server events ---------- */
  socket.on('quiz:warning', ({ reason, violations, allowed, pendingReview }) => {
    el('#violLine', shell).textContent = `⚠ ${violations} flag${violations === 1 ? '' : 's'}`;
    if (pendingReview) toast(`Copy/paste is disabled. Flagged for your teacher to review.`, 'err');
    else toast(`Warning: ${reason} (${violations}/${allowed + 1})`, 'err');
  });
  socket.on('quiz:failed', ({ reason, attemptId }) => {
    // A teacher-confirmed fail carries an attemptId; ignore ones meant for other students.
    if (attemptId && myAttemptId && attemptId !== myAttemptId) return;
    cleanup();
    showFailOverlay(reason);
  });
  socket.on('quiz:flag_dismissed', ({ attemptId }) => {
    if (attemptId && myAttemptId && attemptId !== myAttemptId) return;
    toast('Your teacher dismissed a flag. Continue your exam.', 'ok');
  });
  socket.on('quiz:result', (result) => {
    cleanup();
    showResultOverlay(result, () => (location.hash = '#/'));
  });
  socket.on('quiz:ended', () => { if (!ended) submit(); });

  render();
}

function showFailOverlay(reason) {
  const ov = h(`<div class="overlay fail">
    <div class="box">
      <div style="font-size:44px">🚩</div>
      <div class="big">F</div>
      <h2>Exam stopped</h2>
      <p class="muted">${esc(reason)}.</p>
      <p class="muted">A proctoring rule was broken, so your attempt was ended and recorded as a fail. Your teacher has been notified.</p>
      <button class="btn block mt2" onclick="location.hash='#/'">Leave</button>
    </div></div>`);
  document.body.appendChild(ov);
}
