# Board Rules (v2) — /r/board

*Taproot deployment policy. Framework default; node operators may override.*

## Rules for anonymous posting

1. Nothing illegal under US law. Nothing inciting violence.
2. No NSFW.
3. No shilling crypto projects.
4. No links — enforced by the node: anonymous posts containing links are rejected at post time.
5. No images — enforced by the node: anonymous posts cannot attach images.
6. No stealing or reposting content without attribution.
7. No spamming; no flooding that compromises normal operation of the site.

## Enforcement

- Rules 4-5 are enforced automatically at post time (403 on link/image).
- Rules 1-3 and 6-7 are mod-enforced: moderators may delete posts in their root at any time; the admin token may delete any post.
- Report endpoint: POST /api/report with a reason from REPORT_REASONS.
- Anonymous posts (new threads and replies) are allowed on board-archetype roots with anonymous enabled only.
- Board posts roll off after the retention window (Taproot: 24 hours).
