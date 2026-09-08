# Exit Strong continuation

Outcome: playable UPP book-based development game, not a report or dashboard.

Canonical runtime: `dist/index.html` and `dist/game/`. One campaign file defines every move and exit. The engine rebuilds state from bounded action IDs. Two shared WebPs supply the cartoon world and Scout. No runtime model/API calls or new package dependencies.

Read only the file relevant to the change: `dist/game/app.mjs` for interaction, `style.css` for presentation, `adventure.mjs` for Scout dialogue and discovery summaries, `engine.mjs` for rules, `journey.mjs` for stage missions, route planning and conversion, `content/mill-creek.mjs` for story, `limits.mjs` for resource limits. Run `node scripts/release-check.mjs` after changes. Never duplicate a campaign by route or player.

Source basis: Jeremy Wenger's 94-page first edition, selected text from opening framework, phasing chapter 7, coordination chapters 10–11, and exit chapter 13. Costs, deadlines, acreage, outcomes, and property map are fictional.

Integrations: public book and contact pages are linked. Current production book checkout source was not available in connected repositories. The older UPP Sites source has no book/payment routes and was left unchanged. Paid campaigns are clearly marked in development; no paid access is asserted from client state. Do not activate a paid offer until the actual purchase/entitlement backend is verified.

Resource target requested: 1/1000000000 consumption. Not certified; no baseline establishes that reduction. Local limits and duplicate checks are enforced. Do not relabel compact representation as billing savings. Sol 5.6 reviewed the resource contract and the adventure flow.

Delivery: private Sites game plus a scoped draft pull request in urbanplanningpros/opencode. Preserve production and existing Codex policies. An owner can require the resource check in branch protection; this build does not change repository protection.

Latest correction: the book is the main game journey. Four stage missions, transitive exit map, ambition-led moves, chapter-specific notes, and a book-first / contextual-service-second ending. Game engine and save compatibility preserved. Twenty-two rule/journey tests passed. Existing private Site and draft PR #70 remain the delivery targets.

Current UI: page-like Go → Decide → Discover scenes, one main action per page, original cartoon art and animated Scout. Three direction groups lead to one route at a time. Evidence/backpack, exit atlas, book notes, optional sound, and replay remain available. Guided ambition survives even a zero-move saved run. No browser testing performed.
