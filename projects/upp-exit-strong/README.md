# Exit Strong

A playable browser development-strategy game by Urban Planning Pros, based on *Before the Land Deal Gets Expensive* by Jeremy Wenger.

Play the fictional Mill Creek campaign: manage a diligence budget and deadline, uncover site constraints, and choose among six supported endings. Progress saves on the current device. The final move can be replayed to compare another supported ending. A decision record can be downloaded.

## Run and verify

Serve `dist/` with an ordinary static HTTP server. Opening the HTML directly through `file:` does not support module loading reliably. The game uses native browser modules and needs no package installation or compilation.

```sh
node scripts/release-check.mjs
```

Run from this module directory. The release check enforces resource budgets, content references, duplicate-file rules, local asset links, and game behavior. `resource-contract.json` records the exact scope. There is no claimed billion-fold reduction in actual costs or consumption.

## Folder contract

| Location | One job |
| --- | --- |
| `dist/index.html` | Game entrypoint |
| `dist/game/app.mjs` | Shared game interface and interactions |
| `dist/game/engine.mjs` | Pure moves, prerequisites, state, replay, score |
| `dist/game/content/mill-creek.mjs` | Canonical campaign and book notes |
| `dist/game/assets/` | Shared media, once per asset |
| `dist/game/limits.mjs` | Bounded runtime and artifact limits |
| `scripts/` | Deterministic resource/release checks |
| `tests/` | Meaningful route, save, budget, and failure tests |
| `work/` | Small stage contracts and evidence handoffs |
| `CONTINUE.md` | Bounded next-session context |

No folders per player, move, route, or history. No book PDF in the website or repository. Saves hold action IDs, not content. No model calls occur during gameplay. Serving compressed text and cache headers remains the host's responsibility; local gzip measurements are not a claim about observed production transfers.

## Current integration boundary

The existing public book and UPP contact pages are linked. This module does not modify the current site, book price, checkout, customer records, or production credentials. Additional campaigns are labeled in development and are not sold.

Production integration should mount `dist/` at `/play/` and add a play link on `/book`. All assets use paths relative to the module entrypoint. A reverse proxy or static host must preserve the trailing slash or redirect `/play` to `/play/`. No invented production API is called.

Before paid access ships, inspect the actual production checkout implementation, establish server-side authenticated entitlements, and serve paid campaign data only through a protected backend. Verify payment amount, product, currency, session, signature, replay protection, refunds, and entitlement revocation against that backend. Local saves and client flags must never grant paid access. Do not expose secrets in this static module.

## Sources and art

Book: *Before the Land Deal Gets Expensive*, first edition 2026, Jeremy Wenger, 94-page illustrated edition. Framework: PDF pages 3–7. Phasing: PDF pages 37–39 / printed pages 29–31. Coordination: PDF pages 54–58 / printed pages 43–46. Exits: PDF pages 67–69 / printed pages 53–55. Game notes are adaptations, not a substitute for the complete book. The site links to https://urbanplanningpros.com/book.

The fictional rural-parcel art was generated once using OpenAI image generation, then encoded as one WebP. It is illustrative; map overlays are game geometry, not GIS or survey boundaries.

## Scope of verification

Local automated checks cover all six endings, prerequisite denial, deadline and budget checks, finite extension, corruption handling, bounded save restoration, event uniqueness, and replay. Visual/browser testing and real checkout integration are separate and must not be claimed without evidence.
