#!/bin/bash
set -e
cd "$(dirname "$0")/../.."

echo "🩺 Checking MySQL..."
if [ -z "$(docker compose ps -q mysql)" ]; then
    echo "❌ MySQL container is NOT running."
    exit 1
fi

docker compose exec mysql mysqladmin ping -h localhost -u root -proot --silent && echo "✅ MySQL is responsive"