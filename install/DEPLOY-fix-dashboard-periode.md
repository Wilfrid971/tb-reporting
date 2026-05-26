# Déploiement hotfix — « Mois en cours » sans effet (dashboard)

**Contexte** : dans le sélecteur de période des pages intégrées, « Mois en cours » envoyait
le même `annee='ytd'` que « YTD calendaire » (copier-coller `mtd → ytd`) → aucun effet.
Correctif = `public/dashboard.html`. Voir PR #9.

**Portée** : 1 seul fichier **front statique** (`public/dashboard.html`).
- ❌ Pas de `npm install` (aucune dépendance modifiée).
- ❌ **Pas besoin de redémarrer le service** : `express.static` relit le fichier du disque
  à chaque requête. (Un `nssm restart TBReporting` ne fait pas de mal mais est inutile ici.)
- ⚠️ Le vrai piège est le **cache navigateur** côté utilisateurs → rechargement forcé.

---

## Option A — Hotfix 1 fichier (recommandé)

À exécuter **sur srv-impec**, dans une invite **PowerShell** (admin pas indispensable ici,
mais cohérent avec la procédure prix).

### 1. Repérer le dossier d'installation
```powershell
$APP  = (nssm get TBReporting AppDirectory).Trim()
$dash = Join-Path $APP 'public\dashboard.html'
```

### 2. Sauvegarder la version actuelle (rollback)
```powershell
Copy-Item $dash "$dash.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
```

### 3. Transférer le nouveau `dashboard.html`
Copier le fichier corrigé depuis le poste de dev (via le partage VPN / RDP) vers
`$APP\public\dashboard.html`. Source côté dev :
`C:\Users\Wilfrid\Claude\Projects\TB_REPORTING\public\dashboard.html`

> Également présent dans le zip recompilé `install\tb-reporting-deploy.zip`
> (entrée `public/dashboard.html`) si tu préfères extraire depuis l'archive.

### 4. (Optionnel) Forcer une relecture propre
Le fichier statique est servi immédiatement ; rien à redémarrer. Si tu veux malgré tout :
```powershell
nssm restart TBReporting
```

### 5. Vider le cache côté navigateur (ÉTAPE CLÉ)
Sur chaque poste utilisateur, recharger le dashboard avec **Ctrl+F5** (ou Maj+clic sur ↻).
`express.static` envoie des en-têtes `ETag`/`Last-Modified` (revalidation), donc un
rechargement normal suffit en général ; **Ctrl+F5** garantit la prise en compte.

### 6. Vérifier
Ouvrir le dashboard → page intégrée (ex. *CA Global*) :
- Choisir **« Mois en cours »** → les chiffres doivent correspondre au **mois courant**
  (1er du mois → aujourd'hui), **distincts** de « YTD calendaire ».
- Choisir **« YTD calendaire »** → inchangé (depuis le 01/01).

### Rollback si besoin
```powershell
Copy-Item "$dash.bak-XXXX" $dash -Force   # remettre le .bak horodaté
# (recharger Ctrl+F5 côté navigateur)
```

---

## Option B — Redéploiement complet par le zip
Le zip ne contient ni `data/` ni `.env` (préservés) :
```powershell
$APP = (nssm get TBReporting AppDirectory).Trim()
Expand-Archive -Path '<chemin>\tb-reporting-deploy.zip' -DestinationPath $APP -Force
# package.json inchangé → npm install NON nécessaire ; service restart non requis (fichiers statiques).
```
Puis **Ctrl+F5** côté navigateur.

> Note : le zip courant contient AUSSI le correctif `server/routes/prix.js` (PR #8).
> Un redéploiement complet applique donc les deux à la fois.
