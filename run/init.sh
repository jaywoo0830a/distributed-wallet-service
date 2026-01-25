#!/bin/sh

set -e

echo "----------------------------------------------------------------"
echo "Initializing Project Dependencies using Docker (Node 24 Alpine)..."
echo "----------------------------------------------------------------"

# Ensure docker is running
if ! command -v docker >/dev/null 2>&1; then
    echo "Error: Docker is not installed or running."
    exit 1
fi

# Get current user ID and Group ID to prevent permission issues
USER_ID=$(id -u)
GROUP_ID=$(id -g)

# Run npm install inside a container, mapping the current directory
# This populates node_modules on the host machine
docker run --rm \
    -v "$(pwd):/app" \
    -w /app \
    --user "$USER_ID:$GROUP_ID" \
    node:24-alpine \
    npm install

echo "----------------------------------------------------------------"
echo "Dependencies installed successfully!"
echo "You can now run: docker-compose up --build"
echo "----------------------------------------------------------------"