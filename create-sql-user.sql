-- ═══════════════════════════════════════════════════════════════════════════
--   TB Reporting — Création du compte SQL Server dédié
-- ═══════════════════════════════════════════════════════════════════════════
--
--   À exécuter dans SQL Server Management Studio (SSMS) en tant que "sa"
--   ou avec un compte membre du rôle sysadmin.
--
--   Prérequis : SQL Server en mode d'authentification mixte
--               (Properties > Security > SQL Server and Windows Authentication
--                mode > redémarrer le service SQL Server)
--
-- ───────────────────────────────────────────────────────────────────────────
--   AVANT D'EXÉCUTER : ouvrir ce fichier dans SSMS, utiliser
--   Edit > Find and Replace > Quick Replace (Ctrl+H) pour remplacer :
--
--     MOTDEPASSE_A_CHANGER  →  <votre mot de passe fort>
--     WAVESOFT_PROD         →  <nom réel de la base Wavesoft>
--
--   (Le nom du compte reste "tb_reporting" sauf cas particulier.)
-- ───────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
--   1) Création du LOGIN au niveau instance
-- ═══════════════════════════════════════════════════════════════════════════
USE master;
GO

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'tb_reporting')
BEGIN
    CREATE LOGIN [tb_reporting]
    WITH PASSWORD         = 'MOTDEPASSE_A_CHANGER',
         DEFAULT_DATABASE = [WAVESOFT_PROD],
         CHECK_POLICY     = ON,
         CHECK_EXPIRATION = OFF;
    PRINT '[OK] Login tb_reporting créé.';
END
ELSE
    PRINT '[INFO] Login tb_reporting déjà existant — ignoré.';
GO


-- ═══════════════════════════════════════════════════════════════════════════
--   2) Droit VIEW ANY DATABASE
--      (nécessaire pour lister les bases dans Paramètres > Connexions)
-- ═══════════════════════════════════════════════════════════════════════════
GRANT VIEW ANY DATABASE TO [tb_reporting];
GO


-- ═══════════════════════════════════════════════════════════════════════════
--   3) Création du USER dans la base principale + droits LECTURE SEULE
-- ═══════════════════════════════════════════════════════════════════════════
USE [WAVESOFT_PROD];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'tb_reporting')
BEGIN
    CREATE USER [tb_reporting] FOR LOGIN [tb_reporting];
    PRINT '[OK] User tb_reporting créé dans WAVESOFT_PROD.';
END
ELSE
    PRINT '[INFO] User tb_reporting déjà existant dans WAVESOFT_PROD — ignoré.';
GO

ALTER ROLE db_datareader ADD MEMBER [tb_reporting];
GO

GRANT VIEW DEFINITION TO [tb_reporting];
GO

PRINT '[OK] Droits db_datareader + VIEW DEFINITION accordés sur WAVESOFT_PROD.';
GO


-- ═══════════════════════════════════════════════════════════════════════════
--   4) [OPTIONNEL] Répéter pour d'autres bases (multi-sociétés)
--      Décommenter le bloc et remplacer WAVESOFT_SOCIETE2 / _3 par les
--      noms réels. Dupliquer autant de fois que nécessaire.
-- ───────────────────────────────────────────────────────────────────────────

/*
USE [WAVESOFT_SOCIETE2];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'tb_reporting')
    CREATE USER [tb_reporting] FOR LOGIN [tb_reporting];
GO
ALTER ROLE db_datareader ADD MEMBER [tb_reporting];
GO
GRANT VIEW DEFINITION TO [tb_reporting];
GO

USE [WAVESOFT_SOCIETE3];
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'tb_reporting')
    CREATE USER [tb_reporting] FOR LOGIN [tb_reporting];
GO
ALTER ROLE db_datareader ADD MEMBER [tb_reporting];
GO
GRANT VIEW DEFINITION TO [tb_reporting];
GO
*/


-- ═══════════════════════════════════════════════════════════════════════════
--   5) Vérification finale
-- ═══════════════════════════════════════════════════════════════════════════
USE [WAVESOFT_PROD];
GO

SELECT
    sp.name              AS login_name,
    sp.type_desc         AS login_type,
    sp.is_disabled       AS disabled,
    dp.name              AS db_user,
    STUFF((SELECT ', ' + r.name
           FROM sys.database_role_members rm
           JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
           WHERE rm.member_principal_id = dp.principal_id
           FOR XML PATH('')), 1, 2, '') AS roles
FROM sys.server_principals sp
LEFT JOIN sys.database_principals dp ON dp.name = sp.name
WHERE sp.name = 'tb_reporting';
GO

PRINT '═══════════════════════════════════════════════════════════';
PRINT '  Installation terminée. Reporter dans le fichier .env :';
PRINT '    DB_USER=tb_reporting';
PRINT '    DB_PASSWORD=<le mot de passe défini plus haut>';
PRINT '    DB_DATABASE=WAVESOFT_PROD';
PRINT '═══════════════════════════════════════════════════════════';
GO


-- ═══════════════════════════════════════════════════════════════════════════
--   SUPPRESSION / ROLLBACK (à décommenter si besoin)
--   Il faut DROP USER dans CHAQUE base avant le DROP LOGIN final.
-- ═══════════════════════════════════════════════════════════════════════════

/*
USE [WAVESOFT_PROD];
GO
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'tb_reporting')
    DROP USER [tb_reporting];
GO

-- Répéter le DROP USER dans chaque base supplémentaire ici avant de passer
-- au DROP LOGIN ci-dessous.

USE master;
GO
IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'tb_reporting')
    DROP LOGIN [tb_reporting];
GO
*/
