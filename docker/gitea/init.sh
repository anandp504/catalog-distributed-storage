#!/bin/sh
set -e

NODE_URL="${1:-http://localhost:3001}"
ADMIN_USER="${GITEA_ADMIN_USER:-gitea_admin}"
ADMIN_PASS="${GITEA_ADMIN_PASSWORD}"
ADMIN_EMAIL="${GITEA_ADMIN_EMAIL:-admin@beckn.local}"
ORG="${GITEA_ORG:-beckn}"

if [ -z "${ADMIN_PASS}" ]; then
  echo "ERROR: GITEA_ADMIN_PASSWORD env var is required"
  exit 1
fi

echo "==> Waiting for Gitea at ${NODE_URL}..."
until curl -sf "${NODE_URL}/api/v1/version" > /dev/null 2>&1; do
  sleep 3
done
echo "==> Gitea is up."

# Find the Docker container mapped to this URL's host port
HOST_PORT=$(echo "${NODE_URL}" | sed 's|.*:\([0-9]*\)$|\1|')
CONTAINER=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
  | grep ":${HOST_PORT}->" \
  | awk '{print $1}' \
  | head -1)

# Create the admin user via docker exec (env var approach is unreliable in 1.22)
if [ -n "${CONTAINER}" ]; then
  echo "==> Creating admin user '${ADMIN_USER}' in container '${CONTAINER}'..."
  docker exec --user git "${CONTAINER}" gitea admin user create \
    --username "${ADMIN_USER}" \
    --password "${ADMIN_PASS}" \
    --email "${ADMIN_EMAIL}" \
    --admin \
    --must-change-password=false 2>&1 || echo "==> Admin user already exists — OK."
else
  echo "WARNING: Could not find Docker container for port ${HOST_PORT}. Skipping admin user creation."
  echo "         Make sure Docker is running and the container is mapped to port ${HOST_PORT}."
fi

# Verify credentials work before continuing
echo "==> Verifying credentials..."
CHECK=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  "${NODE_URL}/api/v1/user")
if [ "${CHECK}" != "200" ]; then
  echo "ERROR: Credential check failed (HTTP ${CHECK}). Admin user may not exist."
  exit 1
fi
echo "==> Credentials OK."

echo "==> Creating org '${ORG}' on ${NODE_URL}..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${NODE_URL}/api/v1/orgs" \
  -H "Content-Type: application/json" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -d "{\"username\":\"${ORG}\",\"visibility\":\"public\"}" || true)

if [ "${HTTP_STATUS}" = "201" ]; then
  echo "==> Org '${ORG}' created."
elif [ "${HTTP_STATUS}" = "422" ] || [ "${HTTP_STATUS}" = "409" ]; then
  echo "==> Org '${ORG}' already exists — OK."
else
  echo "WARNING: org creation returned HTTP ${HTTP_STATUS} — check manually."
fi

echo ""
echo "==> Done! ${NODE_URL} is ready."
echo "    Browse: ${NODE_URL}/${ORG}"
