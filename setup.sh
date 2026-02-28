#!/bin/bash
# integrity.molt - Quick Setup & Deployment Script
# This script helps you get your autonomous agent running

set -e

echo "========================================================"
echo "🚀 integrity.molt - Autonomous Agent Setup"
echo "========================================================"
echo ""

# Check Python version
echo "[1/7] Checking Python..."
python_version=$(python3 --version 2>&1 | cut -d' ' -f2 | cut -d'.' -f1-2)
if [[ "$python_version" < "3.11" ]]; then
    echo "❌ Python 3.11+ required (you have $python_version)"
    exit 1
fi
echo "✅ Python $python_version OK"
echo ""

# Check .env file
echo "[2/7] Checking .env configuration..."
if [ ! -f ".env" ]; then
    echo "❌ .env file not found"
    echo "📋 Creating from .env.example..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your settings"
    echo "   - TELEGRAM_TOKEN"
    echo "   - OPENAI_API_KEY"
    echo "   - SOLANA_PUBLIC_KEY"
    echo "   - MOLTBOOK_API_KEY"
    echo "   - MOLTBOOK_WEBHOOK_SECRET"
    exit 1
fi
echo "✅ .env found"
echo ""

# Install dependencies
echo "[3/7] Installing dependencies..."
pip install -q -r requirements.txt
echo "✅ Dependencies installed"
echo ""

# Validate configuration
echo "[4/7] Validating configuration..."
python3 -c "
from src.config import validate_config
try:
    validate_config()
    print('✅ Configuration valid')
except Exception as e:
    print(f'❌ Configuration error: {e}')
    exit(1)
"
echo ""

# Check MongoDB (if in use)
echo "[5/7] Checking database..."
database_mode=$(grep "DATABASE_MODE=" .env | cut -d'=' -f2)
if [ "$database_mode" == "real" ]; then
    echo "⚠️  Real MongoDB mode - ensure connection string is valid"
    echo "   MONGODB_URI: $(grep 'MONGODB_URI=' .env)"
else
    echo "✅ Using mock database (development mode)"
fi
echo ""

# Summary
echo "[6/7] Component summary:"
echo "  • Telegram Bot: Enabled (polling mode)"
echo "  • FastAPI Marketplace API: Port 8000"
echo "  • Autonomous Auditor: Background loop (5s interval)"
echo ""

# Instructions
echo "[7/7] Ready to start!"
echo ""
echo "========================================================"
echo "🎯 Next Steps:"
echo "========================================================"
echo ""
echo "LOCAL TESTING:"
echo "  python -m src"
echo ""
echo "PRODUCTION (Railway):"
echo "  git add ."
echo "  git commit -m 'Deploy autonomous agent'"
echo "  git push railway main"
echo ""
echo "MONITOR EARNINGS:"
echo "  curl http://localhost:8000/earnings"
echo ""
echo "VIEW LOGS:"
echo "  railway logs"
echo ""
echo "========================================================"
echo "📖 Documentation: See MONETIZATION_GUIDE.md"
echo "========================================================"
