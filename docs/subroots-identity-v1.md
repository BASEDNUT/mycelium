# Subroots & Identity Architecture v1 — DRAFT (Boss-corrected 2026-08-23)

Status: Boss agreed "mostly" + corrected subroot model + set mint pricing. This doc supersedes the subroot section of services-v1.md. AP-support question answered with verified evidence (see research/fediverse-references-2026-08-23.md).

## Subroots = the subreddit primitive (corrected model)

Users/actors and posts exist. Posts must occur somewhere. That somewhere = **subroot** (Reddit got this right with subreddits). A subroot is a container with:

- slug + title + description + links (primitives per subroot)
- config: votes on/off, anonymous allowed, retention (rolling 7d default for boards, ∞ for forums)
- federation as AP **Group actor** (Lemmy/mbin-proven pattern)

### Two classes of subroot

**1. Special system subroots** (fixed archetypes, node-owned):

| System subroot | Archetype | Behavior |
|---|---|---|
| `/s/feed` | Twitter-style | short posts, follows, likes/boosts |
| `/s/board` | 4chan-style | anonymous, rolling 7-day deletion |
| `/s/forum` | Reddit-style | threads with titles + votes |
| `/s/meta` | guidelines/governance | node rules, appeals, transparency |

**2. General community subroots** (user-created, cost money):

- `/s/basednut` — BASED NUT + taproot home (seeded first)
- `/s/crypto`, `/s/fintech`, `/s/agents`, `/s/coinbase`, … — organized categories
- open-ended; better organization than flat list (category grouping)

Each general subroot declares its archetype (feed/board/forum) — the special subroots are just the first instances of each archetype.

## ActivityPub support: YES (verified)

- Group actors for communities: Lemmy, mbin, kbin (FEP-1b12)
- Votes = Like/Dislike activities: Lemmy/mbin in production
- Threads + microblog mixed on one platform: mbin does exactly this
- Cross-interop: mbin speaks Mastodon + Lemmy + PeerTube
- Commerce Proposals: FEP-0837 (menuverse, Fedify-native — same framework we use)
- Evidence: research/fediverse-references-2026-08-23.md

## Identity: $10 mint → attestation engine

- **Mint cost: $10** — economically unviable to fake identity at scale
- One account = one identity record **on-chain** with an **economic nonce** that is incredibly hard to reproduce (binds to wNUT economic-nonce design, S59+)
- NUT identities attested on-chain via the attestation engine; portable — take identity to your own servers, other nodes, any verifier
- Browse always free; mint only when you want to post in forum/feed or take identity elsewhere

### Anonymous path

- Board subroots allow anonymous posts: no mint required (not logged in) OR minted users choosing anonymity
- Rolling 7-day deletion default; zero identity retention on anon posts
- Spam control on anon surface: TBD (candidates: per-IP rate limit, proof-of-work per post, per-subroot captcha-ish challenge) — open question

## Vote weight

- Default: 1-identity-1-vote (one minted identity = one vote)
- Stake-weighted voting deferred (future knob, not v1)

## Cost model

| Action | Cost |
|---|---|
| Browse | free, anonymous |
| Mint identity | $10 → attestation engine, on-chain record + economic nonce |
| Post (forum/feed/board as identity) | free (identity already paid) |
| Anon post (board only) | free, rate-controlled |
| Create subroot | costs money (anti-spam skin in game) |

## Open questions

1. Anon spam control mechanism (IP limit vs PoW vs hybrid)
2. Subroot creation price point
3. $10 denom: USDC via x402? NUT equivalent? both accepted?
