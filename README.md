# godot-lsp-stdio-bridge

[![npm version](https://badge.fury.io/js/godot-lsp-stdio-bridge.svg)](https://www.npmjs.com/package/godot-lsp-stdio-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A stdio-to-TCP bridge for Godot's GDScript Language Server. Enables AI coding agents to use Godot's LSP for code intelligence.

**npm**: https://www.npmjs.com/package/godot-lsp-stdio-bridge

## Why?

Most AI coding tools (Claude Code, Cursor, OpenCode, etc.) expect LSP servers to communicate via **stdio**, but Godot's LSP only supports **TCP** (port 6005). This bridge solves that.

## Features

| Feature | Description |
|---------|-------------|
| **stdio ↔ TCP Bridge** | Converts between stdio (AI tools) and TCP (Godot LSP) |
| **Binary-Safe Buffers** | Uses `Buffer.concat()` instead of string concatenation - fixes data loss with large files |
| **Auto Port Discovery** | Automatically tries ports 6005, 6007, 6008 if connection fails |
| **Auto Reconnection** | Reconnects automatically when Godot Editor restarts |
| **Windows URI Normalization** | Converts `C:\path` to `/C:/path` for cross-platform compatibility |
| **Notification Buffering** | Buffers notifications until initialize response (fixes Godot's non-standard ordering) |
| **Memory Protection** | 10MB buffer limit and 1000 message queue limit to prevent memory exhaustion |
| **Graceful Shutdown** | Handles SIGINT, SIGTERM, SIGHUP signals properly |
| **Zero Dependencies** | Pure Node.js, no external dependencies |

## Requirements

- **Node.js** 18+
- **Godot Editor** running with your project open (LSP server runs on port 6005)

## Installation

```bash
npm install -g godot-lsp-stdio-bridge
```

Or use directly with npx:
```bash
npx godot-lsp-stdio-bridge
```

## Configuration

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "lsp": {
    "gdscript": {
      "command": ["npx", "godot-lsp-stdio-bridge"],
      "extensions": [".gd", ".gdshader"]
    }
  }
}
```

### Claude Code

Add to your MCP settings or Claude configuration:

```json
{
  "lsp": {
    "gdscript": {
      "command": ["npx", "godot-lsp-stdio-bridge"],
      "extensions": [".gd"]
    }
  }
}
```

### Cursor

In Cursor settings, add a custom language server:

```json
{
  "gdscript": {
    "command": ["npx", "godot-lsp-stdio-bridge"],
    "filetypes": ["gdscript"]
  }
}
```

### VS Code / Generic LSP Client

```json
{
  "languageserver": {
    "gdscript": {
      "command": "npx",
      "args": ["godot-lsp-stdio-bridge"],
      "filetypes": ["gdscript"],
      "rootPatterns": ["project.godot"]
    }
  }
}
```

### Neovim (nvim-lspconfig)

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

configs.gdscript_bridge = {
  default_config = {
    cmd = { 'npx', 'godot-lsp-stdio-bridge' },
    filetypes = { 'gdscript' },
    root_dir = lspconfig.util.root_pattern('project.godot'),
  },
}

lspconfig.gdscript_bridge.setup{}
```

### Windows

On Windows, npm creates `.cmd` wrapper scripts for global packages:

```json
{
  "lsp": {
    "gdscript": {
      "command": ["godot-lsp-stdio-bridge.cmd"],
      "extensions": [".gd"]
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GODOT_LSP_PORT` | Auto-discover | Fixed port (skips auto-discovery if set) |
| `GODOT_LSP_HOST` | `127.0.0.1` | Godot LSP server host |
| `GODOT_LSP_BRIDGE_DEBUG` | `false` | Enable debug logging |
| `GODOT_LSP_BRIDGE_LOG` | `/tmp/godot-lsp-stdio-bridge.log` | Log file path (Windows: `%TEMP%\godot-lsp-stdio-bridge.log`) |

## Usage

1. **Open Godot Editor** with your project
2. **Start your AI coding tool** (it will automatically start the bridge)
3. **Edit `.gd` files** - you'll get diagnostics, symbols, go-to-definition, etc.

## LSP Features

Once connected, you get full GDScript LSP features:

- Diagnostics (errors, warnings)
- Document symbols
- Go to definition
- Find references
- Hover information
- Completion suggestions
- Signature help

## How it works

```
┌─────────────────┐     stdio      ┌─────────────────┐      TCP       ┌─────────────────┐
│   AI Coding     │ ─────────────► │  godot-lsp-     │ ─────────────► │   Godot LSP     │
│   Agent         │ ◄───────────── │  stdio-bridge   │ ◄───────────── │   Server        │
│ (Claude, etc.)  │                │                 │                │   (port 6005)   │
└─────────────────┘                └─────────────────┘                └─────────────────┘
```

### Port Discovery

If `GODOT_LSP_PORT` is not set, the bridge tries these ports in order:
1. **6005** - Default Godot LSP port
2. **6007** - Alternative port (some Godot versions)
3. **6008** - Fallback port

### Reconnection Flow

1. Connection lost → Wait 5 seconds
2. Try to reconnect (with port discovery)
3. On success → 1 second warmup delay → Flush buffered messages
4. Notify client: "Godot LSP server restarted"

## Troubleshooting

### "Connection failed" error

Make sure Godot Editor is running with your project open. The LSP server only runs when the editor is active.

### Enable debug logging

```bash
GODOT_LSP_BRIDGE_DEBUG=true npx godot-lsp-stdio-bridge
```

Check logs at `/tmp/godot-lsp-stdio-bridge.log` (Linux/macOS) or `%TEMP%\godot-lsp-stdio-bridge.log` (Windows)

### Custom port

If Godot uses a different port:

```bash
GODOT_LSP_PORT=6008 npx godot-lsp-stdio-bridge
```

### Large file issues

This bridge uses binary-safe `Buffer.concat()` instead of string concatenation, which prevents data loss with large GDScript files (80KB+). If you experience issues with other bridges, this one should work.

## Comparison with other bridges

| Feature | godot-lsp-stdio-bridge (this) | opencode-godot-lsp | godot-lsp-bridge (can0pus) |
|---------|------------------------------|--------------------|-----------------------------|
| Binary-safe buffers | ✅ `Buffer.concat()` | ❌ `.toString()` | ❌ `.toString()` |
| Auto port discovery | ✅ 6005, 6007, 6008 | ❌ | ✅ |
| Auto reconnection | ✅ | ❌ | ✅ |
| Windows URI normalization | ✅ | ❌ | ✅ |
| Memory protection | ✅ 10MB limit | ❌ | ✅ |
| Dependencies | None | None | None |
| Build required | ❌ | ❌ | ✅ TypeScript |

## License

MIT

## Contributing

Issues and PRs welcome at [GitHub](https://github.com/code-xhyun/godot-lsp-stdio-bridge).

## Acknowledgments

- [Godot Engine](https://godotengine.org/) - The open-source game engine that provides the GDScript Language Server
- [Disunday](https://github.com/code-xhyun/disunday) - Control OpenCode from Discord

## Sponsors

<a href="https://www.redimo.dev/" target="_blank">
  <img src="https://www.redimo.dev/logo/logo.png" alt="Redimo - The Ultimate Redis GUI Client" width="120" />
</a>

**[Redimo](https://www.redimo.dev/)** - The Ultimate Redis GUI Client. Visualize, Manage, and Monitor.
