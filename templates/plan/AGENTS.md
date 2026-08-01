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
| `GET /api/sessions/:id/assets/*` | Read a validated local asset |

## Checks

Run focused tests while editing, then `pnpm --dir templates/plan typecheck`,
`pnpm --dir templates/plan test`, and `pnpm --dir templates/plan build` before
calling the work complete.
