@echo off
chcp 65001 >nul
title FDQH - Update

echo ============================================
echo   FDQH Quality Hub - Sync Update
echo ============================================
echo.

cd /d "%~dp0\.."

:: Check git
where git >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Git not found. Please install Git:
    echo https://git-scm.com/downloads
    pause
    exit /b 1
)

echo [1/3] Fetching latest version...
git pull origin main

echo.
echo [2/3] Checking dependencies...
if exist "package.json" (
    git diff HEAD@{1} -- package.json | findstr "dependencies" >nul
    if %ERRORLEVEL% EQU 0 (
        echo [INFO] package.json changed, updating dependencies...
        npm install
    ) else (
        echo [INFO] Dependencies unchanged, skipping npm install
    )
)

echo.
echo [3/3] Restarting server...
echo [INFO] Press Ctrl+C to stop, then run start.bat to restart
echo.

node server.js
pause
