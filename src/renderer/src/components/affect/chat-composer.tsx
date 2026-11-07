// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

/*
 * Chat Composer (Clean) – a single self-contained file.
 * One white card with hairline shadows: the message on top, the tools in a row below it,
 * and a quiet last row on a gray layer: "Work in a folder" on the left, "Connect apps" on the right.
 * The plus, the approval, the model, the folder and the apps button each open a menu next to them.
 * Icons are inline SVGs and the styles are injected below, so no extra files are needed.
 */

/** An app under "Connect apps" – its brand mark shows in the row and in the menu */
export type ChatApp = {
  id: string;
  name: string;
  Logo: ComponentType;
};

export type ChatModel = {
  id: string;
  name: string;
  /** A line under the name in the picker – leave it out for names alone */
  description?: string;
  Logo?: ComponentType;
};

type Menu = "add" | "approval" | "model" | "folder" | "apps";

/** How the agent's actions get approved: ask first, approve the safe ones by itself, or never ask */
export type ApprovalMode = "ask" | "auto" | "full";

/** A permission mode of your own, for the approval menu */
export type ComposerMode = { id: string; label: string; description: string; icon: ReactNode; tone?: "alert"; shortcut?: string };

/** Effort, switches and more models in the model menu, the way a coding agent offers them */
export type ComposerModelMenu = {
  /** A line on top of the menu, e.g. the agent and its account */
  head?: ReactNode;
  /** Effort levels; the first one is the default and is left off the button */
  efforts?: { id: string; label: string }[];
  effort?: string;
  effortLabel?: string;
  /** A line under the effort levels */
  effortHint?: ReactNode;
  /** Switches under the models; with indicator, "· label" shows on the button while on */
  toggles?: { id: string; label: string; description?: string; icon?: ReactNode; on?: boolean; disabled?: boolean; indicator?: boolean }[];
  /** Models behind a "More models" row, with a search field */
  more?: ChatModel[];
  /** Number keys on the first four models */
  keys?: boolean;
};

/** A section of your own for the plus menu */
export type ComposerAddSection = { title?: string; rows: { id: string; label: string; description?: string; icon: ReactNode; shortcut?: string; disabled?: boolean }[] };

/** Words the composer says to screen readers and in titles – pass your own to translate them */
export type ComposerLabels = {
  composer: string;
  add: string;
  addMenu: string;
  approvalMenu: string;
  /** Announced when a mode or model is picked */
  selected: (label: string) => string;
};

const defaultLabels: ComposerLabels = {
  composer: "Message composer",
  add: "Add",
  addMenu: "Add to the chat",
  approvalMenu: "How should actions be approved?",
  selected: (label) => `${label} selected.`,
};

export type ChatComposerProps = {
  placeholder?: string;
  /** Models in the picker; the first one is selected by default */
  models?: ChatModel[];
  /** Demo transcript that appears word by word while recording – replace with live speech-to-text */
  dictation?: string;
  onSend?: (message: string, details: { model: string }) => void;
  onModelChange?: (model: ChatModel) => void;
  /** An entry of the plus menu was picked: "files", "claude", "folder", "goal", "plan", "skill", "draw", "documents" or "pdf" */
  onAttach?: (item: string) => void;
  /** The approval mode to start with */
  approval?: string;
  onApprovalChange?: (mode: string) => void;
  /** Your own approval modes in place of the three built-in ones */
  approvalModes?: ComposerMode[];
  /** Your own line on top of the approval menu */
  approvalHead?: ReactNode;
  /** Width of the approval menu – default 468, room for long descriptions */
  approvalWidth?: number;
  /** Your own plus menu */
  addSections?: ComposerAddSection[];
  /** Your own model control in place of the built-in model button */
  modelSlot?: ReactNode;
  /** Controls of your own before the model, e.g. a context meter */
  extra?: ReactNode;
  /** Effort, switches and more models in the built-in model menu */
  modelMenu?: ComposerModelMenu;
  /** Leave out the voice input button */
  voice?: boolean;
  /** A turn is running: the send button becomes Stop while the message is empty */
  running?: boolean;
  onStop?: () => void;
  /** Text already in the message field */
  defaultMessage?: string;
  /** "Learn more" in the approval menu */
  onLearnMore?: () => void;
  /** Folders in the "Work in a folder" picker – an empty list leaves the picker out */
  folders?: string[];
  /** The folder to start in */
  folder?: string;
  /** A folder was picked – null when the picked one was picked again to leave it */
  onFolderChange?: (folder: string | null) => void;
  /** Apps in the "Connect apps" menu; the first three show their marks in the row */
  apps?: ChatApp[];
  /** Ids of the apps that are connected to start with */
  connectedApps?: string[];
  /** An app was connected or disconnected – with the ids of all connected apps */
  onAppsChange?: (connected: string[]) => void;
  /** Your own last row on the gray layer, in place of "Work in a folder" and "Connect apps" */
  foot?: ReactNode;
  /** Your own message field in place of the text area, such as a rich editor; it sets its own height */
  field?: ReactNode;
  /** A press on the writing area outside your field: put the caret in it */
  onFieldFocus?: () => void;
  /** Your own send control in place of the built-in send and stop buttons */
  send?: ReactNode;
  /** Controls of your own right after the approval button */
  start?: ReactNode;
  /** Why the plus button can't be used right now; it is disabled while set */
  addDisabled?: string;
  labels?: Partial<ComposerLabels>;
};

export const defaultFolders = ["Q3 Campaign", "Brand assets", "Hiring", "Research"];

export const defaultApps: ChatApp[] = [
  { id: "gmail", name: "Gmail", Logo: () => <GmailLogo /> },
  { id: "slack", name: "Slack", Logo: () => <SlackLogo /> },
  { id: "clickup", name: "ClickUp", Logo: () => <ClickUpLogo /> },
];

export const defaultModels: ChatModel[] = [
  { id: "auto", name: "Auto", Logo: () => <SparklesIcon /> },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", Logo: () => <ClaudeLogo /> },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", Logo: () => <ClaudeLogo /> },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", Logo: () => <ClaudeLogo /> },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", Logo: () => <ClaudeLogo /> },
  { id: "gpt-5", name: "GPT-5", Logo: () => <ChatGPTLogo /> },
  { id: "gpt-5-mini", name: "GPT-5 mini", Logo: () => <ChatGPTLogo /> },
];

/** The approval menu – the button shows the picked mode */
const builtInModes: { id: ApprovalMode; label: string; description: string; Icon: ComponentType; tone?: "alert" }[] = [
  { id: "ask", label: "Request approval", description: "Always ask before editing outside files or using the internet", Icon: () => <HandIcon /> },
  { id: "auto", label: "Approve for me", description: "Only ask for potentially unsafe actions", Icon: () => <AutoIcon /> },
  { id: "full", label: "Full access", description: "Unrestricted access to the internet and all files on your computer", Icon: () => <ShieldIcon />, tone: "alert" },
];

/** The plus menu: things to add to the chat, then plugins */
const builtInAdd: { title: string; rows: { id: string; label: string; description?: string; Icon: ComponentType }[] }[] = [
  {
    title: "Add",
    rows: [
      { id: "files", label: "Files and folders", Icon: () => <PaperclipIcon /> },
      { id: "claude", label: "Attach Claude", Icon: () => <ClaudeLogo /> },
      { id: "folder", label: "Work in a folder", description: "Choose a folder for this chat", Icon: () => <FolderLineIcon /> },
      { id: "goal", label: "Goal", description: "Set a goal to keep working toward", Icon: () => <GoalIcon /> },
      { id: "plan", label: "Plan mode", description: "Turn on plan mode", Icon: () => <BulbIcon /> },
      { id: "skill", label: "Record a skill", Icon: () => <RecordIcon /> },
      { id: "draw", label: "Draw", description: "Sketch a drawing", Icon: () => <DrawIcon /> },
    ],
  },
  {
    title: "Plugins",
    rows: [
      { id: "documents", label: "Documents", description: "Create and edit documents", Icon: () => <DocIcon color="#3e7bfa" /> },
      { id: "pdf", label: "PDF", description: "Read, create and verify PDFs", Icon: () => <DocIcon color="#e5484d" /> },
    ],
  },
];

/** Number of samples in the audio trace next to the recording controls */
const TRACE = 16;
const silentTrace = () => Array.from({ length: TRACE }, () => 0);
/** The message field shows at least this many lines, grows with the text up to the most, then scrolls */
const MIN_LINES = 2;
const MAX_LINES = 4;

export function ChatComposer({
  placeholder = "Start by typing...",
  models = defaultModels,
  dictation = "Draft a short update for the team about this week's progress",
  onSend,
  onModelChange,
  onAttach,
  approval: firstApproval = "ask",
  onApprovalChange,
  approvalModes: ownModes,
  approvalHead,
  approvalWidth = 468,
  addSections: ownAdd,
  modelSlot,
  extra,
  modelMenu,
  voice = true,
  running = false,
  onStop,
  defaultMessage = "",
  onLearnMore,
  folders = defaultFolders,
  folder: firstFolder,
  onFolderChange,
  apps = defaultApps,
  connectedApps = ["gmail"],
  onAppsChange,
  foot,
  field,
  onFieldFocus,
  send: ownSend,
  start,
  addDisabled,
  labels: ownLabels,
}: ChatComposerProps) {
  const labels = { ...defaultLabels, ...ownLabels };
  const approvalModes: ComposerMode[] =
    ownModes ?? builtInModes.map(({ Icon, ...m }) => ({ ...m, icon: <Icon /> }));
  const addSections: ComposerAddSection[] =
    ownAdd ?? builtInAdd.map((section) => ({ title: section.title, rows: section.rows.map(({ Icon, ...r }) => ({ ...r, icon: <Icon /> })) }));
  const [approval, setApproval] = useState<string>(firstApproval);
  const [approvalMorph, setApprovalMorph] = useState(false);
  // A mode set from outside, such as a key that cycles them, shows on the button with the same morph
  const [givenApproval, setGivenApproval] = useState(firstApproval);
  if (givenApproval !== firstApproval) {
    setGivenApproval(firstApproval);
    if (firstApproval !== approval) {
      setApproval(firstApproval);
      setApprovalMorph(true);
    }
  }
  const [plan, setPlan] = useState(false);
  const [message, setMessage] = useState(defaultMessage);
  const [folder, setFolder] = useState<string | null>(firstFolder ?? null);
  const [connected, setConnected] = useState<string[]>(connectedApps);
  // Without models the picker stays out of the way
  const [model, setModel] = useState<ChatModel | undefined>(models[0]);
  const efforts = modelMenu?.efforts ?? [];
  const toggles = modelMenu?.toggles ?? [];
  const more = modelMenu?.more ?? [];
  const [effort, setEffort] = useState(modelMenu?.effort ?? efforts[0]?.id);
  const [toggleOn, setToggleOn] = useState<Record<string, boolean>>(() => Object.fromEntries(toggles.map((t) => [t.id, !!t.on])));
  const [showMore, setShowMore] = useState(false);
  const [moreQuery, setMoreQuery] = useState("");
  const shownMore = more.filter((m) => m.name.toLowerCase().includes(moreQuery.trim().toLowerCase()));
  const allModels = models.concat(more);
  // The button names the model, then the effort when it isn't the default, then each indicator switch that is on
  const modelDetail = [
    ...(effort && effort !== efforts[0]?.id ? [efforts.find((x) => x.id === effort)?.label] : []),
    ...toggles.filter((t) => t.indicator && toggleOn[t.id]).map((t) => `· ${t.label}`),
  ].join(" ");
  // One menu at a time: the plus menu, the approval modes, the models, the folders or the apps
  const [menu, setMenu] = useState<Menu | null>(null);
  const toggleMenu = (which: Menu) => setMenu((open) => (open === which ? null : which));
  // Arrow Down or Up on a menu's button opens it, like Enter and Space
  const openOnArrow = (which: Menu) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    setMenu(which);
  };
  const [recording, setRecording] = useState(false);
  const [heard, setHeard] = useState(""); // gray, not yet confirmed
  const [trace, setTrace] = useState(silentTrace);
  const [status, setStatus] = useState("");

  const body = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const draft = useRef<HTMLDivElement>(null);
  // The message starts with one line and grows with the text; longer text scrolls inside
  const [lines, setLines] = useState(MIN_LINES);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const prev = el.style.height;
    el.style.height = "0px";
    // While recording, the heard words in the draft count too
    const content = Math.max(el.scrollHeight, heard ? (draft.current?.scrollHeight ?? 0) : 0);
    el.style.height = prev;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 1;
    setLines(Math.min(MAX_LINES, Math.max(MIN_LINES, Math.round(content / lineHeight))));
  }, [message, heard]);
  const modelButton = useRef<HTMLButtonElement>(null);
  const approvalButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const folderButton = useRef<HTMLButtonElement>(null);
  const appsButton = useRef<HTMLButtonElement>(null);
  // Model switch morph: the button glides to its new width while logo and name blur in (not on first render)
  const modelWidth = useRef(0);
  const [modelMorph, setModelMorph] = useState(false);

  // Picking the folder you're in leaves it again
  const pickFolder = (name: string) => {
    const next = folder === name ? null : name;
    setFolder(next);
    setMenu(null);
    setStatus(next ? `Working in ${next}.` : "No folder selected.");
    onFolderChange?.(next);
    folderButton.current?.focus();
  };

  // Each app connects or disconnects on its own
  const toggleApp = (id: string) => {
    const on = !connected.includes(id);
    const next = on ? [...connected, id] : connected.filter((x) => x !== id);
    setConnected(next);
    setMenu(null);
    setStatus(`${apps.find((a) => a.id === id)?.name} ${on ? "connected" : "disconnected"}.`);
    onAppsChange?.(next);
    appsButton.current?.focus();
  };

  const pickApproval = (next: string) => {
    if (next !== approval) setApprovalMorph(true);
    setApproval(next);
    setMenu(null);
    setStatus(labels.selected(approvalModes.find((m) => m.id === next)?.label ?? next));
    onApprovalChange?.(next);
    approvalButton.current?.focus();
  };

  const pickAdd = (id: string) => {
    setMenu(null);
    if (id === "plan") {
      setStatus(plan ? "Plan mode off." : "Plan mode on.");
      setPlan(!plan);
    }
    onAttach?.(id);
    // "Work in a folder" opens the folder picker in the last row
    if (id === "folder" && folders.length > 0 && !foot) return setMenu("folder");
    addButton.current?.focus();
  };

  // In the model menu a switch flips and "More models" opens in place; only a model closes the menu
  const pickModelRow = (id: string) => {
    if (id === "__more") return setShowMore(true);
    if (id.startsWith("toggle:")) {
      const t = toggles.find((x) => `toggle:${x.id}` === id);
      if (!t || t.disabled) return;
      setToggleOn((on) => ({ ...on, [t.id]: !on[t.id] }));
      setStatus(`${t.label} ${toggleOn[t.id] ? "off" : "on"}.`);
      return;
    }
    pickModel(allModels.find((m) => m.id === id) ?? model!);
  };

  const pickModel = (next: ChatModel) => {
    if (next.id !== model?.id) setModelMorph(true);
    setModel(next);
    setMenu(null);
    setStatus(labels.selected(next.name));
    onModelChange?.(next);
    modelButton.current?.focus();
  };

  useLayoutEffect(() => {
    const el = modelButton.current;
    if (!el) return;
    // Layout width, not the on-screen one – so a scaled preview doesn't throw it off
    const width = el.offsetWidth;
    const from = modelWidth.current;
    modelWidth.current = width;
    if (!modelMorph || !from || Math.abs(from - width) < 0.5) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ width: `${from}px` }, { width: `${width}px` }], {
      duration: 460,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    });
  }, [model?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- Voice input ---------- */

  // While recording, words arrive one by one and the trace scrolls with the input level
  useEffect(() => {
    if (!recording) return;
    const words = dictation.split(/\s+/).filter(Boolean);
    let count = 0;
    const speak = window.setInterval(() => {
      count = Math.min(words.length, count + 1);
      setHeard(words.slice(0, count).join(" "));
    }, 320);
    const listen = window.setInterval(() => {
      const talking = count < words.length;
      const level = talking && Math.random() > 0.3 ? 0.3 + Math.random() * 0.7 : 0;
      setTrace((t) => [...t.slice(1), level]);
    }, 120);
    return () => {
      clearInterval(speak);
      clearInterval(listen);
    };
  }, [recording, dictation]);

  const startRecording = () => {
    setMenu(null);
    setHeard("");
    setTrace(silentTrace());
    setRecording(true);
    setStatus("Recording. Press Escape to discard.");
  };

  const stopRecording = (keep: boolean) => {
    setRecording(false);
    if (keep && heard) {
      setMessage((current) => (current.trim() ? `${current.trimEnd()} ${heard}` : heard));
      setStatus("Recording added to your message.");
    } else {
      setStatus("Recording discarded.");
    }
    setHeard("");
    textarea.current?.focus();
  };

  /* ---------- Sending ---------- */

  const canSend = message.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    onSend?.(message.trim(), { model: model?.id ?? "" });
    setMessage("");
    setStatus("Message sent.");
    textarea.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const onBodyKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && recording) {
      event.preventDefault();
      stopRecording(false);
    }
  };

  // Clicking anywhere on the writing area puts the caret in the text area
  const focusMessage = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea, input, a, [contenteditable], [data-composer-own]")) return;
    event.preventDefault();
    if (field) onFieldFocus?.();
    else textarea.current?.focus();
  };

  const mode: ComposerMode | undefined = approvalModes.find((m) => m.id === approval) ?? approvalModes[0];
  const closeMenu = (button: RefObject<HTMLButtonElement | null>) => (refocus: boolean) => {
    setMenu(null);
    if (refocus) button.current?.focus();
  };

  return (
    <div className="ui-ccc">
      {/* React 19 hoists this into <head> once, no matter how many composers render */}
      <style href="ui-chat-composer-clean" precedence="default">
        {css}
      </style>

      <section
        ref={body}
        className="ui-ccc__body"
        data-recording={recording}
        style={{ "--ui-ccc-lines": lines } as CSSProperties}
        aria-label={labels.composer}
        onKeyDown={onBodyKeyDown}
      >
        <div className="ui-ccc__write" onPointerDown={focusMessage}>
          <div className="ui-ccc__field" data-own={field ? "" : undefined}>
            {field ?? (<>
            <textarea
              ref={textarea}
              className="ui-ccc__message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              aria-label="Message"
              spellCheck={false}
              readOnly={recording}
              dir="auto"
            />
            {/* While recording, the heard words show up in gray behind the confirmed text */}
            <div ref={draft} className="ui-ccc__draft" aria-hidden="true" dir="auto">
              {message}
              {message && heard && !/\s$/.test(message) ? " " : ""}
              <span className="ui-ccc__heard">{heard}</span>
            </div>
            </>)}
          </div>

          <div className="ui-ccc__tools">
            <div className="ui-ccc__group">
              <button
                ref={addButton}
                type="button"
                className="ui-ccc__icon-btn"
                aria-label={labels.add}
                title={addDisabled}
                disabled={!!addDisabled}
                aria-haspopup="menu"
                aria-expanded={menu === "add"}
                onClick={() => toggleMenu("add")}
                onKeyDown={openOnArrow("add")}
              >
                <PlusIcon />
              </button>
              {mode && (
              <button
                ref={approvalButton}
                type="button"
                className="ui-ccc__approval"
                data-tone={mode.tone}
                aria-haspopup="listbox"
                aria-expanded={menu === "approval"}
                onClick={() => toggleMenu("approval")}
                onKeyDown={openOnArrow("approval")}
              >
                {/* A new key per mode replays the morph-in of icon and label */}
                <span className="ui-ccc__approval-face" key={mode.id} data-morph={approvalMorph || undefined}>
                  <span className="ui-ccc__approval-icon" aria-hidden="true">
                    {mode.icon}
                  </span>
                  <span className="ui-ccc__approval-text">{mode.label}</span>
                </span>
              </button>
              )}
              {start}
            </div>

            <div className="ui-ccc__swap">
              <div className="ui-ccc__group ui-ccc__group--end" inert={recording}>
                {extra}
                {modelSlot}
                {!modelSlot && model && (
                <button
                  ref={modelButton}
                  type="button"
                  className="ui-ccc__model"
                  aria-haspopup="listbox"
                  aria-expanded={menu === "model"}
                  onClick={() => toggleMenu("model")}
                  onKeyDown={openOnArrow("model")}
                >
                  {/* A new key per model replays the morph-in of logo and name */}
                  <span className="ui-ccc__model-face" key={model.id} data-morph={modelMorph || undefined}>
                    {model.Logo && model.id !== "auto" && (
                      <span className="ui-ccc__model-logo" aria-hidden="true">
                        <model.Logo />
                      </span>
                    )}
                    {/* A long model name shortens – the full name is in the tooltip and the menu */}
                    <span className="ui-ccc__model-name" title={model.name} dir="auto">
                      {model.name}
                    </span>
                    {modelDetail && <span className="ui-ccc__model-detail">{modelDetail}</span>}
                  </span>
                  <span className="ui-ccc__chevron" aria-hidden="true">
                    <ChevronIcon />
                  </span>
                </button>
                )}
                {voice && (
                  <button type="button" className="ui-ccc__icon-btn" aria-label="Voice input" onClick={startRecording}>
                    <MicIcon />
                  </button>
                )}
                {ownSend ?? (running && !canSend ? (
                  <button type="button" className="ui-ccc__send" data-stop="" aria-label="Stop" title="Stop  Esc" onClick={onStop}>
                    <StopIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ui-ccc__send"
                    aria-label={running ? "Queue message" : "Send message"}
                    title={running ? "Queue it · ⌘↵ sends it into this turn" : undefined}
                    disabled={!canSend}
                    onClick={send}
                  >
                    <ArrowUpIcon />
                  </button>
                ))}
              </div>

              <div className="ui-ccc__group ui-ccc__group--end ui-ccc__group--voice" inert={!recording}>
                <span className="ui-ccc__trace" aria-hidden="true">
                  {trace.map((level, i) => (
                    <span key={i} style={{ height: Math.max(2, level * 16) }} />
                  ))}
                </span>
                <button type="button" className="ui-ccc__button" aria-label="Discard recording" onClick={() => stopRecording(false)}>
                  <CancelIcon />
                </button>
                <button type="button" className="ui-ccc__send" aria-label="Use recording" onClick={() => stopRecording(true)}>
                  <TickIcon />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* The last row on the gray layer: your own, or the folder to work in on the left and the apps on the right */}
        {foot ? (
          <div className="ui-ccc__foot" data-custom="">
            {foot}
          </div>
        ) : (
          <div className="ui-ccc__foot">
            {folders.length > 0 && (
              <button
                ref={folderButton}
                type="button"
                className="ui-ccc__row ui-ccc__row--folder"
                aria-haspopup="listbox"
                aria-expanded={menu === "folder"}
                onClick={() => toggleMenu("folder")}
                onKeyDown={openOnArrow("folder")}
              >
                <span className="ui-ccc__folder" aria-hidden="true">
                  <FolderIcon />
                </span>
                {/* A long folder name shortens first – the full name is in the tooltip and the menu */}
                <span className="ui-ccc__row-label" title={folder ?? undefined} dir="auto">
                  {folder ?? "Work in a folder"}
                </span>
              </button>
            )}
            {apps.length > 0 && (
              <button
                ref={appsButton}
                type="button"
                className="ui-ccc__row ui-ccc__row--apps"
                aria-haspopup="menu"
                aria-expanded={menu === "apps"}
                onClick={() => toggleMenu("apps")}
                onKeyDown={openOnArrow("apps")}
              >
                Connect apps
                <span className="ui-ccc__logos" aria-hidden="true">
                  {apps.slice(0, 3).map((app) => (
                    <span key={app.id} className="ui-ccc__logo">
                      <app.Logo />
                    </span>
                  ))}
                </span>
              </button>
            )}
          </div>
        )}

        <PopMenu
          open={menu === "add"}
          role="menu"
          label={labels.addMenu}
          inline
          wide
          divided={!!ownAdd}
          sections={addSections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({
              id: row.id,
              label: row.label,
              description: row.id === "plan" && plan ? "Turn off plan mode" : row.description,
              icon: row.icon,
              shortcut: row.shortcut,
              checked: row.id === "plan" && !ownAdd ? plan : undefined,
              disabled: row.disabled,
            })),
          }))}
          anchor={addButton}
          container={body}
          onPick={pickAdd}
          onClose={closeMenu(addButton)}
        />
        {mode && (
        <PopMenu
          open={menu === "approval"}
          label={labels.approvalMenu}
          head={
            approvalHead ?? (
              <>
                <span>How should actions be approved?</span>
                <button type="button" className="ui-ccc__menu-link" onClick={onLearnMore}>
                  Learn more
                </button>
              </>
            )
          }
          width={approvalWidth}
          align="start"
          sections={[{ rows: approvalModes.map((m) => ({ id: m.id, label: m.label, description: m.description, icon: m.icon, tone: m.tone, shortcut: m.shortcut, checked: m.id === approval })) }]}
          anchor={approvalButton}
          container={body}
          onPick={(id) => pickApproval(id)}
          onClose={closeMenu(approvalButton)}
        />
        )}
        {!modelSlot && model && !modelMenu && (
          <PopMenu
            open={menu === "model"}
            label="Select a model"
            sections={[{ rows: models.map((m) => ({ id: m.id, label: m.name, description: m.description, icon: m.Logo && <m.Logo />, checked: m.id === model.id })) }]}
            anchor={modelButton}
            container={body}
            onPick={(id) => pickModel(models.find((m) => m.id === id) ?? model)}
            onClose={closeMenu(modelButton)}
          />
        )}
        {!modelSlot && model && modelMenu && (
          <PopMenu
            open={menu === "model"}
            role="menu"
            label="Model, effort and switches"
            divided
            head={modelMenu.head}
            width={320}
            sections={[
              {
                rows: models.map((m, i) => ({
                  id: m.id,
                  label: m.name,
                  description: m.description,
                  icon: m.Logo && <m.Logo />,
                  checked: m.id === model.id,
                  shortcut: modelMenu.keys && i < 4 ? String(i + 1) : undefined,
                })),
              },
              ...(more.length
                ? [
                    showMore
                      ? {
                          title: "More models",
                          block: (
                            <input
                              className="ui-ccc__menu-search"
                              placeholder="Search models"
                              aria-label="Search models"
                              value={moreQuery}
                              autoFocus
                              onChange={(e) => setMoreQuery(e.target.value)}
                            />
                          ),
                          rows: shownMore.map((m) => ({ id: m.id, label: m.name, description: m.description, icon: m.Logo && <m.Logo />, checked: m.id === model.id })),
                        }
                      : { rows: [{ id: "__more", label: "More models", icon: <SparklesIcon />, shortcut: String(more.length) }] },
                  ]
                : []),
              ...(efforts.length
                ? [
                    {
                      title: modelMenu.effortLabel ?? "Effort",
                      rows: [],
                      block: (
                        <div className="ui-ccc__seg" role="radiogroup" aria-label={modelMenu.effortLabel ?? "Effort"}>
                          {efforts.map((x) => (
                            <button key={x.id} type="button" role="radio" aria-checked={x.id === effort} onClick={() => setEffort(x.id)}>
                              {x.label}
                            </button>
                          ))}
                        </div>
                      ),
                      foot: modelMenu.effortHint,
                    },
                  ]
                : []),
              ...(toggles.length
                ? [
                    {
                      rows: toggles.map((t) => ({
                        id: `toggle:${t.id}`,
                        label: t.label,
                        description: t.description,
                        icon: t.icon,
                        toggle: true,
                        checked: !!toggleOn[t.id],
                        disabled: t.disabled,
                      })),
                    },
                  ]
                : []),
            ]}
            anchor={modelButton}
            container={body}
            onPick={pickModelRow}
            onClose={closeMenu(modelButton)}
          />
        )}
        {!foot && folders.length > 0 && (
          <PopMenu
            open={menu === "folder"}
            label="Work in a folder"
            align="start"
            sections={[{ title: "Work in a folder", rows: folders.map((name) => ({ id: name, label: name, icon: <FolderLineIcon />, checked: name === folder })) }]}
            anchor={folderButton}
            container={body}
            onPick={pickFolder}
            onClose={closeMenu(folderButton)}
          />
        )}
        {!foot && apps.length > 0 && (
          <PopMenu
            open={menu === "apps"}
            role="menu"
            label="Apps"
            sections={[{ title: "Apps", rows: apps.map((app) => ({ id: app.id, label: app.name, icon: <app.Logo />, checked: connected.includes(app.id) })) }]}
            anchor={appsButton}
            container={body}
            onPick={toggleApp}
            onClose={closeMenu(appsButton)}
          />
        )}
      </section>
      <p className="ui-ccc__sr-only" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

/** The rectangle the menu has to stay in: the nearest ancestor that clips, otherwise the viewport */
function clippingFrame(from: HTMLElement) {
  for (let el = from.parentElement; el && el !== document.body; el = el.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(el);
    if (overflowX !== "visible" || overflowY !== "visible") {
      // …and never past the edge of the window
      const r = el.getBoundingClientRect();
      return { top: Math.max(r.top, 0), left: Math.max(r.left, 0), right: Math.min(r.right, window.innerWidth), bottom: Math.min(r.bottom, window.innerHeight) };
    }
  }
  return { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/* ---------- Menus: open upward, or downward when there is no room above ---------- */

type MenuRow = { id: string; label: string; description?: string; icon?: ReactNode; tone?: "alert"; checked?: boolean; shortcut?: string; toggle?: boolean; disabled?: boolean };
type MenuSection = { title?: string; rows: MenuRow[]; block?: ReactNode; foot?: ReactNode };

function PopMenu({
  open,
  role = "listbox",
  label,
  head,
  sections,
  anchor,
  container,
  align = "end",
  width = 260,
  wide = false,
  inline = false,
  divided = false,
  onPick,
  onClose,
}: {
  /** A hairline between the sections */
  divided?: boolean;
  open: boolean;
  /** A listbox picks one row (with a check); a menu runs actions */
  role?: "listbox" | "menu";
  label: string;
  /** A line on top, e.g. a question and a link */
  head?: ReactNode;
  sections: MenuSection[];
  anchor: RefObject<HTMLButtonElement | null>;
  container: RefObject<HTMLElement | null>;
  /** Which edge of the button the menu lines up with */
  align?: "start" | "end";
  width?: number;
  /** As wide as the composer, above it */
  wide?: boolean;
  /** Descriptions next to the names instead of under them */
  inline?: boolean;
  onPick: (id: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const flat = sections.flatMap((section) => section.rows);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState({ top: 0, left: 0, width, up: true, fromTop: 0, fromLeft: 0, fromRadius: 0 });
  const [fill, setFill] = useState({ y: 0, h: 0, glide: false });
  // The fill only shows while the pointer is over a row (or the keyboard moves through the list)
  const [shown, setShown] = useState(false);
  const wasShown = useRef(false);

  // The menu opens in two steps: first the closed shape moves to the button, then it morphs open.
  // In one step the very first opening had no start shape and just appeared.
  const [visible, setVisible] = useState(false);
  const [placing, setPlacing] = useState(false);
  // More rows below the visible ones: the list fades out at its lower edge
  const [more, setMore] = useState(false);
  const checkMore = () => {
    const el = panel.current;
    if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
  };
  // Closed and done animating, the menu leaves the layout – so it never makes the page around it scroll
  const [parked, setParked] = useState(true);

  // Place the menu next to its button, always inside the visible frame (the nearest clipping ancestor, or the viewport), and focus it
  useLayoutEffect(() => {
    if (!open) {
      setVisible(false);
      const park = window.setTimeout(() => setParked(true), 320);
      return () => clearTimeout(park);
    }
    if (parked) {
      setParked(false);
      return;
    }
    if (!anchor.current || !container.current || !panel.current) return;
    const button = anchor.current.getBoundingClientRect();
    const box = container.current.getBoundingClientRect();
    const frame = clippingFrame(container.current);
    // Inside a scaled preview (a CSS transform) the measured pixels are scaled too – work in those, then scale back
    const scale = box.width / (container.current.offsetWidth || box.width) || 1;
    // Never wider than the visible frame
    const layoutWidth = Math.min(wide ? container.current.offsetWidth : width, (frame.right - frame.left) / scale - 16);
    panel.current.style.width = `${layoutWidth}px`;
    panel.current.style.maxHeight = "";
    const menuWidth = layoutWidth * scale;
    const natural = panel.current.offsetHeight * scale;
    const gap = 8 * scale;
    // Above the composer the plus menu ends a small gap above it, like Codex's
    const tuck = wide ? -6 * scale : 0;
    const inset = 8 * scale;
    // A wide menu sits right above the whole composer, the others next to their button
    const edge = wide ? box : button;

    const roomAbove = edge.top + tuck - (frame.top + inset);
    const roomBelow = frame.bottom - inset - (edge.bottom + gap);
    // The plus menu stays above the composer while a few rows fit there; the others take the side with more room
    const up = wide ? roomAbove >= Math.min(natural, 160 * scale) || roomAbove >= roomBelow : roomAbove >= natural || roomAbove >= roomBelow;
    // Too long for its side: it ends before the frame's edge and scrolls inside
    const height = Math.min(natural, Math.max(0, up ? roomAbove : roomBelow));
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
    const top = clamp(up ? edge.top + tuck - height : edge.bottom + gap, frame.top + inset, frame.bottom - inset - height);
    const left = clamp(wide ? box.left : align === "start" ? button.left : button.right - menuWidth, frame.left + inset, frame.right - inset - menuWidth);

    // The morph starts as a button-sized piece in the corner closest to the button
    const fromLeft = clamp(button.left - left, 0, menuWidth - 1) / scale;
    const fromTop = (up ? clamp(height - button.height, 0, height - 1) : 0) / scale;
    panel.current.style.maxHeight = `${height / scale}px`;
    setPlace({ top: (top - box.top) / scale, left: (left - box.left) / scale, width: layoutWidth, up, fromTop, fromLeft, fromRadius: 6 });
    setActive(Math.max(0, flat.findIndex((row) => row.checked)));
    setShown(false);
    setPlacing(true);
  }, [open, parked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the closed shape sits at the button, apply it, then open – so the browser has a start shape to morph from
  useLayoutEffect(() => {
    if (!open || visible || !panel.current) return;
    void getComputedStyle(panel.current).clipPath;
    setPlacing(false);
    setVisible(true);
  }, [place]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (visible) {
      panel.current?.focus({ preventScroll: true });
      // Opened from the keyboard: the active row shows right away, so it's clear where the arrows start
      if (panel.current?.matches(":focus-visible")) setShown(true);
    }
    checkMore();
  }, [visible]);

  // One fill glides between rows; when it first appears it fades in on the spot
  useLayoutEffect(() => {
    const row = rows.current[active];
    if (row) setFill({ y: row.offsetTop, h: row.offsetHeight, glide: wasShown.current && shown });
    // A long list scrolls – keep the active row in view while the keyboard moves
    const list = panel.current;
    if (row && list && open) {
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 4;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 4;
    }
    wasShown.current = shown;
  }, [active, open, shown]);

  // Click outside closes
  useEffect(() => {
    if (!open) return;
    const away = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onClose, anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A link in the head (e.g. Learn more) is the menu's one other stop: Tab reaches it from the list, Shift+Tab goes back
    const onList = event.target === panel.current;
    const link = panel.current?.querySelector<HTMLElement>(".ui-ccc__menu-head :is(a, button)");
    if (event.key === "Tab" && link && onList !== event.shiftKey) {
      event.preventDefault();
      (onList ? link : panel.current)?.focus({ preventScroll: true });
      return;
    }
    // On the link only Tab and Escape belong to the menu – Enter and Space press the link itself
    if (!onList && event.key !== "Tab" && event.key !== "Escape") return;
    const last = flat.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last,
    };
    // A row's own key picks it, as its shortcut column shows
    const keyed = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey ? flat.find((row) => row.shortcut === event.key && !row.disabled) : undefined;
    if (keyed) {
      event.preventDefault();
      onPick(keyed.id);
    } else if (event.key in moves) {
      event.preventDefault();
      setActive(moves[event.key]);
      setShown(true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!flat[active]?.disabled) onPick(flat[active].id);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "Tab") {
      // Leaves from the menu's button, so Tab goes on to the control after it (Shift+Tab to the one before)
      anchor.current?.focus({ preventScroll: true });
      onClose(false);
    }
  };

  let index = -1;
  return (
    <div
      className="ui-ccc__menu"
      data-open={visible}
      data-placing={placing}
      data-up={place.up}
      data-inline={inline || undefined}
      data-above={(wide && place.up) || undefined}
      data-divided={divided || undefined}
      style={
        {
          display: parked ? "none" : undefined,
          top: place.top,
          left: place.left,
          width: place.width,
          "--from-top": `${place.fromTop}px`,
          "--from-left": `${place.fromLeft}px`,
          "--from-bottom": place.up ? "0px" : `calc(100% - ${place.fromRadius * 2}px)`,
          "--from-radius": `${place.fromRadius}px`,
        } as CSSProperties
      }
      inert={!visible}
    >
      <div
        ref={panel}
        className="ui-ccc__menu-panel"
        role={role}
        tabIndex={-1}
        aria-label={label}
        aria-activedescendant={`${id}-${active}`}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setShown(false)}
        onScroll={checkMore}
        data-more={more || undefined}
      >
        <span
          className="ui-ccc__menu-fill"
          aria-hidden="true"
          data-glide={fill.glide}
          style={{ transform: `translateY(${fill.y}px)`, height: fill.h, opacity: shown ? 1 : 0 }}
        />
        {head && <div className="ui-ccc__menu-head">{head}</div>}
        {sections.map((section, si) => (
          <div key={si} className="ui-ccc__menu-section" role="group" aria-label={section.title}>
            {section.title && (
              <div className="ui-ccc__menu-title" aria-hidden="true">
                {section.title}
              </div>
            )}
            {section.block}
            {section.rows.map((row) => {
              const i = ++index;
              return (
                <div
                  key={row.id}
                  ref={(el) => {
                    rows.current[i] = el;
                  }}
                  id={`${id}-${i}`}
                  role={role === "listbox" ? "option" : row.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-selected={role === "listbox" ? !!row.checked : undefined}
                  aria-checked={role === "menu" && row.checked !== undefined ? row.checked : undefined}
                  aria-disabled={row.disabled || undefined}
                  data-checked={(!row.toggle && row.checked) || undefined}
                  data-toggle={row.toggle || undefined}
                  data-tone={row.tone}
                  className="ui-ccc__option"
                  onPointerEnter={() => {
                    setActive(i);
                    setShown(true);
                  }}
                  onClick={() => !row.disabled && onPick(row.id)}
                >
                  <span className="ui-ccc__option-logo" aria-hidden="true">
                    {row.icon}
                  </span>
                  <span className="ui-ccc__option-text">
                    <span className="ui-ccc__option-name" title={row.label} dir="auto">
                      {row.label}
                    </span>
                    {row.description && (
                      <span className="ui-ccc__option-desc" dir="auto">
                        {row.description}
                      </span>
                    )}
                  </span>
                  {row.shortcut && <kbd className="ui-ccc__option-key">{row.shortcut}</kbd>}
                  {row.toggle ? (
                    <span className="ui-ccc__switch" data-on={row.checked || undefined} aria-hidden="true" />
                  ) : (
                    <span className="ui-ccc__option-check" aria-hidden="true">
                      <TickIcon />
                    </span>
                  )}
                </div>
              );
            })}
            {section.foot && <div className="ui-ccc__menu-foot">{section.foot}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Icons: 16px, thin lines and solid shapes ---------- */

const StopIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" />
  </svg>
);

const PlusIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.5c.28 0 .5.22.5.5v4.5H13a.5.5 0 0 1 0 1H8.5V13a.5.5 0 0 1-1 0V8.5H3a.5.5 0 0 1 0-1h4.5V3c0-.28.22-.5.5-.5Z" />
  </svg>
);

const AutoIcon = () => (
  <svg viewBox="0 0 24 24" {...line} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.5L10.8 14.8L15.5 9.8" />
  </svg>
);

const PaperclipIcon = () => (
  <svg viewBox="0 0 24 24" {...line} aria-hidden="true">
    <path d="M19.5 12.5L12.6 19.4C10.6 21.4 7.4 21.4 5.4 19.4C3.4 17.4 3.4 14.2 5.4 12.2L12.8 4.8C14.1 3.5 16.2 3.5 17.6 4.8C18.9 6.2 18.9 8.3 17.6 9.6L10.4 16.8C9.7 17.5 8.6 17.5 7.9 16.8C7.2 16.1 7.2 15 7.9 14.3L14.5 7.7" />
  </svg>
);

const FolderLineIcon = () => (
  <svg viewBox="0 0 24 24" {...line} aria-hidden="true">
    <path d="M3 7.5C3 6.1 4.1 5 5.5 5H9.2C9.9 5 10.5 5.3 11 5.8L12.2 7H18.5C19.9 7 21 8.1 21 9.5V16.5C21 17.9 19.9 19 18.5 19H5.5C4.1 19 3 17.9 3 16.5V7.5Z" />
    <path d="M3 10H21" />
  </svg>
);

const GoalIcon = () => (
  <svg viewBox="0 0 24 24" {...line} aria-hidden="true">
    <path d="M21 12A9 9 0 1 1 12 3" />
    <path d="M17 12A5 5 0 1 1 12 7" />
    <path d="M12 12L19 5M16 4.5V8H19.5" />
  </svg>
);

const BulbIcon = () => (
  <svg viewBox="0 0 24 24" {...line} aria-hidden="true">
    <path d="M9 18H15M10 21H14M12 3C8.7 3 6 5.6 6 8.9C6 11.1 7.2 12.6 8.4 13.8C9 14.4 9.4 15.2 9.4 16V16.5H14.6V16C14.6 15.2 15 14.4 15.6 13.8C16.8 12.6 18 11.1 18 8.9C18 5.6 15.3 3 12 3Z" />
  </svg>
);

const RecordIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="12" cy="12" r="4.6" fill="currentColor" />
  </svg>
);

const DrawIcon = () => (
  <svg viewBox="0 0 24 24" {...line} stroke="#14b8a6" aria-hidden="true">
    <path d="M4 15C6 10 8.5 6 10 6.5C12 7.2 6 15 8 16C10 17 13.5 9 15.5 10C17.3 10.9 13 16 14.8 16.8C16 17.3 18 15 20 13" />
    <path d="M4 20H12" />
  </svg>
);

const DocIcon = ({ color }: { color: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 2.5H14L19.5 8V19.5C19.5 20.6 18.6 21.5 17.5 21.5H6.5C5.4 21.5 4.5 20.6 4.5 19.5V4.5C4.5 3.4 5.4 2.5 6.5 2.5Z" fill={color} />
    <path d="M14 2.5V6.5C14 7.3 14.7 8 15.5 8H19.5" fill="#fff" fillOpacity="0.45" />
    <path d="M8 13H16M8 16.5H13.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const HandIcon = () => (
  <svg viewBox="0 0 68.155 68.155" fill="none" aria-hidden="true">
    <path
      d="M52.5305 32.6557V24.8463C52.5305 22.1016 54.7555 19.8766 57.5001 19.8766C60.2448 19.8766 62.4698 22.1016 62.4698 24.8463V42.027C62.4698 53.3194 53.3154 62.4735 42.0233 62.4735H34.2388M22.7127 39.7552L15.94 31.8537C14.8314 30.5602 13.2129 29.8159 11.5094 29.8159H11.1235C8.11379 29.8159 5.67395 32.2558 5.67395 35.2655C5.67395 36.3412 5.99241 37.393 6.58919 38.2881L16.4118 53.0221C20.3482 58.9269 26.9753 62.4735 34.0719 62.4735"
      stroke="currentColor"
      strokeWidth="4.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M52.534 24.1378V16.3284C52.534 13.5837 50.3091 11.3588 47.5644 11.3588C44.8197 11.3588 42.5948 13.5837 42.5948 16.3284V29.8174"
      stroke="currentColor"
      strokeWidth="4.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M42.5958 29.8198V10.6513C42.5958 7.90661 40.3708 5.68163 37.6262 5.68163C34.8815 5.68163 32.6565 7.90661 32.6565 10.6513V28.4"
      stroke="currentColor"
      strokeWidth="4.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M32.6576 28.3975V16.3284C32.6576 13.5837 30.4326 11.3588 27.6879 11.3588C24.9433 11.3588 22.7183 13.5837 22.7183 16.3284V39.7567"
      stroke="currentColor"
      strokeWidth="4.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ShieldIcon = () => (
  <svg viewBox="0 0 66.543 66.543" fill="none" aria-hidden="true">
    <path
      d="M33.2482 22.1795V33.27"
      stroke="currentColor"
      strokeWidth="4.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M33.5966 43.67H33.2501M33.9432 43.67C33.9432 44.0529 33.633 44.3631 33.2501 44.3631C32.8672 44.3631 32.5569 44.0529 32.5569 43.67C32.5569 43.2871 32.8672 42.9768 33.2501 42.9768C33.633 42.9768 33.9432 43.2871 33.9432 43.67Z"
      stroke="currentColor"
      strokeWidth="4.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M58.202 31.0087V22.9595C58.202 18.4124 58.202 16.1389 57.0816 14.6555C55.9612 13.1722 53.4278 12.452 48.3612 11.0118C44.8995 10.0278 41.848 8.84228 39.41 7.76002C36.0859 6.28445 34.4237 5.54666 33.2484 5.54666C32.0728 5.54666 30.4109 6.28445 27.0868 7.76002C24.6487 8.84228 21.5973 10.0278 18.1357 11.0118C13.069 12.452 10.5356 13.1722 9.4152 14.6555C8.29475 16.1389 8.29475 18.4124 8.29475 22.9595V31.0087C8.29475 46.605 22.3319 55.9626 29.3498 59.6666C31.0331 60.5549 31.8748 60.9991 33.2484 60.9991C34.622 60.9991 35.4635 60.5549 37.1467 59.6666C44.1648 55.9626 58.202 46.605 58.202 31.0087Z"
      stroke="currentColor"
      strokeWidth="4.6"
      strokeLinecap="round"
    />
  </svg>
);

const MicIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M7 6.5C7 4.01472 9.01472 2 11.5 2C13.9853 2 16 4.01472 16 6.5V11.5C16 13.9853 13.9853 16 11.5 16C9.01472 16 7 13.9853 7 11.5V6.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M11.5 19H11.0828C7.57267 19 4.57706 16.4623 4 13M11.5 19H11.9172C15.4273 19 18.4229 16.4623 19 13M11.5 19V22"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ArrowUpIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 5.5V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path
      d="M18 11C18 11 13.5811 5.00001 12 5C10.4188 4.99999 6 11 6 11"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/* A folder in two blues – its tab on top, the open front below – for "Work in a folder" */
const FolderIcon = () => (
  <svg viewBox="0 0 67 67" fill="none" aria-hidden="true">
    <path d="M11.17 15.35v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98Z" fill="#00A1FF" />
    <path d="M33.5 16.75l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5Zm0 0h-9.77" stroke="#00A1FF" strokeWidth="4.19" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M6.59 42.38c-1.05-5.26-1.57-7.89-.08-9.67l.31-.34c1.66-1.66 4.59-1.66 10.45-1.66h32.46c5.86 0 8.79 0 10.45 1.66l.31.34c1.49 1.78.97 4.41-.08 9.67-1.51 7.56-2.26 11.34-5.1 13.66l-.6.46c-3.01 2.13-7.23 2.13-15.66 2.13h-11.1c-8.43 0-12.64 0-15.66-2.13l-.6-.46c-2.84-2.32-3.6-6.1-5.1-13.66Z" fill="#3CC7FF" stroke="#3CC7FF" strokeWidth="4.19" />
  </svg>
);

/** Unique ids for gradients, so several composers on one page don't clash */
const useSvgId = () => "ui-ccc" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

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

/* Line icons that follow the text color */
const line = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SparklesIcon = () => (
  <svg viewBox="0 0 24 24" {...line} aria-hidden="true">
    <path d="M15 2L15.5387 4.39157C15.9957 6.42015 17.5798 8.00431 19.6084 8.46127L22 9L19.6084 9.53873C17.5798 9.99569 15.9957 11.5798 15.5387 13.6084L15 16L14.4613 13.6084C14.0043 11.5798 12.4202 9.99569 10.3916 9.53873L8 9L10.3916 8.46127C12.4201 8.00431 14.0043 6.42015 14.4613 4.39158L15 2Z" />
    <path d="M7 12L7.38481 13.7083C7.71121 15.1572 8.84275 16.2888 10.2917 16.6152L12 17L10.2917 17.3848C8.84275 17.7112 7.71121 18.8427 7.38481 20.2917L7 22L6.61519 20.2917C6.28879 18.8427 5.15725 17.7112 3.70827 17.3848L2 17L3.70827 16.6152C5.15725 16.2888 6.28879 15.1573 6.61519 13.7083L7 12Z" />
  </svg>
);

const TickIcon = () => (
  <svg viewBox="0 0 24 24" {...line} strokeWidth={2} aria-hidden="true">
    <path d="M5 14L8.5 17.5L19 6.5" />
  </svg>
);

const CancelIcon = () => (
  <svg viewBox="0 0 24 24" {...line} aria-hidden="true">
    <path d="M18 6L6.00081 17.9992M17.9992 18L6 6.00085" />
  </svg>
);

/* Model logos */
const ClaudeLogo = () => (
  <svg viewBox="0 0 1200 1200" aria-hidden="true">
    <path
      fill="#D97757"
      d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"
    />
  </svg>
);

const ChatGPTLogo = () => (
  <svg viewBox="0 0 68.614 68.002" aria-hidden="true">
    <path
      fill="currentColor"
      d="M26.3166 24.7525V18.2923C26.3166 17.7482 26.5208 17.3401 26.9966 17.0684L39.9853 9.5882C41.7533 8.56821 43.8615 8.09244 46.0372 8.09244C54.1973 8.09244 59.3658 14.4167 59.3658 21.1486C59.3658 21.6245 59.3658 22.1686 59.2976 22.7127L45.8331 14.8243C45.0172 14.3486 44.2009 14.3486 43.385 14.8243L26.3166 24.7525ZM56.6454 49.9134V34.4766C56.6454 33.5244 56.2371 32.8444 55.4213 32.3685L38.3529 22.4403L43.9291 19.244C44.405 18.9723 44.8131 18.9723 45.289 19.244L58.2776 26.7242C62.018 28.9005 64.5338 33.5244 64.5338 38.0122C64.5338 43.1802 61.4739 47.9406 56.6454 49.9128V49.9134ZM22.3045 36.3131L16.7284 33.0492C16.2526 32.7775 16.0484 32.3692 16.0484 31.8251V16.8649C16.0484 9.58891 21.6245 4.08038 29.1729 4.08038C32.0293 4.08038 34.6809 5.03262 36.9255 6.7326L23.5292 14.485C22.7134 14.9608 22.3052 15.6408 22.3052 16.5932V36.3137L22.3045 36.3131ZM34.307 43.2491L26.3166 38.7611V29.2412L34.307 24.7532L42.2968 29.2412V38.7611L34.307 43.2491ZM39.4411 63.9219C36.5848 63.9219 33.9333 62.9697 31.6886 61.2699L45.0848 53.5173C45.9007 53.0415 46.3089 52.3615 46.3089 51.4091V31.6886L51.9533 34.9525C52.4291 35.2242 52.6333 35.6324 52.6333 36.1766V51.1369C52.6333 58.4128 46.9889 63.9214 39.4411 63.9214V63.9219ZM23.3245 48.7576L10.3358 41.2775C6.59541 39.1011 4.07967 34.4773 4.07967 29.9894C4.07967 24.7532 7.2078 20.0612 12.0356 18.0889V33.5933C12.0356 34.5455 12.4439 35.2255 13.2597 35.7014L30.2605 45.5613L24.6844 48.7576C24.2086 49.0293 23.8003 49.0293 23.3245 48.7576ZM22.5769 59.9099C14.8926 59.9099 9.24834 54.1297 9.24834 46.9895C9.24834 46.4454 9.31651 45.9013 9.38411 45.3572L22.7804 53.1097C23.5962 53.5856 24.4127 53.5856 25.2284 53.1097L42.2968 43.2498V49.71C42.2968 50.2541 42.0927 50.6622 41.6168 50.9339L28.6283 58.4141C26.8601 59.4341 24.752 59.9099 22.5762 59.9099H22.5769ZM39.4411 68.0017C47.6694 68.0017 54.5372 62.1538 56.1019 54.4013C63.718 52.4291 68.6141 45.2889 68.6141 38.0129C68.6141 33.2526 66.5743 28.6288 62.9021 25.2966C63.2421 23.8685 63.4462 22.4403 63.4462 21.0129C63.4462 11.2887 55.5578 4.01207 46.4454 4.01207C44.6098 4.01207 42.8416 4.28375 41.0735 4.89614C38.0129 1.90392 33.7968 0 29.1729 0C20.9447 0 14.0769 5.84782 12.5122 13.6003C4.89614 15.5725 0 22.7127 0 29.9887C0 34.749 2.03983 39.3728 5.71204 42.705C5.37205 44.1331 5.16797 45.5613 5.16797 46.9889C5.16797 56.713 13.0563 63.9895 22.1686 63.9895C24.0044 63.9895 25.7725 63.7179 27.5407 63.1055C30.6005 66.0977 34.8166 68.0017 39.4411 68.0017Z"
    />
  </svg>
);

/* ---------- Styles ---------- */

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-ccc */
.ui-ccc {
  --ui-ccc-card: #ffffff;
  --ui-ccc-strong: #000000;
  --ui-ccc-ink: rgba(0, 0, 0, 0.88);
  --ui-ccc-text: rgba(0, 0, 0, 0.61);
  --ui-ccc-muted: rgba(0, 0, 0, 0.45);
  --ui-ccc-faint: rgba(0, 0, 0, 0.27);
  /* The placeholder: lighter than the controls, darker than faint lines */
  --ui-ccc-hint: rgba(0, 0, 0, 0.36);
  --ui-ccc-icon: rgba(0, 0, 0, 0.447);
  --ui-ccc-line: rgba(0, 0, 0, 0.06);
  --ui-ccc-fill: rgba(0, 0, 0, 0.06);
  --ui-ccc-wash: rgba(0, 0, 0, 0.03);
  /* The last row's gray layer under the white writing area */
  --ui-ccc-tray: #f5f5f5;
  --ui-ccc-tray-hover: rgba(0, 0, 0, 0.04);
  --ui-ccc-solid: rgba(0, 0, 0, 0.88);
  --ui-ccc-on-solid: #fcfcfc;
  --ui-ccc-accent: rgba(0, 96, 226, 0.765);
  --ui-ccc-alert: #e5484d;
  --ui-ccc-alert-wash: rgba(229, 72, 77, 0.08);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-ccc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-ccc-shadow-pop: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 12px 28px -10px rgba(0, 0, 0, 0.16), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-ccc-focus: rgba(0, 96, 226, 0.35);
  --ui-ccc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ui-ccc-ease-pop: cubic-bezier(0.34, 1.5, 0.64, 1);
  position: relative;
  container-type: inline-size;
  width: 100%;
  max-width: 560px;
}

.ui-ccc__body {
  position: relative;
  border-radius: 16px;
  background: var(--ui-ccc-tray);
  box-shadow: var(--ui-ccc-shadow);
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-ccc-text);
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
.ui-ccc__body *, .ui-ccc__body *::before, .ui-ccc__body *::after { box-sizing: border-box; }
:where(.ui-ccc__body) button {
  appearance: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.ui-ccc__body svg { display: block; flex: none; max-width: none; }
.ui-ccc__body button:focus-visible { outline: 2px solid var(--ui-ccc-focus); outline-offset: 1px; }

/* ---------- Writing area ---------- */
/* The white writing area on the gray layer, rounded all round */
.ui-ccc__write { position: relative; z-index: 2; padding: 14px 10px 10px; border-radius: 16px; background: var(--ui-ccc-card); box-shadow: 0 0 0 0.5px var(--ui-ccc-line), 0 1px 2px 0 rgba(0, 0, 0, 0.04); cursor: text; }
.ui-ccc__field { position: relative; padding: 0 4px; }
.ui-ccc__message,
.ui-ccc__draft {
  display: block;
  width: 100%;
  height: calc(var(--ui-ccc-lines, 2) * 20px);
  margin: 0;
  padding: 0;
  border: 0;
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  color: var(--ui-ccc-strong);
  white-space: pre-wrap;
  overflow-wrap: break-word;
  text-align: start;
}
.ui-ccc__message {
  outline: 0;
  background: transparent;
  resize: none;
  overflow-y: auto;
  scrollbar-width: none;
  caret-color: var(--ui-ccc-accent);
  transition: height 260ms var(--ui-ccc-ease);
}
.ui-ccc__message::-webkit-scrollbar { display: none; }
.ui-ccc__message::placeholder { color: var(--ui-ccc-hint); opacity: 1; }
.ui-ccc__message:focus-visible { outline: none; }
.ui-ccc__draft { position: absolute; inset: 0 4px; width: auto; overflow: hidden; pointer-events: none; visibility: hidden; }
.ui-ccc__icon-btn:disabled { opacity: 0.45; cursor: default; }
.ui-ccc__icon-btn:disabled:hover { background: none; color: var(--ui-ccc-icon); }
.ui-ccc__heard { color: var(--ui-ccc-faint); }
.ui-ccc__body[data-recording="true"] .ui-ccc__draft { visibility: visible; }
.ui-ccc__body[data-recording="true"] .ui-ccc__message { color: transparent; caret-color: transparent; }
.ui-ccc__body[data-recording="true"] .ui-ccc__message::placeholder { color: transparent; }

/* ---------- Tools under the message ---------- */
.ui-ccc__tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; }
.ui-ccc__group { display: flex; align-items: center; gap: 4px; min-width: 0; }
.ui-ccc__swap { display: grid; justify-items: end; min-width: 0; }
.ui-ccc__swap > * { grid-area: 1 / 1; max-width: 100%; }

/* Ghost icon buttons: 28px, icon in the gray of the reference */
.ui-ccc__icon-btn {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  color: var(--ui-ccc-icon);
  transition: background-color 160ms ease, color 160ms ease, transform 160ms var(--ui-ccc-ease);
}
.ui-ccc__icon-btn svg { width: 16px; height: 16px; }
.ui-ccc__icon-btn svg:not([fill="none"]) { fill: currentColor; }
.ui-ccc__icon-btn:hover { background: var(--ui-ccc-wash); color: var(--ui-ccc-ink); }
.ui-ccc__icon-btn:active { transform: scale(0.94); }

/* Approval: a quiet button with the picked mode – it opens the approval menu */
.ui-ccc__approval {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  height: 28px;
  padding: 0 10px 0 8px;
  overflow: clip;
  border-radius: 999px;
  font-weight: 400;
  white-space: nowrap;
  color: var(--ui-ccc-muted);
  transition: background-color 200ms ease, color 160ms ease, transform 160ms var(--ui-ccc-ease);
}
.ui-ccc__approval:hover,
.ui-ccc__approval[aria-expanded="true"] { background: var(--ui-ccc-wash); color: var(--ui-ccc-ink); }
.ui-ccc__approval:active { transform: scale(0.97); }
.ui-ccc__approval-face { display: inline-flex; align-items: center; gap: 6px; }
.ui-ccc__approval-face[data-morph] { animation: ui-ccc-model-in 460ms cubic-bezier(0.25, 1, 0.5, 1) both; }
.ui-ccc__approval-face[data-morph] .ui-ccc__approval-icon { animation: ui-ccc-logo-in 520ms cubic-bezier(0.25, 1, 0.5, 1) both; }
.ui-ccc__approval-icon { display: grid; flex: none; place-items: center; width: 16px; height: 16px; color: var(--ui-ccc-icon); }
.ui-ccc__approval-icon svg { width: 100%; height: 100%; }
/* Full access warns in red */
.ui-ccc__approval[data-tone="alert"],
.ui-ccc__approval[data-tone="alert"] .ui-ccc__approval-icon { color: var(--ui-ccc-alert); }
.ui-ccc__approval[data-tone="alert"]:is(:hover, [aria-expanded="true"]) { background: var(--ui-ccc-alert-wash); }
.ui-ccc__icon-btn[aria-expanded="true"] { background: var(--ui-ccc-wash); color: var(--ui-ccc-ink); }

/* Model: a quiet button – logo, name and a small chevron */
.ui-ccc__model {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  min-width: 0;
  max-width: 100%;
  padding: 0 6px 0 8px;
  overflow: clip;
  border-radius: 999px;
  font-weight: 400;
  white-space: nowrap;
  color: var(--ui-ccc-ink);
  transition: background-color 160ms ease, color 160ms ease, transform 160ms var(--ui-ccc-ease);
}
.ui-ccc__model:hover,
.ui-ccc__model[aria-expanded="true"] { background: var(--ui-ccc-wash); color: var(--ui-ccc-ink); }
.ui-ccc__model:active { transform: scale(0.97); }
.ui-ccc__model-face { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.ui-ccc__model-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.ui-ccc__model-face[data-morph] { animation: ui-ccc-model-in 460ms cubic-bezier(0.25, 1, 0.5, 1) both; }
.ui-ccc__model-face[data-morph] .ui-ccc__model-logo { animation: ui-ccc-logo-in 520ms cubic-bezier(0.25, 1, 0.5, 1) both; }
.ui-ccc__model-logo { display: grid; flex: none; place-items: center; width: 14px; height: 14px; color: var(--ui-ccc-strong); }
.ui-ccc__model-logo svg, .ui-ccc__option-logo svg { width: 100%; height: 100%; }
.ui-ccc__chevron { display: grid; flex: none; place-items: center; width: 16px; height: 16px; color: var(--ui-ccc-icon); }
.ui-ccc__chevron svg { width: 14px; height: 14px; transition: transform 220ms var(--ui-ccc-ease); }
.ui-ccc__model[aria-expanded="true"] .ui-ccc__chevron svg { transform: rotate(180deg); }

/* Send: the dark chip of the reference; empty, it falls back to a gray tile */
.ui-ccc__send {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin-left: 2px;
  border-radius: 999px;
  background: var(--ui-ccc-solid) !important;
  color: var(--ui-ccc-on-solid);
  transition: background-color 200ms ease, color 200ms ease, transform 160ms var(--ui-ccc-ease);
}
.ui-ccc__send svg { width: 16px; height: 16px; }
.ui-ccc__send:disabled { background: var(--ui-ccc-fill) !important; color: var(--ui-ccc-faint); cursor: default; }
.ui-ccc__send:not(:disabled):active { transform: scale(0.94); }

/* Recording: the trace, discard and keep take the place of the right group */
.ui-ccc__group--end { transition: opacity 220ms ease-out, transform 320ms var(--ui-ccc-ease); }
.ui-ccc__group--voice { gap: 6px; opacity: 0; transform: translateY(6px); pointer-events: none; }
.ui-ccc__body[data-recording="true"] .ui-ccc__group--end:not(.ui-ccc__group--voice) { opacity: 0; transform: translateY(-6px); pointer-events: none; }
.ui-ccc__body[data-recording="true"] .ui-ccc__group--voice { opacity: 1; transform: none; pointer-events: auto; }
.ui-ccc__trace { display: flex; align-items: center; gap: 3px; height: 20px; margin-right: 6px; }
.ui-ccc__trace > span { flex: none; width: 2px; border-radius: 1px; background: var(--ui-ccc-accent); transition: height 110ms ease-out; }
/* Discard: the white button with the hairline shadow */
.ui-ccc__button {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--ui-ccc-card) !important;
  box-shadow: var(--ui-ccc-shadow);
  color: var(--ui-ccc-ink);
  transition: background-color 160ms ease, transform 160ms var(--ui-ccc-ease);
}
.ui-ccc__button:hover { background: #fafafa !important; }
.ui-ccc__button:active { transform: scale(0.94); }
.ui-ccc__button svg { width: 16px; height: 16px; }

/* ---------- Last row: a folder to work in on the left, apps on the right – on a gray layer under the writing area ---------- */
.ui-ccc__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 36px;
  padding: 0 6px;
}
/* Your own last row: it lays itself out */
.ui-ccc__foot[data-custom] { display: block; height: auto; padding: 0; }
.ui-ccc__row {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  height: 26px;
  padding: 0 8px 0 7px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  color: var(--ui-ccc-muted);
  transition: background-color 160ms ease, color 160ms ease, transform 160ms var(--ui-ccc-ease);
}
.ui-ccc__row:hover,
.ui-ccc__row[aria-expanded="true"] { background: var(--ui-ccc-tray-hover); color: var(--ui-ccc-ink); }
.ui-ccc__row:active { transform: scale(0.97); }
/* Narrow: the folder's name shortens first, the apps keep their size */
.ui-ccc__row--folder { flex: 0 1 auto; }
.ui-ccc__row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-ccc__row--apps { flex: none; gap: 10px; margin-left: auto; }
.ui-ccc__logos { display: flex; align-items: center; gap: 6px; }
.ui-ccc__logo { display: grid; place-items: center; width: 13px; height: 13px; }
.ui-ccc__logo svg { width: 13px; height: 13px; }
.ui-ccc__folder { flex: none; width: 16px; height: 16px; }
.ui-ccc__folder svg { width: 100%; height: 100%; }
/* The logos and the folder sit a quarter pixel higher, so their middle meets the middle of the capitals */
.ui-ccc__row > :is(.ui-ccc__logos, .ui-ccc__folder) { translate: 0 -0.25px; }

/* ---------- Menus: grow out of the corner next to their button ---------- */
.ui-ccc__menu {
  --morph: 380ms cubic-bezier(0.32, 0.72, 0, 1);
  position: absolute;
  z-index: 5;
  width: 260px;
  transition: visibility 0s linear 0s;
}
.ui-ccc__menu[data-open="false"] { visibility: hidden; pointer-events: none; transition: visibility 0s linear 300ms; }
.ui-ccc__menu-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-radius: 10px;
  background: var(--ui-ccc-card);
  box-shadow: var(--ui-ccc-shadow-pop);
  outline: none;
  clip-path: inset(-40px -40px -40px -40px round 10px);
  transition: clip-path var(--morph);
  /* A long list scrolls inside the panel */
  max-height: 340px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.ui-ccc__menu[data-placing="true"] .ui-ccc__menu-panel { transition: none !important; }
.ui-ccc__menu[data-open="false"] .ui-ccc__menu-panel {
  clip-path: inset(var(--from-top) 0 var(--from-bottom) var(--from-left) round var(--from-radius));
  transition: clip-path 260ms cubic-bezier(0.4, 0, 0.2, 1);
}
.ui-ccc__menu-panel > * { transition: opacity 220ms ease-out 100ms, transform 360ms var(--ui-ccc-ease) 60ms; }
.ui-ccc__menu[data-open="false"] .ui-ccc__menu-panel > * { opacity: 0; transition: opacity 120ms ease-in; }
.ui-ccc__menu[data-open="false"] .ui-ccc__option { transform: translateY(4px); }
.ui-ccc__menu[data-open="false"][data-up="false"] .ui-ccc__option { transform: translateY(-4px); }
.ui-ccc__menu-panel:focus-visible { outline: none; }
/* The plus menu above the composer: as round as it, the composer's own hairline instead of a lifted shadow,
   and the list fades out toward its lower edge */
.ui-ccc__menu[data-above] .ui-ccc__menu-panel { border-radius: 16px; box-shadow: var(--ui-ccc-shadow); }
.ui-ccc__menu[data-above]:not([data-open="false"]) .ui-ccc__menu-panel { clip-path: inset(-2px round 16px); }
.ui-ccc__menu[data-above] .ui-ccc__menu-panel[data-more]::after {
  content: "";
  position: sticky;
  bottom: -4px;
  flex: none;
  height: 28px;
  margin: -28px -4px -4px;
  background: linear-gradient(to bottom, color-mix(in srgb, var(--ui-ccc-card) 0%, transparent), var(--ui-ccc-card) 90%);
  pointer-events: none;
}
.ui-ccc__menu-fill {
  position: absolute;
  left: 4px;
  right: 4px;
  top: 0;
  border-radius: 6px;
  background: var(--ui-ccc-fill);
  pointer-events: none;
  transition: transform 190ms cubic-bezier(0.25, 1, 0.3, 1), height 190ms cubic-bezier(0.25, 1, 0.3, 1), opacity 160ms ease-out;
}
.ui-ccc__menu-fill[data-glide="false"] { transition: opacity 160ms ease-out; }
.ui-ccc__option { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.ui-ccc__option-logo { display: grid; place-items: center; flex: none; width: 16px; height: 16px; margin-top: 2px; color: var(--ui-ccc-icon); }
.ui-ccc__option-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
/* Names in the body text: 13px regular in the ink gray – the picked one in medium and full black */
.ui-ccc__option-name { overflow: hidden; text-align: start; font-size: 13px; font-weight: 400; line-height: 20px; white-space: nowrap; text-overflow: ellipsis; color: var(--ui-ccc-ink); }
.ui-ccc__option[aria-selected="true"] .ui-ccc__option-name { color: var(--ui-ccc-strong); }
.ui-ccc__option-desc { text-align: start; font-size: 12px; line-height: 16px; color: var(--ui-ccc-hint); }
.ui-ccc__model-detail { flex: none; font-weight: 400; color: var(--ui-ccc-muted); }
.ui-ccc__option[aria-disabled="true"] { opacity: 0.45; cursor: default; }
.ui-ccc__switch { position: relative; flex: none; width: 26px; height: 16px; margin-top: 2px; border-radius: 5px; background: var(--ui-ccc-fill); box-shadow: inset 0 0 0 0.5px var(--ui-ccc-line); transition: background-color 220ms ease; }
.ui-ccc__switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 3.5px; background: #fff; box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.16); transition: transform 280ms var(--ui-ccc-ease); }
.ui-ccc__switch[data-on] { background: var(--ui-ccc-accent); }
.ui-ccc__switch[data-on]::after { transform: translateX(10px); }
.ui-ccc__seg { display: flex; gap: 2px; margin: 4px 8px 2px; padding: 2px; border-radius: 8px; background: var(--ui-ccc-fill); }
.ui-ccc__seg button { flex: 1; height: 24px; border-radius: 6px; font-size: 12px; font-weight: 500; text-align: center !important; color: var(--ui-ccc-text); transition: background-color 160ms ease, color 160ms ease; }
.ui-ccc__seg button:hover { color: var(--ui-ccc-ink); }
.ui-ccc__seg button[aria-checked="true"] { background: var(--ui-ccc-card); box-shadow: var(--ui-ccc-shadow); color: var(--ui-ccc-ink); }
.ui-ccc__menu-foot { padding: 4px 8px 6px; font-size: 12px; line-height: 16px; color: var(--ui-ccc-hint); }
.ui-ccc__menu-search { display: block; width: calc(100% - 8px); height: 30px; margin: 2px 4px 4px; padding: 0 8px; border: 0; border-radius: 6px; outline: 0; background: var(--ui-ccc-wash); box-shadow: inset 0 0 0 0.5px var(--ui-ccc-line); font: inherit; font-size: 13px; color: var(--ui-ccc-ink); }
.ui-ccc__menu-search::placeholder { color: var(--ui-ccc-faint); }
.ui-ccc__menu[data-divided] .ui-ccc__menu-panel { max-height: 560px; }
.ui-ccc__menu[data-divided] .ui-ccc__menu-section + .ui-ccc__menu-section { border-top: 0.5px solid var(--ui-ccc-line); padding-top: 4px; }
.ui-ccc__option-key { flex: none; min-width: 16px; margin-top: 2px; font: inherit; font-size: 11px; line-height: 16px; text-align: center; color: var(--ui-ccc-faint); }
.ui-ccc__option-check { flex: none; width: 16px; height: 16px; margin-top: 2px; color: var(--ui-ccc-ink); opacity: 0; transform: scale(0.6); transition: opacity 160ms ease-out, transform 260ms var(--ui-ccc-ease-pop); }
.ui-ccc__option-check svg { width: 100%; height: 100%; }
.ui-ccc__option[data-checked] .ui-ccc__option-check { opacity: 1; transform: none; }
/* Full access: only its icon and name in red, the line under it stays gray */
.ui-ccc__option[data-tone="alert"] :is(.ui-ccc__option-logo, .ui-ccc__option-name) { color: var(--ui-ccc-alert); }
/* The plus menu: one line per row, the description beside the name */
.ui-ccc__menu[data-inline] .ui-ccc__option-text { flex-direction: row; align-items: baseline; gap: 8px; }
.ui-ccc__menu[data-inline] .ui-ccc__option-desc { overflow: hidden; font-size: 13px; line-height: 20px; white-space: nowrap; text-overflow: ellipsis; }
/* A question with a link on top, titles over the sections */
.ui-ccc__menu-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 6px 8px 4px; font-size: 12px; line-height: 16px; color: var(--ui-ccc-hint); }
.ui-ccc__menu-link { flex: none; font-size: 12px; color: var(--ui-ccc-muted) !important; transition: color 140ms ease; }
.ui-ccc__menu-link:hover { color: var(--ui-ccc-ink) !important; text-decoration: underline; text-underline-offset: 3px; }
.ui-ccc__menu-section { display: flex; flex-direction: column; }
.ui-ccc__menu-section + .ui-ccc__menu-section { margin-top: 4px; }
.ui-ccc__menu-title { padding: 6px 8px 2px; font-size: 12px; line-height: 16px; color: var(--ui-ccc-muted); }

.ui-ccc__sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@keyframes ui-ccc-model-in { from { opacity: 0; filter: blur(3px); transform: translateY(30%); } }
@keyframes ui-ccc-logo-in { from { opacity: 0; transform: scale(0.6) rotate(-12deg); } }

/* Narrow containers: the approval button keeps just its icon */
@container (max-width: 400px) {
  .ui-ccc__approval { padding: 0; width: 28px; justify-content: center; }
  .ui-ccc__approval-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
}
/* Touch screens: taller hit targets */
@media (pointer: coarse) {
  .ui-ccc__icon-btn, .ui-ccc__send, .ui-ccc__button { width: 34px; height: 34px; }
  .ui-ccc__model, .ui-ccc__approval { height: 34px; }
  .ui-ccc__foot { height: 42px; }
  .ui-ccc__row { height: 32px; }
}
@media (pointer: coarse) {
  @container (max-width: 400px) { .ui-ccc__approval { width: 34px; } }
}
@media (prefers-reduced-motion: reduce) {
  .ui-ccc *, .ui-ccc *::after { animation: none !important; transition-duration: 1ms !important; transition-delay: 0ms !important; }
}

/* Text fields: no focus box while typing – also against global :focus-visible rules of the host page */
.ui-ccc textarea:focus-visible { outline: none; }

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-ccc {
  --ui-ccc-card: #1c1c1e;
  --ui-ccc-strong: #ffffff;
  --ui-ccc-ink: rgba(255, 255, 255, 0.9);
  --ui-ccc-text: rgba(255, 255, 255, 0.62);
  --ui-ccc-muted: rgba(255, 255, 255, 0.46);
  --ui-ccc-faint: rgba(255, 255, 255, 0.3);
  --ui-ccc-hint: rgba(255, 255, 255, 0.36);
  --ui-ccc-icon: rgba(255, 255, 255, 0.5);
  --ui-ccc-line: rgba(255, 255, 255, 0.08);
  --ui-ccc-fill: rgba(255, 255, 255, 0.08);
  --ui-ccc-wash: rgba(255, 255, 255, 0.04);
  --ui-ccc-tray: #161618;
  --ui-ccc-tray-hover: rgba(255, 255, 255, 0.05);
  --ui-ccc-solid: rgba(255, 255, 255, 0.92);
  --ui-ccc-on-solid: #161618;
  --ui-ccc-accent: #4d8dff;
  --ui-ccc-alert: #ff6369;
  --ui-ccc-alert-wash: rgba(229, 72, 77, 0.14);
  --ui-ccc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-ccc-shadow-pop: 0 0 0 0.5px rgba(255, 255, 255, 0.12), 0 12px 28px -10px rgba(0, 0, 0, 0.6);
  --ui-ccc-focus: rgba(77, 141, 255, 0.5);
}
:where(.dark, [data-theme="dark"]) .ui-ccc__button:hover { background: #232326 !important; }
`;
