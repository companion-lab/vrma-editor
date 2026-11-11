import { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, Eraser, Send, Settings, Square, XCircle } from 'lucide-react';
import { runAgent, type AgentEvent, type AgentRunHandle } from '../lib/ai/agent';
import type { ToolResult } from '../lib/ai/execute';
import {
  loadSettings,
  saveSettings,
  PROVIDER_PRESETS,
  type AISettings,
  type WireMessage,
} from '../lib/ai/provider';
import { useAiBridgeConnected } from '../lib/ai/bridge';

type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; result: ToolResult; image?: string }
  | { kind: 'error'; text: string };

// --- Settings dialog ---

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<AISettings>(() => loadSettings());
  const set = (patch: Partial<AISettings>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    saveSettings(draft);
    onClose();
  };

  return (
    <div className="ai-settings-backdrop" onClick={onClose}>
      <div className="ai-settings" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title">AI settings</div>
        <div className="panel-body">
          <label className="field">
            <span>Provider preset</span>
            <select
              value=""
              onChange={(e) => {
                const p = PROVIDER_PRESETS.find((x) => x.label === e.target.value);
                if (p) set({ baseUrl: p.baseUrl, model: p.model });
              }}
            >
              <option value="">Choose…</option>
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Endpoint (OpenAI-compatible base URL)</span>
            <input
              value={draft.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(e) => set({ baseUrl: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={draft.model} onChange={(e) => set({ model: e.target.value })} />
          </label>
          <label className="field">
            <span>API key (stored in this browser only)</span>
            <input
              type="password"
              value={draft.apiKey}
              placeholder="empty = local endpoint"
              onChange={(e) => set({ apiKey: e.target.value })}
            />
          </label>
          <label className="ctl-row">
            <input
              type="checkbox"
              checked={draft.sendScreenshots}
              onChange={(e) => set({ sendScreenshots: e.target.checked })}
            />
            <span>Send viewport screenshots back to the model (needs a vision model)</span>
          </label>
          <div className="btn-row">
            <button className="btn accent" onClick={save} disabled={!draft.baseUrl || !draft.model}>
              Save
            </button>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
          <div className="muted small">
            Calls go straight from this browser to the endpoint. For Ollama, start with
            OLLAMA_ORIGINS="*" so the browser may call it.
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Tool chip ---

function argSummary(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v != null && v !== '')
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(' ');
}

function ToolChip({ entry }: { entry: Extract<ChatEntry, { kind: 'tool' }> }) {
  const ok = entry.result.ok;
  return (
    <details className={`ai-tool ${ok ? '' : 'fail'}`}>
      <summary>
        {ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
        <span className="ai-tool-name">{entry.name}</span>
        <span className="ai-tool-args">{argSummary(entry.args)}</span>
      </summary>
      <pre className="ai-tool-detail">{JSON.stringify(entry.result.ok ? entry.result.result : entry.result.error, null, 1)}</pre>
    </details>
  );
}

// --- Panel ---

export function AIPanel() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bridgeConnected = useAiBridgeConnected();
  const conversationRef = useRef<WireMessage[]>([]);
  const runRef = useRef<AgentRunHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, busy]);

  const push = (e: ChatEntry) => setEntries((prev) => [...prev, e]);

  const onEvent = (ev: AgentEvent) => {
    if (ev.kind === 'assistant') {
      if (ev.text) push({ kind: 'assistant', text: ev.text });
    } else if (ev.kind === 'tool') {
      push({ kind: 'tool', name: ev.name, args: ev.args, result: ev.result, image: ev.image });
    } else if (ev.kind === 'error') {
      push({ kind: 'error', text: ev.message });
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    push({ kind: 'user', text });
    setBusy(true);
    const handle = runAgent(conversationRef.current, text, onEvent);
    runRef.current = handle;
    handle.promise.finally(() => {
      setBusy(false);
      if (runRef.current === handle) runRef.current = null;
    });
  };

  const stop = () => runRef.current?.cancel();

  const clear = () => {
    if (busy) stop();
    conversationRef.current = [];
    setEntries([]);
  };

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span className="ai-title">
          <Bot size={14} /> Assistant
        </span>
        <span
          className={`ai-bridge-dot ${bridgeConnected ? 'on' : ''}`}
          title={bridgeConnected ? 'MCP bridge connected' : 'MCP bridge not connected (dev only)'}
        />
        <button className="btn icon small" title="Clear conversation" onClick={clear}>
          <Eraser size={13} />
        </button>
        <button className="btn icon small" title="AI settings" onClick={() => setSettingsOpen(true)}>
          <Settings size={13} />
        </button>
      </div>

      <div className="ai-chat" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="muted pad small">
            Ask the assistant to animate or edit the model — e.g. “wave both arms for 2 seconds”,
            “make the jacket red”, “crouch and then jump”. Configure an endpoint in the settings
            (gear) first.
          </div>
        )}
        {entries.map((e, i) => {
          if (e.kind === 'user') return <div key={i} className="ai-msg user">{e.text}</div>;
          if (e.kind === 'assistant') return <div key={i} className="ai-msg assistant">{e.text}</div>;
          if (e.kind === 'error') return <div key={i} className="ai-msg error">{e.text}</div>;
          return (
            <div key={i} className="ai-msg toolrow">
              <ToolChip entry={e} />
              {e.image && <img className="ai-shot" src={e.image} alt="viewport screenshot" />}
            </div>
          );
        })}
        {busy && <div className="ai-msg thinking">thinking…</div>}
      </div>

      <div className="ai-input-row">
        <textarea
          value={input}
          placeholder="Ask the assistant…"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy ? (
          <button className="btn icon" title="Stop" onClick={stop}>
            <Square size={14} />
          </button>
        ) : (
          <button className="btn icon accent" title="Send (Enter)" onClick={send} disabled={!input.trim()}>
            <Send size={14} />
          </button>
        )}
      </div>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
