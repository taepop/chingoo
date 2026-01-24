#!/bin/bash
set -e

echo "=== Running Prisma DB Push ==="
cd /app/packages/shared
npx prisma db push --accept-data-loss
echo "=== Database schema synced ==="

echo "=== Starting API Server ==="
cd /app/apps/api
node dist/main.js
