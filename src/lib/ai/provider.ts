// LLM provider client: OpenAI-compatible chat completions with tool calling.
// Works with OpenAI, GLM/Z.ai, OpenRouter, Ollama/LM Studio (local) and any
// other /v1/chat/completions endpoint. The API key is stored in localStorage.
// Remote endpoints are relayed through the same-origin /api/chat Vercel
// function (they don't allow browser CORS calls); local endpoints are called
// straight from the browser.

import { TOOL_DEFS } from './toolDefs';

export interface AISettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Feed screenshot results back to the model as images (needs a vision model). */
  sendScreenshots: boolean;
}

export const DEFAULT_SETTINGS: AISettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  sendScreenshots: true,
};

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  { label: 'GLM (Z.ai)', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', needsKey: true },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4', needsKey: true },
  {
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    needsKey: false,
    note: 'Start with OLLAMA_ORIGINS="*" ollama serve to allow browser calls',
  },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: 'local-model', needsKey: false },
];

const SETTINGS_KEY = 'vrma-editor-ai-settings';

export function loadSettings(): AISettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') {
        return {
          baseUrl: typeof v.baseUrl === 'string' && v.baseUrl ? v.baseUrl : DEFAULT_SETTINGS.baseUrl,
          apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
          model: typeof v.model === 'string' && v.model ? v.model : DEFAULT_SETTINGS.model,
          sendScreenshots: v.sendScreenshots !== false,
        };
      }
    }
  } catch {
    // ignore corrupted storage
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: AISettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore quota errors
  }
}

// --- Wire types (OpenAI chat completions subset) ---

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatChoiceMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

const OPENAI_TOOLS = TOOL_DEFS.map((d) => ({
  type: 'function',
  function: { name: d.name, description: d.description, parameters: d.inputSchema },
}));

function endpoint(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return `${b}/chat/completions`;
}

function isLikelyLocal(baseUrl: string): boolean {
  return /localhost|127\.0\.0\.1|\[::1\]/.test(baseUrl);
}

/**
 * One chat-completion round trip. Returns the assistant message (possibly
 * with tool_calls). Throws Error with a readable message on failure.
 */
export async function chatCompletion(
  messages: WireMessage[],
  opts: { signal?: AbortSignal } = {},
): Promise<ChatChoiceMessage> {
  const s = loadSettings();
  if (!s.baseUrl) throw new Error('No AI endpoint configured — open the AI settings (gear icon).');
  if (!s.apiKey && !isLikelyLocal(s.baseUrl)) {
    throw new Error('No API key configured — open the AI settings (gear icon).');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;

  const body = JSON.stringify({
    model: s.model,
    messages,
    tools: OPENAI_TOOLS,
    tool_choice: 'auto',
    temperature: 0.4,
  });

  // Remote providers block browser CORS calls, so relay through the
  // same-origin /api/chat proxy (Vercel function in prod, matching dev-server
  // middleware in dev). Local endpoints (Ollama/LM Studio) are only reachable
  // from the user's machine anyway, so those go direct from the browser.
  const local = isLikelyLocal(s.baseUrl);
  const proxied = !local;
  const url = proxied ? '/api/chat' : endpoint(s.baseUrl);
  const requestHeaders = proxied ? { ...headers, 'x-ai-url': endpoint(s.baseUrl) } : headers;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(
      `Could not reach ${s.baseUrl} (${(err as Error).message}). Check the endpoint${proxied ? '' : ' and that it allows browser (CORS) requests'}.`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // On a static deploy without the function, /api/chat 404s with a
    // non-JSON body — say so instead of blaming the provider.
    if (proxied && !/^\s*[[{]/.test(text)) {
      throw new Error(
        `/api/chat proxy unavailable (HTTP ${res.status}) — this needs the Vercel serverless deploy, or use a local endpoint.`,
      );
    }
    throw new Error(`AI endpoint returned HTTP ${res.status}: ${text.slice(0, 600) || res.statusText}`);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error('AI endpoint returned invalid JSON.');
  }
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error(`AI endpoint returned no message: ${JSON.stringify(data).slice(0, 400)}`);
  return msg as ChatChoiceMessage;
}
