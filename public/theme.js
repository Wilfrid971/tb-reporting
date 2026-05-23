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
      '--bg': '#f0f2f7', '--surface': '#ffffff', '--surface2': '#f5f7fb',
      '--border': '#dde1ec', '--text': '#1a1d2e', '--muted': '#5a6380',
      '--text-muted': '#5a6380', '--blue': '#1976D2', '--accent': '#1976D2',
      '--green': '#388e3c', '--orange': '#f57c00', '--red': '#d32f2f', '--purple': '#7b1fa2',
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
      '--bg': '#eef1f7', '--surface': '#ffffff', '--surface2': '#f4f6fb',
      '--border': '#d0d7e8', '--text': '#1565C0', '--muted': '#5c7aa8',
      '--text-muted': '#5c7aa8', '--blue': '#1565C0', '--accent': '#1565C0',
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

  var saved = localStorage.getItem('tb_theme') || 'dark';
  applyTheme(saved);

  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    var t = (s.theme && s.theme.name) ? s.theme.name : 'dark';
    if (t !== localStorage.getItem('tb_theme')) applyTheme(t);
  }).catch(function () {});

  window.TB_THEMES = THEMES;
  window.applyTheme = applyTheme;
})();
