# git-distributed-poc

A proof-of-concept for storing Beckn v2.0 catalog data as versioned git repositories distributed across multiple Gitea nodes, with a Praefect-inspired coordinator for deterministic routing.

## What this POC demonstrates

- **Horizontal git storage** — catalog JSON is stored as bare git repos on independent Gitea nodes; each node owns a deterministic shard of the catalog ID space
- **Praefect-inspired coordinator** — PostgreSQL is the authoritative routing table (catalog ID → node URL); Redis is a read-through cache in front of it; the consistent hash ring is used only for first-time placement of new catalog IDs; each physical node gets 150 virtual positions on the ring so that load is statistically balanced (~50% per node for a 2-node cluster) regardless of where the node URLs happen to hash — with only 1 position per physical node the split could be arbitrarily skewed
- **Zero-movement node addition** — adding a 4th Gitea node updates `GITEA_NODES` and restarts the API; existing catalog IDs keep their Postgres-recorded node; only new IDs begin routing to the expanded ring; no data migration required
- **Full version history** — every publish creates a new git commit; MERGE and FULL update modes both produce an auditable commit log

## Architecture

```
BPP (publisher)
      |
      v
  API :3000  (Express — validates Beckn v2.0, routes via coordinator)
      |
      +---- PostgreSQL :5432  (authoritative routing table)
      |---- Redis      :6379  (routing cache; ephemeral — no persistence)
      |
      +---- Gitea-1 :3001  (~1/2 of catalog repos, SQLite + volume)
      +---- Gitea-2 :3002  (~1/2 of catalog repos, SQLite + volume)
```

## Prerequisites

- Node.js 20+
- Docker with Compose v2 (`docker compose` subcommand)
- `curl` and `jq` (used by the bootstrap script)

## 1. Install dependencies

```bash
npm install
```

## 2. Configure environment

Copy the example env file and set the required secrets:

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
GITEA_ADMIN_PASSWORD=your-password-here
POSTGRES_PASSWORD=your-password-here
```

The full set of variables:

| Variable | Default | Required |
|---|---|---|
| `GITEA_ADMIN_PASSWORD` | — | **yes** |
| `POSTGRES_PASSWORD` | — | **yes** |
| `GITEA_ADMIN_USER` | `gitea_admin` | no |
| `GITEA_ADMIN_EMAIL` | `admin@beckn.local` | no |
| `GITEA_NODES` | set in compose | no |
| `PORT` | `3000` | no |
| `GITEA_ORG` | `beckn` | no |

## 3. Start the stack

`start.sh` builds images, starts all containers, creates the Gitea admin user on each node, creates the `beckn` org, and waits for the API to be healthy — all in one step.

```bash
./start.sh
```

For a clean slate (wipes all volumes and rebuilds from scratch):

```bash
./start.sh --fresh
```

When it finishes you will see:

```
Stack is ready.

  API:     http://localhost:3000
  Gitea-1: http://localhost:3001/beckn
  Gitea-2: http://localhost:3002/beckn
```

> **What `start.sh` does internally:**
> 1. Sources `.env` for credentials
> 2. Starts Postgres, Redis, and both Gitea nodes (`docker compose up --build -d`)
> 3. Runs `docker/gitea/init.sh` against each node — waits for Gitea readiness, creates the admin user via `docker exec`, creates the `beckn` org
> 4. Starts the API container (`docker compose up -d api`)
> 5. Polls `GET /health` until the API is up

## 4. Run the smoke test

```bash
node tests/e2e/smokeTest.js
```

Env vars are read from the `.env` file. Requires the full Docker Compose stack to be running. Covers:

1. Publish a catalog → `200 ACK`
2. Read it back → manifest matches
3. Re-publish → second git commit on the same Gitea node
4. Publish 90 distinct IDs → each of the 2 Gitea nodes receives 35–55 repos
5. GET an unknown catalog → `404 NACK NOT_FOUND`
6. POST an invalid payload → `400 NACK INVALID_REQUEST`

## 5. Run unit and integration tests

No Docker required — all external dependencies are mocked with nock / ioredis-mock / jest.mock.

```bash
npm test                                                          # full suite
npm test -- --testPathPattern=tests/unit/coordinator/hashRing    # Phase 1 only
npm test -- --testPathPattern=tests/unit/coordinator/routingTable # Phase 2 only
npm test -- --testPathPattern=tests/unit/gitea/giteaClient       # Phase 3 only
npm test -- --testPathPattern=tests/integration/gitea            # Phase 4 only
npm test -- --testPathPattern=tests/integration/api              # Phase 5 only
npm test -- --coverage                                            # with coverage report
```

## 6. Browse repos

After publishing, inspect repos in the Gitea web UI:

- `http://localhost:3001/beckn`
- `http://localhost:3002/beckn`

Each catalog ID appears as a repo under the `beckn` org on whichever node owns its shard.

## 7. Adding a 3rd node (zero migration)

1. Add a `gitea-3` service to `docker-compose.yml` (copy any existing `gitea-N` block, port `3003:3000`, volume `gitea-data-3`).
2. Start it:
   ```bash
   docker compose up -d gitea-3
   ```
3. Bootstrap the new node:
   ```bash
   GITEA_ADMIN_PASSWORD=changeme ./docker/gitea/init.sh http://localhost:3003
   ```
4. Update `GITEA_NODES` and restart the API:
   ```bash
   GITEA_NODES="http://gitea-1:3000,http://gitea-2:3000,http://gitea-3:3000" \
   docker compose up -d api
   ```

Existing catalog IDs continue routing to their original nodes (Postgres entries are unchanged). Only new catalog IDs are placed using the updated 3-node ring.

## Key documents

| Document | Purpose |
|---|---|
| `docs/PRD.md` | Product requirements and acceptance criteria |
| `docs/DISTRIBUTED_GIT_COMPARISON.md` | Comparison of this approach vs Gitaly/Praefect and other distributed git strategies |
| `docs/IMPLEMENTATION_PLAN.md` | Phased TDD implementation plan (Phases 0–7) |
| `CLAUDE.md` | Component map, hard rules, file index for AI agents |
