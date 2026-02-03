# godot-lsp-bridge

[![npm version](https://badge.fury.io/js/godot-lsp-bridge.svg)](https://www.npmjs.com/package/godot-lsp-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A stdio-to-TCP bridge for Godot's GDScript Language Server. Enables AI coding agents to use Godot's LSP for code intelligence.

## Sponsors

<a href="https://www.redimo.dev/" target="_blank">
  <img src="https://www.redimo.dev/logo/logo.png" alt="Redimo - The Ultimate Redis GUI Client" width="120" />
</a>

**[Redimo](https://www.redimo.dev/)** - The Ultimate Redis GUI Client. Visualize, Manage, and Monitor.

## Why?

Most AI coding tools (Claude Code, Cursor, OpenCode, etc.) expect LSP servers to communicate via **stdio**, but Godot's LSP only supports **TCP** (port 6005). This bridge solves that.

### What this bridge does:
- Converts stdio ↔ TCP communication
- Buffers notifications until initialize response (fixes Godot's non-standard message ordering)
- Uses Buffer for binary-safe handling (fixes data loss with large files)

## Requirements

- **Node.js** 18+
- **Godot Editor** running with your project open (LSP server runs on port 6005)

## Installation

```bash
npm install -g godot-lsp-bridge
```

Or use directly with npx:
```bash
npx godot-lsp-bridge
```

## Configuration

### OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "lsp": {
    "gdscript": {
      "command": ["npx", "godot-lsp-bridge"],
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
      "command": ["npx", "godot-lsp-bridge"],
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
    "command": ["npx", "godot-lsp-bridge"],
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
      "args": ["godot-lsp-bridge"],
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
    cmd = { 'npx', 'godot-lsp-bridge' },
    filetypes = { 'gdscript' },
    root_dir = lspconfig.util.root_pattern('project.godot'),
  },
}

lspconfig.gdscript_bridge.setup{}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GODOT_LSP_PORT` | `6005` | Godot LSP server port |
| `GODOT_LSP_HOST` | `127.0.0.1` | Godot LSP server host |
| `GODOT_LSP_BRIDGE_DEBUG` | `false` | Enable debug logging |
| `GODOT_LSP_BRIDGE_LOG` | `/tmp/godot-lsp-bridge.log` | Log file path |

## Usage

1. **Open Godot Editor** with your project
2. **Start your AI coding tool** (it will automatically start the bridge)
3. **Edit `.gd` files** - you'll get diagnostics, symbols, go-to-definition, etc.

## Features

Once connected, you get full GDScript LSP features:

- Diagnostics (errors, warnings)
- Document symbols
- Go to definition
- Find references
- Hover information
- Completion suggestions
- Signature help

## Troubleshooting

### "Connection failed" error

Make sure Godot Editor is running with your project open. The LSP server only runs when the editor is active.

### Enable debug logging

```bash
GODOT_LSP_BRIDGE_DEBUG=true npx godot-lsp-bridge
```

Check logs at `/tmp/godot-lsp-bridge.log`

### Custom port

If Godot uses a different port:

```bash
GODOT_LSP_PORT=6008 npx godot-lsp-bridge
```

## How it works

```
┌─────────────────┐     stdio      ┌─────────────────┐      TCP       ┌─────────────────┐
│   AI Coding     │ ─────────────► │  godot-lsp-     │ ─────────────► │   Godot LSP     │
│   Agent         │ ◄───────────── │  bridge         │ ◄───────────── │   Server        │
│ (Claude, etc.)  │                │                 │                │   (port 6005)   │
└─────────────────┘                └─────────────────┘                └─────────────────┘
```

## Acknowledgments

- [Godot Engine](https://godotengine.org/) - The open-source game engine that provides the GDScript Language Server
- [Redimo](https://www.redimo.dev/) - The Ultimate Redis GUI Client
- [Disunday](https://github.com/code-xhyun/disunday) - Control OpenCode from Discord

## License

MIT

## Contributing

Issues and PRs welcome at [GitHub](https://github.com/code-xhyun/godot-lsp-bridge).
