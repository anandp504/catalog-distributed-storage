# git-distributed-poc — Claude Navigation Index

POC for storing Beckn v2.0 catalog data as bare git repositories distributed across multiple Node.js container nodes, with consistent hashing for data locality.

**Not** a production system. No Kafka. No authentication. Pure demonstration of distributed git storage patterns.

---

## What This Proves

1. Catalog JSON can be stored as versioned git commits (history, MERGE/FULL modes)
2. A consistent hash ring routes any `catalogId` deterministically to one node
3. The git storage layer scales horizontally (add nodes → redistribute load)
4. Data locality: every node knows exactly which repos live on its disk

---

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| API Service | `src/api/` | Express — receives `/catalog/publish`, routes to correct Gitea node |
| Hash Ring | `src/coordinator/hashRing.js` | Initial placement only — `catalogId` → Gitea node URL for first-ever publish |
| Routing Table | `src/coordinator/routingTable.js` | Three-layer lookup: Redis cache → Postgres (authoritative) → hash ring (new only) |
| Gitea Client | `src/gitea/giteaClient.js` | Wraps Gitea REST API for one node (create repo, commit, read) |
| Gitea Router | `src/gitea/giteaRouter.js` | Combines RoutingTable + GiteaClient — routed catalog operations |
| Common | `src/common/` | Beckn ACK/NACK builders, constants |
| PostgreSQL | `postgres:16-alpine` (Docker) | Authoritative `catalog_routing` table — durable, backup via `pg_dump` |
| Redis | `redis:7-alpine` (Docker) | Read-through cache in front of Postgres — no persistence needed |
| Gitea Nodes | `gitea/gitea:latest` (Docker) | 2 independent Gitea instances, each owning a shard of repos |

---

## File Map

| Task | File |
|------|------|
| Add/change routes | `src/api/routes/catalogRoutes.js` |
| Publish handler | `src/api/handlers/publishHandler.js` |
| Read handler | `src/api/handlers/readHandler.js` |
| Beckn v2.0 validation | `src/api/validation/catalogSchema.js` |
| Consistent hash ring (initial placement) | `src/coordinator/hashRing.js` |
| Three-layer routing table (Redis → Postgres → ring) | `src/coordinator/routingTable.js` |
| Gitea REST API wrapper | `src/gitea/giteaClient.js` |
| Routed catalog operations | `src/gitea/giteaRouter.js` |
| ACK/NACK builders | `src/common/becknShapes.js` |
| Gitea bootstrap script | `docker/gitea/init.sh` |
| Postgres schema init | `docker/postgres/init.sql` |

---

## Beckn v2.0 `/catalog/publish` Shape

```json
{
  "context": {
    "action": "catalog/publish",
    "version": "2.0.0",
    "networkId": "string",
    "messageId": "uuid",
    "transactionId": "uuid",
    "timestamp": "ISO8601"
  },
  "message": {
    "catalogs": [
      {
        "id": "CAT-001",
        "descriptor": { "name": "...", "shortDesc": "..." },
        "provider": { "id": "PROV-001", "descriptor": { "name": "..." } },
        "resources": [
          {
            "id": "RES-001",
            "descriptor": { "name": "..." },
            "resourceAttributes": { "@context": "URI", "@type": "Type", "...": "..." }
          }
        ]
      }
    ],
    "publishDirectives": [
      { "catalogId": "CAT-001", "catalogType": "regular", "updateMode": "MERGE" }
    ]
  }
}
```

ACK: `{ "status": "ACK" }`
NACK: `{ "status": "NACK", "error": { "errorCode": "INVALID_REQUEST", "errorMessage": "..." } }`

---

## Git Storage Layout

```
{baseDir}/
  {h1}/{h2}/{catalogId}.git      — catalog manifest bare repo
```

- `h1` = SHA-256(catalogId)[0:2], `h2` = SHA-256(catalogId)[2:4]
- Each repo stores `manifest.json` + `.metadata.json` per commit
- HEAD is always `refs/heads/main`

---

## Coordinator Routing (Three Layers)

1. **Redis cache** — `HGET catalog-routing {catalogId}` → fast path, no Postgres query
2. **PostgreSQL** — `SELECT node_url FROM catalog_routing WHERE catalog_id = $1` → authoritative record, populated into Redis on miss
3. **Hash ring** — consulted only for brand-new catalogIds (never seen in Postgres); result is INSERTed into Postgres and cached in Redis

**Hash ring parameters:**
- 150 virtual nodes per physical node
- Hash: `crypto.createHash('sha256').update(repoId).digest('hex')`
- Ring: sorted array of `{ hash, nodeUrl }`, binary search
- Deterministic — same `catalogId` + same node list always produces the same assignment

**Redis is a cache, not a store** — no AOF, no RDB persistence; a flush is harmless (Postgres is the source of truth).

---

## Gitea REST API (used by API service — one call set per node)

```
POST /api/v1/orgs/beckn/repos                                 — create repo for catalogId (idempotent)
POST /api/v1/repos/beckn/{catalogId}/contents/manifest.json   — first commit
PUT  /api/v1/repos/beckn/{catalogId}/contents/manifest.json   — subsequent commits (needs prev blob sha)
GET  /api/v1/repos/beckn/{catalogId}/contents/manifest.json   — read current manifest
GET  /api/v1/repos/beckn/{catalogId}/commits                  — commit history
```

All calls carry `Authorization: Basic <base64(user:password)>`.
Web UI per node: `http://localhost:3001` / `:3002` → org `beckn` → repos.

---

## Build & Test

```bash
npm install
npm test                                                   # all tests (nock mocks Gitea)
npm test -- --testPathPattern=tests/unit/coordinator       # phase 1 only
npm test -- --testPathPattern=tests/unit/gitea             # phase 2 only
npm test -- --coverage

# E2E (requires Docker)
docker-compose up --build -d
GITEA_ADMIN_PASSWORD=changeme ./docker/gitea/init.sh http://localhost:3001
GITEA_ADMIN_PASSWORD=changeme ./docker/gitea/init.sh http://localhost:3002
node tests/e2e/smokeTest.js
```

---

## Agents

Five agents in `.claude/agents/`:

| Agent | Model | Purpose |
|-------|-------|---------|
| `prd-writer` | Opus | Writes the PRD to `docs/PRD.md` |
| `impl-plan` | Opus | Generates phased TDD implementation plan to `docs/IMPLEMENTATION_PLAN.md` |
| `implement` | Sonnet | Implements one phase at a time (Red→Green→Refactor) |
| `test-runner` | Haiku | Runs tests and reports pass/fail. Cheap — use freely. |
| `review` | Opus | Code review — CRITICAL/HIGH/MEDIUM/LOW findings |

**Development Workflow:**
```
prd-writer → [USER REVIEW] → impl-plan → [USER REVIEW] → implement (phase by phase) → test-runner → review → done
```

---

## Hard Rules — Never Violate

- **No git library on the client** — all git operations go through Gitea REST API via `node-fetch`; no `isomorphic-git`, `simple-git`, or `child_process git`
- **No Kafka** — direct HTTP between API and Gitea nodes
- **No Beckn auth** — this is a POC; no signature verification
- **Catalog path sanitization** — `catalogId` must be validated before use in Gitea API URLs (reject `../`, `/`, `\`)
- **Consistent hash is deterministic** — same `catalogId` + same node list → same node, always
- **NACK format** — always `{ status: "NACK", error: { errorCode, errorMessage } }` never `{ error: "..." }`
- **Bare repos only** — no working trees, no `.git` subdirectories
- **One repo per catalog** — never share a repo between two different `catalogId`s
- **Node URLs from env only** — never from request body (`GITEA_NODES=url1,url2`)
- **Gitea independent instances** — each node has its own SQLite + volume; no shared storage
- **Postgres is authoritative** — all routing writes go to Postgres first, then Redis; never write to Redis only
- **Redis is cache-only** — never run Redis with AOF or RDB persistence for this system; a flush must be safe

---

## Docker Compose Topology

```
api       → port 3000 → validates Beckn payload, routes via coordinator, calls Gitea REST API
postgres  → port 5432 → catalog_routing table — authoritative routing store (backup: pg_dump)
redis     → port 6379 → routing cache (no persistence — cache only)
gitea-1   → port 3001 → SQLite: gitea-data-1 — owns ~1/2 of catalog repos
gitea-2   → port 3002 → SQLite: gitea-data-2 — owns ~1/2 of catalog repos
```

Browse repos at `http://localhost:3001/beckn` after publishing.

---

## Parent Project Reference

The parent project `beckn-catalg` (Java/JGit) uses the same storage concept but on a single node. See:
- `../beckn-catalg/jobs/catalog-indexer-job/src/main/java/org/beckn/catalogindexer/git/jgit/ItemGitProvider.java`
- The POC translates this to a multi-node, Node.js, horizontally scaled version.
