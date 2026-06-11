# Activation Ledger — peer-audited--behavioral-blockchain

> Source of truth for activation status, evidence, and next-mile blockers.
> Mirrors `~/Workspace/session-meta/escape-velocity/activation-ledger-2026-06-10.csv`
> row 6 (`a-organvm/peer-audited--behavioral-blockchain, 676`).

## Status

| Field | Value |
|---|---|
| **Status** | `ship-now` (static user-facing surface) / `ship-soon` (full activation including `/launch` and `/api`) |
| **Activated on** | 2026-06-10 (Evidence: `peer_audited_activation_2026-06-10.csv`) |
| **GitHub issue** | https://github.com/a-organvm/peer-audited--behavioral-blockchain/issues/676 |
| **Canonical URL** | https://a-organvm.github.io/peer-audited--behavioral-blockchain/ |
| **Owning team** | ORGAN-III (Commerce) — Styx |
| **Package scope** | `@styx/*` |

## What is shipped (evidence: 2026-06-10T23:04:07Z)

| Endpoint | HTTP | Verdict |
|---|---|---|
| `https://a-organvm.github.io/peer-audited--behavioral-blockchain/` | **200** | `ship-now` — the static user-facing surface is reachable and serves the marketing/explainer deck |
| `https://a-organvm.github.io/peer-audited--behavioral-blockchain/launch` | 404 | **gap to `ship-soon`** — interactive launch surface not yet deployed |
| `https://a-organvm.github.io/peer-audited--behavioral-blockchain/api` | 404 | **gap to `ship-soon`** — API surface not yet wired to a public host |

Evidence file:
- `~/Workspace/session-meta/escape-velocity/activation-evidence/peer_audited_activation_2026-06-10.csv`
- `~/Workspace/session-meta/escape-velocity/activation-evidence/peer_audited_activation_2026-06-10_root.html`

## Activation command

The single canonical activation probe (re-runnable by any user):

```bash
curl -sS -o /dev/null -w "%{http_code} %{url_effective}\n" \
  -L https://a-organvm.github.io/peer-audited--behavioral-blockchain/
```

**Expected output:** `200 https://a-organvm.github.io/peer-audited--behavioral-blockchain/`

To verify the gap to `ship-soon` (will be 404 until those routes are deployed):

```bash
for path in / /launch /api; do
  printf "%s -> " "$path"
  curl -sS -o /dev/null -w "%{http_code}\n" \
    "https://a-organvm.github.io/peer-audited--behavioral-blockchain${path}"
done
```

**Expected output today (2026-06-11):**

```
/ -> 200
/launch -> 404
/api -> 404
```

## Why is this not fully `ship-soon`?

| Blocker | Root cause | Resolution path |
|---|---|---|
| `/launch` 404 | The launch surface (interactive sign-up / waitlist) is not yet built into the `src/web` Next.js app or not yet routed through the GitHub Pages base | Open a tracked issue in Phase Gamma milestone; port the waitlist flow from `src/web`; re-test |
| `/api` 404 | The API (NestJS at `src/api`) is not deployed to a public host — current deploy target is Render (per `render.yaml`), and the env-backed config hardening (PR #669) is the prerequisite for stable deploys | Land Phase Beta deploy artifacts in Issue #675 (`ship-soon`); connect Render blueprint; re-test |
| Activation evidence regen is manual | `scripts/build-chat-context.ts` re-emits the embedded `styx-knowledge.ts` from `CLAUDE.md`; CLAUDE.md is not in repo, so the knowledge file regenerates from a synthetic empty state | Decide whether to (a) add a CLAUDE.md or (b) replace the build-time synthesis with a checked-in artifact |

## Decision

**`ship-now` on the static user surface, with explicit `ship-soon` gap documented above.** No further action required to keep the static surface live; the gap to `ship-soon` is owned by Issues tracked in Phase Beta (deploy) and Phase Gamma (launch surface).

## Cross-system reconciliation

- `~/Workspace/session-meta/escape-velocity/activation-ledger-2026-06-10.csv` row 6 says `ship-now` — **matches this ledger**.
- If the cross-system ledger is updated, this file must be updated in the same commit to preserve the invariant.
