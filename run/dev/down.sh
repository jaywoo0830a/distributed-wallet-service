#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
echo "🛑 Stopping Development Environment..."
docker-compose -f docker-compose.yml -f docker-compose.dev.yml down --remove-orphans
