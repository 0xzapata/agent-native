# Agent-Native Plan Local

Private, local-only fork of `BuilderIO/agent-native`, pinned to upstream commit
`d04621c8cdab6e090a0557792cc9be8c93d94c79`.

The upstream repository did not declare a repository-level license when this
fork was made on 2026-08-01. Keep this checkout private. Do not publish or
redistribute copied source without permission from its owner.

## Purpose

`templates/plan` is adapted into a single-user TanStack Start editor for
Agent-Native Plan MDX folders. Plan content, comments, assets, and editor state
stay on the machine and are served only from `127.0.0.1:8105`.

## Commands

```bash
pnpm --dir templates/plan local open --dir /absolute/path/to/plan
pnpm --dir templates/plan local check --dir /absolute/path/to/plan
pnpm --dir templates/plan local blocks --out /absolute/path/to/plan-blocks.md
pnpm --dir templates/plan local status
pnpm --dir templates/plan local stop
```

The editor preserves `plan.mdx`, optional `canvas.mdx`, `prototype.mdx`,
`.plan-state.json`, `comments.json`, and `assets/`.
