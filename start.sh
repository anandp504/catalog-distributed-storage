#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

FRESH=false
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Source .env if present
if [ -f .env ]; then
  set -o allexport
  # shellcheck source=.env
  source .env
  set +o allexport
fi

: "${GITEA_ADMIN_PASSWORD:?GITEA_ADMIN_PASSWORD is required — set it in .env or environment}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required — set it in .env or environment}"

GITEA_ADMIN_USER="${GITEA_ADMIN_USER:-gitea_admin}"
GITEA_ADMIN_EMAIL="${GITEA_ADMIN_EMAIL:-admin@beckn.local}"

# --fresh: tear down and wipe all volumes before starting
if [ "$FRESH" = true ]; then
  echo "==> Wiping existing volumes..."
  docker compose down -v 2>/dev/null || true
  echo ""
fi

# Start backing services first so we can initialise Gitea before the API comes up
echo "==> Building and starting Postgres, Redis, and Gitea nodes..."
docker compose up --build -d postgres redis gitea-1 gitea-2

# Initialise each Gitea node: create admin user + beckn org
echo ""
GITEA_ADMIN_USER="$GITEA_ADMIN_USER" \
GITEA_ADMIN_PASSWORD="$GITEA_ADMIN_PASSWORD" \
GITEA_ADMIN_EMAIL="$GITEA_ADMIN_EMAIL" \
  ./docker/gitea/init.sh http://localhost:3001

echo ""
GITEA_ADMIN_USER="$GITEA_ADMIN_USER" \
GITEA_ADMIN_PASSWORD="$GITEA_ADMIN_PASSWORD" \
GITEA_ADMIN_EMAIL="$GITEA_ADMIN_EMAIL" \
  ./docker/gitea/init.sh http://localhost:3002

# Now start the API (depends_on gitea health, which is already satisfied)
echo ""
echo "==> Starting API..."
docker compose up -d api

echo "==> Waiting for API at http://localhost:3000/health..."
until curl -sf http://localhost:3000/health > /dev/null 2>&1; do
  sleep 2
done

echo ""
echo "Stack is ready."
echo ""
echo "  API:     http://localhost:3000"
echo "  Gitea-1: http://localhost:3001/beckn"
echo "  Gitea-2: http://localhost:3002/beckn"
echo ""
echo "Publish a catalog:"
echo "  curl -s -X POST http://localhost:3000/catalog/publish \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d @data/electronics_catalog.json | jq ."
