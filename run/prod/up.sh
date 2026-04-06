#!/bin/bash
set -e
cd "$(dirname "$0")/../.."

echo "🚀 Starting Wallet Service in PRODUCTION mode..."
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
