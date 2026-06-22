(function () {
  var THEMES = {
    dark: {
      label: 'Dark', icon: '🌑',
      '--bg': '#0f1117', '--surface': '#1a1d2e', '--surface2': '#1e2235',
      '--border': '#2a2d3e', '--text': '#e2e8f0', '--muted': '#8892a4',
      '--text-muted': '#8892a4', '--blue': '#2196F3', '--accent': '#2196F3',
      '--green': '#4CAF50', '--orange': '#FF9800', '--red': '#F44336', '--purple': '#9C27B0',
    },
    darkblue: {
      label: 'Dark Blue', icon: '🌊',
      '--bg': '#070d1f', '--surface': '#0d1830', '--surface2': '#112040',
      '--border': '#1a2a4a', '--text': '#dde8ff', '--muted': '#6878a0',
      '--text-muted': '#6878a0', '--blue': '#4d8fff', '--accent': '#4d8fff',
      '--green': '#40d080', '--orange': '#ffab40', '--red': '#ff5252', '--purple': '#ce93d8',
    },
    darkgreen: {
      label: 'Dark Vert', icon: '🌿',
      '--bg': '#091410', '--surface': '#0f1f18', '--surface2': '#132419',
      '--border': '#1a3325', '--text': '#d5ede3', '--muted': '#6a9080',
      '--text-muted': '#6a9080', '--blue': '#26a069', '--accent': '#26a069',
      '--green': '#66bb6a', '--orange': '#ffb74d', '--red': '#ef5350', '--purple': '#ab47bc',
    },
    light: {
      label: 'Clair', icon: '☀️',
      '--bg': '#eceff5', '--surface': '#ffffff', '--surface2': '#f3f5fa',
      '--border': '#d4d9e6', '--text': '#14171f', '--muted': '#454c61',
      '--text-muted': '#454c61', '--blue': '#1565C0', '--accent': '#1565C0',
      '--green': '#2e7d32', '--orange': '#e65100', '--red': '#c62828', '--purple': '#6a1b9a',
    },
    pro: {
      label: 'Gris Pro', icon: '🔥',
      '--bg': '#1a1a1a', '--surface': '#242424', '--surface2': '#2c2c2c',
      '--border': '#363636', '--text': '#e8e8e8', '--muted': '#909090',
      '--text-muted': '#909090', '--blue': '#FF9800', '--accent': '#FF9800',
      '--green': '#66bb6a', '--orange': '#ffa726', '--red': '#ef5350', '--purple': '#ab47bc',
    },
    grisbleu: {
      label: 'Gris & Bleu', icon: '🔷',
      // Texte = bleu nuit très foncé (lisible sur fond clair) ; le bleu vif reste
      // réservé aux accents (--blue/--accent), pas au corps de texte.
      '--bg': '#e9edf5', '--surface': '#ffffff', '--surface2': '#f1f4fa',
      '--border': '#cdd6e8', '--text': '#102a43', '--muted': '#3f587f',
      '--text-muted': '#3f587f', '--blue': '#1565C0', '--accent': '#1565C0',
      '--green': '#2e7d32', '--orange': '#e65100', '--red': '#c62828', '--purple': '#6a1b9a',
    },
  };

  function applyTheme(name) {
    var vars = THEMES[name] || THEMES.dark;
    var root = document.documentElement;
    for (var k in vars) {
      if (k.indexOf('--') === 0) root.style.setProperty(k, vars[k]);
    }
    localStorage.setItem('tb_theme', name);
  }

  // Thème PAR UTILISATEUR : priorité au thème du compte connecté (tb_user.theme,
  // alimenté par /api/auth login & me), puis dernier thème appliqué sur ce poste
  // (tb_theme), puis 'dark'. Plus de réglage global imposé à tous.
  function userTheme() {
    try {
      var u = JSON.parse(localStorage.getItem('tb_user') || 'null');
      if (u && u.theme && THEMES[u.theme]) return u.theme;
    } catch (e) {}
    return null;
  }
  applyTheme(userTheme() || localStorage.getItem('tb_theme') || 'dark');

  // Re-synchronise si la session (tb_user) est rafraîchie après coup (auth-client
  // refreshSession met à jour tb_user : un changement de thème fait sur un autre
  // poste se propage ainsi au prochain refresh, sans rechargement manuel).
  window.addEventListener('storage', function (e) {
    if (e.key === 'tb_user') {
      var t = userTheme();
      if (t && t !== localStorage.getItem('tb_theme')) applyTheme(t);
    }
  });

  window.TB_THEMES = THEMES;
  window.applyTheme = applyTheme;
  window.tbUserTheme = userTheme;
})();
