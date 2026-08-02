# Local Visual Plan Editor

This private fork is a single-user TanStack Start editor for Agent-Native Plan
MDX folders. It runs only on `127.0.0.1:8105`; local files are the source of
truth.

## Skills

- `visual-plan` — plan authoring, canvas, prototype, and document quality.
- `plan-source-sync` — the upstream MDX compatibility contract.
- `frontend-design` — read before redesigning editor surfaces.
- `shadcn-ui` — read before adding controls or dialogs.
- `writing-agent-instructions` — read before editing these instructions.

## Core Rules

- Preserve exact compatibility with `plan.mdx`, optional `canvas.mdx`,
  `prototype.mdx`, `.plan-state.json`, `comments.json`, and `assets/`.
- Do not add hosted Plan calls, authentication, sharing, SQL, analytics, agent
  chat, version history, or collaboration transports.
- Browser data uses the local daemon API. Never expose an absolute plan path or
  daemon token in a browser URL.
- Resolve plan folders with `realpath`; reject traversal and symlink escapes.
- Save atomically and require the caller's source revision. A stale revision is
  a visible conflict, never a silent overwrite.
- Bind only to `127.0.0.1:8105` and reuse one healthy daemon.
- TypeScript everywhere. Use pnpm, the repository lockfile, and existing
  dependencies before adding anything.
- Never fabricate success. Verify writes by reading the saved revision back.

## Local API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/register` | Register a validated folder; daemon-token protected |
| `GET /api/sessions/:id` | Read MDX, state, comments, assets, and revisions |
| `PUT /api/sessions/:id/files/:file` | Atomically save a known file with revision |
| `GET/POST/PUT /api/sessions/:id/comments` | Read or update local comments |
| `POST /api/sessions/:id/publish` | Publish the editor through Tailscale Serve on HTTPS 8443 |
| `GET /api/sessions/:id/assets/*` | Read a validated local asset |

## Agent Harness Metadata

- Record the originating agent in `plan.mdx` frontmatter as optional
  `harness: "codex" | "claude-code" | "opencode"`.
- `AGENT_NATIVE_HARNESS` is the explicit override. Otherwise `local open`
  detects the active Codex, Claude Code, or OpenCode environment and keeps the
  value in private session metadata without rewriting legacy plans.
- “Send to agent” routes feedback back to that harness. A plan with no metadata
  keeps the current Codex fallback for backward compatibility.

## Tailnet Publishing

- “Publish to tailnet” uses `tailscale serve`, never Funnel, and copies a URL
  available only to peers authorized by the active tailnet ACLs.
- The dedicated HTTPS port is `8443`. Refuse to overwrite an unrelated Serve
  listener already using that port.
- Tailnet peers may view the plan and add comments. File edits, comment edits
  or deletion, agent dispatch, publish, registration, and shutdown remain
  unavailable through the tailnet URL.
- Agents can publish with `pnpm local publish --dir <plan-folder>` and receive
  the tailnet URL on stdout.

## Checks

Run focused tests while editing, then `pnpm --dir templates/plan typecheck`,
`pnpm --dir templates/plan test`, and `pnpm --dir templates/plan build` before
calling the work complete.
