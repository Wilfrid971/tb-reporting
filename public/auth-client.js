// Client-side auth helper. Call AUTH.require('pageId') at top of each protected page.
const AUTH = (() => {
  const TOKEN_KEY = 'tb_token';
  const USER_KEY  = 'tb_user';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser()  {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }

  function logout(msg) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    const q = msg ? '?msg=' + encodeURIComponent(msg) : '';
    location.href = '/login.html?redirect=' + encodeURIComponent(location.pathname) + q;
  }

  function canAccess(type, id) {
    const user = getUser();
    if (!user) return false;
    const list = user[type]; // 'pages', 'dashboards', 'reports'
    if (!list) return false;
    return list.includes('*') || list.includes(id);
  }

  // Check if user can access a specific section within a page
  // Returns true if: full admin (*), page not restricted, or section explicitly allowed
  function canPageSection(page, section) {
    const user = getUser();
    if (!user) return false;
    if (user.pages?.includes('*')) return true;
    if (!user.pages?.includes(page)) return false;
    const perms = user.pagePerms || {};
    if (!perms[page]) return true; // page accessible, no section restriction
    return perms[page].includes('*') || perms[page].includes(section);
  }

  // Refresh user rights + rotate JWT via /api/auth/me — sans déconnexion.
  // Dédup des appels concurrents. Retourne true si OK, false si non auth, null si erreur réseau.
  let _refreshPromise = null;
  function refreshSession() {
    if (_refreshPromise) return _refreshPromise;
    const token = getToken();
    if (!token) return Promise.resolve(false);
    _refreshPromise = (async () => {
      try {
        const r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
        if (r.status === 401) { logout('Session expirée'); return false; }
        if (!r.ok) return null;
        const me = await r.json();
        if (me.token) {
          localStorage.setItem(TOKEN_KEY, me.token);
          delete me.token;
        }
        localStorage.setItem(USER_KEY, JSON.stringify(me));
        renderHeaderInfo();
        return true;
      } catch {
        return null;
      } finally {
        _refreshPromise = null;
      }
    })();
    return _refreshPromise;
  }

  // Affiche un écran plein écran (utilisé pour "Accès refusé" / "Vérification…")
  // Diffère jusqu'à DOMContentLoaded si <body> pas encore présent.
  function _showFullscreen(html) {
    const apply = () => { document.body.innerHTML = html; };
    if (document.body) apply();
    else document.addEventListener('DOMContentLoaded', apply);
  }

  // Call at top of every protected page. pageId = 'dashboard', 'backoffice', etc.
  function require(pageId) {
    const token = getToken();
    const user  = getUser();
    if (!token || !user) {
      location.href = '/login.html?redirect=' + encodeURIComponent(location.pathname);
      return false;
    }
    // Check token expiry (JWT exp claim)
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp && Date.now() / 1000 > payload.exp) {
        logout('Votre session a expiré, veuillez vous reconnecter');
        return false;
      }
    } catch { /* ignore */ }

    if (!canAccess('pages', pageId)) {
      // Les droits sont peut-être périmés — tente un refresh avant de refuser.
      refreshSession().then(ok => {
        if (ok && canAccess('pages', pageId)) {
          location.reload();
        } else {
          _showFullscreen('<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0f1117;color:#fca5a5;font-size:1.1rem">Accès refusé pour cette page.</div>');
        }
      });
      return false;
    }

    // Accès accordé — refresh en arrière-plan pour détecter les évolutions
    // (révocations / nouvelles sections accordées par l'admin).
    refreshSession();
    return true;
  }

  // Enrich fetch options with Authorization header
  function fetchOpts(opts) {
    const token = getToken();
    if (!token) return opts || {};
    return {
      ...(opts || {}),
      headers: { ...(opts?.headers || {}), Authorization: 'Bearer ' + token }
    };
  }

  // Authenticated fetch — auto-logout on 401
  async function apiFetch(url, opts) {
    const res = await fetch(url, fetchOpts(opts));
    if (res.status === 401) { logout('Session expirée'); return res; }
    return res;
  }

  // Install global fetch interceptor — adds Authorization header for all /api/* calls
  function installFetchInterceptor() {
    const _fetch = window.fetch.bind(window);
    window.fetch = function(url, opts) {
      const token = getToken();
      if (token && typeof url === 'string' && url.startsWith('/api/')) {
        opts = opts || {};
        opts.headers = Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {});
      }
      return _fetch(url, opts);
    };
  }

  // Injecte un badge "DB · Société" dans le <header> de la page.
  // Idempotent : si le badge existe déjà, met à jour le texte.
  function renderHeaderInfo() {
    const header = document.querySelector('header');
    if (!header) return;
    const user = getUser();
    if (!user) return;

    const dbName  = user.database || '';
    const societe = user.societe  || '';
    if (!dbName && !societe) return;

    let el = document.getElementById('db-info-badge');
    if (!el) {
      el = document.createElement('span');
      el.id = 'db-info-badge';
      el.style.cssText = 'font-size:.72rem;color:var(--muted,#94a3b8);background:var(--surface2,rgba(148,163,184,.1));border:1px solid var(--border,#2a2d3e);border-radius:999px;padding:3px 10px;margin-left:6px;display:inline-flex;align-items:center;gap:6px;white-space:nowrap';
      // Insertion : avant #header-user s'il existe, sinon avant le bouton Déconnexion, sinon à la fin
      const anchor = document.getElementById('header-user')
        || [...header.querySelectorAll('button')].find(b => /d[ée]connexion/i.test(b.textContent))
        || null;
      if (anchor) header.insertBefore(el, anchor);
      else header.appendChild(el);
    }
    const parts = [];
    if (dbName)  parts.push(`🗄️ ${dbName}`);
    if (societe) parts.push(societe);
    el.textContent = parts.join(' · ');
    el.title = societe ? `Base : ${dbName}\nSociété : ${societe}` : `Base : ${dbName}`;
  }

  // Auto-rafraîchissement : à chaque chargement de page + quand l'onglet
  // reprend le focus (admin a modifié les droits dans un autre onglet).
  if (typeof document !== 'undefined') {
    const run = () => { renderHeaderInfo(); refreshSession(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
    window.addEventListener('focus', () => { refreshSession(); });
  }

  return { getToken, getUser, logout, canAccess, canPageSection, require, fetchOpts, apiFetch, installFetchInterceptor, renderHeaderInfo, refreshSession };
})();
