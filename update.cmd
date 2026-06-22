@echo off
setlocal EnableExtensions EnableDelayedExpansion
title TB Reporting - Mise a jour (service NSSM)

REM =============================================================
REM   TB Reporting - Mise a jour apres extraction d'un nouveau zip
REM   - Arrete le service TBReporting
REM   - Relance "npm install --production" UNIQUEMENT si les
REM     dependances ont change (hash de package-lock.json)
REM   - Redemarre le service
REM
REM   A lancer en ADMIN, depuis le dossier du projet, APRES avoir
REM   extrait le nouveau zip par-dessus (server\, public\, config\).
REM =============================================================

set "SERVICE_NAME=TBReporting"
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "LOG_DIR=%APP_DIR%\logs"
set "HASH_FILE=%LOG_DIR%\.pkg-hash"
set "LOCK_FILE=%APP_DIR%\package-lock.json"

echo ============================================================
echo   TB Reporting - Mise a jour
echo   Dossier : %APP_DIR%
echo ============================================================
echo.

REM ---- 1. Droits admin ---------------------------------------
net session >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] A lancer en tant qu'administrateur.
    echo Clic droit ^> "Executer en tant qu'administrateur"
    pause
    exit /b 1
)

REM ---- 2. Le service doit exister ----------------------------
sc query %SERVICE_NAME% >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Service %SERVICE_NAME% introuvable.
    echo Lancer d'abord install-service.cmd ^(installation initiale^).
    pause
    exit /b 1
)

REM ---- 3. nssm disponible ? ----------------------------------
where nssm >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] nssm.exe introuvable dans le PATH.
    echo Relancer install-service.cmd pour le mettre en place.
    pause
    exit /b 1
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM ---- 4. Arret du service -----------------------------------
echo [INFO] Arret du service...
nssm stop %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul
echo [OK] Service arrete

REM ---- 5. Dependances : npm install seulement si change -------
set "DOINSTALL="
if not exist "%APP_DIR%\node_modules" (
    echo [INFO] node_modules absent - npm install requis.
    set "DOINSTALL=1"
) else if not exist "%LOCK_FILE%" (
    echo [INFO] package-lock.json absent - npm install par securite.
    set "DOINSTALL=1"
) else (
    set "NEWHASH="
    for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash '%LOCK_FILE%' -Algorithm SHA256).Hash" 2^>nul') do set "NEWHASH=%%H"
    set "OLDHASH="
    if exist "%HASH_FILE%" set /p OLDHASH=<"%HASH_FILE%"
    if /i "!NEWHASH!"=="!OLDHASH!" (
        echo [OK] Dependances inchangees - npm install ignore.
    ) else (
        echo [INFO] package-lock.json modifie - npm install requis.
        set "DOINSTALL=1"
    )
)

if defined DOINSTALL (
    echo [INFO] npm install --production ^(peut prendre plusieurs minutes^)...
    call npm install --production --no-audit --no-fund
    if errorlevel 1 (
        echo [ERREUR] npm install a echoue. Service NON redemarre.
        echo Corriger puis relancer ce script.
        pause
        exit /b 1
    )
    REM Memorise le hash courant pour la prochaine fois
    for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash '%LOCK_FILE%' -Algorithm SHA256).Hash" 2^>nul') do > "%HASH_FILE%" echo %%H
    echo [OK] Dependances a jour
)

REM ---- 6. Redemarrage ----------------------------------------
echo [INFO] Demarrage du service...
nssm start %SERVICE_NAME%
if errorlevel 1 (
    echo [ERREUR] Demarrage echoue. Voir %LOG_DIR%\stderr.log
    pause
    exit /b 1
)

timeout /t 3 /nobreak >nul
echo.
echo ============================================================
echo   Etat du service
echo ============================================================
sc query %SERVICE_NAME% | findstr /C:"STATE"
echo.
if exist "%LOG_DIR%\stdout.log" (
    echo Dernieres lignes de stdout.log :
    powershell -NoProfile -Command "Get-Content '%LOG_DIR%\stdout.log' -Tail 12"
)
echo.
echo ============================================================
echo   Mise a jour terminee.
echo   Pensez a vider le cache navigateur : Ctrl+F5
echo ============================================================
echo.
pause
exit /b 0
