#!/bin/bash
# FDQH Update Script - Sync latest code and restart
# Usage: chmod +x update.sh && ./update.sh

set -e

echo "============================================"
echo "  FDQH Quality Hub - Sync Update"
echo "============================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
cd "$APP_DIR"

# Check git
if ! command -v git &> /dev/null; then
    echo "[ERROR] Git not found. Please install Git:"
    echo "        Ubuntu/Debian: sudo apt install git"
    echo "        CentOS/RHEL:   sudo yum install git"
    exit 1
fi

# Stop existing process
echo "[0/3] Stopping existing process..."
if command -v pm2 &> /dev/null; then
    pm2 stop fdqh 2>/dev/null || true
fi
pkill -f "node server.js" 2>/dev/null || true
sleep 1

# Pull latest
echo "[1/3] Fetching latest version..."
git pull origin main

# Check dependencies changed
echo "[2/3] Checking dependencies..."
if git diff HEAD@{1} -- package.json 2>/dev/null | grep -q "dependencies"; then
    echo "[INFO] package.json changed, updating dependencies..."
    npm install
else
    echo "[INFO] Dependencies unchanged"
fi

# Restart
echo "[3/3] Restarting server..."
echo ""

if command -v pm2 &> /dev/null && pm2 list 2>/dev/null | grep -q fdqh; then
    pm2 restart fdqh
    echo "[OK] Server restarted via PM2"
else
    nohup node server.js > fdqh.log 2>&1 &
    echo "[OK] Server started in background (PID: $!)"
    echo "[INFO] Logs: tail -f fdqh.log"
fi

echo ""
echo "[DONE] Update complete!"
echo "       URL: http://localhost:${PORT:-3000}"
