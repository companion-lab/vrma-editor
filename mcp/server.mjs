#!/usr/bin/env node
// Standalone MCP server for the VRM editor (stdio transport).
//
// It is a thin, generic proxy: the actual tools live in the editor page
// (src/lib/ai/toolDefs.ts) and are executed there. This process connects to
// the dev server's WS relay (vite.config.ts aiBridge plugin), fetches the
// tool catalog from the editor and forwards every tool call to it.
//
// Usage:
//   npm run dev            # start the editor (http://localhost:5173)
//   npm run mcp            # start this server (in another terminal)
//   ...or point any MCP client at:  node mcp/server.mjs
//
// Env:
//   VRM_EDITOR_WS   relay URL (default ws://localhost:5173/__ai_bridge?role=mcp)
//
// All diagnostics go to stderr — stdout carries only the MCP protocol.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

const WS_URL = process.env.VRM_EDITOR_WS ?? 'ws://localhost:5173/__ai_bridge?role=mcp';
const REQUEST_TIMEOUT_MS = 90000;

const log = (...args) => console.error('[vrm-editor-mcp]', ...args);

// --- Relay connection ---

let ws = null;
let editorConnected = false;
let reconnectTimer = null;

const pending = new Map(); // id -> { resolve, reject, timer }
let idSeq = 0;
let cachedTools = []; // last known tool catalog (survives editor restarts)

function connect() {
  if (ws) return;
  let socket;
  try {
    socket = new WebSocket(WS_URL);
  } catch (err) {
    log(`bad relay URL "${WS_URL}":`, err.message);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.on('open', () => {
    log(`connected to relay ${WS_URL}`);
  });

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === 'editor') {
      const now = !!msg.connected;
      if (now !== editorConnected) {
        editorConnected = now;
        log(now ? 'editor page connected' : 'editor page disconnected');
      }
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  });

  socket.on('close', () => {
    ws = null;
    editorConnected = false;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Relay connection closed'));
    }
    pending.clear();
    log('relay connection closed');
    scheduleReconnect();
  });

  socket.on('error', () => {
    // 'close' follows; avoid noisy stack traces while the dev server is down.
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function request(cmd, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`Not connected to the VRM editor. Start it with "npm run dev" (http://localhost:5173) and try again.`));
      return;
    }
    const id = `m${++idSeq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Editor did not answer "${cmd}" within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, cmd, args }));
  });
}

async function fetchTools() {
  const res = await request('__tools', {}, 15000);
  if (!res.ok) throw new Error(res.error ?? 'Editor refused to list tools');
  cachedTools = res.result;
}

/** Resolve once the relay socket is open (bounded wait — the dev server may
 *  still be booting; we start MCP regardless so initialize never hangs). */
function waitForRelayOpen(timeoutMs = 10000) {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 100);
  });
}

// --- MCP server ---

const mcp = new Server(
  { name: 'vrm-editor', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  // Always refresh while the editor is reachable; fall back to the last
  // known catalog when it is not.
  try {
    await fetchTools();
  } catch (err) {
    log('tool list refresh failed:', err.message);
  }
  return { tools: cachedTools };
});

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {});
  try {
    const res = await request(name, args);
    if (!res.ok) {
      return {
        content: [{ type: 'text', text: `Error: ${res.error ?? 'tool failed'}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(res.result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err).message}` }],
      isError: true,
    };
  }
});

// --- Boot ---

connect();
const transport = new StdioServerTransport();
log(`VRM editor MCP server starting (relay: ${WS_URL})`);
waitForRelayOpen().then((up) => {
  if (!up) log(`relay at ${WS_URL} not reachable — tools appear once it is (npm run dev)`);
  return mcp.connect(transport);
});
