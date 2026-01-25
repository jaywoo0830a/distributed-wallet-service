#!/bin/bash
set -e
cd "$(dirname "$0")/../.."
echo "🛑 Stopping Development Environment..."
docker-compose down --remove-orphans