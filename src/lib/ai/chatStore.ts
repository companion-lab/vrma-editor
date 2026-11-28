// Session-persistent AI chat state. The AIPanel component is unmounted by
// every inspector tab switch (Pose/Motion/Model/AI), so the conversation must
// live here instead of component state — otherwise the chat, the "thinking…"
// indicator and a run still in flight disappear from view when the user opens
// another tab, and every event the agent streams during that time is lost even
// though the run keeps working in the background.

import { create } from 'zustand';
import { runAgent, type AgentEvent, type AgentRunHandle } from './agent';
import type { ToolResult } from './execute';
import type { WireMessage } from './provider';

export type ChatEntry =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; result: ToolResult; image?: string }
  | { kind: 'error'; text: string };

/** The mutable agent conversation (wire format). runAgent mutates it in place
 *  and it is passed back on every send — kept module-level, next to the run
 *  handle, so both survive panel unmounts. */
let conversation: WireMessage[] = [];
let run: AgentRunHandle | null = null;

function onAgentEvent(ev: AgentEvent): void {
  const chat = useAiChat.getState();
  if (ev.kind === 'assistant') {
    if (ev.text) chat.push({ kind: 'assistant', text: ev.text });
  } else if (ev.kind === 'tool') {
    chat.push({ kind: 'tool', name: ev.name, args: ev.args, result: ev.result, image: ev.image });
  } else if (ev.kind === 'error') {
    chat.push({ kind: 'error', text: ev.message });
  }
  // 'done' — the final text was already delivered as an assistant entry.
}

interface AiChatState {
  entries: ChatEntry[];
  busy: boolean;
  input: string;
  /** Downscaled data-URL image attachments waiting to be sent. */
  attachments: string[];
  push: (e: ChatEntry) => void;
  setInput: (v: string) => void;
  addAttachments: (urls: string[]) => void;
  removeAttachment: (index: number) => void;
  /** Send the current input (or just the attachments when the text is empty). */
  send: () => void;
  /** Cancel the in-flight run (no-op when idle). */
  stop: () => void;
  /** Clear the conversation; cancels a busy run first. */
  clear: () => void;
}

export const useAiChat = create<AiChatState>()((set, get) => ({
  entries: [],
  busy: false,
  input: '',
  attachments: [],

  push: (e) => set((s) => ({ entries: [...s.entries, e] })),
  setInput: (v) => set({ input: v }),
  addAttachments: (urls) => set((s) => ({ attachments: [...s.attachments, ...urls] })),
  removeAttachment: (index) =>
    set((s) => ({ attachments: s.attachments.filter((_, i) => i !== index) })),

  send: () => {
    const { busy, input, attachments } = get();
    const text = input.trim();
    if (busy || (!text && attachments.length === 0)) return;
    const images = attachments;
    set({ input: '', attachments: [], busy: true });
    get().push({ kind: 'user', text: text || '[image]', images: images.length ? images : undefined });
    const handle = runAgent(conversation, text || '[image attached]', images, onAgentEvent);
    run = handle;
    handle.promise.finally(() => {
      // A clear() + resend may have replaced this run; only the active one
      // settles the busy flag (a cancelled run's late settle must not clear
      // the state of the run that replaced it).
      if (run === handle) {
        run = null;
        set({ busy: false });
      }
    });
  },

  stop: () => run?.cancel(),

  clear: () => {
    // No `run = null` here: the aborted run's settle must still see itself as
    // the active one to reset busy (unless a resend already replaced it).
    if (get().busy) get().stop();
    conversation = [];
    set({ entries: [] });
  },
}));
