import { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, Eraser, ImagePlus, Send, Settings, Square, X, XCircle } from 'lucide-react';
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
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; result: ToolResult; image?: string }
  | { kind: 'error'; text: string };

/** Read an image file into a downscaled data URL (long side ≤1024px, huge
 * PNGs fall back to JPEG on white) so attachments stay well under the
 * /api/chat proxy's request size limit. */
async function fileToImageDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const url = canvas.toDataURL(type, 0.9);
  if (url.length <= 1_500_000) return url;
  // Still oversized (detailed PNG) → re-encode as JPEG, alpha is lost.
  const flat = document.createElement('canvas');
  flat.width = w;
  flat.height = h;
  const ctx = flat.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0);
  return flat.toDataURL('image/jpeg', 0.85);
}

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
            Remote endpoints are relayed through the site's /api/chat proxy, so no CORS setup is
            needed. Local endpoints (Ollama/LM Studio) are called straight from the browser — start
            Ollama with OLLAMA_ORIGINS="*" so the browser may call it.
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
  const [attachments, setAttachments] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const bridgeConnected = useAiBridgeConnected();
  const conversationRef = useRef<WireMessage[]>([]);
  const runRef = useRef<AgentRunHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

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

  /** Turn picked/pasted/dropped image files into downscaled attachments. */
  const addImages = async (files: Iterable<File>) => {
    for (const f of [...files]) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const url = await fileToImageDataUrl(f);
        setAttachments((prev) => [...prev, url]);
      } catch (err) {
        push({ kind: 'error', text: `Could not read image “${f.name || 'clipboard'}”: ${(err as Error).message}` });
      }
    }
  };

  const send = () => {
    const text = input.trim();
    if (busy || (!text && attachments.length === 0)) return;
    const images = attachments;
    setInput('');
    setAttachments([]);
    push({ kind: 'user', text: text || '[image]', images: images.length ? images : undefined });
    setBusy(true);
    const handle = runAgent(conversationRef.current, text || '[image attached]', images, onEvent);
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
    <div
      className={`ai-panel${dragOver ? ' dragover' : ''}`}
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        dragDepthRef.current++;
        setDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setDragOver(false);
        if (e.dataTransfer.files.length) void addImages(e.dataTransfer.files);
      }}
    >
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
            “make the jacket red”, “crouch and then jump”. You can also attach an image (📎 button,
            paste or drag-drop) for vision models. Configure an endpoint in the settings (gear) first.
          </div>
        )}
        {entries.map((e, i) => {
          if (e.kind === 'user')
            return (
              <div key={i} className="ai-msg user">
                {e.images && (
                  <div className="ai-msg-images">
                    {e.images.map((src, j) => (
                      <img key={j} src={src} alt="attached image" />
                    ))}
                  </div>
                )}
                {e.text}
              </div>
            );
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

      {attachments.length > 0 && (
        <div className="ai-attach-row">
          {attachments.map((url, i) => (
            <div key={i} className="ai-attach-thumb">
              <img src={url} alt="" />
              <button
                className="ai-attach-remove"
                title="Remove image"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ai-input-row">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addImages(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="btn icon"
          title="Attach image — you can also paste or drop one"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus size={14} />
        </button>
        <textarea
          value={input}
          placeholder="Ask the assistant…"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length > 0) {
              e.preventDefault();
              void addImages(files);
            }
          }}
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
          <button
            className="btn icon accent"
            title="Send (Enter)"
            onClick={send}
            disabled={!input.trim() && attachments.length === 0}
          >
            <Send size={14} />
          </button>
        )}
      </div>

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
