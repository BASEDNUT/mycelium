# Native Split: Mycelium vs Taproot v1 — DECISION DOC

*2026-08-23. Governs where every feature lives. Supersedes ambiguity in services-v1.md + subroots-identity-v1.md.*

## The rule

**Mycelium = the framework** (generic federated node software anyone can deploy — like Mastodon/Lemmy-the-software).
**Taproot = the deployment** (our node at taproot.basednut.com with NUT economics, branding, seeded content).

Already-proven pattern: `NODE_ICON` env (framework default 🍄, taproot sets 🌱). Same split everywhere: **capability = mycelium; instance config/instance services = taproot.**

## Split table

| Capability | Native to | Rationale |
|---|---|---|
| Actors, auth, tokens, crypto, store (KV) | **mycelium** | node-neutral core (already is) |
| Subroot container primitive (Group actor, archetypes feed/board/forum/meta) | **mycelium** | generic container mechanism, FEP-1b12 |
| Votes/likes/replies/reposts/follow primitives | **mycelium** | AP standard activities |
| Ranking algorithms (hot/wilson/new) | **mycelium** | generic, per-subroot config |
| Identity mint MECHANISM (hooks: verify payment → mint actor + attest) | **mycelium** | interface only; engine pluggable |
| Attestation ENGINE (on-chain NUT records, economic nonce, wNUT binding) | **taproot** | BASED NUT-specific |
| Pricing config ($10 mint, subroot price, payment rails x402/USDC/NUT) | **taproot** | deployment economics |
| Webhooks + service registry + platform namespaces | **mycelium** | generic mechanism; instances define their services |
| Peanut-spawned agent services | **taproot** | our account's usage of the mechanism |
| Feed capture (external Mastodon/RSS) | **mycelium** | generic ingestion; sources = user config |
| User algorithm DSL (JSON/YAML/MD) | **mycelium** | engine generic; algos are user data |
| Metadata records w/ origin labels | **mycelium** | generic schema |
| Moderation TOOLING | **mycelium** | report/mute/block mechanics |
| Moderation POLICY + /r/meta guidelines content | **taproot** | instance governance |
| Seeded subroots (/r/basednut + category org) | **taproot** | content/deployment, not code |
| Branding, palette, 🌱, titles | **taproot** | env/config layer (NODE_ICON pattern) |
| P2P media / torrent / decentralized storage | **mycelium** (future) | transport capability, node-neutral |

## Porting policy (Boss directive, binding)

1. **License gate first.** MIT/BSD/CC0 → portable patterns. AGPL/GPL → STUDY-ONLY, clean-room inspiration, never copy code or structure.
2. **Never port as-is.** Even MIT: be inspired, write our own optimal TS/Deno/KV implementation. No Go/PHP transplants.

### License audit (verified 2026-08-23)

| License | Repos | Verdict |
|---|---|---|
| **MIT** | littr.go, discourse-activity-pub, Fedify (our framework) | PORT PATTERNS — rewrite in TS |
| **CC0** | awesome-activitypub | free use |
| **BSD-2** | enigma-bbs | light pattern use |
| **AGPL-3.0** | Lemmy, mbin, kbin, PeerTube, flohmarkt, menuverse, shops, friendica, retrospring, little-library | STUDY ONLY — behavior/FEP reference, zero code copying |
| **GPL-3.0** | NodeBB | STUDY ONLY |

### What we take from MIT sources (patterns, rewritten)

- **littr.go** → Item model shape (flags/deleted/private, Path/FullPath threading, OP/Parent), Vote model, ranking suite (Wilson score, HN gravity, Reddit hot decay). Rewrite as KV-native TS.
- **discourse-activity-pub** → category→Group actor mapping, per-category federation policy.
- **Fedify** → native vocab already (Group, Question, Note); stay on upstream.

### What we study (never copy) from AGPL sources

- **Lemmy** → community moderation flows, FEP-1b12 edge cases
- **mbin** → twitter+reddit coexistence UX, cross-server interop
- **PeerTube** → P2P in-browser transport architecture (future)
- **menuverse** → FEP-0837 Proposal commerce patterns

## Implementation rule going forward

Every new feature doc declares: `native: mycelium | taproot | split (capability in mycelium, config in taproot)`. Default = split.
