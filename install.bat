@echo off
setlocal enabledelayedexpansion
title TB Reporting - Installation

echo ============================================================
echo   TB Reporting - Script d'installation
echo ============================================================
echo.

:: ---- 1. Verification Node.js -------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js n'est pas installe ou absent du PATH.
    echo.
    echo Telecharger l'installateur LTS depuis :
    echo   https://nodejs.org/en/download/
    echo puis relancer ce script.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo [OK] Node.js detecte : !NODE_VERSION!
echo.

:: ---- 2. Creation dossiers ----------------------------------------------
if not exist "logs" (
    mkdir logs
    echo [OK] Dossier logs\ cree
)
if not exist "data" (
    mkdir data
    echo [OK] Dossier data\ cree
)
echo.

:: ---- 3. Fichier .env ---------------------------------------------------
if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
        echo [ATTENTION] Fichier .env cree depuis .env.example
        echo             Editez-le avant de demarrer le serveur.
    ) else (
        echo [ERREUR] Ni .env ni .env.example trouve. Fichier requis.
        pause
        exit /b 1
    )
) else (
    echo [OK] Fichier .env deja present
)
echo.

:: ---- 4. Installation des dependances -----------------------------------
echo Installation des dependances npm (peut prendre plusieurs minutes, telecharge Chromium)...
echo.
call npm install --production
if errorlevel 1 (
    echo.
    echo [ERREUR] npm install a echoue. Verifiez votre acces internet.
    pause
    exit /b 1
)
echo.
echo [OK] Dependances installees
echo.

:: ---- 5. Injection JWT_SECRET genere si encore sur la valeur par defaut --
findstr /C:"JWT_SECRET=CHANGEME" .env >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%s in ('node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"') do (
        set JWT_NEW=%%s
    )
    powershell -NoProfile -Command "(Get-Content .env -Raw) -replace 'JWT_SECRET=CHANGEME[^\r\n]*', 'JWT_SECRET=!JWT_NEW!' | Set-Content .env -NoNewline -Encoding utf8"
    echo [OK] JWT_SECRET genere et injecte dans .env
)
echo.

:: ---- 6. Saisie cle API Anthropic (optionnelle) -------------------------
findstr /C:"ANTHROPIC_API_KEY=CHANGEME" .env >nul 2>&1
if not errorlevel 1 (
    echo.
    echo --- Cle API Anthropic ---------------------------------------
    echo Recommande : creer un workspace dedie a ce client sur
    echo   https://console.anthropic.com/settings/workspaces
    echo puis generer une cle API ^(Settings ^> API Keys^) restreinte
    echo a ce workspace, et fixer une limite de depense mensuelle.
    echo.
    set /p "ANT_KEY=Cle API Anthropic (laisser vide pour saisir plus tard): "
    if defined ANT_KEY (
        powershell -NoProfile -Command "(Get-Content .env -Raw) -replace 'ANTHROPIC_API_KEY=CHANGEME', 'ANTHROPIC_API_KEY=!ANT_KEY!' | Set-Content .env -NoNewline -Encoding utf8"
        echo [OK] Cle Anthropic enregistree dans .env
    ) else (
        echo [INFO] Cle Anthropic non saisie - editer .env plus tard
    )
)
echo.

:: ---- 7. Recapitulatif --------------------------------------------------
echo ============================================================
echo   Installation terminee
echo ============================================================
echo.
echo Etapes suivantes :
echo.
echo   1. Editer le fichier .env avec les parametres du client :
echo        - DB_SERVER, DB_DATABASE, DB_USER, DB_PASSWORD
echo        - SMTP_USER, SMTP_PASS, SMTP_FROM
echo        - ANTHROPIC_API_KEY (si non saisie ci-dessus)
echo.
echo   2. Tester le demarrage manuel :
echo         node server\app.js
echo      puis ouvrir http://localhost:5000 ^(Ctrl+C pour stopper^)
echo.
echo   3. Ouvrir le port 5000 dans le pare-feu :
echo         netsh advfirewall firewall add rule name="TB Reporting" dir=in action=allow protocol=TCP localport=5000 profile=domain,private
echo.
echo   4. Installer comme service Windows avec NSSM ^(voir INSTALL.md section 2.8^)
echo.
echo Documentation complete : INSTALL.md
echo.
echo Ouverture de .env dans Notepad pour finaliser la configuration...
start notepad .env
echo.
pause
