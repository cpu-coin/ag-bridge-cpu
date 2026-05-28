# 🔒 CODEFREEZE — Maintenance Only

**Status: FROZEN as of 2026-05-27**
**Reason: Feature-complete. All new development goes to `memflow-cpu`.**

This repository (`ag-bridge-cpu`) serves as a **dumb secure relay** between
mobile devices and AI agents. It contains no intelligence, decision-making,
or protocol logic — all of that lives in `memflow-cpu`.

## What's allowed
- Bug fixes, security patches, dependency updates
- Documentation corrections

## What's NOT allowed
- New features, endpoints, or capabilities
- New intelligence or routing logic
- UI redesigns (maintenance fixes only)

## Where to put new code

| Feature | Repository |
|---------|-----------|
| Agent intelligence | [`memflow-cpu`](https://github.com/cpucoinio/memflow-cpu) (private) |
| Public MCP tools | [`memflow`](https://github.com/cpu-coin/memflow) (public) |
| Learning pipeline | [`env-migration-learning`](https://github.com/cpucoinio/env-migration-learning) |

---

*If you believe a maintenance change is needed, open a PR against `main` with the `maintenance` label.*
