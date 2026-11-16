/* Tiny DOM + helper utilities. */
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function el(sel, root) { return (root || document).querySelector(sel); }
function els(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, kind = '') {
  const t = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
  el('#toast').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 4200 : 2600);
}
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}
function topbar() {
  const u = Store.user;
  let right = '';
  if (u) {
    const label = u.role === 'teacher' ? 'Teacher' : u.role === 'student' ? 'Student' : 'Admin';
    right = `
      <span class="pill">${esc(label)} · ${esc(u.full_name)}</span>
      ${u.role === 'teacher' ? '<a class="btn secondary" href="#/teacher">Console</a>' : ''}
      ${u.role === 'student' ? '<a class="btn secondary" href="#/dashboard">Dashboard</a>' : ''}
      <button class="btn ghost" id="logoutBtn">Log out</button>`;
  } else {
    right = `<a class="btn ghost" href="#/join">Join a quiz</a><a class="btn" href="#/login">Sign in</a>`;
  }
  const bar = h(`<div class="topbar">
    <a class="logo" href="#/"><span class="mark">◆</span> QuizArena</a>
    <div class="nav-actions">${right}</div>
  </div>`);
  const lb = el('#logoutBtn', bar);
  if (lb) lb.onclick = async () => { await API.post('/api/auth/logout'); Store.user = null; location.hash = '#/'; };
  return bar;
}
function mount(node) {
  const app = el('#app');
  app.innerHTML = '';
  app.appendChild(topbar());
  app.appendChild(node);
}
