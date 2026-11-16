/* Hash router. */
async function route() {
  const hash = location.hash || '#/';
  const [path, arg] = hash.replace(/^#\//, '').split('/');

  // ensure we know who's signed in for guarded pages
  if (Store.user === null && ['dashboard', 'teacher', 'field', 'edit'].includes(path)) {
    await Store.loadMe();
  }

  switch (path) {
    case '':          return pageLanding();
    case 'login':     return pageLogin();
    case 'register':  return pageRegister();
    case 'join':      return pageJoin();
    case 'dashboard': return pageDashboard();
    case 'field':     return pageField(arg);
    case 'teacher':   return pageTeacher();
    case 'edit':      return openQuizEditor(Number(arg));
    default:          return pageLanding();
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  await Store.loadMe();
  route();
});
