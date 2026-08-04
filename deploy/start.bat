@echo off
chcp 65001 >nul
title FDQH Quality Hub

echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║   FosunDx Quality Hub (FDQH) Platform       ║
echo   ║   IVD 数字化质量管理平台 v2.16               ║
echo   ╚══════════════════════════════════════════════╝
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. Please install Node.js 18+
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

echo [INFO] Node.js version:
node -v

:: Check if node_modules exists
if not exist "..\node_modules" (
    echo.
    echo [INFO] Installing dependencies...
    cd ..
    npm install --production
    cd deploy
)

echo.
echo [INFO] Starting FDQH server...
echo [INFO] Default URL: http://localhost:3000
echo [INFO] Press Ctrl+C to stop
echo.

cd ..
node server.js
pause
