# AG Bridge (Antigravity Bridge)

**A lightweight Mobile Interface for the Antigravity Agent.**
Chat with your AI agent from your couch, verify tasks, and "poke" it to wake up—all from your phone.

## Features
- 📱 **Premium Mobile Workspace**: A glassmorphic dark-themed dashboard that feels native on your phone, complete with tabbed navigation.
- 🧠 **MemFlow Integration (CPUcoin Edition)**: Tightly integrated with CPUcoin's MemFlow system (currently in development) acting as a highly reliable, persistent communication bus.
- 🎯 **IDE-Independent & Headless**: Zero reliance on third-party IDEs, accessibility permissions, or UI automation. Works purely via local SQLite.
- 🩸 **Persistent Polling**: Automatically polls the MemFlow outbox, ensuring agent messages are never lost and delivered to your phone reliably.
- 🔒 **Secure Remote Access**: Built-in support for Tailscale with *automatic HTTPS Let's Encrypt certificate provisioning*.
- 🔌 **MCP Integration**: Includes `memflow_inbox` and `memflow_reply` MCP tools so any AI agent can connect to your mobile stream seamlessly.

## 🔌 Connector Plugin Architecture

`ag_bridge` is designed to be fully modular and supports routing to multiple IDEs and agents through its `connectors/` directory.

### Supported Connectors
* **MemFlow (Primary)**: Uses `better-sqlite3` to interact with CPUcoin's MemFlow infrastructure (`~/.memflow/memflow.sqlite`) for reliable, headless communication.
* **Antigravity IDE (Fallback)**: Connects via Chrome DevTools Protocol (CDP) or AppleScript to track active workbench instances and inject remote keystrokes if MemFlow is unavailable.
* *(Coming Soon)*: **VibeCraft**, **Maitrix**

To add a new connector, create a file in `connectors/` that exports `getTargets()` and `poke()`. Register the plugin in `connectors/index.mjs` to automatically enable scanning and routing.

## Architecture
`Phone` <-> `Bridge Server` <-> `MemFlow (SQLite)` <-> `MCP Agent Tools` <-> `Any Agent`
(See [Architecture](docs/architecture.md) for details).

## Requirements
- **Node.js**: v18+
- **MemFlow**: Local installation of CPUcoin MemFlow (creates `~/.memflow/memflow.sqlite`)
- **Network**: Local Wi-Fi **OR** [Tailscale](docs/remote_with_tailscale.md) for zero-config remote access.

## Quick Start

### 1. Install & Start Bridge
```bash
npm install
npm start
```
You will see a **Pairing Code**, local IP address, and (if Tailscale is active) a secure **HTTPS** link.

### 3. Open on Phone
1. Go to the URL provided in the console (e.g., `https://<tailnet-name>.ts.net/`).
3. Enter the Pairing Code.
4. Select your active Workspace and chat away!

## ⚠️ Important Note on Two-Way Chat

AG Bridge supports two distinct ways to route Agent responses back to your mobile device:

1. **MemFlow MCP Tools (Recommended)**
   If you configure your agent to use the included `ag-bridge-mcp` tools (by adding `mcp-server.mjs` to your agent's tool configuration), the agent can natively read your messages and write replies directly to the MemFlow Outbox database. **This works entirely headless and is extremely reliable.**

2. **Chrome DevTools Protocol (Fallback)**
   If you rely on the legacy `antigravity.mjs` connector, AG Bridge uses an **AppleScript fallback** to type your mobile messages into the correct Antigravity Desktop window. While this guarantees your messages are delivered reliably, **AppleScript is blind**—it cannot read the AI's replies back out of the chat window.
   To get legacy two-way sync, you must launch the Antigravity Desktop App from your terminal with the Chrome DevTools Protocol (CDP) port open:
   ```bash
   /Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=9000
   ```
   *(You can use ports 9000, 9001, 9002, or 9003. The bridge scans these automatically to read the chat history DOM).*

## Remote Access (Built-In) ☁️
AG Bridge is designed with **first-class Tailscale integration** for secure remote access:
- **Auto-HTTPS**: When you run `npm start`, the bridge automatically detects Tailscale and runs `tailscale serve --bg 8787` to provision a secure Let's Encrypt SSL certificate. 
- **Requirements**: You must enable HTTPS and "Serve" in your Tailscale Admin Console.
- **Security**: The connection is completely encrypted end-to-end. There are no open ports on your router, and the web interface requires an initial Pairing Code on first connect.

## Testing & CI 🧪
To run the test suite locally:
```bash
npm test
```
(Runs unit tests and smoke tests via Vitest)

To scan for repo hygiene issues:
```bash
npm run check:bidi
```
(Scans for hidden Unicode characters)

**CI**: GitHub Actions automatically runs these tests on every Pull Request.


## Documentation
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](docs/security.md)

## License
MIT. Built for the Antigravity community.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).
