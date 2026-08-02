# Agent-Native Plan Local

Private, local-only fork of `BuilderIO/agent-native`, pinned to upstream commit
`d04621c8cdab6e090a0557792cc9be8c93d94c79`.

The upstream repository did not declare a repository-level license when this
fork was made on 2026-08-01. Keep this checkout private. Do not publish or
redistribute copied source without permission from its owner.

## Purpose

`templates/plan` is adapted into a single-user TanStack Start editor for
Agent-Native Plan MDX folders. Plan content, comments, assets, and editor state
stay on the machine. The daemon always binds to `127.0.0.1:8105`.

An explicit publish command can proxy one plan through Tailscale Serve on HTTPS
port `8443` for authorized tailnet peers. It never enables Funnel. Peers may
view the plan and add comments, but cannot edit files or existing comments,
dispatch agents, publish plans, register folders, or stop the daemon.

## Commands

```bash
pnpm --dir templates/plan local open --dir /absolute/path/to/plan
pnpm --dir templates/plan local check --dir /absolute/path/to/plan
pnpm --dir templates/plan local blocks --out /absolute/path/to/plan-blocks.md
pnpm --dir templates/plan local publish --dir /absolute/path/to/plan
pnpm --dir templates/plan local status
pnpm --dir templates/plan local stop
```

The editor preserves `plan.mdx`, optional `canvas.mdx`, `prototype.mdx`,
`.plan-state.json`, `comments.json`, and `assets/`.
