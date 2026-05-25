# Déploiement hotfix — Rapport prix vide en prod (STATUT 'validee')

**Contexte** : le rapport prix filtrait `STATUT='envoyee'`, or en prod (IMPECGWA / `srv-impec\wavesoft`)
les relevés sont en `STATUT='validee'` → rapport vide. Correctif = `prix.js` filtre désormais
`STATUT IN ('envoyee','validee')`. Voir PR #8.

**Portée** : 1 seul fichier modifié (`server/routes/prix.js`), aucune dépendance changée
→ **pas de `npm install`**, juste remplacer le fichier et redémarrer le service.

---

## Option A — Hotfix 1 fichier (recommandé)

À exécuter **sur srv-impec**, dans une invite **PowerShell en administrateur**.

### 1. Repérer le dossier d'installation
```powershell
nssm get TBReporting AppDirectory
```
Noter le chemin retourné (ex. `C:\TB_Reporting`). On l'appelle `$APP` ci-dessous :
```powershell
$APP = (nssm get TBReporting AppDirectory).Trim()
$prix = Join-Path $APP 'server\routes\prix.js'
```

### 2. Sauvegarder la version actuelle (rollback)
```powershell
Copy-Item $prix "$prix.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
```

### 3. Transférer le nouveau `prix.js`
Copier le fichier corrigé depuis le poste de dev (via le partage VPN / RDP) vers
`$APP\server\routes\prix.js`. Source côté dev :
`C:\Users\Wilfrid\Claude\Projects\TB_REPORTING\server\routes\prix.js`

> Le fichier corrigé est aussi dans le zip recompilé `install\tb-reporting-deploy.zip`
> (entrée `server/routes/prix.js`) si tu préfères extraire depuis l'archive.

### 4. Redémarrer le service
```powershell
nssm restart TBReporting
```

### 5. Vérifier
```powershell
# Service en cours d'exécution
nssm status TBReporting
# Démarrage propre dans les logs
Get-Content "$APP\logs\stdout.log" -Tail 20
```
Puis ouvrir le **rapport prix** dans le navigateur → cliquer **Actualiser** :
des relevés doivent apparaître (fenêtre 90 j par défaut). Si la section reste vide
alors que les KPI/arbre s'affichent, passer le sélecteur **client** sur « Tous »
(certains clients prod peuvent être inactifs).

### Rollback si besoin
```powershell
Copy-Item "$prix.bak-XXXX" $prix -Force   # remettre le .bak horodaté
nssm restart TBReporting
```

---

## Option B — Redéploiement complet par le zip

Si tu préfères repartir de l'archive (le zip ne contient ni `data/` ni `.env`,
ils sont donc préservés) :

```powershell
$APP = (nssm get TBReporting AppDirectory).Trim()
nssm stop TBReporting
# Extraire le zip par-dessus l'installation (écrase server\ public\ config\ scripts\)
Expand-Archive -Path '<chemin>\tb-reporting-deploy.zip' -DestinationPath $APP -Force
# package.json inchangé ici → npm install NON nécessaire.
# (À ne lancer QUE si package.json/package-lock.json ont changé :)
#   cd $APP ; npm install --production
nssm start TBReporting
Get-Content "$APP\logs\stdout.log" -Tail 20
```

---

## Vérification SQL (optionnelle, depuis le dev via VPN)
Confirmer que des relevés `validee` existent bien dans la fenêtre :
```sql
SELECT COUNT(*) FROM EXT_RELEVE_PRIX
WHERE STATUT IN ('envoyee','validee') AND PRIX_RELEVE IS NOT NULL
  AND DATE_RELEVE >= DATEADD(day,-90,CAST(GETDATE() AS date));
-- attendu : > 0 (≈ 772 au 2026-05-25)
```
