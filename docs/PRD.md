# PRD: Distributed Git Catalog Storage — POC

**Version:** 1.0
**Date:** 2026-05-05
**Status:** DRAFT

---

## 1. Overview

The Beckn catalog system (beckn-catalg) already stores catalog data as bare git repositories on a single node using JGit. This POC replaces that single node with a horizontally scaled cluster of Gitea storage nodes managed by a **coordinator** (PostgreSQL routing table + Redis cache + API service), modelled after GitLab's Gitaly + Praefect architecture. The coordinator permanently records which node owns each catalog repository in PostgreSQL (durable, backup-friendly), with Redis as a high-throughput read cache in front of it. New nodes can be added at any time to absorb new catalog assignments — existing repos never move, eliminating data migration risk entirely. The goal is to prove that git-based catalog storage can scale horizontally beyond a single disk while preserving immutable history and safe, zero-movement node addition.

---

## 2. Goals

- [ ] **G1:** Implement `POST /catalog/publish` that accepts Beckn v2.0 catalog payloads, assigns each catalog to a Gitea node via the coordinator, and stores the manifest as a git commit.
- [ ] **G2:** Prove stable data locality — a given `catalogId` always routes to the same Gitea node, and that assignment survives API restarts and Redis flushes because it is durably recorded in PostgreSQL.
- [ ] **G3:** Run 2 Gitea nodes as Docker containers; demonstrate even initial distribution across both.
- [ ] **G4:** Prove zero-movement horizontal scaling — adding a 3rd Gitea node causes new catalogs to be assigned to it while all existing catalogs remain on their original nodes, with no data migration.
- [ ] **G5:** Support MERGE mode (second publish = new commit, history preserved) and FULL mode (manifest replaced, still a commit).
- [ ] **G6:** Implement `GET /catalog/:catalogId` that reads the current `manifest.json` from the correct node.
- [ ] **G7:** Document the distributed git server technology comparison and the coordinator architecture rationale.

---

## 3. Non-Goals

- No Kafka integration — direct HTTP between the API and git-worker nodes.
- No Beckn HTTP Signature authentication — this is a POC, not a production service.
- No subscription, delivery, or discovery pipeline.
- No replication — each repo lives on exactly one node's disk (no redundancy).
- No failover — if a Gitea node is down, publishes to its repos fail with a clear error.
- No full GitLab/GitHub replacement — only bare repo commit and read operations.
- No production TLS, secrets management, or rate limiting.
- No item-level git repos (only catalog manifests for this POC — item-level sharding is a natural extension).
- No data migration — existing repos never move when nodes are added; only new catalog assignments go to the new node.
- No rebalancing of existing repos — the coordinator pattern means old repos stay on original nodes permanently unless explicitly migrated (out of scope).

---

## 4. Background & Motivation

### The Single-Node Limit

In `beckn-catalg`, `ItemGitProvider` manages all bare git repos on a single local filesystem. Every catalog, item, and manifest gets its own directory under `{baseDir}/`. This works well for moderate scale but hits a hard ceiling: one disk, one machine, one failure domain.

### Why Git for Catalog Storage?

Git gives us three properties that relational databases do not:
1. **Immutable history** — every publish creates a commit; we can read the catalog at any point in time.
2. **Content-addressed storage** — git's object model deduplicates identical blobs automatically.
3. **Structured diffing** — comparing two versions of a catalog is a native `git diff` operation.

### Why Distributed?

A seller network with thousands of BPPs, each publishing hundreds of resources, creates millions of tiny git repos. No single disk can hold all of them at production scale. Distributing repos across nodes means:
- Each node manages only 1/N of the total repo count.
- Read and write operations parallelize across nodes.
- New nodes can be added to absorb growth by migrating a subset of repos to the new node.

### The Data Locality Problem and Why Pure Hashing Breaks at Scale

A stateless hash function (`hash(catalogId) mod N`) seems appealing but fails when nodes are added. Adding node-4 to a 3-node cluster remaps ~25% of existing catalog IDs to node-4 — but their repos physically live on nodes 1, 2, or 3. The only fix is migrating data, which introduces:
- Risk of data loss during transfer
- Downtime or read-your-own-write inconsistency during migration
- Operational complexity proportional to the amount of data that moves
- A migration that must complete before the new node is useful

**This is the wrong model for catalog data at scale.**

### The Right Model: Coordinator with Permanent Assignment Recording

GitLab faced this exact problem with git repository storage. Their solution — **Gitaly + Praefect** — is the reference architecture for this POC:

```
Clients
    │
    ▼
Praefect (coordinator)          ← our equivalent: API Service + Redis
    │  PostgreSQL: repo → node  ← our equivalent: Redis routing table
    │
    ├── Gitaly-1 /repos         ← our equivalent: Gitea-1
    └── Gitaly-2 /repos         ← our equivalent: Gitea-2
```

**Praefect is a master coordinator node** backed by PostgreSQL. When a repo is created, Praefect assigns it to a Gitaly node and records `repo_path → gitaly_node` permanently. All future operations look up this record — the assignment never changes unless explicitly migrated.

**When GitLab adds a new Gitaly node:**
1. Add the node to Praefect's config
2. Praefect immediately starts assigning **new repos** to the new node
3. All existing repos remain on their original Gitaly nodes — **no data movement, no migration, no risk**
4. The PostgreSQL assignment record for existing repos is unchanged

This is pure horizontal scaling: add storage capacity, it absorbs new work, old data never moves.

### How We Implement This

Our coordinator has three components:
1. **PostgreSQL routing table** — the authoritative, durable `catalogId → nodeUrl` record, equivalent to Praefect's PostgreSQL. Supports `pg_dump`, WAL archiving, and point-in-time recovery. A Redis flush or crash never loses routing data.
2. **Redis cache** — a read-through cache in front of PostgreSQL. High-throughput lookups hit Redis (sub-millisecond); on a cache miss the record is fetched from PostgreSQL and populated into Redis. Redis requires no persistence (`--save ""`) since it is purely a cache.
3. **Assignment policy** — how to pick a node for a brand-new catalogId (consistent hash ring; the result is written to PostgreSQL and cached in Redis; the policy is never consulted again for that catalogId).

**Routing logic:**
```
route(catalogId):
  // 1. Redis cache (fast path)
  node = Redis.HGET("catalog-routing", catalogId)
  if node is not nil: return node

  // 2. PostgreSQL (authoritative)
  node = Postgres.query("SELECT node_url FROM catalog_routing WHERE catalog_id = $1", catalogId)
  if node is not nil:
    Redis.HSET("catalog-routing", catalogId, node)  // populate cache
    return node

  // 3. First-ever publish — assign and record durably
  node = hashRing.getNode(catalogId)
  Postgres.query("INSERT INTO catalog_routing (catalog_id, node_url) VALUES ($1, $2) ON CONFLICT DO NOTHING", catalogId, node)
  Redis.HSET("catalog-routing", catalogId, node)
  return node
```

**Adding a new node (e.g. gitea-3):** Update `GITEA_NODES` to include the new Gitea instance. The hash ring now includes it as a candidate. New catalogIds get assigned to it (recorded in Postgres + cached in Redis). Existing catalogIds have their routing already in Postgres — they stay on original nodes. **Zero data movement.**

**Redis failure recovery:** If Redis is flushed or restarted, the next lookup for any catalogId is a cache miss → fetched from Postgres → repopulated in Redis. No routing data is ever lost.

---

## 5. Users & Actors

| Actor | Role |
|-------|------|
| BPP (seller) | POSTs Beckn v2.0 catalogs to `POST /catalog/publish` |
| API Service | Validates payload; resolves routing via coordinator → Gitea node; commits manifest |
| Hash Ring (in-process) | Determines initial placement for new catalog IDs (consulted only on first publish) |
| PostgreSQL | Authoritative, durable `catalogId → nodeUrl` store; survives Redis flush; supports backup/recovery |
| Redis | Read-through cache in front of PostgreSQL; high-throughput lookups; no persistence needed |
| Gitea Node (N instances) | Stores bare git repos on local disk; exposes standard Gitea REST API |
| Operator | Adds new Gitea nodes; updates `GITEA_NODES` env var and restarts API |
| Test/Smoke Client | `node tests/e2e/smokeTest.js` — verifies distribution, routing, and node-addition correctness |

---

## 6. Functional Requirements

### FR-1: Catalog Publish Endpoint

The API service MUST expose `POST /catalog/publish` accepting a Beckn v2.0 request body.

The endpoint MUST:
- Validate that `context.action === "catalog/publish"`
- Validate that `context.version === "2.0.0"`
- Validate that `message.catalogs` is a non-empty array
- Validate that each catalog has `id`, `descriptor`, `provider`
- Validate that each catalog has at least one of `resources` or `offers`
- Return `{ status: "ACK" }` (HTTP 200) on successful commit
- Return `{ status: "NACK", error: { errorCode, errorMessage } }` (HTTP 400) on validation failure
- Return `{ status: "NACK", error: { errorCode: "INTERNAL_ERROR", errorMessage } }` (HTTP 500) on git-worker error

### FR-2: Coordinator Routing (Three-Layer)

**Layer 1 — Redis cache (fast path):**
- On every publish and read, the API MUST first check `Redis.HGET("catalog-routing", catalogId)`
- On a cache hit, route directly to the returned node — no PostgreSQL query needed
- Redis requires no persistence; a flush or restart causes cache misses (resolved by Layer 2) with no data loss

**Layer 2 — PostgreSQL routing table (authoritative record):**
- On a Redis cache miss, the API MUST query `SELECT node_url FROM catalog_routing WHERE catalog_id = $1`
- If a record exists, the API MUST populate Redis (`Redis.HSET`) and route to the returned node
- The PostgreSQL entry for a catalogId is **permanent** — it does not change when new nodes are added
- PostgreSQL is the source of truth; it MUST be backed up using standard Postgres tooling (`pg_dump`, WAL archiving)

**Layer 3 — Assignment policy (new catalogs only):**
- Consulted ONLY when `catalogId` is absent from both Redis and PostgreSQL (first-ever publish of that catalogId)
- MUST use consistent hash ring: 150 virtual nodes per physical node, SHA-256, binary search
- The result MUST be written to PostgreSQL first, then cached in Redis; the ring is never consulted for that catalogId again
- When a new Gitea node is added to `GITEA_NODES`, the ring is updated — **only new (never-seen) catalogIds** are affected; all existing catalogIds continue routing via PostgreSQL/Redis (unchanged)

**Horizontal scaling guarantee:**
Adding a new Gitea node to `GITEA_NODES` MUST require no data migration. Existing catalogIds route to their PostgreSQL-recorded nodes (unchanged). New catalogIds are assigned to the expanded pool (which now includes the new node). No data moves.

### FR-3: Git Worker Node — Commit

Each git-worker node MUST:
- Expose `POST /repos/:catalogId/commit` accepting `{ manifest: Object, metadata: Object }`
- Create the bare git repo on first commit (idempotent init)
- Store repos under `{baseDir}/{h1}/{h2}/{catalogId}.git` where `h1` = SHA-256(catalogId)[0:2], `h2` = SHA-256(catalogId)[2:4]
- Commit `manifest.json` and `.metadata.json` as a new commit on `refs/heads/main`
- Return `{ commitSha: string, version: number }` on success

### FR-4: Git Worker Node — Read

Each git-worker node MUST:
- Expose `GET /repos/:catalogId/manifest` returning the HEAD `manifest.json` content
- Expose `GET /repos/:catalogId/history` returning an array of `{ commitSha, timestamp }` (newest first)
- Expose `GET /health` returning `{ status: "ok", repoCount: number }`
- Return HTTP 404 with NACK when the repo does not exist

### FR-5: Publish Modes

The API MUST support:
- **MERGE mode** (default): commits the new manifest as a new commit, preserving history
- **FULL mode** (when `publishDirectives[].updateMode === "FULL"`): still commits (no deletion in this POC — distinction is semantic and documented for future use)

### FR-6: Input Sanitization

The API and git-worker MUST reject `catalogId` values containing path traversal characters (`../`, `/`, `\`, null bytes). Return HTTP 400 NACK with `errorCode: "INVALID_CATALOG_ID"`.

### FR-7: Catalog Read Endpoint

The API service MUST expose `GET /catalog/:catalogId` that:
- Resolves the correct node via the routing table (Redis), falling back to the hash ring for unknown catalogs
- Fetches `manifest.json` from that node via Gitea REST API
- Returns the manifest JSON body on success (HTTP 200)
- Returns HTTP 404 NACK when the catalog does not exist

### FR-8: Horizontal Node Addition (Zero Data Movement)

The system MUST support adding new Gitea nodes to increase storage capacity, with no data migration and no downtime.

**Procedure (operator):**
1. Start a new Gitea container; the admin user is created automatically from env vars; run the bootstrap script to create the `beckn` org
2. Add the new node URL to `GITEA_NODES` env var and restart the API service
3. No further action required — the system is immediately operational with the new node in the pool

**System behaviour after node addition:**
- Existing catalogIds: Redis routing table entries are unchanged → all existing repos route to their original nodes as before
- New catalogIds (first publish after node addition): hash ring now includes the new node → some new catalogs are assigned to the new node → recorded in Redis
- The new node starts receiving a share of all future new catalog assignments proportional to its weight in the ring
- At no point does any existing repo move, copy, or become temporarily unavailable

**The API MUST NOT require a migration step or rebalance script for the cluster to be fully functional after adding a node.** The routing table already contains correct entries for all existing repos; it simply grows as new repos are assigned.

---

## 7. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Publish latency p99 | < 500ms for a single catalog with 10 resources |
| Node count (POC) | 2 Gitea containers (expandable to 3+ with no migration) |
| Initial distribution evenness | Each node receives 50% ± 20% of repos over 1000 random catalogIds |
| Routing accuracy | 100% — routing table is always consulted; ring only for first placement |
| Node addition correctness | After adding node-3: all existing repos accessible, no 404s, routing table for existing catalogIds unchanged |
| Zero data movement | Adding a node MUST NOT cause any existing repo to move or become temporarily unavailable |
| Git history preserved | All commits before node addition remain accessible on their original nodes |
| Startup time | API ready within 10 seconds of `docker-compose up` (Gitea + Redis init) |
| Test coverage | Unit + integration tests for routing table, assignment policy, and zero-movement node addition |

---

## 8. System Architecture

### Normal Operation (publish / read)

```
BPP
 │  POST /catalog/publish
 ▼
┌────────────────────────────────────────────────┐
│               API Service :3000                 │
│                                                │
│  1. Validate Beckn v2.0 payload                │
│                                                │
│  2. Routing lookup (three-layer):              │
│     a. node = Redis.HGET(catalogId)  ← cache  │
│     b. if null: SELECT node_url      ← pg     │
│                  populate Redis                │
│     c. if null: hashRing.getNode()   ← new    │
│                  INSERT into Postgres          │
│                  populate Redis                │
│                                                │
│  3. Call Gitea REST API on resolved node       │
└───────────────┬────────────────────────────────┘
                │
      ┌─────────┴──────────┐
      │                    │
      ▼                    ▼
┌─────────┐          ┌─────────┐
│ gitea-1 │          │ gitea-2 │
│  :3001  │          │  :3002  │
│ SQLite  │          │ SQLite  │
│ vol-1   │          │ vol-2   │
└─────────┘          └─────────┘

┌───────────────────────────────┐   ┌───────────────────────┐
│   PostgreSQL :5432            │   │   Redis :6379         │
│  catalog_routing table:       │   │  catalog-routing:     │
│  CAT-001 → http://gitea-2:.. │   │  CAT-001 → gitea-2    │
│  CAT-002 → http://gitea-1:.. │   │  CAT-002 → gitea-1    │
│  CAT-003 → http://gitea-2:.. │   │  (cache, no persist)  │
│  [authoritative + durable]    │   │  [fast read path]     │
└───────────────────────────────┘   └───────────────────────┘
```

### Node Addition (zero data movement)

```
Operator:
  1. Start gitea-3 container, run bootstrap script (beckn org creation only — admin auto-created)
  2. Add "http://gitea-3:3000" to GITEA_NODES, restart API service
  3. Done — no migration, no rebalance script, no downtime

After restart:
  hash_ring = HashRing([gitea-1, gitea-2, gitea-3])  ← 3 nodes now

  New catalogId (first publish after restart):
    Redis.HGET  → nil (cache miss)
    Postgres.SELECT → nil (no row — never published before)
    hash_ring.getNode(catalogId) → may return gitea-3
    Postgres INSERT catalog_routing (catalogId, gitea-3)  ← durable record
    Redis.HSET(catalogId, gitea-3)                        ← cache populated
    → new assignment on gitea-3

  Existing catalogId (seen before):
    Redis.HGET → "http://gitea-2:3000"  ← cache hit, hash ring not consulted
    → routes to gitea-2 as before, Postgres row unchanged, repo untouched

  Redis was flushed (cache miss for existing catalogId):
    Redis.HGET  → nil (cache miss)
    Postgres.SELECT → "http://gitea-2:3000"  ← authoritative record intact
    Redis.HSET(catalogId, gitea-2)            ← cache repopulated
    → routes to gitea-2, no data loss

  Result: gitea-3 absorbs a share of all future new catalog assignments.
          All existing Postgres rows and repos stay on original nodes. Zero data moves.
```

### Consistent Hash Ring (initial placement only)

```
Hash ring (SHA-256 values 0 → FFFF...)

  gitea-1 vnodes (150) ────────────────────┐
  gitea-2 vnodes (150) ────────────────────┘

  hash("CAT-001") → 0x3f2a... → nearest vnode → gitea-2
                                ↓
                     Postgres INSERT catalog_routing (CAT-001, gitea-2)
                                ↓
                     Redis.HSET("CAT-001", "gitea-2")  ← cache populated
                                ↓
                     All future: Redis.HGET("CAT-001") → "gitea-2"  ← cache hit
                     Redis miss: SELECT node_url WHERE catalog_id='CAT-001' → "gitea-2"
                     (ring no longer consulted for this catalogId)
```

---

## 9. Data Model

### Bare Git Repo Layout (per node)

```
{GIT_BASE_DIR}/
  {h1}/{h2}/{catalogId}.git/      ← bare git repo
    HEAD                           → refs/heads/main
    objects/
      pack/
    refs/
      heads/
        main                       → <commitSha>
      tags/
        v1, v2, v3 ...             → lightweight version tags
```

### Files per Commit Tree

```
manifest.json    ← full catalog object (id, descriptor, provider, resources, offers)
.metadata.json   ← { publishedAt, networkId, action, messageId, transactionId }
```

### Directory Sharding

```
catalogId = "CAT-GROCERY-FRESHMART-001"
SHA-256    = "3f2a9b..."
h1         = "3f"
h2         = "2a"
repoPath   = "{baseDir}/3f/2a/CAT-GROCERY-FRESHMART-001.git"
```

Same sharding logic as `ItemGitProvider.shardComponents()` in beckn-catalg.

---

## 10. API Contract

### POST /catalog/publish

**Request:**
```json
{
  "context": {
    "action": "catalog/publish",
    "version": "2.0.0",
    "networkId": "beckn.one/ion-retail",
    "messageId": "6636da5a-4845-4a93-b080-3b4a83662501",
    "transactionId": "fe3b216a-bca7-48d9-a4dd-78e9de9c984d",
    "timestamp": "2026-05-05T10:30:00Z"
  },
  "message": {
    "catalogs": [
      {
        "id": "CAT-GROCERY-FRESHMART-001",
        "descriptor": { "name": "FreshMart Grocery Catalog" },
        "provider": { "id": "PROV-001", "descriptor": { "name": "FreshMart Pvt Ltd" } },
        "resources": [ { "id": "RES-001", "descriptor": { "name": "..." }, "resourceAttributes": { "@context": "...", "@type": "..." } } ]
      }
    ],
    "publishDirectives": [
      { "catalogId": "CAT-GROCERY-FRESHMART-001", "catalogType": "regular", "updateMode": "MERGE" }
    ]
  }
}
```

**Success (200):**
```json
{ "status": "ACK" }
```

**Validation failure (400):**
```json
{ "status": "NACK", "error": { "errorCode": "INVALID_REQUEST", "errorMessage": "context.action must be 'catalog/publish'" } }
```

**Server error (500):**
```json
{ "status": "NACK", "error": { "errorCode": "INTERNAL_ERROR", "errorMessage": "Failed to commit to git-worker-2" } }
```

### GET /catalog/:catalogId

**Success (200):** Returns raw `manifest.json` body (the catalog object).

**Not found (404):**
```json
{ "status": "NACK", "error": { "errorCode": "NOT_FOUND", "errorMessage": "Catalog CAT-001 not found" } }
```

### Gitea REST API (per shard node)

The API service talks to each Gitea node using its standard REST API:

```
# Ensure repo exists (create on first publish)
POST /api/v1/orgs/beckn/repos
Body: { name: "{catalogId}", auto_init: false, private: false }

# Read current blob SHA (needed before update)
GET  /api/v1/repos/beckn/{catalogId}/contents/manifest.json

# Create file (first commit)
POST /api/v1/repos/beckn/{catalogId}/contents/manifest.json
Body: { message: "catalog publish", content: "<base64(manifest)>", new_branch: "main" }

# Update file (subsequent commits — requires prev blob sha)
PUT  /api/v1/repos/beckn/{catalogId}/contents/manifest.json
Body: { message: "catalog update", content: "<base64(manifest)>", sha: "<prev blob sha>" }

# Read latest manifest
GET  /api/v1/repos/beckn/{catalogId}/contents/manifest.json
Response: { content: "<base64>", sha: "<blob sha>", ... }

# Commit history
GET  /api/v1/repos/beckn/{catalogId}/commits
```

All requests carry `Authorization: Basic <base64(GITEA_ADMIN_USER:GITEA_ADMIN_PASSWORD)>` header.

---

## 11. Distributed Git Server Choice

See `docs/DISTRIBUTED_GIT_COMPARISON.md` for the full comparison table.

**Chosen: N independent Gitea instances (one per shard node)** — same for both this POC and the production Java system.

### How it works

Each shard node runs a **standalone Gitea instance** with its own SQLite database and local disk volume. Nodes have no knowledge of each other. The consistent hash ring in the API service routes `catalogId → Gitea instance URL`, then calls Gitea's REST API to commit and read files:

```
# Commit manifest.json (creates/updates with a git commit)
PUT /api/v1/repos/beckn/{catalogId}/contents/manifest.json
Body: { message: "catalog update", content: "<base64>", sha: "<prev blob sha if updating>" }

# Read manifest.json from HEAD
GET /api/v1/repos/beckn/{catalogId}/contents/manifest.json
Response: { content: "<base64>", sha: "<blob sha>", ... }
```

This means the client (Node.js in the POC, Java in production) needs only an HTTP client — no git library, no JGit.

### Why Gitea

- **REST API for file operations** — commit and read files without any git library on the client; the Java production service calls the same API with an HTTP client (Apache HttpClient / OkHttp)
- **Standard git protocol also available** — `git clone`, JGit HTTP transport, or any git client can interact with each node's repos directly
- **Web UI** — inspect any catalog's git history in a browser during development and demo
- **Lightweight** — Go binary, SQLite per node, no shared infrastructure between nodes; ~80–120 MB image, ~100–200 MB RAM per instance
- **Java SDK** — `gitea4j` on Maven Central for the production Java implementation
- **Independent instances** — each node is fully standalone; data locality is enforced by the hash ring in the API layer, not by Gitea itself

Note: Gitea's *HA clustering mode* (shared NFS/S3 + PostgreSQL + Redis) is **not** used. We use N **independent standalone instances**, each owning a distinct shard of the catalog space.

### Why Not the Others (summary)

| Option | Reason not chosen |
|--------|------------------|
| Gitaly + Praefect | Requires GitLab auth + PostgreSQL; gRPC only — no Java/JGit or Node.js binding; massive overhead |
| Gitea HA mode | Shared-storage model contradicts per-node local disk sharding |
| git-http-backend + nginx | No REST API — requires JGit HTTP transport or git CLI on client; no web UI |
| Soft Serve | No REST API for file operations; SSH-first; no Java SDK |
| Custom Node.js + simple-git | POC-only complexity that diverges from the production approach |

---

## 12. Docker Compose Topology

```yaml
services:
  api:
    build: docker/api/
    ports: ["3000:3000"]
    environment:
      GITEA_NODES: "http://gitea-1:3000,http://gitea-2:3000"
      GITEA_ORG: beckn
      GITEA_ADMIN_USER: "${GITEA_ADMIN_USER:-gitea_admin}"
      GITEA_ADMIN_PASSWORD: "${GITEA_ADMIN_PASSWORD}"
      DATABASE_URL: "postgresql://beckn:beckn@postgres:5432/catalog_routing"
      REDIS_URL: "redis://redis:6379"
    depends_on: [gitea-1, gitea-2, postgres, redis]

  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: catalog_routing
      POSTGRES_USER: beckn
      POSTGRES_PASSWORD: beckn
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./docker/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    # Backup: pg_dump -U beckn catalog_routing > backup.sql

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    # No persistence — Redis is a cache only; routing data lives in Postgres
    command: redis-server --save ""

  gitea-1:
    image: gitea/gitea:latest
    ports: ["3001:3000"]
    environment:
      GITEA__database__DB_TYPE: sqlite3
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__server__ROOT_URL: "http://gitea-1:3000"
      GITEA__server__OFFLINE_MODE: "true"
      GITEA_ADMIN_USER: "${GITEA_ADMIN_USER:-gitea_admin}"
      GITEA_ADMIN_PASSWORD: "${GITEA_ADMIN_PASSWORD}"
      GITEA_ADMIN_EMAIL: "${GITEA_ADMIN_EMAIL:-admin@beckn.local}"
    volumes:
      - gitea-data-1:/data

  gitea-2:
    image: gitea/gitea:latest
    ports: ["3002:3000"]
    environment:
      GITEA__database__DB_TYPE: sqlite3
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__server__ROOT_URL: "http://gitea-2:3000"
      GITEA__server__OFFLINE_MODE: "true"
      GITEA_ADMIN_USER: "${GITEA_ADMIN_USER:-gitea_admin}"
      GITEA_ADMIN_PASSWORD: "${GITEA_ADMIN_PASSWORD}"
      GITEA_ADMIN_EMAIL: "${GITEA_ADMIN_EMAIL:-admin@beckn.local}"
    volumes:
      - gitea-data-2:/data

volumes:
  postgres-data:
  gitea-data-1:
  gitea-data-2:
```

`docker/postgres/init.sql`:
```sql
CREATE TABLE IF NOT EXISTS catalog_routing (
  catalog_id   TEXT        PRIMARY KEY,
  node_url     TEXT        NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Each Gitea node is fully independent (own SQLite, own volume). The API service's `GITEA_NODES` env var feeds the hash ring (initial placement only). PostgreSQL is the authoritative routing store; Redis is the cache in front of it. An init SQL script creates the `catalog_routing` table at first startup. The admin user is created automatically by the Gitea container on first start via env vars; the init script only needs to create the `beckn` org.

To demonstrate node addition: add a `gitea-3` service to the compose file, run the bootstrap script, add its URL to `GITEA_NODES`, and restart the API. The smoke test verifies that all existing repos are still accessible and new catalogs are now distributed across all three nodes.

---

## 13. Acceptance Criteria

### Publish & Read
- [ ] **AC-1:** `POST /catalog/publish` with the `grocery_catalog.json` fixture returns `{ status: "ACK" }` (HTTP 200).
- [ ] **AC-2:** After AC-1, Redis routing table contains `CAT-GROCERY-FRESHMART-ION-005 → <nodeUrl>`, and that Gitea node has a repo with a `manifest.json` commit on `main`.
- [ ] **AC-3:** A second `POST /catalog/publish` for the same catalog creates a second commit in the same repo, routing table entry unchanged.
- [ ] **AC-4:** `GET /catalog/CAT-GROCERY-FRESHMART-ION-005` returns the current manifest JSON.
- [ ] **AC-5:** Publishing 300 random catalog IDs results in each of the 2 Gitea nodes receiving 120–180 repos.

### Routing Correctness
- [ ] **AC-6:** Restarting only the API container — PostgreSQL routing table persists — re-publishing `CAT-001` routes to the same Gitea node as before.
- [ ] **AC-7:** Flushing Redis entirely (`FLUSHALL`) and then publishing to an existing `CAT-001` — Redis cache miss → PostgreSQL lookup → correct node returned, Redis repopulated. No data loss, no mis-route.
- [ ] **AC-8:** `POST /catalog/publish` with `catalogId = "../../../etc/passwd"` returns HTTP 400 NACK with `errorCode: "INVALID_CATALOG_ID"` and nothing is written to Redis or Gitea.

### Node Addition (Zero Data Movement)
- [ ] **AC-9:** After publishing 30 catalogs across 2 nodes, add `gitea-3` to `GITEA_NODES` and restart the API. No migration script is run.
- [ ] **AC-10:** After node addition, `GET /catalog/:catalogId` returns correct data for all 30 previously published catalogs (no 404s) — all still served from their original nodes.
- [ ] **AC-11:** After node addition, the Redis routing table entries for all 30 existing catalogs are unchanged — they still point to their original Gitea nodes (gitea-1 or gitea-2).
- [ ] **AC-12:** Publishing 30 new catalogs after node addition results in `gitea-3` receiving approximately 33% of the new assignments (±10%), while all 30 old catalogs remain on their original nodes.

### Tests
- [ ] **AC-13:** All unit tests pass (`npm test -- --testPathPattern=tests/unit`).
- [ ] **AC-14:** All integration tests pass (`npm test -- --testPathPattern=tests/integration`).
- [ ] **AC-15:** E2E smoke test (including node addition scenario) passes against the running Docker Compose stack.

---

## 14. Out of Scope

- Beckn HTTP Signature authentication
- Kafka producer/consumer
- Subscription management
- Delivery / push to subscribers
- Git repo replication or failover (each repo lives on one node only)
- Item-level git repos (only catalog manifests for this POC)
- Production hardening (TLS, rate limiting, secrets management)
- Node removal (decommissioning a node — requires a separate migration procedure to move its repos off first; out of scope)
- Repo rebalancing (redistributing existing repos across nodes after addition — this is explicitly excluded by the zero-movement design; if needed it would be a separate operational concern)
- Automatic/continuous rebalancing

---

## 15. Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Should FULL mode physically delete and recreate the repo, or just commit a replacement manifest? | OPEN — for POC, FULL = new commit (same as MERGE) |
| 2 | What is the right virtual node count? (150 per node is a starting point) | OPEN — tune in Phase 1 tests |
| 3 | Redis cache key structure: `HSET catalog-routing {catalogId} {nodeUrl}` (single hash) or `SET catalog-routing:{catalogId} {nodeUrl}` (per-key with optional TTL)? | OPEN — single hash preferred for diagnostics (`HGETALL`); per-key allows TTL-based cache expiry if routing entries ever need forced refresh |
| 4 | Concurrent first-publish to the same new catalogId: two simultaneous requests → both do INSERT; PostgreSQL's `ON CONFLICT DO NOTHING` ensures only one row is written; both get the same node back (deterministic hash ring). | RESOLVED — `ON CONFLICT DO NOTHING` + deterministic hash ring makes this safe |
| 5 | What happens if PostgreSQL is lost? | OPEN — disaster recovery: restore from `pg_dump` backup, or scan all Gitea nodes' org repos and rebuild the routing table (both out of scope for the POC) |
| 6 | Should Redis cache entries have a TTL, or be permanent until explicitly invalidated? | OPEN — permanent (no TTL) is simplest given entries never change in the zero-movement model |
