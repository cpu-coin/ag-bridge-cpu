# Contributing to AG Bridge

> **🔒 MAINTENANCE-ONLY (Frozen 2026-05-27)**
> This repo is feature-complete. Only bug fixes, security patches, and dependency updates are accepted.
> New features, endpoints, and intelligence logic go to [`memflow-cpu`](https://github.com/cpucoinio/memflow-cpu).
> See [CODEFREEZE.md](CODEFREEZE.md) for details.

We follow a **structured feature-branch workflow** to ensure stability in `main`.

## License
By submitting a pull request, you agree that your contribution is licensed under the MIT License (see `LICENSE`).

## Workflow Summary
**`dev` -> PR -> `main`**

1.  **Development Branch**: All new work happens on `dev` (or feature branches off `dev`).
2.  **Pull Requests**: Merge changes from `dev` into `main` via Pull Request (PR).
3.  **Releases**: `main` is always stable and tagged with versions (e.g., `v0.1`).

## Branching Strategy
- **`main`**: 🛡️ **Stable / Production**. Protected branch. No direct commits. Only accepts PRs from `dev`.
- **`dev`**: 🧪 **Integration / Staging**. The default branch for testing.
- **`feat/xxx`** or **`fix/xxx`**: 🔨 **Working Branches**. Short-lived branches for specific tasks.

## How to Contribute

### Core Team (You)
1.  **Branch off `dev`**: `git checkout -b feat/my-cool-feature dev`
2.  **Work & Push**: `git push origin feat/my-cool-feature`
3.  **PR**: Open Pull Request to **merge `feat/xxx` into `dev`**.
4.  **Release**: Periodically PR `dev` -> `main` for a numbered release (v0.x).

### External Contributors (Community)
1.  **Fork** the repo to their own account.
2.  **Clone** their fork.
3.  **Branch** off `dev`.
4.  **PR**: Open Pull Request to **upstream `dev`**.
    - *Why `dev`?* So we can test integration before hitting `main`.

## IMPORTANT
- ## Security non-negotiables (read this twice)
- **Do not commit secrets**: auth keys, tokens, cookies, Tailnet info, pairing codes, etc.
- **Do not commit runtime state** (example: `data/state.json` must be template-only or generated at runtime).
- If you suspect you committed a secret: rotate it immediately and tell the maintainer.

## Unicode / Hidden character policy
- PRs **must not** introduce hidden/bidirectional (bidi) Unicode control characters.
- If GitHub flags “hidden or bidirectional Unicode text”, the PR must be cleaned/normalized before merge.

## PR checklist
- [ ] `npm install` + `npm start` works
- [ ] `npm test` passes (Smoke tests + Secrets scan)
- [ ] `npm start` works
- [ ] No secrets or keys committed
- [ ] No runtime state (`data/state.json`) committed
- [ ] No hidden/bidi Unicode warnings (`npm run check:bidi`)
- [ ] No secrets or runtime state committed
- [ ] Docs updated if behavior changed
- [ ] Changes are small and focused (one feature/fix per PR)

## Network features (Tailscale / remote access)
- Remote access must be **opt-in**
- Do not rely on “VPN == auth”; app-layer auth still required
- Bind/listen interfaces must be explicit (avoid exposing to 0.0.0.0 unintentionally)
