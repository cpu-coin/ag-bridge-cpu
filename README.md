# AG Bridge (Antigravity Bridge)

**A lightweight Mobile Interface for the Antigravity Agent.**
Chat with your AI agent from your couch, verify tasks, and "poke" it to wake up—all from your phone.

## Features
- 📱 **Premium Mobile Workspace**: A glassmorphic dark-themed dashboard that feels native on your phone, complete with tabbed navigation.
- 🎯 **Multi-Project Selection**: Actively scans local CDP ports to detect all open IDE windows running Antigravity. Select a specific project to dynamically route your commands directly to that window.
- 🩸 **The Poke & Batching**: Remotely wakes up the Agent. Queued messages are batched for better context.
- 🔒 **Secure Remote Access**: Built-in support for Tailscale with *automatic HTTPS Let's Encrypt certificate provisioning*.
- 🔌 **MCP Integration**: Agent can read messages and report real-time status and active tasks directly to the UI.

## 🔌 Connector Plugin Architecture

`ag_bridge` is designed to be fully modular and supports routing to multiple IDEs and agents through its `connectors/` directory.

### Supported Connectors
* **Antigravity IDE**: Connects via Chrome DevTools Protocol (CDP) to track active workbench instances and inject remote keystrokes.
* *(Coming Soon)*: **VibeCraft**, **Maitrix**

To add a new connector, create a file in `connectors/` that exports:
```javascript
export const CONNECTOR_ID = 'my_agent';
export async function getTargets() { 
    // Returns array of active targets
    return [{ id: 'target_1', connectorId: CONNECTOR_ID, title: 'My Target' }]; 
}
export async function poke(target, messageContent) {
    // Sends a message to the specific target
    return { ok: true };
}
```
Register the plugin in `connectors/index.mjs` to automatically enable scanning and routing.

## Architecture
`Phone` <-> `Bridge Server` <-> `Antigravity (Agent)`
(See [Architecture](docs/architecture.md) for details).

## Requirements
- **Node.js**: v18+
- **Antigravity**: Launched with `--remote-debugging-port=9000` (or up to 9003) via terminal.
- **Network**: Local Wi-Fi **OR** [Tailscale](docs/remote_with_tailscale.md) for zero-config remote access.

## Quick Start

### 1. Start AG (Critical)
You **must** start AG from a terminal to enable the Poke:
```bash
antigravity.exe . --remote-debugging-port=9000

*(If the Agent doesn't "wake up", this is usually why.)*

### 2. Install & Start Bridge
```bash
npm install
npm start
```
You will see a **Pairing Code**, local IP address, and (if Tailscale is active) a secure **HTTPS** link.

### 3. Open on Phone
1. Go to the URL provided in the console (e.g., `https://<tailnet-name>.ts.net/`).
3. Enter the Pairing Code.
4. Select your active Workspace and chat away!

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
