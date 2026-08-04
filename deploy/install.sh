#!/bin/bash
# FDQH One-Click Install for Linux
# Usage: chmod +x install.sh && ./install.sh

set -e

echo "============================================"
echo " FDQH Quality Hub - Installation"
echo "============================================"
echo ""

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    OS="unknown"
fi

# Install Node.js if needed
if ! command -v node &> /dev/null; then
    echo "[STEP 1] Installing Node.js 20.x..."
    case $OS in
        ubuntu|debian)
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
            ;;
        centos|rhel|fedora)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo yum install -y nodejs
            ;;
        *)
            echo "Please install Node.js 18+ manually: https://nodejs.org/"
            exit 1
            ;;
    esac
    echo "[OK] Node.js $(node -v) installed"
else
    echo "[STEP 1] Node.js already installed: $(node -v)"
fi

# Install dependencies
echo "[STEP 2] Installing npm dependencies..."
cd "$(dirname "$0")/.."
npm install --production
echo "[OK] Dependencies installed"

# Create data directory
echo "[STEP 3] Creating data directory..."
mkdir -p data
echo "[OK] Data directory ready"

echo ""
echo "============================================"
echo " Installation Complete!"
echo "============================================"
echo ""
echo "  Start the server:"
echo "    cd deploy && ./start.sh"
echo ""
echo "  Or using npm:"
echo "    npm start"
echo ""
echo "  Default URL:  http://localhost:3000"
echo "  Default user: admin / admin123"
echo ""
echo "  Optional: Set MongoDB connection"
echo "    export MONGODB_URI='mongodb://localhost:27017/fdqh'"
