# TB Reporting — Installation & Déploiement

Procédure de déploiement sur un serveur **Windows Server** en **LAN interne** (réseau client).

---

## Sommaire

1. [Préparation de l'archive](#1--préparation-de-larchive-côté-dev)
2. [Installation sur le serveur](#2--installation-sur-le-serveur-windows)
3. [Accès utilisateurs](#3--accès-utilisateurs-côté-client)
4. [Checklist de mise en service](#4--checklist-de-mise-en-service)
5. [Exploitation courante](#5--exploitation-courante)
6. [Points d'attention](#6--points-dattention)

---

## 1 — Préparation de l'archive (côté dév)

Sur la machine de dev, créer une archive ZIP à transmettre au client :

```bat
cd C:\Users\Wilfrid\Claude\Projects\TB_REPORTING

powershell -Command "Compress-Archive -Path server,public,config,scripts,package.json,package-lock.json,install.bat,.env.example,INSTALL.md -DestinationPath C:\Users\Wilfrid\Claude\Projects\TB_REPORTING\install\tb-reporting-deploy.zip -Force"
```

**À NE PAS inclure** dans l'archive :
- `node_modules/` → réinstallé sur la cible
- `.git/`
- `.env` (credentials spécifiques au client)
- `data/users.json` et autres données spécifiques

### Dossier `data/` à livrer séparément

Préparer un dossier `data/` de départ avec les fichiers suivants :

| Fichier | Contenu initial |
|---|---|
| `users.json` | uniquement le compte admin (voir ci-dessous) |
| `connections.json` | `[]` |
| `dashboards.json` | `[]` |
| `reports.json` | `[]` |
| `custom-sources.json` | `[]` |
| `custom-dimensions.json` | `[]` |
| `groups.json` | `[]` |
| `settings.json` | `{}` |
| `builtin-titles.json` | `{}` ou version courante |
| `builtin-schedules.json` | `{}` ou version courante |
| `kpis.json` | version courante |

**Fichier `users.json` de départ** (mot de passe admin = `admin`, à changer dès la 1ʳᵉ connexion) :

```json
[
  {
    "id": "usr-admin",
    "username": "admin",
    "password": "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
    "group": "grp-admin",
    "active": true
  }
]
```

---

## 2 — Installation sur le serveur Windows

### 2.1 Prérequis

À installer sur le serveur cible **avant** de lancer `install.bat` :

1. **Node.js LTS 20.x** — installateur MSI officiel https://nodejs.org
   *(cocher ou non les outils natifs, pas nécessaire ici)*
2. **Accès SQL Server** — un compte SQL dédié `tb_reporting` avec droits **SELECT** sur la base Wavesoft, OU authentification Windows sur le compte qui fera tourner le service
3. **Accès internet pendant l'install** — `npm install` télécharge Puppeteer/Chromium (~300 Mo)
   *Si le serveur est isolé : faire `npm install` côté dév, zipper `node_modules/`, transférer.*
4. **NSSM** (pour service Windows) — https://nssm.cc/download → extraire `nssm.exe` dans `C:\Windows\System32\`

### 2.2 Arborescence cible

```
C:\TB_Reporting\
  server\
  public\
  config\
  scripts\
  data\            (copier le dossier préparé)
  node_modules\    (créé par npm install)
  package.json
  package-lock.json
  install.bat
  .env             (créé à partir de .env.example)
  .env.example
  INSTALL.md
  logs\            (créé par install.bat)
```

### 2.3 Déploiement

1. Créer `C:\TB_Reporting\`
2. Extraire l'archive ZIP dans ce dossier
3. Copier le dossier `data/` préparé à la racine
4. **Ouvrir une invite de commande en tant qu'administrateur** dans `C:\TB_Reporting\`
5. Lancer :

```bat
install.bat
```

Le script va :
- Vérifier Node.js
- Créer les dossiers `logs\` et `data\` si absents
- Créer `.env` à partir de `.env.example` si absent
- Lancer `npm install --production` (télécharge Puppeteer)
- Proposer un `JWT_SECRET` aléatoire à coller dans `.env`

### 2.4 Configuration du fichier `.env`

Éditer `C:\TB_Reporting\.env` — toutes les valeurs `CHANGEME` doivent être remplacées :

```ini
PORT=5000

DB_SERVER=localhost
DB_PORT=1433
DB_DATABASE=WAVESOFT_PROD
DB_USER=tb_reporting
DB_PASSWORD=<mot de passe SQL dédié>
DB_ENCRYPT=false
DB_TRUST_SERVER_CERTIFICATE=true
DB_TRUSTED_CONNECTION=false

JWT_SECRET=<48 octets hex générés par install.bat>

SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=rapports@client.fr
SMTP_PASS=<mot de passe SMTP ou App Password>
SMTP_FROM=rapports@client.fr
```

Pour générer manuellement un `JWT_SECRET` solide :
```bat
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 2.5 Test manuel

```bat
cd C:\TB_Reporting
node server\app.js
```

La console doit afficher :
```
[DB] Connexion localhost/WAVESOFT_PROD — SQL (tb_reporting)
[DB] Connecté à WAVESOFT_PROD.
[SERVER] Dashboard disponible sur http://localhost:5000
```

Ouvrir un navigateur sur le serveur → `http://localhost:5000` → login `admin` / `admin` → **changer immédiatement le mot de passe** (Paramètres > Utilisateurs).

`Ctrl+C` pour stopper.

### 2.6 Règle de pare-feu

Ouvrir le port 5000 pour le LAN :

```bat
netsh advfirewall firewall add rule name="TB Reporting" dir=in action=allow protocol=TCP localport=5000 profile=domain,private
```

Les profils `domain` (domaine AD) et `private` (réseau privé) sont ouverts ; le profil `public` reste fermé par sécurité.

### 2.7 Test d'accès depuis un poste client

Depuis un autre poste du LAN, trouver l'IP du serveur :
```bat
ipconfig | findstr IPv4
```

Ouvrir `http://<IP-serveur>:5000` dans un navigateur. Login admin doit fonctionner.

### 2.8 Installation comme service Windows (démarrage auto)

Après avoir validé le démarrage manuel, créer le service via **NSSM**.

```bat
nssm install TBReporting
```

Une fenêtre graphique s'ouvre. Remplir :

**Onglet Application**
- *Path* : `C:\Program Files\nodejs\node.exe`
- *Startup directory* : `C:\TB_Reporting`
- *Arguments* : `server\app.js`

**Onglet Details**
- *Display name* : `TB Reporting`
- *Description* : `Serveur de reporting Wavesoft`
- *Startup type* : `Automatic`

**Onglet I/O**
- *Output (stdout)* : `C:\TB_Reporting\logs\stdout.log`
- *Error (stderr)*  : `C:\TB_Reporting\logs\stderr.log`

**Onglet File Rotation**
- Cocher *Replace existing Output / Error files*
- *Rotate Files* : cocher, seuil 10 Mo

**Onglet Log on**
- Laisser *Local System* par défaut
- Si `DB_TRUSTED_CONNECTION=true` : utiliser *This account* avec un compte Windows ayant droit SELECT sur la base Wavesoft

Cliquer **Install service**, puis démarrer :

```bat
nssm start TBReporting
```

Vérifier dans `services.msc` que **TB Reporting** est à l'état *En cours d'exécution* et en démarrage *Automatique*.

---

## 3 — Accès utilisateurs (côté client)

### 3.1 URL d'accès

Récupérer l'IP LAN du serveur :
```bat
ipconfig | findstr IPv4
```
Exemple : `192.168.1.50`

**URL à communiquer aux utilisateurs** :
```
http://192.168.1.50:5000
```

*(Optionnel)* Si le client a un DNS interne, créer un alias `tb-reporting.clientlocal` → `192.168.1.50` pour obtenir `http://tb-reporting.clientlocal:5000`.

### 3.2 Création des comptes utilisateurs

Connecté en `admin` :

1. **Paramètres > Utilisateurs & Groupes**
2. Créer les groupes voulus (ex : `Commerciaux`, `Direction`) avec leurs permissions
3. Ajouter les ~10 utilisateurs avec un mot de passe initial
4. Communiquer les identifiants aux utilisateurs en leur demandant de changer le mot de passe à la 1ʳᵉ connexion

### 3.3 Configuration métier initiale

- **Paramètres > Base de données** : vérifier/ajouter les connexions (multi-sociétés si applicable)
- **Paramètres > Email** : envoyer un email de test pour valider le SMTP
- **Backoffice > Pages intégrées** : saisir les titres pour *CA Global*, *CA par Commercial*, *Segmentation*
- Créer un rapport ou dashboard de démonstration pour valider la chaîne complète
- Tester l'envoi manuel ("Envoyer maintenant") d'un rapport intégré

---

## 4 — Checklist de mise en service

- [ ] Service `TBReporting` **démarré** et en mode **Automatique**
- [ ] Port **5000** ouvert en pare-feu (profils *domaine* + *privé*)
- [ ] Logs `[DB] Connecté à ...` visibles dans `logs\stdout.log`
- [ ] Mot de passe **admin changé**
- [ ] `JWT_SECRET` **unique** généré dans `.env`
- [ ] Test **envoi SMTP** OK
- [ ] Accès depuis un **poste client** du LAN fonctionne
- [ ] Un rapport planifié s'envoie par email (via "Envoyer maintenant")
- [ ] Titres des **pages intégrées** renseignés (backoffice)
- [ ] Génération **PDF** testée (si format activé)
- [ ] Génération **Excel** testée (si format activé)
- [ ] Plan de **sauvegarde** mis en place sur `C:\TB_Reporting\data\` et `.env`

---

## 5 — Exploitation courante

### Redémarrer le service
```bat
nssm restart TBReporting
```

### Consulter les logs en direct
```bat
powershell Get-Content C:\TB_Reporting\logs\stdout.log -Wait -Tail 50
```

### Mettre à jour le code
```bat
nssm stop TBReporting
:: Remplacer les fichiers dans server\, public\, config\
:: Si package.json a changé :
npm install --production
nssm start TBReporting
```

### Sauvegarde

Inclure dans le plan de sauvegarde du client :
- `C:\TB_Reporting\data\` — tous les JSON (users, rapports, dashboards, titres, plannings)
- `C:\TB_Reporting\.env` — credentials

Fréquence recommandée : quotidienne.

---

## 6 — Points d'attention

### Puppeteer / génération PDF
- Le flag `--no-sandbox` est déjà présent dans le code
- Le compte **Local System** doit avoir accès en lecture à `node_modules\`
- Tester la génération PDF dès la mise en service pour valider Chromium

### Timeouts SQL
- Si Wavesoft est lent sur de gros rapports : augmenter `DB_REQUEST_TIMEOUT` dans `.env`
- Exemple pour 60 secondes : `DB_REQUEST_TIMEOUT=60000`

### SMTP Microsoft 365 / Office 365
- Si le compte a la **MFA active**, utiliser un **App Password** à la place du mot de passe normal
- Vérifier que **SMTP AUTH** est activé côté tenant

### Clé API Anthropic (assistant IA)
TB Reporting utilise l'API Anthropic (modèle Claude Haiku) pour la génération de configurations à partir de descriptions en langage naturel.

**Procédure recommandée — un workspace par client :**

1. Connexion à https://console.anthropic.com avec le compte payeur (compte du dev/intégrateur)
2. **Settings → Workspaces → Create Workspace** : nommer le workspace au nom du client (ex : `Client-DUPONT`)
3. **Settings → Limits** (dans le workspace) : fixer une **limite de dépense mensuelle** (ex : 20 €) pour cadrer la conso
4. **Settings → API Keys → Create Key** :
   - Workspace : sélectionner le workspace du client
   - Name : `tb-reporting-client-XXX`
   - Copier la clé `sk-ant-api03-...` immédiatement (non récupérable ensuite)
5. Saisir cette clé dans `.env` du serveur client (variable `ANTHROPIC_API_KEY`) — `install.bat` propose la saisie interactive

**Avantages de cette organisation :**
- Suivi de consommation isolé par client (Usage → filtre par workspace)
- Limite de dépense par client → pas de mauvaises surprises
- Si une clé fuite, révocation pour ce client uniquement (sans impacter les autres)
- Refacturation possible avec marge sur la conso réelle

**Facturation :**
- Tous les workspaces sont facturés sur le **compte Anthropic principal** (carte / facturation enregistrées une seule fois)
- Pas de facturation directe au client par Anthropic — c'est à l'intégrateur de refacturer (forfait, conso + marge…)
- Coût indicatif : modèle utilisé = Haiku 4.5 (~0,80 € par million de tokens en entrée). Une utilisation typique « assistant IA » dans TB Reporting reste sous **quelques euros par mois et par client**.

**Révocation / rotation :**
- Console Anthropic → workspace → API Keys → bouton **Revoke**
- Créer une nouvelle clé, l'injecter dans le `.env` du client, redémarrer le service `nssm restart TBReporting`

### Mises à jour Node.js
- Rester sur la **même major** (20.x) pendant la phase de test
- Les changements de major peuvent nécessiter un nouveau `npm install` complet

### Sécurité LAN
- Le profil de pare-feu **public** reste fermé — ne pas l'ouvrir
- Pour un accès internet ultérieur : prévoir reverse proxy (IIS / Nginx) + HTTPS + auth renforcée

### Monitoring
- Consulter périodiquement `logs\stderr.log` pour détecter les erreurs récurrentes
- Tester mensuellement qu'un rapport planifié part bien à l'heure prévue
