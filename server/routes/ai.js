const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');

// ── Contexte métier injecté dans le system prompt ──────────────────────────────

const SYSTEM_PROMPT = `Tu es un assistant expert en configuration de rapports de vente pour TB Reporting, un outil connecté à un ERP Wavesoft (base SQL Server).

Tu génères des configurations JSON valides à partir de descriptions en langage naturel.

## Dimensions disponibles (champ "dimensions")

### Groupe Commercial/Représentant
- rep_nom : Nom du commercial
- rep_id  : ID du commercial (numérique)

### Groupe Client
- cli_nom      : Nom du client
- cli_cat      : Catégorie client
- cli_activite : Activité client
- cli_geo      : Zone géographique
- cli_branche  : Branche client
- cli_enseigne : Enseigne client
- cli_origine  : Origine client
- cli_cible1   : Cible 1 client
- cli_cible2   : Cible 2 client

### Groupe Article
- art_famille    : Famille article
- art_sousfamille: Sous-famille article
- art_categorie  : Catégorie article
- art_nature     : Nature article
- art_collection : Collection article
- art_marque     : Marque article
- art_classe     : Classe article
- art_ref        : Référence article (ARTCODE) — niveau ligne
- art_designation: Désignation article — niveau ligne

### Groupe Période
- time_annee    : Année
- time_mois     : Mois (numéro)
- time_mois_lib : Mois (libellé)
- time_anneemois: Année-Mois (ex: 2024-03)
- time_semaine  : Semaine (ex: 2024-S12)
- time_jour     : Jour (numéro)
- time_date     : Date complète

Note : les dimensions art_ref, art_designation, art_famille, art_sousfamille, art_categorie, art_nature, art_collection, art_marque, art_classe sont de niveau "ligne" (plus lentes). Les autres sont de niveau "header" (rapides).

## Indicateurs disponibles (champ "measures")

- ca        : CA HT en euros
- qte       : Quantité vendue
- marge_sf  : Marge brute sans frais (CA - coût)
- marge_af  : Marge nette avec frais (CA - coût - frais)
- frais     : Frais de port/logistique
- pr_crump  : Total prix de revient CRUMP (stock moyen)
- pr_prmp   : Total prix de revient PRMP
- pr_last   : Total dernier prix de revient

## Période (champ filters.periode_debut / periode_fin)

- "" ou absent : toutes les données
- "ytd"        : Année en cours du 01/01 à aujourd'hui
- "mtd"        : Mois en cours du 01/MM à aujourd'hui
- "2024"       : Toute l'année 2024
- "2023"       : Toute l'année 2023
- Deux champs : periode_debut="2023", periode_fin="2024" → de 2023 à 2024

## Format JSON de sortie

Tu dois retourner UNIQUEMENT un objet JSON valide, sans texte avant ni après, sans bloc markdown.

### Structure :
\`\`\`
{
  "source": {
    "name": "Nom de la source de données",
    "dimensions": ["dim1", "dim2"],
    "measures": ["ca", "marge_sf"],
    "pivot": false,
    "pivotCols": [],
    "ruptures": [],
    "limit": 20,
    "filters": {
      "periode_debut": "ytd",
      "periode_fin": "",
      "mois": "",
      "repid": ""
    }
  },
  "widgets": [
    {
      "title": "Titre du widget",
      "displayType": "table",
      "chartType": "bar",
      "chartMeasure": "ca",
      "width": "full"
    }
  ],
  "target": "dashboard",
  "name": "Nom du rapport/tableau de bord",
  "description": "Description courte",
  "explanation": "Explication courte en français de ce qui a été généré"
}
\`\`\`

### Règles :
- "target" : "source" (source seule), "report" (rapport email), "dashboard" (tableau de bord)
- "displayType" : "table", "chart", ou "kpi"
- "chartType" : "bar", "line", "doughnut"
- "chartMeasure" : clé d'un indicateur de la liste measures
- "width" : "full", "half", "third"
- "pivot" : true pour mettre une dimension en colonnes (ex: années en colonnes)
- "pivotCols" : liste des IDs de dimensions à mettre en colonnes
- "ruptures" : liste des IDs de dimensions pour grouper en sous-totaux (ex: ["rep_nom"])
- "limit" : entre 5 et 200, défaut 20
- Tu peux générer plusieurs widgets (ex: un tableau + un graphique sur la même source)
- Si l'utilisateur parle de "pivot" ou "évolution par année", utilise pivot:true avec time_annee dans pivotCols

### Exemples d'interprétation :
- "par commercial" → dimensions: ["rep_nom"]
- "par famille d'articles" → dimensions: ["art_famille"]
- "évolution mensuelle" → dimensions: ["time_anneemois"] ou dimensions: ["time_annee", "time_mois_lib"] avec pivot
- "avec sous-totaux par commercial puis famille" → ruptures: ["rep_nom", "art_famille"]
- "cette année" → filters.periode_debut: "ytd"
- "l'année dernière" → filters.periode_debut: "2024" (ou l'année précédente)
- "comparaison N/N-1" → pivot:true, pivotCols:["time_annee"], dimensions:[...autres dims..., "time_annee"]
- "top 10" → limit: 10
- "en graphique barres" → displayType:"chart", chartType:"bar"

Réponds UNIQUEMENT avec le JSON, sans aucun texte avant ou après.`;

// ── Route ──────────────────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  const { prompt, target, messages } = req.body;
  if (!prompt?.trim() && !messages?.length) return res.status(400).json({ error: 'Prompt vide' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configurée dans .env' });

  try {
    const client = new Anthropic({ apiKey });

    // Multi-turn: use provided messages array, or build from single prompt
    let convMessages;
    if (messages?.length) {
      convMessages = messages;
    } else {
      const userMsg = target
        ? `Génère une configuration de type "${target}" pour : ${prompt}`
        : prompt;
      convMessages = [{ role: 'user', content: userMsg }];
    }

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: convMessages,
    });

    const raw = message.content[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'Réponse IA invalide', raw });

    let config;
    try {
      config = JSON.parse(jsonMatch[0]);
    } catch {
      return res.status(422).json({ error: 'JSON invalide dans la réponse IA', raw });
    }

    res.json({ ok: true, config, assistantRaw: raw });
  } catch (err) {
    console.error('[AI]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
