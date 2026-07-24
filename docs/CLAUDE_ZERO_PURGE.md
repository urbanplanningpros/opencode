# Claude-Zero Source Purge

## Objective

Remove all dormant Anthropic and Claude capability from the OpenCode fork so the repository cannot install, discover, select, route to, cache for, or execute any Claude model directly or through a gateway.

## Required removals

- Remove `@ai-sdk/anthropic` from package manifests and regenerate the Bun lockfile.
- Remove direct Anthropic and Google Vertex Anthropic bundled provider loaders.
- Remove Anthropic custom provider headers and model loaders.
- Filter or reject all provider and model identifiers containing `anthropic` or `claude` before they enter the provider database.
- Reject Claude models exposed through Amazon Bedrock, Google Vertex, GitHub Copilot, OpenRouter, Cloudflare AI Gateway, GitLab AI Gateway, or any other aggregator.
- Remove Claude-specific model priority, small-model selection, transformations, caching behavior, tests, fixtures, documentation, and saved configuration examples.
- Remove or invalidate stored Anthropic credentials, sessions, and model history during migration.

## Acceptance criteria

- No package manifest or lockfile contains an Anthropic SDK package.
- No executable source path imports, installs, discovers, selects, or invokes an Anthropic or Claude model.
- A repository-wide guard test fails when `anthropic` or `claude` is introduced into executable configuration or source, excluding this policy document and explicit deny-list tests.
- Attempts to configure Claude through a direct provider or model gateway fail before network execution.
- Full package typecheck, unit tests, build, and operator continuity tests pass using OpenAI and an approved local route only.
- Migration documentation identifies local and account-level credentials that must be revoked outside the repository.

## Rollout

Perform the purge on an isolated branch, regenerate dependencies, run full builds on Linux and Windows, then merge only after the OpenAI/local continuity workflow passes end to end.
