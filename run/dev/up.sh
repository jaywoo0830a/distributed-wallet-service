#!/bin/bash
set -e
cd "$(dirname "$0")/../.."

echo "🚀 Starting Development Environment..."

if [ ! -d "node_modules" ]; then
    echo "Dependencies missing. Running initialization..."
    ./run/init.sh
fi

docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
