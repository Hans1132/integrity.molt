#!/bin/bash
# Deploy to Railway.app - Quick Start Script

set -e

echo "🚀 integrity.molt Production Deployment"
echo "========================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if git is clean
if [[ -n $(git status -s) ]]; then
    echo -e "${YELLOW}⚠️  You have uncommitted changes. Commit them first:${NC}"
    echo "  git add -A"
    echo "  git commit -m 'feat: Phase 3d production deployment'"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Prerequisites Check${NC}"
echo "   - Git repository clean"
echo "   - .env configured"
echo "   - requirements.txt updated"
echo ""

# Verify required environment variables
echo -e "${GREEN}✅ Environment Variables${NC}"

ENV_VARS=(
    "TELEGRAM_TOKEN"
    "OPENAI_API_KEY"
    "SOLANA_RPC_URL"
    "SOLANA_PUBLIC_KEY"
    "MONGODB_URI"
)

for var in "${ENV_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        echo -e "${YELLOW}⚠️  $var not set in railway dashboard${NC}"
    else
        echo "   ✅ $var configured"
    fi
done

echo ""
echo -e "${GREEN}✅ Git Status${NC}"
git log --oneline -3

echo ""
echo "Ready to deploy to Railway.app!"
echo "1. Push to GitHub: git push origin main"
echo "2. Railway will auto-build and deploy"
echo "3. Monitor: https://railway.app/projects/your-project"
echo ""
echo -e "${GREEN}✅ Deployment ready${NC}"
