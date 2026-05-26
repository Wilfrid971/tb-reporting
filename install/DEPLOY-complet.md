# Redéploiement complet — srv-impec (IMPECGWA)

Regroupe les correctifs mergés dans `main` :
- **PR #8** — `prix.js` : rapport prix prend `STATUT IN ('envoyee','validee')` (relevés prod).
- **PR #9** — `dashboard.html` : « Mois en cours » ne filtre plus comme YTD.
- **PR #10** — `prix.js` + `rapport-prix.html` : option client « Clients avec CA sur N/N-1 ».
- **PR #11** — `prix.js` + `rapport-prix.html` :
  - section « Produits concurrents non rattachés » (secteur → client → produit), web + Excel ;
  - relevés scopés par secteur d'activité du client relevé (plus de débordement inter-secteurs).
- **PR #12** — `prix.js` + `rapport-prix.html` :
  - arbre : colonne « Mon relevé moy » (relevés direct) vs « Concurrent moy » (via_concurrent), écart = mon relevé vs concurrent (plus le PV vendu) ;
  - articles relevés mais non vendus dans un secteur ajoutés à l'arbre (cartons=0) — plus de relevé perdu.

Le zip `install/tb-reporting-deploy.zip` est recompilé et contient tous ces correctifs.

> ⚠️ Backend modifié (`prix.js`) → **redémarrage du service obligatoire**.
> ⚠️ Front modifié (`dashboard.html`, `rapport-prix.html`, `rapport-ca.html`) → **Ctrl+F5** côté navigateurs.
> Le zip n'inclut **ni `data/` ni `.env`** → ils sont préservés. `package.json` inchangé → **pas de `npm install`**.

---

## Procédure (sur srv-impec, PowerShell admin)

```powershell
$APP = (nssm get TBReporting AppDirectory).Trim()

# 1. Sauvegardes horodatées
$ts = Get-Date -Format yyyyMMdd-HHmmss
Copy-Item "$APP\server" "$APP\server.bak-$ts" -Recurse -Force
Copy-Item "$APP\public" "$APP\public.bak-$ts" -Recurse -Force

# 2. Arrêt du service
nssm stop TBReporting

# 3. Extraction du zip par-dessus l'installation (data/ et .env préservés)
Expand-Archive -Path '<chemin>\tb-reporting-deploy.zip' -DestinationPath $APP -Force

# 4. Redémarrage (REQUIS : prix.js est du backend chargé en mémoire)
nssm start TBReporting

# 5. Vérifs serveur
nssm status TBReporting
Get-Content "$APP\logs\stdout.log" -Tail 20
```

## Vérifications fonctionnelles (navigateur, après Ctrl+F5)

| Correctif | Test | Attendu |
|---|---|---|
| PR #8 | Rapport **Prix concurrents** → Actualiser | Des relevés s'affichent (≈772 sur 90 j) |
| PR #9 | Dashboard → page intégrée → période **« Mois en cours »** | Mois courant (1er → aujourd'hui), distinct de YTD |
| PR #10 | Rapport Prix → sélecteur client | Option **« Clients avec CA sur N/N-1 »** (plus « fidèles N et N-2 ») |
| PR #11 | Rapport Prix → bas de page | Section **« Produits concurrents non rattachés »** (secteur → client) + onglet Excel |
| PR #11 | Rapport Prix → arbre | Prix relevé affiché **uniquement dans le secteur du client relevé** (pas de débordement) ; secteurs/articles vendus conservés |
| PR #12 | Rapport Prix → arbre | Colonne **« Mon relevé moy »** vs « Concurrent moy » ; **écart relevé** (mon relevé vs concurrent) ; article relevé non vendu (ex. Moët en Restaurant) **visible** (cartons=0) |
| (rappel) | Période **« YTD calendaire »** | 01/01/2026 → aujourd'hui (et non début d'exercice) |

## Contrôles de version sur le serveur (preuve avant/après)
```powershell
$APP = (nssm get TBReporting AppDirectory).Trim()
[bool](Select-String "$APP\server\routes\prix.js"      -Pattern "STATUT IN \('envoyee','validee'\)" -Quiet)  # True
[bool](Select-String "$APP\server\routes\prix.js"      -Pattern "isPeriodMode" -Quiet)                        # True
[bool](Select-String "$APP\server\routes\prix.js"      -Pattern "releveBySecteurArt" -Quiet)                   # True (scoping secteur)
[bool](Select-String "$APP\server\routes\prix.js"      -Pattern "concurrentsNonRattaches" -Quiet)             # True (non rattachés)
[bool](Select-String "$APP\public\rapport-prix.html"   -Pattern 'value="period"' -Quiet)                      # True
[bool](Select-String "$APP\server\routes\prix.js"      -Pattern "prix_mon_releve_moy_ht" -Quiet)              # True (mon relevé vs concurrent)
[bool](Select-String "$APP\public\rapport-prix.html"   -Pattern 'id="unmatched-section"' -Quiet)              # True (section non rattachés)
[bool](Select-String "$APP\public\rapport-prix.html"   -Pattern 'Mon relevé moy' -Quiet)                      # True (colonne arbre)
[bool](Select-String "$APP\public\dashboard.html"      -Pattern "Mois en cours = du 1er du mois" -Quiet)      # True
[bool](Select-String "$APP\public\rapport-ca.html"     -Pattern 'value="ytd"' -Quiet)                         # True
```

## Rollback
```powershell
$APP = (nssm get TBReporting AppDirectory).Trim()
nssm stop TBReporting
Remove-Item "$APP\server","$APP\public" -Recurse -Force
Rename-Item "$APP\server.bak-<ts>" "$APP\server"
Rename-Item "$APP\public.bak-<ts>" "$APP\public"
nssm start TBReporting
```
