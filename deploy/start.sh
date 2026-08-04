#!/bin/bash
# FDQH Quality Hub Startup Script for Linux

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║   FosunDx Quality Hub (FDQH) Platform       ║"
echo "  ║   IVD 数字化质量管理平台 v2.16               ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found. Please install Node.js 18+"
    echo "        Ubuntu/Debian: sudo apt install nodejs npm"
    echo "        CentOS/RHEL:   sudo yum install nodejs npm"
    echo "        Or download:   https://nodejs.org/"
    exit 1
fi

echo "[INFO] Node.js version: $(node -v)"

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

# Check if node_modules exists
if [ ! -d "$APP_DIR/node_modules" ]; then
    echo ""
    echo "[INFO] Installing dependencies..."
    cd "$APP_DIR"
    npm install --production
fi

# Check MongoDB environment variable
if [ -z "$MONGODB_URI" ]; then
    echo "[INFO] MONGODB_URI not set, using JSON file storage (no MongoDB required)"
    echo "[INFO] To use MongoDB: export MONGODB_URI='mongodb://localhost:27017/fdqh'"
fi

# Set port
export PORT=${PORT:-3000}

echo ""
echo "[INFO] Starting FDQH server..."
echo "[INFO] URL: http://localhost:${PORT}"
echo "[INFO] Default login: admin / admin123"
echo "[INFO] Press Ctrl+C to stop"
echo ""

cd "$APP_DIR"
node server.js
