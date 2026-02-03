#!/usr/bin/env node
/**
 * Godot LSP Bridge
 * 
 * A stdio-to-TCP bridge for Godot's GDScript Language Server.
 * Enables AI coding agents (Claude Code, Cursor, OpenCode, etc.) to use Godot's LSP.
 * 
 * Why this bridge is needed:
 * 1. Most AI coding tools expect LSP servers to communicate via stdio
 * 2. Godot's LSP only supports TCP (port 6005)
 * 3. Godot sends notifications before the initialize response (non-standard)
 * 
 * This bridge:
 * - Converts stdio <-> TCP communication
 * - Buffers notifications until initialize response is sent
 * - Uses Buffer for binary-safe handling (fixes data loss with large files)
 * - Auto-reconnects when Godot restarts
 * - Normalizes Windows file URIs for cross-platform compatibility
 * 
 * @license MIT
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';

// Configuration
const GODOT_LSP_PORT = parseInt(process.env.GODOT_LSP_PORT || '6005', 10);
const GODOT_LSP_HOST = process.env.GODOT_LSP_HOST || '127.0.0.1';
const LOG_FILE = process.env.GODOT_LSP_BRIDGE_LOG || (os.platform() === 'win32' 
  ? `${os.tmpdir()}\\godot-lsp-bridge.log` 
  : '/tmp/godot-lsp-bridge.log');
const DEBUG = process.env.GODOT_LSP_BRIDGE_DEBUG === 'true';

// Reconnection settings
const RECONNECT_DELAY = 5000; // 5 seconds
const WARMUP_DELAY = 1000; // 1 second delay after reconnect
const MAX_RECONNECT_ATTEMPTS = -1; // -1 = infinite
const CONNECTION_TIMEOUT = 2000; // 2 seconds

function log(msg) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // Ignore log write errors
  }
  process.stderr.write(line);
}

log('=== Godot LSP Bridge starting ===');
log(`Platform: ${os.platform()}`);
log(`Connecting to Godot LSP at ${GODOT_LSP_HOST}:${GODOT_LSP_PORT}`);

// State
let tcpSocket = null;
let tcpConnected = false;
let tcpBuffer = Buffer.alloc(0);
let stdinBuffer = Buffer.alloc(0);
let pendingMessages = [];

let waitingForInitialize = false;
let initializeRequestId = null;
let bufferedNotifications = [];

// Reconnection state
let isReconnecting = false;
let isWarmingUp = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let wasInitialized = false;
let shouldKeepRunning = true;

const HEADER_DELIMITER = Buffer.from('\r\n\r\n');

/**
 * Normalize Windows file URIs for Godot's LSP server.
 * 
 * Godot expects file URIs in the format: file:///C:/path/to/file
 * But some clients send: file://C:\path\to\file or file://C:/path/to/file
 */
function normalizeFileUri(uri) {
  if (!uri || !uri.startsWith('file://')) {
    return uri;
  }

  // Remove the file:// prefix
  let path = uri.slice(7);
  
  // Convert backslashes to forward slashes
  path = path.replace(/\\/g, '/');
  
  // Ensure the path starts with a slash (for file:///)
  // On Windows, paths like C:/... need a leading slash: /C:/...
  if (path.length > 0 && path[0] !== '/') {
    path = '/' + path;
  }
  
  return 'file://' + path;
}

/**
 * Recursively normalize all file URIs in an object.
 */
function normalizeUrisInObject(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'string') {
    if (obj.startsWith('file://')) {
      return normalizeFileUri(obj);
    }
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => normalizeUrisInObject(item));
  }
  
  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = normalizeUrisInObject(value);
    }
    return result;
  }
  
  return obj;
}

/**
 * Extract complete LSP messages from a buffer.
 * Uses Buffer for binary-safe handling to prevent data loss with large files.
 */
function extractMessages(buffer, onMessage) {
  let remaining = buffer;
  
  while (true) {
    const headerEnd = remaining.indexOf(HEADER_DELIMITER);
    if (headerEnd === -1) {
      if (remaining.length > 0 && DEBUG) {
        log(`[parse] waiting for header, buffer: ${remaining.length} bytes`);
      }
      break;
    }

    const header = remaining.slice(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      log(`[parse] no Content-Length in header, skipping`);
      remaining = remaining.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1], 10);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;

    if (remaining.length < messageEnd) {
      if (DEBUG) {
        log(`[parse] waiting for body, need: ${contentLength}, have: ${remaining.length - messageStart}`);
      }
      break;
    }

    const content = remaining.slice(messageStart, messageEnd).toString('utf8');
    remaining = remaining.slice(messageEnd);
    onMessage(content, contentLength);
  }
  
  return remaining;
}

/**
 * Write an LSP message to stdout (back to the client).
 */
function writeToStdout(content, contentLength) {
  log(`stdout <- ${content.substring(0, 100)}...`);
  const byteLength = Buffer.byteLength(content, 'utf8');
  process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${content}`);
}

/**
 * Send an LSP message to Godot's LSP server.
 */
function sendToGodot(content, contentLength) {
  log(`stdin -> ${content.substring(0, 100)}...`);
  
  // Normalize URIs for Windows compatibility
  let normalizedContent = content;
  try {
    const msg = JSON.parse(content);
    
    // Track initialize request
    if (msg.method === 'initialize' && msg.id !== undefined) {
      waitingForInitialize = true;
      initializeRequestId = msg.id;
      wasInitialized = false;
      log(`Initialize request id: ${initializeRequestId}`);
    }
    
    // Normalize all file URIs
    const normalized = normalizeUrisInObject(msg);
    normalizedContent = JSON.stringify(normalized);
    
    if (normalizedContent !== content && DEBUG) {
      log('Normalized URIs in message');
    }
  } catch (e) {
    // Not valid JSON, still forward it
  }
  
  if (tcpConnected && tcpSocket && !tcpSocket.destroyed) {
    const byteLength = Buffer.byteLength(normalizedContent, 'utf8');
    tcpSocket.write(`Content-Length: ${byteLength}\r\n\r\n${normalizedContent}`);
  } else {
    log('Buffering message (not connected yet)');
    pendingMessages.push({ content: normalizedContent, contentLength: Buffer.byteLength(normalizedContent, 'utf8') });
  }
}

/**
 * Handle messages received from Godot's LSP server.
 * Buffers notifications until the initialize response is sent.
 */
function handleGodotMessage(content, contentLength) {
  log(`tcp <- ${content.substring(0, 100)}...`);
  
  try {
    const msg = JSON.parse(content);
    
    // Handle initialize sequence - Godot sends notifications before response
    if (waitingForInitialize) {
      if (msg.id === initializeRequestId && msg.result !== undefined) {
        log('Got initialize response, sending first');
        writeToStdout(content, contentLength);
        waitingForInitialize = false;
        wasInitialized = true;
        
        // Flush buffered notifications after initialize response
        for (const notif of bufferedNotifications) {
          log('Flushing buffered notification');
          writeToStdout(notif.content, notif.contentLength);
        }
        bufferedNotifications = [];
        return;
      }
      
      // Buffer notifications during initialize
      if (msg.method !== undefined && msg.id === undefined) {
        log(`Buffering notification: ${msg.method}`);
        bufferedNotifications.push({ content, contentLength });
        return;
      }
    }
    
    writeToStdout(content, contentLength);
  } catch (e) {
    // Forward even if not valid JSON
    writeToStdout(content, contentLength);
  }
}

/**
 * Send a notification to the LSP client.
 */
function sendNotificationToClient(method, params) {
  const notification = {
    jsonrpc: '2.0',
    method,
    params
  };
  const content = JSON.stringify(notification);
  writeToStdout(content, Buffer.byteLength(content, 'utf8'));
}

/**
 * Reset connection state for reconnection.
 */
function resetConnectionState() {
  tcpConnected = false;
  tcpBuffer = Buffer.alloc(0);
  waitingForInitialize = false;
  initializeRequestId = null;
  bufferedNotifications = [];
  
  if (tcpSocket) {
    tcpSocket.removeAllListeners();
    tcpSocket.destroy();
    tcpSocket = null;
  }
}

/**
 * Connect to Godot's LSP server via TCP.
 */
function connectToGodot() {
  return new Promise((resolve, reject) => {
    log(`Connecting to ${GODOT_LSP_HOST}:${GODOT_LSP_PORT}...`);
    
    tcpSocket = new net.Socket();
    tcpSocket.setTimeout(CONNECTION_TIMEOUT);
    
    tcpSocket.connect(GODOT_LSP_PORT, GODOT_LSP_HOST, () => {
      log('Connected to Godot LSP');
      tcpSocket.setTimeout(0);
      tcpConnected = true;
      reconnectAttempts = 0;
      
      if (isReconnecting) {
        // After reconnect, clear stale messages
        log(`Reconnected - clearing ${pendingMessages.length} stale pending messages`);
        pendingMessages = [];
        isReconnecting = false;
        
        // Warmup delay to let Godot stabilize
        isWarmingUp = true;
        log(`Waiting ${WARMUP_DELAY}ms for Godot to stabilize...`);
        setTimeout(() => {
          isWarmingUp = false;
          log(`Warmup complete, flushing ${pendingMessages.length} buffered messages`);
          for (const msg of pendingMessages) {
            const byteLength = Buffer.byteLength(msg.content, 'utf8');
            tcpSocket.write(`Content-Length: ${byteLength}\r\n\r\n${msg.content}`);
          }
          pendingMessages = [];
        }, WARMUP_DELAY);
        
        // Notify client that server restarted
        if (wasInitialized) {
          log('Server restarted, notifying client');
          sendNotificationToClient('window/showMessage', {
            type: 2, // Warning
            message: 'Godot LSP server restarted. You may need to reopen files for diagnostics.'
          });
        }
      } else {
        // Initial connection - flush pending messages
        log(`Flushing ${pendingMessages.length} pending messages`);
        for (const msg of pendingMessages) {
          const byteLength = Buffer.byteLength(msg.content, 'utf8');
          tcpSocket.write(`Content-Length: ${byteLength}\r\n\r\n${msg.content}`);
        }
        pendingMessages = [];
      }
      
      resolve();
    });

    tcpSocket.on('timeout', () => {
      log('Connection timeout');
      tcpSocket.destroy();
      reject(new Error('Connection timeout'));
    });

    tcpSocket.on('error', (err) => {
      log(`Connection error: ${err.message}`);
      reject(err);
    });
    
    tcpSocket.on('close', () => {
      log('TCP connection closed');
      tcpConnected = false;
      
      if (!shouldKeepRunning) {
        return;
      }
      
      // Attempt reconnection
      scheduleReconnect();
    });

    tcpSocket.on('data', (data) => {
      tcpBuffer = Buffer.concat([tcpBuffer, data]);
      log(`[tcp] received ${data.length} bytes, total: ${tcpBuffer.length}`);
      tcpBuffer = extractMessages(tcpBuffer, handleGodotMessage);
    });
  });
}

/**
 * Schedule a reconnection attempt.
 */
function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  
  if (!shouldKeepRunning) {
    return;
  }
  
  if (MAX_RECONNECT_ATTEMPTS >= 0 && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
    console.error('Max reconnection attempts reached. Exiting.');
    process.exit(1);
    return;
  }
  
  reconnectAttempts++;
  isReconnecting = true;
  
  console.error(`Connection to Godot LSP closed. Reconnecting in ${RECONNECT_DELAY / 1000}s... (attempt ${reconnectAttempts})`);
  
  reconnectTimer = setTimeout(async () => {
    if (!shouldKeepRunning) return;
    
    resetConnectionState();
    
    try {
      await connectToGodot();
      console.error(`Reconnected to Godot LSP on port ${GODOT_LSP_PORT}`);
    } catch (err) {
      log(`Reconnect failed: ${err.message}`);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY);
}

/**
 * Set up stdin reader to receive messages from the LSP client.
 */
function setupStdinReader() {
  log('Setting up stdin reader');
  
  process.stdin.on('data', (chunk) => {
    log(`stdin data: ${chunk.length} bytes`);
    stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
    log(`[buffer] total stdin buffer: ${stdinBuffer.length} bytes`);
    
    stdinBuffer = extractMessages(stdinBuffer, (content, contentLength) => {
      if (!tcpConnected || isWarmingUp) {
        log(`Buffering message - ${!tcpConnected ? 'not connected' : 'warming up'}`);
        pendingMessages.push({ content, contentLength });
        return;
      }
      sendToGodot(content, contentLength);
    });
    
    log(`[buffer] after parse, remaining: ${stdinBuffer.length} bytes`);
  });
  
  process.stdin.on('end', () => {
    log('stdin ended');
    cleanup('stdin-end');
  });
  
  process.stdin.on('close', () => {
    log('stdin closed');
    cleanup('stdin-close');
  });
  
  process.stdin.on('error', (err) => {
    log(`stdin error: ${err.message}`);
    cleanup('stdin-error');
  });
}

/**
 * Clean up and exit.
 */
function cleanup(reason) {
  if (!shouldKeepRunning) return;
  shouldKeepRunning = false;
  
  log(`Cleaning up (${reason})...`);
  console.error(`Shutting down (${reason})...`);
  
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  if (tcpSocket) {
    tcpSocket.removeAllListeners();
    tcpSocket.destroy();
    tcpSocket = null;
  }
  
  process.exit(0);
}

/**
 * Connect to Godot with initial retries.
 */
async function connectWithInitialRetry() {
  const MAX_INITIAL_RETRIES = 5;
  const INITIAL_RETRY_DELAY = 100;
  
  for (let i = 0; i < MAX_INITIAL_RETRIES; i++) {
    try {
      await connectToGodot();
      return;
    } catch (err) {
      log(`Initial connection attempt ${i + 1} failed: ${err.message}`);
      if (i < MAX_INITIAL_RETRIES - 1) {
        await new Promise(r => setTimeout(r, INITIAL_RETRY_DELAY));
      }
    }
  }
  
  // Start reconnection loop
  console.error('Could not connect to Godot LSP. Waiting for Godot to become available...');
  scheduleReconnect();
}

/**
 * Main entry point.
 */
async function main() {
  // Set up signal handlers
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGHUP', () => cleanup('SIGHUP'));
  
  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err.message}`);
    console.error(`Fatal error: ${err.message}`);
    cleanup('uncaught-exception');
  });
  
  process.on('unhandledRejection', (reason) => {
    log(`Unhandled rejection: ${reason}`);
    console.error(`Unhandled rejection: ${reason}`);
  });
  
  // Setup stdin reader BEFORE connecting (messages will be buffered)
  setupStdinReader();
  log('Stdin reader ready, messages will be buffered until connected');
  
  // Start connection
  await connectWithInitialRetry();
  
  if (tcpConnected) {
    console.error(`Godot LSP Bridge started (connected to port ${GODOT_LSP_PORT})`);
  }
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
