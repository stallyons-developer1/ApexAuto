#!/usr/bin/env bash
# Redeploy the Imperium rental verification app to production.
# The 7 environment variables (Didit key, WooCommerce keys, etc.) are already
# stored in Vercel — this script does NOT contain any secrets.
# Usage:  VERCEL_TOKEN=xxxxxxxx bash deploy.sh
set -e
cd "$(dirname "$0")"
if [ -z "$VERCEL_TOKEN" ]; then echo "Set VERCEL_TOKEN first (Vercel > Settings > Tokens)."; exit 1; fi
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" 2>/dev/null
npx --yes vercel --token "$VERCEL_TOKEN" --yes deploy --prod
