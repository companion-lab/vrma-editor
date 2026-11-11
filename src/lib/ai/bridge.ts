// Dev-server WS bridge, editor side. The standalone MCP server (mcp/server.mjs)
// talks to this relay: requests arrive as { __cid, id, cmd, args } and are
// executed here against the editor (executeTool); the response is echoed back
// with the same __cid. Also serves the tool catalog for cmd '__tools'.
//
// Dev-only: there is no relay in a static build, so this file stays dormant
// outside the dev server.

import { useSyncExternalStore } from 'react';
import { executeTool } from './execute';
import { TOOL_DEFS } from './toolDefs';

interface BridgeRequest {
  __cid: string;
  id?: unknown;
  cmd: string;
  args?: Record<string, unknown>;
}

let ws: WebSocket | null = null;
let connected = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
const listeners = new Set<() => void>();

function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAiBridgeConnected(): boolean {
  return useSyncExternalStore(subscribe, () => connected);
}

function handleMessage(data: string) {
  let msg: BridgeRequest;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (typeof msg.__cid !== 'string' || typeof msg.cmd !== 'string') return;

  const reply = (ok: boolean, payload: unknown) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const out: Record<string, unknown> = { __cid: msg.__cid, id: msg.id, ok };
    if (ok) out.result = payload;
    else out.error = typeof payload === 'string' ? payload : 'Unknown error';
    ws!.send(JSON.stringify(out));
  };

  if (msg.cmd === '__tools') {
    reply(true, TOOL_DEFS);
    return;
  }
  void executeTool(msg.cmd, msg.args ?? {}).then((res) => {
    if (res.ok) reply(true, res.result);
    else reply(false, res.error ?? 'Tool failed');
  });
}

function connect() {
  if (ws) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(`ws://${location.host}/__ai_bridge?role=editor`);
  } catch {
    return; // no relay available (e.g. static build) — stay dormant
  }
  ws = socket;

  socket.onopen = () => {
    retryDelay = 1000;
    setConnected(true);
  };
  socket.onmessage = (ev) => {
    if (typeof ev.data === 'string') handleMessage(ev.data);
  };
  socket.onclose = () => {
    ws = null;
    setConnected(false);
    // Reconnect with capped backoff — covers dev-server restarts and
    // "page opened before vite finished booting the relay".
    if (!retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!ws) connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    }
  };
  socket.onerror = () => socket.close();
}

/** Start the bridge (called once from main.tsx; dev mode only). */
export function startAiBridge(): void {
  if (!import.meta.env.DEV) return;
  connect();
}
