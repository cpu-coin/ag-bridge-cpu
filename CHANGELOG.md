# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added `docs/BRANCHING.md`, `docs/RELEASING.md`, `docs/CORE_CONTRACT.md`.
- Added GitHub templates (PR, Issue).
- Added CI workflow (`.github/workflows/ci.yml`).
- Added `scripts/precommit.mjs` and related `package.json` script.
- Reconnect/Replay support for WebSocket clients.

### Changed
- Hardened repository structure to align with AG standards.

### Fixed
- Fixed WebSocket broadcast event naming mismatch (`new_message` to `message_new`), ensuring the mobile app reliably receives agent responses.
- Resolved deadlock state in `antigravity.mjs` connector; `ABORT` and `STOP` commands now properly bypass the "busy" check and forcefully click the IDE's Cancel button to reset the agent.
- Corrected an overly broad project filter in `server.mjs` that was hiding valid workspace targets containing the word `memflow` (e.g. `memflow-cpu`) from the mobile dropdown.
