# Distributed Git Server — Comparison & Choice

**Date:** 2026-05-05
**Purpose:** Select the right git storage engine for running multiple git-server containers with consistent-hash-based data locality. The production implementation is Java (JGit). This POC uses Node.js for simplicity; the server choice must be language-agnostic and compatible with Java/JGit.

---

## Problem Statement

We need to distribute bare git repositories across N container nodes, where each node owns a deterministic subset of repos (data locality). A routing layer (consistent hash ring) in the API service decides which node stores a given `catalogId`. The git server software on each node only needs to:

1. Accept writes: create a bare repo on first use, commit JSON files
2. Serve reads: return the latest file content from HEAD
3. Expose an interface usable from **Java** (production) and **Node.js** (POC)

**Critical distinction:** The *sharding/routing* problem is solved by the consistent hash ring in the API layer — not by the git server. The git server on each node is unaware of other nodes. It just manages its local repos.

---

## How Do These Servers Expose Their Interface?

A key evaluation criterion is what interface a client (Java or Node.js) uses to talk to each server:

| Server | REST API | Git smart HTTP | gRPC | SSH |
|--------|----------|----------------|------|-----|
| **Gitea** | Full OpenAPI spec — file CRUD, repo management, commits | Yes (`/owner/repo.git`) | No | Yes |
| **Gogs** | Subset of Gitea API (Gitea's ancestor) | Yes | No | Yes |
| **git-http-backend** | None | Yes (`/path/to/repo.git`) | No | No |
| **Gitaly** | None (internal GitLab) | No | Yes (GitLab-specific protos) | No |
| **Soft Serve** | Limited HTTP API; SSH Wish API for management | Yes (since v0.6) | No | Yes (primary) |
| **Forgejo** | Same as Gitea (fork) | Yes | No | Yes |

### What "REST API for file operations" means (Gitea example)

Gitea allows creating and reading file contents entirely over HTTP without any git client:

```
# Create/update a file (creates a commit)
PUT /api/v1/repos/{owner}/{repo}/contents/{filepath}
Body: { message: "commit msg", content: "<base64-encoded content>", sha: "<prev blob sha if updating>" }
Response: { content: { sha, name, ... }, commit: { sha, ... } }

# Read a file (from HEAD or a ref)
GET /api/v1/repos/{owner}/{repo}/contents/{filepath}
Response: { content: "<base64>", encoding: "base64", sha, ... }

# List commits
GET /api/v1/repos/{owner}/{repo}/commits
```

This means the Java production system can call Gitea's REST API with a plain HTTP client — no JGit required.

---

## Comparison Table

| Option | Stack | Container size (est.) | REST API | JGit compat | Clustering model | Data locality support | Notes |
|--------|-------|-----------------------|----------|-------------|------------------|-----------------------|-------|
| **N independent Gitea instances** | Go binary + SQLite | ~80–120 MB image, ~100–200 MB RAM | ✅ Full OpenAPI | ✅ HTTP transport | Independent shards (hash ring routes externally) | ✅ Excellent — each instance owns its shard | Web UI; `gitea4j` Java SDK |
| **git-http-backend + nginx** | C (git) + nginx | ~20–40 MB Alpine | ❌ None | ✅ Native HTTP transport | None (external routing only) | ✅ Excellent — nginx upstream routing trivial | Lightest; no web UI; no REST |
| **Soft Serve** | Go single binary | ~30–50 MB | ⚠️ Limited HTTP API | ✅ HTTP + SSH transport | None (single-instance design) | ✅ Good as stateless HTTP backend | Best SSH story; no Java SDK |
| **Gitea HA (shared storage)** | Go + PostgreSQL + Redis + NFS | 500 MB+ total stack | ✅ Full OpenAPI | ✅ | All nodes share one storage pool | ❌ Wrong model — contradicts per-node local disk sharding | This is NOT what we want |
| **Gogs** | Go binary + DB | ~50–80 MB | ⚠️ Subset of REST | ✅ HTTP transport | None | ✅ Like Gitea but simpler | Reduced maintenance (1 maintainer) |
| **Gitaly + Praefect** | Go + PostgreSQL | 500 MB+ | ❌ (internal GitLab protos) | ❌ gRPC only | Built-in (Praefect) | ❌ Praefect owns routing — not customizable | Requires full GitLab auth stack |
| **JGit HTTP servlet** | Java + JVM | 200–400 MB JVM | ❌ None | ✅ Native | None | ✅ Good (same lib as beckn-catalg) | Already used in parent project; JVM weight |
| **Custom Node.js worker + simple-git** | Node.js + git CLI | ~50–60 MB | ✅ Custom REST | ✅ via REST | None | ✅ Excellent | POC-only; simple-git wraps system git |
| **nodegit** | Node.js + native C | Heavy | N/A | N/A | N/A | N/A | Abandoned; Node 18+ build failures |
| **isomorphic-git** | Pure JS | Tiny (library) | N/A (client only) | N/A | N/A | N/A | Client library only — no server-side |

---

## Deep Dives

### Option A: N Independent Gitea Instances (one per shard)

Each shard node runs a **standalone Gitea instance** with its own SQLite database and local disk volume. Nodes have no knowledge of each other. The API's consistent hash ring routes `catalogId → Gitea instance URL`.

```
API Service (Java or Node.js)
├── HashRing.getNode(catalogId) → "http://gitea-2:3000"
├── PUT http://gitea-2:3000/api/v1/repos/beckn/{catalogId}/contents/manifest.json
│   Body: { message: "catalog update", content: base64(manifest), sha: prevSha }
└── GET http://gitea-2:3000/api/v1/repos/beckn/{catalogId}/contents/manifest.json

Gitea-1 (:3001) ─── SQLite + /data/gitea ── owns ~1/3 of all repos
Gitea-2 (:3002) ─── SQLite + /data/gitea ── owns ~1/3 of all repos
Gitea-3 (:3003) ─── SQLite + /data/gitea ── owns ~1/3 of all repos
```

**Repo lifecycle:**
1. Before first commit: `POST /api/v1/orgs/beckn/repos` to create the repo on the correct node
2. Subsequent commits: `PUT /api/v1/repos/beckn/{catalogId}/contents/manifest.json` (idempotent with `sha` of previous blob)

**Pros:**
- Full REST API — Java production code needs only an HTTP client (Apache HttpClient, OkHttp), not JGit
- Web UI: inspect any repo's commit history in a browser during development/demo
- Standard git protocol also available — JGit or `git clone` works against any instance
- Production-grade: 45k+ GitHub stars, actively maintained, MIT license
- Java SDK: `gitea4j` on Maven Central
- SQLite per node: no external DB dependency in basic mode
- Docker image: `gitea/gitea:latest` (~80–120 MB)

**Cons:**
- Heavier than bare git-http-backend (~100–200 MB RAM per instance vs ~5 MB)
- Repo must be explicitly created via API before first commit (extra step)
- Admin token required for API auth (setup step in Docker Compose)
- SHA of existing blob required for updates (must track `sha` field per file per repo)

**Java interaction pattern:**
```java
// Using Apache HttpClient or OkHttp — no JGit needed
var client = HttpClient.newHttpClient();
var body = Map.of(
    "message", "catalog update: " + catalogId,
    "content", Base64.getEncoder().encodeToString(manifestJson.getBytes()),
    "sha", existingBlobSha  // empty on first write
);
var response = client.send(
    HttpRequest.newBuilder()
        .uri(URI.create(giteaNodeUrl + "/api/v1/repos/beckn/" + catalogId + "/contents/manifest.json"))
        .header("Authorization", "token " + giteaToken)
        .PUT(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
        .build(),
    HttpResponse.BodyHandlers.ofString()
);
```

---

### Option B: git-http-backend + nginx (per node)

Each node runs the `git http-backend` CGI program (bundled with git) behind nginx. This implements the full git smart HTTP protocol (upload-pack for clone/fetch, receive-pack for push). JGit's HTTP transport connects to it natively.

```
API Service (Java/JGit)
├── HashRing.getNode(catalogId) → "http://git-node-2:80"
└── JGit HTTP transport: push manifest.json to http://git-node-2/repos/{h1}/{h2}/{catalogId}.git

nginx-1 (:81) ─── git http-backend CGI ─── /data/repos (bare repos)
nginx-2 (:82) ─── git http-backend CGI ─── /data/repos (bare repos)
nginx-3 (:83) ─── git http-backend CGI ─── /data/repos (bare repos)
```

**Pros:**
- Lightest option: Alpine + nginx + git ≈ 20–40 MB image, ~5–10 MB RAM idle per node
- JGit HTTP transport is natively compatible (no REST layer)
- Pattern directly mirrors what beckn-catalg already does (JGit on local disk), but made remote
- No authentication setup for POC (nginx can skip auth)

**Cons:**
- No REST API — only git smart HTTP protocol; Node.js POC needs `git-http-backend` npm package or a custom proxy
- No web UI for repo inspection
- Repo must be pre-created (`git init --bare`) before first push — need a pre-receive hook or sidecar
- nginx configuration required (CGI setup)

**Java interaction pattern:**
```java
// Uses JGit HTTP transport — same pattern as existing ItemGitProvider but remote
var remoteRepoUrl = giteaNodeUrl + "/repos/" + h1 + "/" + h2 + "/" + catalogId + ".git";
try (var git = Git.cloneRepository()
        .setURI(remoteRepoUrl).setBare(true).call()) {
    // ... commit and push
}
```

---

### Option C: Soft Serve

Single Go binary, MIT license, 6.9k stars (March 2026). Supports HTTP since v0.6. Works as a standalone HTTP git server.

**For this use case:** Good fit as a stateless HTTP git backend per node. No REST API for file operations (management is via SSH Wish API or the HTTP API is limited). JGit SSH or HTTP transport works. No clustering built-in — hash ring routes externally. No Java SDK.

The lack of a REST API means the Java client must use JGit transport, similar to Option B.

**Not chosen** over Gitea (no REST API for file ops) and over git-http-backend (heavier with no added benefit for this use case).

---

### Why Gitea HA Mode is NOT the Right Model

Gitea's HA (high availability) mode connects multiple Gitea instances to a **single shared storage backend** (NFS, GlusterFS, or MinIO/S3) and a **shared PostgreSQL database**. Every node sees every repo. This achieves redundancy (any node can serve any request) but not sharding/locality (repos are not partitioned by node).

**This is the opposite of what we want.** We want node-1 to own repos A-F, node-2 to own G-M, etc. Gitea HA means all three nodes own all repos — no data locality, no horizontal storage scaling.

**The correct Gitea model for sharding is: N independent standalone instances**, each unaware of the others, with external consistent-hash routing. Each instance uses SQLite (no shared DB). Each instance has its own local volume.

---

## Recommendation

### For the POC (Node.js): Custom Node.js worker + simple-git

For the POC, the cleanest approach is a custom Node.js Express service on each worker node using `simple-git` (a thin Node.js wrapper around the system git CLI):

- **Simplest to implement** for a Node.js POC — no Gitea setup/tokens/admin bootstrap
- **Educational** — every component is explicit JavaScript code
- **Exact control** over repo layout (SHA-256 directory sharding, same as beckn-catalg)
- `simple-git` wraps system git binary — the same proven git operations underneath
- Worker API: custom JSON REST (`POST /repos/:catalogId/commit`, `GET /repos/:catalogId/manifest`)

The POC demonstrates the **concept** of distributed git storage. The actual server software (Gitea vs git-http-backend) is a deployment detail.

### For Production (Java): Gitea independent instances

For the production Java implementation, **N independent Gitea instances** (one per shard) is recommended:

| Criterion | Gitea | git-http-backend |
|-----------|-------|-----------------|
| REST API (no JGit on client) | ✅ | ❌ |
| JGit HTTP transport | ✅ | ✅ |
| Web UI for debugging | ✅ | ❌ |
| Container weight | ~100–200 MB RAM | ~5–10 MB RAM |
| Java SDK | `gitea4j` | N/A |
| Admin token setup | Required | Not needed |
| Repo auto-creation | Via API (extra step) | Via pre-receive hook |
| **Winner** | **✅ Preferred** | Good for ultra-light nodes |

**Gitea wins** for production because its REST API means the Java service doesn't need JGit HTTP transport complexity for remote operations — it uses a plain HTTP client. The web UI makes catalog repo inspection easy during development and debugging. The weight (100–200 MB RAM per instance) is acceptable in a production container deployment.

If container weight is a hard constraint (e.g., embedded/edge deployments), **git-http-backend + nginx** is the better alternative (20–40 MB image, ~5–10 MB RAM), with JGit HTTP transport on the Java side.

---

## Docker Compose for the POC

```yaml
# POC: Custom Node.js worker (lightweight, educational)
services:
  api:
    build: docker/api/
    ports: ["3000:3000"]
    environment:
      GIT_WORKER_NODES: "http://git-worker-1:4000,http://git-worker-2:4000,http://git-worker-3:4000"

  git-worker-1:
    build: docker/git-worker/     # Node.js + git binary
    ports: ["4001:4000"]
    volumes: [git-data-1:/data/repos]

  git-worker-2:
    build: docker/git-worker/
    ports: ["4002:4000"]
    volumes: [git-data-2:/data/repos]

  git-worker-3:
    build: docker/git-worker/
    ports: ["4003:4000"]
    volumes: [git-data-3:/data/repos]

volumes: { git-data-1: {}, git-data-2: {}, git-data-3: {} }

# Production equivalent: replace git-worker-N with gitea/gitea:latest
# and configure each with its own GITEA_SQLITE_PATH + volume
```

---

## References

- [Gitea REST API (Swagger UI)](https://gitea.io/api/swagger)
- [gitea4j — Java SDK for Gitea](https://github.com/zeripath/java-gitea-api)
- [Gitea HA Deployment docs](https://docs.gitea.com/enterprise/installation/high-availability)
- [git-http-backend man page](https://git-scm.com/docs/git-http-backend)
- [charmbracelet/soft-serve](https://github.com/charmbracelet/soft-serve)
- [Gitaly + Praefect (GitLab)](https://docs.gitlab.com/administration/gitaly/praefect/)
- [simple-git npm](https://www.npmjs.com/package/simple-git)
- [JGit HTTP transport](https://www.eclipse.org/jgit/)
