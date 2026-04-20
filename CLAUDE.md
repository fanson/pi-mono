# study/architecture-analysis Branch Rules

This file adds branch-specific guidance on top of `AGENTS.md`.

## Branch Model

- `study/architecture-analysis` is a long-lived fork branch, not a temporary feature branch.
- Keep the code baseline aligned with the latest `origin/main`.
- Treat the branch as a docs overlay on top of current upstream code.

## What Should Persist Here

- Branch-specific long-lived changes should stay in `docs/**`.
- This `CLAUDE.md` is the allowed root-level exception because it defines how this branch is maintained.
- Do not introduce branch-only changes under `packages/**` unless the user explicitly asks.

## Default Sync Workflow

1. Update the branch against the latest `origin/main` first.
2. Then audit and update `docs/study/**` and `docs/issue/**` against the current code.
3. Prefer stable symbol/file references over brittle line-number-only claims.
4. Do not describe hypothetical fixes as if they are current behavior.

## Safety Rules

- Prefer isolated worktrees for risky sync or branch-repair operations.
- Temporary sync branches and backup branches are safety tools, not the main branch to maintain.
- Before asking for confirmation or ending a work cycle, use `im_feedback`.
