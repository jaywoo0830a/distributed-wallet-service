#!/bin/sh
set -e

echo "--------------------------------------------------------"
echo "Initializing Dependencies using Docker (Node 24 Alpine)"
echo "--------------------------------------------------------"

if ! command -v docker >/dev/null 2>&1; then
    echo "Error: Docker required but not found."
    exit 1
fi

USER_ID=$(id -u)
GROUP_ID=$(id -g)

# Run npm install inside a container to sync with host
docker run --rm \
    -v "$(pwd):/app" \
    -w /app \
    --user "$USER_ID:$GROUP_ID" \
    node:24-alpine \
    npm install

echo "--------------------------------------------------------"
echo "Done! Ready to run: scripts/dev/up.sh"
echo "--------------------------------------------------------"