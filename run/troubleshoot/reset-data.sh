#!/bin/bash
set -e
cd "$(dirname "$0")/../.."

echo "⚠️  WARNING: ALL DATABASE DATA WILL BE LOST."
read -p "Are you sure? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

docker-compose down -v
echo "✅ Data reset complete."