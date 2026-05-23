# TB Reporting

[![CI](https://github.com/Wilfrid971/tb-reporting/actions/workflows/ci.yml/badge.svg)](https://github.com/Wilfrid971/tb-reporting/actions/workflows/ci.yml)

Plateforme de reporting et tableaux de bord pour ERP **Wavesoft** (SQL Server). Conçue pour être déployée chez le client en LAN interne, sur Windows Server, en tant que service Windows.

## Aperçu

- **Stack** : Node.js 18+, Express 5, SQL Server (`mssql`), Puppeteer (PDF), ExcelJS, JWT, node-cron
- **Frontend** : HTML/JS vanilla, pas de framework — chaque rapport est une page autonome
- **Multi-base** : un compte peut interroger plusieurs bases Wavesoft (mono ou agrégat)
- **Diffusion** : exports Excel/PDF + envois e-mail planifiés (SMTP)
- **IA** : intégration Claude API (Anthropic SDK) pour assistance/analyse contextuelle

## Rapports disponibles

| Page | Contenu |
|---|---|
| `tb-reporting.html` | Vue consolidée multi-rapports (page d'accueil) |
| `rapport-ca.html` | CA jour / mois / année, comparatif N / N-1 / N-2 |
| `rapport-commerciaux.html` | Performance par commercial, marges |
| `rapport-reglement.html` | DSO, encours, échéances |
| `rapport-objectifs.html` | Réalisation vs objectifs annuels (avec simulation) |
| `rapport-secteur-marque.html` | Pénétration secteur × marque × famille — gaps client/article |
| `rapport-prix.html` | Suivi prix concurrents (sources externes) |
| `segmentation.html` | Analyse client par dimensions (catégorie, zone, branche…) |
| `stock.html` | États de stock, valorisation |
| `backoffice.html` | Configuration : sources, dimensions, dashboards, rapports, sources personnalisées |
| `dashboard.html` | Composition de tableaux de bord (widgets + iframes de rapports) |
| `settings.html` | Connexions multi-bases, paramètres SMTP, scheduling |

## Démarrage local

Prérequis : Node.js 18+, SQL Server accessible (instance locale ou distante).

```bash
npm install
cp .env.example .env
# éditer .env : DB_SERVER, DB_DATABASE, DB_USER, DB_PASSWORD, SMTP_*, ANTHROPIC_API_KEY
npm start            # production
npm run dev          # hot-reload (nodemon)
```

L'app écoute sur `http://localhost:5000`. Au premier lancement, créer un admin :

```bash
npm run init-db
```

## Structure

```
server/
  app.js               # bootstrap Express + cron + DB pools
  middleware/auth.js   # JWT, droits pages/dashboards/rapports
  routes/
    auth.js            # login, users, groups
    commercial.js      # CA, commerciaux, secteurs, marques, objectifs, prix
    backoffice.js      # rapports/dashboards configurables
    settings.js        # connexions multi-bases, SMTP, planification
    stock.js, prix.js, ai.js
config/
  database.js          # pools SQL Server (mono + multi-connexion)
  kpis.json            # définitions des KPI
public/                # pages HTML autonomes + helpers (auth-client.js, theme.js, utils.js)
data/                  # configs runtime (dashboards, rapports, groupes…)
install/               # zip de déploiement + données d'amorçage
```

## Déploiement

Voir [INSTALL.md](INSTALL.md) — déploiement complet sur Windows Server (service Windows via `install-service.cmd`).

Le zip de déploiement est généré dans `install/tb-reporting-deploy.zip` (cf. INSTALL.md §1 pour la commande de build).

## Sécurité

- Secrets non versionnés : `.env`, `data/users.json` (bcrypt), `data/connections.json` (mots de passe DB)
- Auth : JWT signé (`JWT_SECRET` obligatoire en prod), expiration 12h
- DB : compte SQL dédié recommandé (`create-sql-user.sql`) avec droits lecture seule sur Wavesoft

## Licence

Code propriétaire — usage interne client.
