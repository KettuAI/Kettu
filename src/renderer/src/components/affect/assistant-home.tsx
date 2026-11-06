// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

/*
 * AI Chat / Start – the start screen of an AI workspace, in a single file.
 * Greeting, the library's Chat Composer with folder and app shortcuts on its gray layer, and quick prompts.
 * Sits in the affectUI App Shell with its Workspace panel on the right, folded away to start; icons from the
 * Hugeicons free set.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ThinkingState, type ThinkingStep } from "./thinking-state";
import type { IconSvgElement } from "@hugeicons/react";
import {
  AiBrain01Icon,
  AiMagicIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  FolderOpenIcon,
  Globe02Icon,
  PencilEdit02Icon,
  SparklesIcon,
  ArrowUp02Icon,
  ChartColumnIcon,
  Database01Icon,
  File01Icon,
  Image01Icon,
  Mic01Icon,
  Plug01Icon,
  PlusSignIcon,
  PresentationBarChart01Icon,
  Table01Icon,
  Telescope01Icon,
} from "@hugeicons/core-free-icons";
import { ChatComposer } from "./chat-composer";
import { AppShell, Dropdown, Icon, WorkspacePanel, defaultProjects, type AppShellProps, type ShellChat } from "./app-shell";

type NavItem = { label: string; icon: IconSvgElement };

const suggestions: NavItem[][] = [
  [
    { label: "Company knowledge", icon: Database01Icon },
    { label: "Create document", icon: File01Icon },
    { label: "Create presentation", icon: PresentationBarChart01Icon },
    { label: "Create table", icon: Table01Icon },
  ],
  [
    { label: "Generate image", icon: Image01Icon },
    { label: "Deep research", icon: Telescope01Icon },
    { label: "Visualize data", icon: ChartColumnIcon },
  ],
];

function greeting() {
  const h = new Date().getHours();
  if (h < 11) return "Good morning!";
  if (h < 18) return "Good afternoon!";
  return "Good evening!";
}

export type AssistantHomeScreenProps = Pick<AppShellProps, "onNavigate" | "workspace" | "user" | "className">;

/** Prepared answers – picked by a keyword in the prompt; replace with your model's answer */
function replyFor(prompt: string): ChatReply {
  const p = prompt.toLowerCase();
  if (/document|doc|write/.test(p))
    return {
      steps: [
        { kind: "step", label: "Reading your request" },
        { kind: "step", label: "Checking Brand assets for tone of voice" },
        { kind: "step", label: "Outlining the document" },
      ],
      paragraphs: [
        "Here's an outline to start from – it follows your Tone-of-Voice guide:",
        "1. Summary – what this is about and why it matters now, in three sentences.",
        "2. Context – the numbers behind it, taken from Q3 Campaign.",
        "3. Proposal – what we do next, who owns it and by when.",
        "Shall I write the full draft into a new document in Q3 Campaign?",
      ],
    };
  if (/research|study|market/.test(p))
    return {
      steps: [
        { kind: "step", label: "Planning the research" },
        { kind: "step", label: "Reading Market-Study and Survey-Results" },
        { kind: "step", label: "Comparing the findings" },
      ],
      paragraphs: [
        "Two things stand out in your Research folder:",
        "Customers who buy twice do so within 30 days – after that, repeat orders drop by more than half.",
        "Price is rarely the reason to leave; slow delivery is named three times as often.",
        "Want a short report with sources, ready to share with the team?",
      ],
    };
  if (/table|data|visual|chart/.test(p))
    return {
      steps: [
        { kind: "step", label: "Reading Media-Budget and Results-Q2" },
        { kind: "step", label: "Matching spend to results" },
        { kind: "step", label: "Building the table" },
      ],
      paragraphs: [
        "I matched your Q2 spend against results per channel:",
        "Organic brought the most revenue at no media cost, paid ads the most new customers, and email the best return per dollar.",
        "Shall I add this as a table to Q3 Campaign, with a chart for the weekly trend?",
      ],
    };
  return {
    steps: [
      { kind: "step", label: "Reading your message" },
      { kind: "step", label: "Looking through Q3 Campaign and Brand assets" },
      { kind: "step", label: "Sorting ideas by effort and impact" },
    ],
    paragraphs: [
      `Here are a few directions for “${prompt}”:`,
      "1. Start with the problem customers name most often in reviews and support chats – it gives every idea a real reason to exist.",
      "2. Turn your strongest proof into the story: 412 orders of the Linen Overshirt last month make a good headline.",
      "3. Test two angles side by side for a week before you commit budget – desire-driven and problem–solution usually split clearly.",
      "Want me to turn one of these into a brief or a first draft?",
    ],
  };
}

/** Earlier chats in the sidebar – some inside the project folders, one pinned, one not read yet */
export const recentChats: ShellChat[] = [
  { id: "c-q3-messaging", title: "Q3 launch messaging", pinned: true, folder: "Q3 Campaign" },
  { id: "c-ad-hooks", title: "Ad hooks for the linen overshirt", unread: true, folder: "Q3 Campaign" },
  { id: "c-budget", title: "Q3 budget split by channel", folder: "Q3 Campaign" },
  { id: "c-logo", title: "Logo usage on partner sites", folder: "Brand assets" },
  { id: "c-interview", title: "Interview questions for designers", folder: "Hiring" },
  { id: "c-pricing", title: "Competitor pricing comparison", folder: "Research" },
  { id: "c-reviews", title: "Summary of last week's reviews", folder: "Research" },
  { id: "c-onboarding", title: "Onboarding email draft" },
  { id: "c-calendar", title: "August content calendar" },
];

export function AssistantHomeScreen(props: AssistantHomeScreenProps) {
  // start: greeting in the middle · leaving: greeting and chips fade · chat: thread on top, composer at the bottom
  const [phase, setPhase] = useState<"start" | "leaving" | "chat">("start");
  const chat = useChatThread(replyFor);
  const slot = useRef<HTMLDivElement>(null);
  const from = useRef<DOMRect | null>(null);
  const thread = useRef<HTMLDivElement>(null);

  const send = (text: string) => {
    if (phase !== "start") return chat.send(text);
    from.current = slot.current?.getBoundingClientRect() ?? null;
    setPhase("leaving");
    window.setTimeout(() => {
      setPhase("chat");
      chat.send(text);
    }, 180);
  };

  // The composer glides from the middle down to its place at the bottom (FLIP – measured, then animated back)
  useLayoutEffect(() => {
    const el = slot.current;
    if (phase !== "chat" || !el || !from.current) return;
    const to = el.getBoundingClientRect();
    // Inside a scaled preview the measured pixels are scaled too
    const scale = to.width / el.offsetWidth || 1;
    const dy = (from.current.top - to.top) / scale;
    from.current = null;
    // Reduced motion: the composer simply is at the bottom
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 720, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }, [phase]);

  return (
    // The work area on the right starts folded away; its icon in the top right corner opens it
    <AppShell active="New chat" panel={<WorkspacePanel />} defaultPanelOpen={false} chats={recentChats} onOpenChat={() => props.onNavigate?.("Chat")} {...props}>
      <style href="ui-screen-assistant-home" precedence="default">
        {css}
      </style>

      <section className="ui-as-start" data-phase={phase}>
        {phase === "chat" && (
          <div ref={thread} className="ui-as-start__thread">
            <div className="ui-as-start__column">
              <ChatMessages messages={chat.messages} scroller={thread} onDone={chat.finish} />
            </div>
          </div>
        )}
        {phase !== "chat" && <h1 className="ui-as-start__title">{greeting()} What's next on your list?</h1>}
        <div ref={slot} className="ui-as-start__composer">
          {/* The library's Chat Composer (clean); while an answer is still being written, a new message waits its turn */}
          <ChatComposer onSend={(text) => !chat.busy && send(text)} placeholder={phase === "chat" ? "Reply…" : "Help me brainstorm ideas for…"} foot={<ComposerTray />} />
        </div>
        {phase !== "chat" && suggestions.some((row) => row.length > 0) && (
          <div className="ui-as-chips">
            {suggestions.map((row, i) => (
              <div key={i} className="ui-as-chips__row">
                {row.map((s, j) => (
                  <button
                    key={s.label}
                    type="button"
                    className="ui-as-chip"
                    // The place in the whole list – narrower layouts show the first ones in even rows
                    data-n={suggestions.slice(0, i).reduce((n, r) => n + r.length, 0) + j}
                    title={s.label}
                    onClick={() => send(s.label)}
                  >
                    <Icon icon={s.icon} size={15} />
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}

/* ---------- Chat ---------- */

/** An answer: thinking steps first, then the text, written out word by word */
export type ChatReply = { steps: ThinkingStep[]; paragraphs: string[] };
export type ChatMessage = { id: number; role: "user"; text: string } | { id: number; role: "assistant"; reply: ChatReply };

/** Messages of a chat with prepared answers; one answer at a time */
export function useChatThread(replyFor: (prompt: string) => ChatReply) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const send = (text: string) => {
    if (busy || !text.trim()) return;
    const id = Date.now();
    setMessages((m) => [...m, { id, role: "user", text }, { id: id + 1, role: "assistant", reply: replyFor(text) }]);
    setBusy(true);
  };
  return { messages, busy, send, finish: () => setBusy(false) };
}

/** The thread: user bubbles on the right, answers with the library's Thinking State and streamed text */
export function ChatMessages({
  messages,
  name,
  scroller,
  onDone,
}: {
  messages: ChatMessage[];
  /** Shown above each answer with a small mark – leave it out for answers without a name */
  name?: string;
  /** Scroll container that follows the newest text */
  scroller: RefObject<HTMLElement | null>;
  onDone: () => void;
}) {
  // Keep the newest text in view while it grows – unless someone scrolled up to read
  const follow = () => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTo({ top: el.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  useEffect(follow, [messages.length]);

  return (
    <>
      <style href="ui-screen-chat" precedence="default">
        {chatCss}
      </style>
      {messages.map((m) =>
        m.role === "user" ? (
          <p key={m.id} className="ui-as-msg-user">
            {m.text}
          </p>
        ) : (
          <Answer key={m.id} name={name} reply={m.reply} onGrow={follow} onDone={onDone} />
        ),
      )}
    </>
  );
}

function Answer({ name, reply, onGrow, onDone }: { name?: string; reply: ChatReply; onGrow: () => void; onDone: () => void }) {
  const [writing, setWriting] = useState(false);
  const [count, setCount] = useState(0);
  const words = reply.paragraphs.map((p) => p.split(" "));
  const total = words.reduce((n, w) => n + w.length, 0);

  // Writes the answer out a few words at a time, like a model streaming
  useEffect(() => {
    if (!writing) return;
    const t = window.setInterval(() => setCount((c) => Math.min(c + 2, total)), 45);
    return () => window.clearInterval(t);
  }, [writing, total]);
  useEffect(() => {
    if (!writing) return;
    onGrow();
    if (count >= total) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, writing]);

  let left = count;
  return (
    <div className="ui-as-msg">
      {name && (
        <span className="ui-as-msg__who">
          <span className="ui-as-msg__avatar">
            <Icon icon={AiBrain01Icon} size={12} />
          </span>
          {name}
        </span>
      )}
      {/* Thinking folds itself away once it's done – the answer follows right under its header */}
      <ThinkingState className="ui-as-msg__thinking" steps={reply.steps} stepMs={700} doneLabel="Ready" collapseOnDone onDone={() => (setWriting(true), onGrow())} />
      {writing &&
        words.map((w, i) => {
          const shown = Math.max(0, Math.min(w.length, left));
          left -= w.length;
          return shown > 0 ? (
            <p key={i} className="ui-as-msg__p">
              {w.slice(0, shown).join(" ")}
            </p>
          ) : null;
        })}
    </div>
  );
}

const chatCss = /* css */ `
/* Chat thread shared by AI Chat / Start and AI Chat / Agents */
.ui-as-msg-user {
  align-self: flex-end;
  max-width: 80%;
  margin: 0;
  padding: 9px 14px;
  border-radius: 16px;
  background: var(--chip);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ink);
  /* Keeps line breaks; long links break instead of running out of the bubble */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  animation: ui-as-msg-in 480ms var(--ease) both;
}
.ui-as-msg {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
  min-width: 0;
  overflow-wrap: anywhere;
  animation: ui-as-msg-in 480ms var(--ease) 160ms both;
}
.ui-as-msg__who { display: flex; align-items: center; gap: 8px; font-weight: 500; }
.ui-as-msg__avatar { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--chip); color: var(--ink); }
/* No card around it: pulled left by its own padding, so its mark lines up with the answer's text */
.ui-as-msg__thinking.ui-thinkc { zoom: 0.92; width: calc(100% + 8px); max-width: 448px; margin-left: -8px; }
.ui-as-msg__p { max-width: 100%; margin: 0; animation: ui-as-msg-fade 360ms ease both; }
@keyframes ui-as-msg-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes ui-as-msg-fade { from { opacity: 0; } to { opacity: 1; } }
`;

/** Models in the composer's picker – the first one is selected */
const models = [
  { name: "Auto", description: "Picks the best model for each task", icon: AiMagicIcon },
  { name: "Claude", description: "Thoughtful writing and code", icon: AiBrain01Icon },
  { name: "ChatGPT", description: "Quick answers for everyday tasks", icon: SparklesIcon },
  { name: "Gemini", description: "Long documents and research", icon: Telescope01Icon },
];
const pluginList = [
  { label: "Web search", description: "Look things up while answering", icon: Globe02Icon },
  { label: "Canvas", description: "Write and edit side by side", icon: PencilEdit02Icon },
  { label: "Image generation", description: "Create images from a prompt", icon: Image01Icon },
];

/**
 * Chat input: white card in a gray tray, the tray holds the folder and app shortcuts.
 * Exported so other screens (AI Chat / Agents) use the very same composer.
 */
export function Composer({
  placeholder = "Help me brainstorm ideas for...",
  onSend,
  busy,
  className,
}: {
  placeholder?: string;
  /** Called with the message when it is sent */
  onSend?: (text: string) => void;
  /** While an answer is being written, sending waits */
  busy?: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [model, setModel] = useState(models[0]?.name ?? "");
  const [plugins, setPlugins] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const toggleIn = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  // Dictation: a short sample sentence appears after a moment – wire up real speech-to-text here
  useEffect(() => {
    if (!recording) return;
    const t = window.setTimeout(() => {
      setText((v) => (v ? v + " " : "") + "Draft a short update for the team about this week.");
      setRecording(false);
      field.current?.focus();
    }, 1800);
    return () => window.clearTimeout(t);
  }, [recording]);

  // Grows with the text, up to six lines
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 20)}px`;
  }, [text]);

  const submit = () => {
    if (!text.trim() || busy) return;
    onSend?.(text.trim());
    setText("");
    setFiles([]);
  };

  return (
    <form className={["ui-as-composer", className].filter(Boolean).join(" ")} onSubmit={(e) => (e.preventDefault(), submit())}>
      <style href="ui-screen-composer" precedence="default">
        {composerCss}
      </style>
      <div className="ui-as-composer__card">
        {files.length > 0 && (
          <div className="ui-as-attachments">
            {files.map((f) => (
              <span key={f} className="ui-as-attachment" title={f}>
                <Icon icon={File01Icon} size={13} />
                <FileName name={f} />
                <button type="button" aria-label={`Remove ${f}`} onClick={() => setFiles((list) => list.filter((x) => x !== f))}>
                  <Icon icon={Cancel01Icon} size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={field}
          className="ui-as-composer__field"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="ui-as-composer__bar">
          <button type="button" className="ui-as-icon-btn" aria-label="Add file" onClick={() => fileInput.current?.click()}>
            <Icon icon={PlusSignIcon} size={15} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])].map((f) => f.name);
              setFiles((list) => [...list, ...picked.filter((n) => !list.includes(n))]);
              e.target.value = "";
            }}
          />
          <Dropdown
            title="Plugins"
            items={pluginList.map((p) => ({
              label: p.label,
              description: p.description,
              icon: p.icon,
              checked: plugins.includes(p.label),
              onSelect: () => setPlugins((list) => toggleIn(list, p.label)),
            }))}
            trigger={({ open, toggle }) => (
              <button type="button" className="ui-as-ghost" aria-haspopup="menu" aria-expanded={open} data-active={plugins.length > 0 || undefined} onClick={toggle}>
                <Icon icon={Plug01Icon} size={14} />
                {plugins.length ? `Plugins · ${plugins.length}` : "Plugins"}
              </button>
            )}
          />
          <span className="ui-as-composer__end">
            {models.length > 0 && (
              <Dropdown
                align="end"
                title="Model"
                items={models.map((m) => ({ label: m.name, description: m.description, icon: m.icon, checked: m.name === model, onSelect: () => setModel(m.name) }))}
                trigger={({ open, toggle }) => (
                  <button type="button" className="ui-as-ghost ui-as-ghost--model" aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
                    <Icon icon={models.find((m) => m.name === model)?.icon ?? AiMagicIcon} size={14} />
                    <span title={model}>{model}</span>
                    <Icon icon={ArrowDown01Icon} size={12} />
                  </button>
                )}
              />
            )}
            <button
              type="button"
              className="ui-as-icon-btn ui-as-mic"
              aria-label={recording ? "Stop dictation" : "Dictate"}
              aria-pressed={recording}
              onClick={() => setRecording((r) => !r)}
            >
              <Icon icon={Mic01Icon} size={15} />
            </button>
            <button type="submit" className="ui-as-send" aria-label="Send" disabled={!text.trim() || busy}>
              <Icon icon={ArrowUp02Icon} size={15} />
            </button>
          </span>
        </div>
      </div>
      <ComposerTray />
    </form>
  );
}

/** The gray tray's row under the input: pick a folder to work in, and connect apps */
export function ComposerTray() {
  const [folder, setFolder] = useState<string | null>(null);
  const [apps, setApps] = useState<string[]>(["Gmail"]);
  const toggleIn = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  return (
    <div className="ui-as-composer__tray">
      {/* Its styles live with the composer's – hoisted once, whichever renders first */}
      <style href="ui-screen-composer" precedence="default">
        {composerCss}
      </style>
      {defaultProjects.length > 0 && (
        <Dropdown
          title="Work in a folder"
          items={[
            ...defaultProjects.map((name) => ({ label: name, icon: FolderOpenIcon, checked: folder === name, onSelect: () => setFolder(folder === name ? null : name) })),
          ]}
          trigger={({ open, toggle }) => (
            <button type="button" className="ui-as-tray-link" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <FolderMark />
              <span title={folder ?? undefined}>{folder ?? "Work in a folder"}</span>
            </button>
          )}
        />
      )}
      <Dropdown
        align="end"
        title="Apps"
        items={appLogos.map(({ name, Logo }) => ({
          label: name,
          logo: <Logo />,
          checked: apps.includes(name),
          onSelect: () => setApps((list) => toggleIn(list, name)),
        }))}
        trigger={({ open, toggle }) => (
          <button type="button" className="ui-as-tray-link ui-as-tray-link--apps" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            Connect apps
            <span className="ui-as-apps" aria-hidden="true">
              <GmailLogo />
              <SlackLogo />
              <ClickUpLogo />
            </span>
          </button>
        )}
      />
    </div>
  );
}

/** A file name cut in the middle, so the end and the extension stay readable */
function FileName({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  // Keep the last few characters before the extension next to it
  const cut = Math.max(0, (dot > 0 ? dot : name.length) - 6);
  return (
    <span className="ui-as-attachment__name">
      <span>{name.slice(0, cut)}</span>
      {name.slice(cut)}
    </span>
  );
}

/* A folder in two blues – its tab on top, the open front below – for "Work in a folder" */
export const FolderMark = () => (
  <svg className="ui-as-tray-link__folder" viewBox="0 0 67 67" fill="none" aria-hidden="true">
    <path d="M11.17 15.35v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98Z" fill="#00A1FF" />
    <path d="M33.5 16.75l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5Zm0 0h-9.77" stroke="#00A1FF" strokeWidth="4.19" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6.59 42.38c-1.05-5.26-1.57-7.89-.08-9.67l.31-.34c1.66-1.66 4.59-1.66 10.45-1.66h32.46c5.86 0 8.79 0 10.45 1.66l.31.34c1.49 1.78.97 4.41-.08 9.67-1.51 7.56-2.26 11.34-5.1 13.66l-.6.46c-3.01 2.13-7.23 2.13-15.66 2.13h-11.1c-8.43 0-12.64 0-15.66-2.13l-.6-.46c-2.84-2.32-3.6-6.1-5.1-13.66Z" fill="#3CC7FF" stroke="#3CC7FF" strokeWidth="4.19" />
  </svg>
);

/* Brand marks (Gmail, Slack, ClickUp) for the "Connect apps" shortcut */
/** Unique ids for gradients, so several logos on one page don't clash */
const useSvgId = () => "lg" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

const GmailLogo = () => {
  const id = useSvgId();
  return (
    <svg viewBox="0 0 56.4108 44.8722" fill="none" aria-hidden="true">
      <path
        d="M44.2255 5.76727H56.4051V41.0239C56.4051 43.148 54.683 44.8701 52.5589 44.8701H46.1486C45.8961 44.8701 45.646 44.8204 45.4127 44.7237C45.1794 44.6271 44.9674 44.4854 44.7888 44.3069C44.6102 44.1283 44.4686 43.9163 44.3719 43.683C44.2753 43.4497 44.2255 43.1996 44.2255 42.947V5.76727Z"
        fill={`url(#${id}-0)`}
      />
      <path
        d="M12.1796 5.76727H0V41.0239C0 43.148 1.72213 44.8701 3.84618 44.8701H10.2565C10.509 44.8701 10.7591 44.8204 10.9924 44.7237C11.2257 44.6271 11.4377 44.4854 11.6163 44.3069C11.7949 44.1283 11.9365 43.9163 12.0332 43.683C12.1298 43.4497 12.1796 43.1996 12.1796 42.947V5.76727Z"
        fill="#FC413D"
      />
      <path
        d="M10.0085 1.42778C7.43377 -0.736342 3.5924 -0.403647 1.42828 2.17105C-0.735843 4.74543 -0.403148 8.58681 2.17155 10.7512L26.5557 31.2479C27.0178 31.6362 27.602 31.8492 28.2056 31.8492C28.8091 31.8492 29.3934 31.6362 29.8554 31.2479L54.2396 10.7509C56.814 8.58681 57.1467 4.74543 54.9825 2.17073C52.8184 -0.403648 48.977 -0.736342 46.4027 1.42778L28.2054 16.724L10.0085 1.42778Z"
        fill={`url(#${id}-1)`}
      />
      <defs>
        <linearGradient
          id={`${id}-0`}
          x1="50.3153"
          y1="5.76727"
          x2="50.3153"
          y2="44.8701"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#60D673" />
          <stop offset="0.17" stopColor="#42C868" />
          <stop offset="0.39" stopColor="#0EBC5F" />
          <stop offset="0.62" stopColor="#00A9BB" />
          <stop offset="0.86" stopColor="#3C90FF" />
          <stop offset="1" stopColor="#3186FF" />
        </linearGradient>
        <linearGradient
          id={`${id}-1`}
          x1="6.04194e-05"
          y1="6.45153"
          x2="56.4107"
          y2="6.45153"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0.08" stopColor="#FF63A0" />
          <stop offset="0.3" stopColor="#FC413D" />
          <stop offset="0.5" stopColor="#FC413D" />
          <stop offset="0.65" stopColor="#FC413D" />
          <stop offset="0.72" stopColor="#FC5C30" />
          <stop offset="0.86" stopColor="#FEB10C" />
          <stop offset="0.91" stopColor="#FEC700" />
          <stop offset="0.96" stopColor="#FFDB0F" />
        </linearGradient>
      </defs>
    </svg>
  );
};

const SlackLogo = () => (
  <svg viewBox="0 0 49.883 49.877" fill="none" aria-hidden="true">
    <g transform="translate(0 0)">
      <path
        d="M18.3549 10.4784C15.4713 10.4784 13.1157 8.12279 13.1157 5.2392C13.1157 2.35561 15.4713 0 18.3549 0C21.2385 0 23.5941 2.35561 23.5941 5.2392V10.4784H18.3549Z"
        fill="#36C5F0"
      />
      <path
        d="M18.3575 13.12C21.2411 13.12 23.5967 15.4756 23.5967 18.3592C23.5967 21.2428 21.2411 23.5984 18.3575 23.5984H5.2392C2.35561 23.5984 0 21.2428 0 18.3592C0 15.4756 2.35561 13.12 5.2392 13.12H18.3575Z"
        fill="#36C5F0"
      />
    </g>
    <g transform="translate(26.28 0)">
      <path
        d="M13.1244 18.3592C13.1244 15.4756 15.48 13.12 18.3636 13.12C21.2472 13.12 23.6028 15.4756 23.6028 18.3592C23.6028 21.2428 21.2472 23.5984 18.3636 23.5984H13.1244V18.3592Z"
        fill="#2EB67D"
      />
      <path
        d="M10.4785 18.3575C10.4785 21.2411 8.12286 23.5967 5.23927 23.5967C2.35568 23.5967 7.4362e-05 21.2411 7.4362e-05 18.3575V5.2392C7.4362e-05 2.35561 2.35568 0 5.23927 0C8.12286 0 10.4785 2.35561 10.4785 5.2392V18.3575Z"
        fill="#2EB67D"
      />
    </g>
    <g transform="translate(0 26.28)">
      <path
        d="M10.4784 5.2392C10.4784 8.12279 8.12279 10.4784 5.2392 10.4784C2.35561 10.4784 0 8.12279 0 5.2392C0 2.35561 2.35561 0 5.2392 0H10.4784V5.2392Z"
        fill="#E01E5A"
      />
      <path
        d="M13.1157 5.2392C13.1157 2.35561 15.4713 0 18.3549 0C21.2385 0 23.5941 2.35561 23.5941 5.2392V18.3575C23.5941 21.2411 21.2385 23.5967 18.3549 23.5967C15.4713 23.5967 13.1157 21.2411 13.1157 18.3575V5.2392Z"
        fill="#E01E5A"
      />
    </g>
    <g transform="translate(26.28 26.28)">
      <path
        d="M5.23927 13.1157C8.12286 13.1157 10.4785 15.4713 10.4785 18.3549C10.4785 21.2385 8.12286 23.5941 5.23927 23.5941C2.35568 23.5941 7.4362e-05 21.2385 7.4362e-05 18.3549V13.1157H5.23927Z"
        fill="#ECB22E"
      />
      <path
        d="M5.23927 10.4784C2.35568 10.4784 7.4362e-05 8.12279 7.4362e-05 5.2392C7.4362e-05 2.35561 2.35568 0 5.23927 0H18.3576C21.2412 0 23.5968 2.35561 23.5968 5.2392C23.5968 8.12279 21.2412 10.4784 18.3576 10.4784H5.23927Z"
        fill="#ECB22E"
      />
    </g>
  </svg>
);

const ClickUpLogo = () => {
  const id = useSvgId();
  return (
    <svg viewBox="0 0 49.7096 59.6884" fill="none" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M0 45.9002L9.1618 38.8247C14.0602 45.1745 19.2307 48.1679 24.9455 48.1679C30.6603 48.1679 35.7401 45.2652 40.3663 38.9154L49.7096 45.8094C42.997 54.8805 34.6516 59.6882 24.9455 59.6882C15.3301 59.6882 6.89403 54.8805 0 45.9002Z"
        fill={`url(#${id}-0)`}
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M24.9535 15.3301L8.62558 29.3903L1.09657 20.5914L25.0442 0L48.8105 20.5914L41.1908 29.2996L24.9535 15.3301Z"
        fill={`url(#${id}-1)`}
      />
      <defs>
        <linearGradient id={`${id}-0`} x1="0" y1="49.2666" x2="49.75" y2="49.2666" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8930FD" />
          <stop offset="1" stopColor="#49CCF9" />
        </linearGradient>
        <linearGradient
          id={`${id}-1`}
          x1="1.09231"
          y1="14.6901"
          x2="48.7603"
          y2="14.6901"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FF02F0" />
          <stop offset="1" stopColor="#FFC800" />
        </linearGradient>
      </defs>
    </svg>
  );
};

/** The apps "Connect apps" offers, each with its logo */
const appLogos = [
  { name: "Gmail", Logo: GmailLogo },
  { name: "Slack", Logo: SlackLogo },
  { name: "ClickUp", Logo: ClickUpLogo },
];

/* ---------- Styles ---------- */

export const css = /* css */ `
/* Assistant start screen – layout taken 1 : 1 from the reference, styled with affectUI tokens */

.ui-as-start {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: min(672px, calc(100% - 48px));
  /* Fills the main area, so heading, composer and suggestions sit in its exact vertical middle */
  min-height: 100%;
  margin: 0 auto;
  padding: 64px 0;
}

.ui-as-start__title {
  margin: 0;
  font-size: 28px;
  line-height: 34px;
  font-weight: 500;
  letter-spacing: -0.025em;
  color: var(--ink);
  text-align: center;
  text-wrap: balance;
}

.ui-as-start__composer { width: 100%; margin-top: 30px; }
.ui-as-start__composer > .ui-ccc { max-width: none; }
.ui-as-start__title, .ui-as-chips { transition: opacity 180ms ease, transform 180ms ease; }
.ui-as-start[data-phase="leaving"] .ui-as-start__title { opacity: 0; transform: translateY(-8px); }
.ui-as-start[data-phase="leaving"] .ui-as-chips { opacity: 0; transform: translateY(8px); }

/* Chat: the thread fills the area and scrolls, the composer waits at the bottom */
/* Only the thread scrolls – the composer stays put at the bottom */
.ui-as-start[data-phase="chat"] { width: 100%; height: 100%; min-height: 0; padding: 0; justify-content: flex-end; overflow: hidden; }
.ui-as-start__thread { flex: 1; width: 100%; min-height: 0; overflow-y: auto; padding: 64px 32px 24px; }
.ui-as-start__column { display: flex; flex-direction: column; gap: 22px; max-width: 672px; margin: 0 auto; }
.ui-as-start[data-phase="chat"] .ui-as-start__composer { flex: none; width: min(672px, calc(100% - 64px)); margin: 0 0 24px; }

/* Suggestions */
.ui-as-start { container: ui-start / inline-size; }
.ui-as-chips { display: grid; gap: 7px; margin-top: 18px; }
.ui-as-chips__row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
/* Too narrow for the rows as written: the chips go into even columns – three per row, then two – and the ones that
   would hang alone in a last row stay out */
@container ui-start (max-width: 650px) {
  .ui-as-chips { grid-template-columns: repeat(3, auto); justify-content: center; justify-items: center; gap: 7px 8px; }
  .ui-as-chips__row { display: contents; }
  .ui-as-chip[data-n="6"] { display: none; }
}
@container ui-start (max-width: 460px) {
  .ui-as-chips { grid-template-columns: repeat(2, auto); }
  .ui-as-chip:is([data-n="4"], [data-n="5"]) { display: none; }
}
.ui-as-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  height: 32px;
  padding: 0 12px 0 11px;
  border-radius: 16px;
  /* No fill and no outline – a soft tint only on hover */
  font-size: 12px;
  color: var(--text);
  transition: background-color 140ms ease, color 140ms ease;
}
.ui-as-chip svg { flex: none; color: var(--text); }
.ui-as-chip span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-as-chip:hover { background: var(--hover); color: var(--ink); }

/* Narrow: a little less room around the column; on a phone the composer runs almost edge to edge */
@container ui-as (max-width: 600px) {
  .ui-as-start { width: calc(100% - 24px); padding: 56px 0 40px; }
  .ui-as-start__title { font-size: 23px; line-height: 29px; }
  .ui-as-start__composer { margin-top: 22px; }
  .ui-as-chips { margin-top: 14px; }
  .ui-as-chips__row { gap: 6px; }
  .ui-as-start__thread { padding: 56px 16px 16px; }
  .ui-as-start[data-phase="chat"] .ui-as-start__composer { width: calc(100% - 16px); margin-bottom: 8px; }
}
`;

export const composerCss = /* css */ `
/* Composer: white card in the gray tray, folder and apps in the tray below */
.ui-as-composer {
  width: 100%;
  padding: 4px;
  border-radius: 18px;
  background: var(--tray);
}
.ui-as-composer__card {
  padding: 14px 10px 8px 14px;
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--card-shadow);
}
.ui-as-composer__field {
  display: block;
  width: 100%;
  min-height: 20px;
  margin: 0;
  padding: 0;
  border: 0;
  resize: none;
  background: transparent;
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  color: var(--ink);
}
.ui-as-composer__field::placeholder { color: var(--placeholder); }
.ui-as-composer__bar {
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 19px 0 0 -6px;
}
.ui-as-composer__end { display: flex; align-items: center; gap: 4px; min-width: 0; margin-left: auto; }
.ui-as-composer__bar > :not(.ui-as-composer__end), .ui-as-composer__end > :not(.ui-as-anchor) { flex: none; }
/* A long model name gets cut, the mic and send buttons keep their place */
.ui-as-composer__end > .ui-as-anchor { min-width: 0; }
.ui-as-ghost--model { min-width: 0; max-width: 100%; }
.ui-as-ghost--model svg { flex: none; }
.ui-as-ghost--model span { min-width: 0; max-width: 180px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-as-ghost[data-active] { color: var(--ink); }
.ui-as-ghost[data-active] svg { color: var(--accent); }
.ui-as-ghost--model > svg:last-child { margin-left: -2px; color: var(--faint); }
.ui-as-composer .ui-as-menu, .ui-as-composer__tray .ui-as-menu { min-width: 248px; }
.ui-as-composer__tray .ui-as-anchor { display: flex; }
/* Dictation: the mic turns red and pulses while it listens */
.ui-as-mic[aria-pressed="true"] { background: rgba(220, 38, 38, 0.1); color: #dc2626; animation: ui-as-listen 1s ease-in-out infinite; }
@keyframes ui-as-listen { 50% { box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.12); } }
.ui-as-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin: -4px 0 10px; }
.ui-as-attachment { max-width: 100%; min-width: 0; }
.ui-as-attachment > svg, .ui-as-attachment button { flex: none; }
.ui-as-attachment__name { display: flex; min-width: 0; white-space: pre; }
.ui-as-attachment__name span { overflow: hidden; text-overflow: ellipsis; }
.ui-as-attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 4px 0 9px;
  border-radius: 8px;
  background: var(--chip);
  font-size: 12.5px;
  color: var(--ink);
  animation: ui-as-pop 240ms var(--ease);
}
.ui-as-attachment > svg { color: var(--muted); }
.ui-as-attachment button { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; color: var(--muted); }
.ui-as-attachment button:hover { background: var(--hover); color: var(--ink); }
.ui-as-ghost {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--text);
  transition: background-color 140ms ease;
}
.ui-as-ghost svg { color: var(--muted); }
.ui-as-ghost:hover { background: var(--hover); }
.ui-as-ghost--model { font-weight: 500; color: var(--ink); }
.ui-as-send {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  margin-left: 2px;
  border-radius: 50%;
  background: var(--ink);
  color: var(--on-ink);
  transition: background-color 160ms ease, transform 160ms var(--ease);
}
.ui-as-send:disabled { background: var(--disabled); cursor: default; }
.ui-as-send:not(:disabled):active { transform: scale(0.94); }

.ui-as-composer__tray {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 37px;
  padding: 0 8px 0 6px;
}
.ui-as-tray-link {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 9px 0 7px;
  border-radius: 999px;
  /* Like the composer's own controls: regular weight in a quiet gray */
  font-size: 12px;
  color: var(--muted);
}
.ui-as-tray-link:hover { background: var(--hover); color: var(--ink); }
.ui-as-composer__tray { gap: 8px; }
.ui-as-composer__tray > .ui-as-anchor:first-child { min-width: 0; }
.ui-as-tray-link { min-width: 0; max-width: 100%; }
.ui-as-tray-link > span:not([class]) { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-as-tray-link__folder { flex: none; width: 16px; height: 16px; }
.ui-as-tray-link--apps { flex: none; gap: 10px; }
.ui-as-composer__tray > .ui-as-anchor:last-child { flex: none; margin-left: auto; }
.ui-as-apps { display: flex; align-items: center; gap: 6px; }
.ui-as-apps svg { width: 13px; height: 13px; }
/* Touch: the tray's links at a finger's height (the tray keeps its own) */
@media (pointer: coarse) {
  .ui-as-tray-link { height: 32px; }
}
`;
