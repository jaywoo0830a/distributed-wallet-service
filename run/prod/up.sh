#!/bin/bash
set -e
cd "$(dirname "$0")/../.."

echo "🚀 Starting Wallet Service in PRODUCTION mode..."
export NODE_ENV=production
docker-compose up --build -d