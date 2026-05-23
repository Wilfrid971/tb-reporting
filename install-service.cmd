@echo off
setlocal EnableExtensions EnableDelayedExpansion
title TB Reporting - Installation service Windows (NSSM)

REM =============================================================
REM   TB Reporting - Installation comme service Windows via NSSM
REM   - Telecharge nssm.exe si absent
REM   - Cree/recree le service "TBReporting"
REM   - Demarrage automatique au boot, redemarrage auto si crash
REM   - Rotation des logs a 10 Mo
REM
REM   A lancer dans une invite PowerShell ou cmd ADMIN, depuis
REM   le dossier du projet (ex: D:\ia\tb_reporting).
REM =============================================================

REM ---- Configuration (modifier au besoin) ---------------------
set "SERVICE_NAME=TBReporting"
set "DISPLAY_NAME=TB Reporting"
set "DESCRIPTION=Serveur de reporting Wavesoft (Node.js)"
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "APP_SCRIPT=server\app.js"
set "LOG_DIR=%APP_DIR%\logs"
set "ROTATE_BYTES=10485760"
set "RESTART_DELAY=5000"

echo ============================================================
echo   TB Reporting - Installation du service Windows
echo ============================================================
echo.
echo   Dossier projet : %APP_DIR%
echo   Service        : %SERVICE_NAME%
echo.

REM ---- 1. Verification droits admin ---------------------------
net session >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Ce script doit etre lance en tant qu'administrateur.
    echo Clic droit sur le .cmd ^> "Executer en tant qu'administrateur"
    pause
    exit /b 1
)
echo [OK] Droits administrateur

REM ---- 2. Localiser Node --------------------------------------
where node >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] node.exe introuvable dans le PATH.
    echo Installer Node.js LTS depuis https://nodejs.org puis relancer.
    pause
    exit /b 1
)
for /f "delims=" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
echo [OK] Node detecte : %NODE_EXE%

REM ---- 3. Verification du script applicatif -------------------
if not exist "%APP_DIR%\%APP_SCRIPT%" (
    echo [ERREUR] Fichier introuvable : %APP_DIR%\%APP_SCRIPT%
    echo Lancer ce script depuis la racine du projet TB Reporting.
    pause
    exit /b 1
)
echo [OK] Script applicatif : %APP_SCRIPT%

REM ---- 4. NSSM : detecter ou telecharger ----------------------
where nssm >nul 2>&1
if errorlevel 1 (
    echo [INFO] nssm.exe absent du PATH - telechargement depuis nssm.cc...
    set "NSSM_TMP=%TEMP%\nssm-install"
    set "NSSM_ZIP=%TEMP%\nssm-install.zip"
    if exist "!NSSM_TMP!" rmdir /s /q "!NSSM_TMP!"
    powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile '%TEMP%\nssm-install.zip' -UseBasicParsing; Expand-Archive -Path '%TEMP%\nssm-install.zip' -DestinationPath '%TEMP%\nssm-install' -Force; Copy-Item '%TEMP%\nssm-install\nssm-2.24\win64\nssm.exe' '%WINDIR%\System32\nssm.exe' -Force; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
    if errorlevel 1 (
        echo [ERREUR] Telechargement NSSM echoue.
        echo Telecharger manuellement https://nssm.cc/release/nssm-2.24.zip
        echo puis copier win64\nssm.exe dans %%WINDIR%%\System32\
        pause
        exit /b 1
    )
    echo [OK] nssm.exe installe dans System32
) else (
    for /f "delims=" %%i in ('where nssm') do (
        if not defined NSSM_PATH set "NSSM_PATH=%%i"
    )
    echo [OK] nssm detecte : !NSSM_PATH!
)

REM ---- 5. Stopper le node manuel s'il tourne ------------------
echo [INFO] Arret eventuel des process node manuels...
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force" >nul 2>&1

REM ---- 6. Creer le dossier logs -------------------------------
if not exist "%LOG_DIR%" (
    mkdir "%LOG_DIR%"
    echo [OK] Dossier logs cree : %LOG_DIR%
) else (
    echo [OK] Dossier logs deja present
)

REM ---- 7. Si le service existe, l'arreter et le supprimer -----
sc query %SERVICE_NAME% >nul 2>&1
if not errorlevel 1 (
    echo [INFO] Service %SERVICE_NAME% existant - reconfiguration...
    nssm stop %SERVICE_NAME% >nul 2>&1
    nssm remove %SERVICE_NAME% confirm >nul 2>&1
    timeout /t 2 /nobreak >nul
)

REM ---- 8. Installer et configurer le service ------------------
echo [INFO] Creation du service...
nssm install %SERVICE_NAME% "%NODE_EXE%" "%APP_SCRIPT%"
if errorlevel 1 (
    echo [ERREUR] nssm install a echoue.
    pause
    exit /b 1
)
nssm set %SERVICE_NAME% AppDirectory       "%APP_DIR%"
nssm set %SERVICE_NAME% DisplayName        "%DISPLAY_NAME%"
nssm set %SERVICE_NAME% Description        "%DESCRIPTION%"
nssm set %SERVICE_NAME% Start              SERVICE_AUTO_START
nssm set %SERVICE_NAME% AppStdout          "%LOG_DIR%\stdout.log"
nssm set %SERVICE_NAME% AppStderr          "%LOG_DIR%\stderr.log"
nssm set %SERVICE_NAME% AppStdoutCreationDisposition 4
nssm set %SERVICE_NAME% AppStderrCreationDisposition 4
nssm set %SERVICE_NAME% AppRotateFiles     1
nssm set %SERVICE_NAME% AppRotateOnline    1
nssm set %SERVICE_NAME% AppRotateBytes     %ROTATE_BYTES%
nssm set %SERVICE_NAME% AppExit Default    Restart
nssm set %SERVICE_NAME% AppRestartDelay    %RESTART_DELAY%
echo [OK] Service configure

REM ---- 9. Demarrer le service ---------------------------------
echo [INFO] Demarrage du service...
nssm start %SERVICE_NAME%
if errorlevel 1 (
    echo [ERREUR] Demarrage echoue. Consulter %LOG_DIR%\stderr.log
    pause
    exit /b 1
)

REM ---- 10. Verification ---------------------------------------
timeout /t 3 /nobreak >nul
echo.
echo ============================================================
echo   Verification
echo ============================================================
sc query %SERVICE_NAME% | findstr /C:"STATE"
echo.
echo Dernieres lignes de stdout.log :
if exist "%LOG_DIR%\stdout.log" (
    powershell -NoProfile -Command "Get-Content '%LOG_DIR%\stdout.log' -Tail 15"
) else (
    echo (log non encore ecrit - reessayer dans quelques secondes)
)
echo.
echo ============================================================
echo   Service installe et demarre
echo ============================================================
echo.
echo Demarrage automatique au boot : OUI
echo Redemarrage auto en cas de crash : OUI ^(delai %RESTART_DELAY% ms^)
echo Rotation des logs a %ROTATE_BYTES% octets ^(%ROTATE_BYTES:~0,-6% Mo^)
echo.
echo Commandes utiles :
echo   nssm restart %SERVICE_NAME%        ^(redemarrer^)
echo   nssm stop    %SERVICE_NAME%
echo   nssm start   %SERVICE_NAME%
echo   nssm status  %SERVICE_NAME%
echo   nssm edit    %SERVICE_NAME%        ^(UI graphique^)
echo   nssm remove  %SERVICE_NAME% confirm ^(desinstaller^)
echo.
echo Logs en direct :
echo   powershell Get-Content "%LOG_DIR%\stdout.log" -Wait -Tail 50
echo.
pause
exit /b 0
