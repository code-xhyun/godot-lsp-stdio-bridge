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
 * 
 * @license MIT
 */

import * as net from 'net';
import * as fs from 'fs';

// Configuration
const GODOT_LSP_PORT = parseInt(process.env.GODOT_LSP_PORT || '6005', 10);
const GODOT_LSP_HOST = process.env.GODOT_LSP_HOST || '127.0.0.1';
const LOG_FILE = process.env.GODOT_LSP_BRIDGE_LOG || '/tmp/godot-lsp-bridge.log';
const DEBUG = process.env.GODOT_LSP_BRIDGE_DEBUG === 'true';

function log(msg) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stderr.write(line);
}

log('=== Godot LSP Bridge starting ===');
log(`Connecting to Godot LSP at ${GODOT_LSP_HOST}:${GODOT_LSP_PORT}`);

let tcpSocket = null;
let tcpConnected = false;
let tcpBuffer = Buffer.alloc(0);
let stdinBuffer = Buffer.alloc(0);
let pendingMessages = [];

let waitingForInitialize = false;
let initializeRequestId = null;
let bufferedNotifications = [];

const HEADER_DELIMITER = Buffer.from('\r\n\r\n');

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
  process.stdout.write(`Content-Length: ${contentLength}\r\n\r\n${content}`);
}

/**
 * Send an LSP message to Godot's LSP server.
 */
function sendToGodot(content, contentLength) {
  log(`stdin -> ${content.substring(0, 100)}...`);
  
  try {
    const msg = JSON.parse(content);
    if (msg.method === 'initialize' && msg.id !== undefined) {
      waitingForInitialize = true;
      initializeRequestId = msg.id;
      log(`Initialize request id: ${initializeRequestId}`);
    }
  } catch (e) {
    // Not valid JSON, still forward it
  }
  
  if (tcpConnected && tcpSocket && !tcpSocket.destroyed) {
    tcpSocket.write(`Content-Length: ${contentLength}\r\n\r\n${content}`);
  } else {
    log('Buffering message (not connected yet)');
    pendingMessages.push({ content, contentLength });
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
 * Connect to Godot's LSP server via TCP.
 */
function connectToGodot() {
  return new Promise((resolve, reject) => {
    log(`Connecting to ${GODOT_LSP_HOST}:${GODOT_LSP_PORT}...`);
    tcpSocket = new net.Socket();
    tcpSocket.setTimeout(500);
    
    tcpSocket.connect(GODOT_LSP_PORT, GODOT_LSP_HOST, () => {
      log('Connected to Godot LSP');
      tcpSocket.setTimeout(0);
      tcpConnected = true;
      
      // Send any messages that were buffered before connection
      log(`Flushing ${pendingMessages.length} pending messages`);
      for (const msg of pendingMessages) {
        tcpSocket.write(`Content-Length: ${msg.contentLength}\r\n\r\n${msg.content}`);
      }
      pendingMessages = [];
      resolve();
    });

    tcpSocket.on('timeout', () => {
      log('Connection timeout');
      tcpSocket.destroy();
      reject(new Error('timeout'));
    });

    tcpSocket.on('error', (err) => {
      log(`Connection error: ${err.message}`);
      reject(err);
    });
    
    tcpSocket.on('close', () => {
      log('TCP connection closed');
      process.exit(0);
    });

    tcpSocket.on('data', (data) => {
      tcpBuffer = Buffer.concat([tcpBuffer, data]);
      log(`[tcp] received ${data.length} bytes, total: ${tcpBuffer.length}`);
      tcpBuffer = extractMessages(tcpBuffer, handleGodotMessage);
    });
  });
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
    stdinBuffer = extractMessages(stdinBuffer, sendToGodot);
    log(`[buffer] after parse, remaining: ${stdinBuffer.length} bytes`);
  });
  process.stdin.on('end', () => {
    log('stdin ended');
    if (tcpSocket) tcpSocket.end();
    process.exit(0);
  });
}

/**
 * Connect to Godot with retries.
 */
async function connectToGodotWithRetry() {
  for (let i = 0; i < 5; i++) {
    try {
      await connectToGodot();
      return;
    } catch (err) {
      log(`Connection attempt ${i + 1} failed: ${err.message}`);
      if (i < 4) await new Promise(r => setTimeout(r, 50));
    }
  }
  throw new Error('All connection attempts failed. Is Godot Editor running?');
}

/**
 * Main entry point.
 */
async function main() {
  // Start connection (non-blocking)
  connectToGodotWithRetry().then(() => {
    log('Main: connected successfully');
  }).catch((err) => {
    log(`Connection failed: ${err.message}`);
    console.error(`Error: ${err.message}`);
    console.error('Make sure Godot Editor is running with the project open.');
    process.exit(1);
  });
  
  // Setup stdin reader immediately - don't wait for connection
  setupStdinReader();
  log('Stdin reader ready, messages will be buffered until connected');
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
