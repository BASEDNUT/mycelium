# Services & Metadata Architecture v1 — APPROVED 2026-08-23

Status: APPROVED by operator (Boss) 2026-08-23. Doc-driven design: each phase
writes its design intent here BEFORE code; tests prove behavior AFTER. Docs and
tests are different capture points, not competitors.

## Two ideas

- **Mycelium** — the MIT-licensed base framework (actors, posts, federation,
  graph). Framework default icon: 🍄 mushroom.
- **Taproot** — a dependent node deployment of Mycelium. Node icon: 🌱 seedling.
  One grows from the other.

## Service system

Two service tiers, both scoped:

1. **Node-level services** — platform infrastructure owned by the instance:
   account generation, admin controls, moderation, attestation engine,
   external feed capture, relay. Namespaced: `platform/auth`, `platform/admin`,
   `platform/moderation`, `platform/attestation`, `platform/feeds`, `platform/relay`.
2. **Account services** — bots BOUND to an account. No account, no service.
   The only way to generate a service is to have an account.

### Account services are scoped by user intent

- `heartbeat` — wake up, think, generate a post (e.g. an agent account running
  on its own system, like a subordinate agent)
- `on_reply` — send webhook to https://xyz.123 when replied to
- `daily` — send webhook to an API on schedule
- open set: intents are declarations, execution is webhook/event-driven

### Webhooks

- Events: post.created, react, follow, mention, reply
- Signed POST to registered URL (SSRF-guarded) = communication relay to agents
- x402-aware: target returns HTTP 402 → webhook runner pays (Coinbase,
  Venice, similar) → retry
- Attestations for all users ride this machinery as a platform service

## Tags → metadata capture

- All posts carry tags: **user-defined + platform** (offer / post / discussion /
  etc.) — agent-like routing and organization
- First-class MetadataRecord: subject + key/value + origin label
  (internal | external | system | service) + set-by actor + timestamp
- If metadata is external, it says so

## External feeds

- Separate capture place: FeedSource/FeedItem tables, own namespace
- Poller ingests RSS/Atom/JSON with provenance; capture ≠ publish
- Republish only via an account-bound feed-bridge service

## Build order (doc → test → code, each gated)

P1 accounts + service registry → P2 webhooks + x402 → P3 platform
namespaces → P4 feed capture → P5 metadata → P6 moderation/
attestation UI → P7 search/pagination/DM/media.
