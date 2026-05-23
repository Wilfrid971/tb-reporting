(function () {
  var MOIS_COURT_FR = ['jan.','fév.','mar.','avr.','mai','jun.','jul.','aoû.','sep.','oct.','nov.','déc.'];
  var MOIS_LONG_FR  = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];

  var DATE_FORMATS = {
    'DD/MM/YYYY':  { label: 'JJ/MM/AAAA',  exemple: '15/04/2025' },
    'DD/MM/YY':    { label: 'JJ/MM/AA',    exemple: '15/04/25'   },
    'DD-MM-YYYY':  { label: 'JJ-MM-AAAA',  exemple: '15-04-2025' },
    'YYYY-MM-DD':  { label: 'AAAA-MM-JJ',  exemple: '2025-04-15' },
    'DD MMM YYYY': { label: 'JJ MMM AAAA', exemple: '15 avr. 2025' },
    'DD MMMM YYYY':{ label: 'JJ MMMM AAAA',exemple: '15 avril 2025' },
  };

  function formatDate(isoStr, fmt) {
    if (!isoStr) return '';
    var f = fmt || localStorage.getItem('tb_date_format') || 'DD/MM/YYYY';
    var d = new Date((isoStr.length > 10 ? isoStr : isoStr + 'T00:00:00'));
    if (isNaN(d)) return isoStr;
    var dd   = String(d.getDate()).padStart(2, '0');
    var mm   = String(d.getMonth() + 1).padStart(2, '0');
    var yy   = String(d.getFullYear()).slice(2);
    var yyyy = String(d.getFullYear());
    var mmm  = MOIS_COURT_FR[d.getMonth()];
    var mmmm = MOIS_LONG_FR[d.getMonth()];
    switch (f) {
      case 'DD/MM/YYYY':   return dd + '/' + mm + '/' + yyyy;
      case 'DD/MM/YY':     return dd + '/' + mm + '/' + yy;
      case 'DD-MM-YYYY':   return dd + '-' + mm + '-' + yyyy;
      case 'YYYY-MM-DD':   return yyyy + '-' + mm + '-' + dd;
      case 'DD MMM YYYY':  return dd + ' ' + mmm + ' ' + yyyy;
      case 'DD MMMM YYYY': return dd + ' ' + mmmm + ' ' + yyyy;
      default:             return dd + '/' + mm + '/' + yyyy;
    }
  }

  // Reformate toutes les dates ISO (YYYY-MM-DD) dans une chaîne
  function formatDatesInLabel(str) {
    if (!str) return str;
    return str.replace(/\d{4}-\d{2}-\d{2}/g, function (d) { return formatDate(d); });
  }

  // Supprime le préfixe "01 - " des libellés de mois (ex: "01 - Janvier" → "Janvier")
  function stripSortPrefix(str) {
    if (!str) return str;
    return str.split(' / ').map(function(p) { return p.replace(/^\d{2} - /, ''); }).join(' / ');
  }

  // Formate un libellé : dates ISO + suppression du préfixe numérique des mois
  function formatLabel(str) {
    return stripSortPrefix(formatDatesInLabel(str));
  }

  function setDateFormat(fmt) {
    localStorage.setItem('tb_date_format', fmt);
  }

  // Sync avec le serveur en arrière-plan
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    var fmt = s.app && s.app.dateFormat ? s.app.dateFormat : 'DD/MM/YYYY';
    if (fmt !== localStorage.getItem('tb_date_format')) setDateFormat(fmt);
  }).catch(function () {});

  window.TB_DATE_FORMATS    = DATE_FORMATS;
  window.formatDate         = formatDate;
  window.formatDatesInLabel = formatDatesInLabel;
  window.stripSortPrefix    = stripSortPrefix;
  window.formatLabel        = formatLabel;
  window.setDateFormat      = setDateFormat;
})();
