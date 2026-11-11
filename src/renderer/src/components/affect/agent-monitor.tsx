// affectUI - licensed under https://www.affectui.com/license, not under this project's open-source license.
"use client";

import { isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/*
 * Agent Monitor – one AI agent at work as a small card, in a single self-contained file.
 *   · on top the agent – its mark, name and role – what it has cost so far (with a soft shimmer while it runs) and
 *     its state
 *   · in a gray well its current step and the clock; each new step rolls in from below
 *   · when it wants something from you, the well shows the exact command, with Decline and Allow (Escape and Enter
 *     while the card has the focus); once it's finished, what came of it ("+42 −8 · 6 files")
 *   · a slim time strip – every step as wide as it took – and the finished steps, three rows tall and scrollable,
 *     each with the logo of the tool it used; a finished step drops in at the top. Point at a bar or a row and its
 *     partner lights up, the rest fade; click either and a small info card opens with what the step did
 *   · fold it away and it's a small bar: the agent's mark, the logos of the tools it has used so far (the one in use
 *     lit, each naming its last step on hover), and the clock or its state – click it to open the card
 * The styles are injected below, so no extra files are needed.
 */

export type AgentRunState = "idle" | "running" | "waiting" | "paused" | "finished" | "failed" | "cancelled";

/** What kind of work a step is – gives it its icon when it has no logo of its own */
export type AgentStepKind = "read" | "search" | "edit" | "run" | "think" | "web";

export type AgentRunStep = {
  id: string;
  /** What the step does or did – the text carries its state, so keep it short */
  label: string;
  kind?: AgentStepKind;
  /** The tool's logo (GitHub, Linear, Slack…) or an icon of your own instead of the kind's */
  icon?: ReactNode;
  state: "queued" | "running" | "done" | "failed";
  /** For the running step: when it began (ms) */
  since?: number;
  /** For a finished step: how long it took (ms) */
  took?: number;
  /** For the step's info card: the tool's name, a sentence on what happened, and what it ran or touched */
  tool?: string;
  detail?: string;
  output?: string;
};

export type AgentMonitorProps = {
  /** Where the run is */
  state?: AgentRunState;
  /** The agent: its name, what it's for (or its model) and its mark – a 14px logo */
  agent?: { name: string; role?: string; mark?: ReactNode };
  /** Every step, oldest first – the running one fills the well, queued ones count toward "3/6" */
  steps?: AgentRunStep[];
  /** What the well says while it runs – leave it out to show the running step */
  current?: { label: string; kind?: AgentStepKind; icon?: ReactNode };
  /** When the run began (ms) – the clock counts from here */
  since?: number;
  /** When it ended (ms) – the clock stops here */
  until?: number;
  /** How long it was paused (ms) – left out of the clock, so it never jumps on resume */
  pausedFor?: number;
  /** What the run has cost so far, in USD */
  cost?: number;
  /** While it's waiting on you: what it wants to do, the exact command, the tool's logo */
  ask?: { title: string; command?: string; icon?: ReactNode };
  /** Once it's finished: what came of it */
  outcome?: { added?: number; removed?: number; files?: number; note?: string };
  /** When it failed: what went wrong, in a few words */
  error?: string;
  /** Start folded away, as the small bar */
  defaultFolded?: boolean;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
  onAllow?: () => void;
  onDecline?: () => void;
  onRetry?: () => void;
  onOpenLog?: () => void;
  /** Every word the card and the bar show or read out, for a translation */
  labels?: Partial<AgentMonitorLabels>;
  className?: string;
};

/** Every word the card and the bar show or read out, for a translation */
export type AgentMonitorLabels = {
  agent: string;
  states: Record<AgentRunState, string>;
  kinds: Record<AgentStepKind, string>;
  failed: string;
  waitingOnYou: string;
  finishedIn: (time: string) => string;
  files: (count: number) => string;
  errorFallback: string;
  cancelledAfter: (time: string) => string;
  noTask: string;
  said: (name: string, state: string, detail?: string) => string;
  open: (said: string) => string;
  costSoFar: (cost: string) => string;
  foldAway: string;
  runningFor: (time: string) => string;
  finishedSteps: string;
  details: (step: string) => string;
  close: string;
  started: string;
  took: string;
  share: string;
  state: string;
  running: string;
  done: string;
  decline: string;
  allow: string;
  retry: string;
  pause: string;
  resume: string;
  cancel: string;
  log: string;
};

const LABELS: AgentMonitorLabels = {
  agent: "Agent",
  states: { idle: "Idle", running: "Running", waiting: "Needs you", paused: "Paused", finished: "Finished", failed: "Failed", cancelled: "Cancelled" },
  kinds: { read: "Read", search: "Search", edit: "Edit", run: "Terminal", think: "Thinking", web: "Web" },
  failed: "Failed",
  waitingOnYou: "Waiting on you",
  finishedIn: (time) => `Finished in ${time}`,
  files: (count) => (count === 1 ? "1 file" : `${count} files`),
  errorFallback: "Something went wrong",
  cancelledAfter: (time) => `Cancelled after ${time}`,
  noTask: "No task yet",
  said: (name, state, detail) => `${name}: ${state}${detail ? ` – ${detail}` : ""}`,
  open: (said) => `${said} – open`,
  costSoFar: (cost) => `Cost so far ${cost}`,
  foldAway: "Fold away",
  runningFor: (time) => `Running for ${time}`,
  finishedSteps: "Finished steps",
  details: (step) => `${step} – details`,
  close: "Close",
  started: "Started",
  took: "Took",
  share: "Share",
  state: "State",
  running: "Running",
  done: "Done",
  decline: "Decline",
  allow: "Allow",
  retry: "Try again",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  log: "Log",
};

/* ---------- Small parts ---------- */

const svg = (d: ReactNode, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const KIND_ICON: Record<AgentStepKind, ReactNode> = {
  read: svg(<><path d="M4 1.75h5.25L12 4.5v9.75H4z" /><path d="M9 1.75V4.75h3M6.25 8h3.5M6.25 10.5h3.5" /></>, 12),
  search: svg(<><circle cx="7.25" cy="7.25" r="4.25" /><path d="m10.5 10.5 3.25 3.25" /></>, 12),
  edit: svg(<><path d="M10.75 2.75 13.25 5.25 6 12.5H3.5V10z" /><path d="m9.25 4.25 2.5 2.5" /></>, 12),
  run: svg(<><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" /><path d="m4.75 6.25 2 1.75-2 1.75M8.5 10h2.75" /></>, 12),
  think: svg(<path d="M8 1.75c.4 3.1 1.6 4.4 4.75 4.75-3.15.35-4.35 1.65-4.75 4.75-.4-3.1-1.6-4.4-4.75-4.75C6.4 6.15 7.6 4.85 8 1.75z" />, 12),
  web: svg(<><circle cx="8" cy="8" r="6.25" /><path d="M1.75 8h12.5M8 1.75c1.75 1.9 2.6 4 2.6 6.25S9.75 12.35 8 14.25C6.25 12.35 5.4 10.25 5.4 8S6.25 3.65 8 1.75z" /></>, 12),
};
const Fold = () => svg(<path d="m5 3 3 3 3-3M5 13l3-3 3 3" />, 12);
const PauseIcon = () => svg(<path d="M6 4v8M10 4v8" />, 11);
const PlayIcon = () => svg(<path d="M5.5 3.75v8.5L12 8z" />, 11);
const CancelIcon = () => svg(<path d="m5 5 6 6M11 5l-6 6" />, 11);
const CheckIcon = () => svg(<path d="m3.75 8.25 2.75 2.75 5.75-6" />, 11);
const WarnIcon = () => svg(<><path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.75a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5z" /><path d="M8 6.25v3M8 11.5v.25" /></>, 11);
const LogIcon = () => svg(<path d="M5.5 10.5 10.75 5.25M6 5h4.75v4.75" />, 12);
const RetryIcon = () => svg(<path d="M3.25 8a4.75 4.75 0 1 0 1.4-3.35M3.25 2.75v2.5h2.5" />, 12);

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};
const words = (ms: number) => {
  // Whole seconds the same way the clock counts them, so "Finished in 18s" and 0:18 agree
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const secs = (ms: number) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : words(ms));
const usd = (n: number) => (n > 0 && n < 0.001 ? "<$0.001" : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const num = new Intl.NumberFormat("en-US");

/** Content that changes in place: the old line rolls up and out while the new one rolls in from below */
function Roll({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  const last = useRef({ id, node: children });
  const [out, setOut] = useState<{ id: string; node: ReactNode } | null>(null);
  if (last.current.id !== id && out?.id !== last.current.id) setOut(last.current);
  useLayoutEffect(() => {
    last.current = { id, node: children };
  });
  return (
    <span className={["ui-agmc__roll", className].filter(Boolean).join(" ")}>
      {out && (
        <span key={`out-${out.id}`} className="ui-agmc__roll-layer" data-leaving="" aria-hidden="true" onAnimationEnd={(e) => e.target === e.currentTarget && setOut(null)}>
          {out.node}
        </span>
      )}
      <span key={id} className="ui-agmc__roll-layer" data-coming={out ? "" : undefined}>
        {children}
      </span>
    </span>
  );
}

/** Content that swaps in place and may change width: the old one fades out as the new one fades in, and the room
 *  between them eases to the new width – so nothing around it jumps */
function Morph({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  const last = useRef({ id, node: children });
  const [out, setOut] = useState<{ id: string; node: ReactNode } | null>(null);
  if (last.current.id !== id && out?.id !== last.current.id) setOut(last.current);
  useLayoutEffect(() => {
    last.current = { id, node: children };
  });
  const cur = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const w = cur.current?.offsetWidth;
    if (w != null && w !== width) setWidth(w);
  });
  return (
    <span className={["ui-agmc__morph", className].filter(Boolean).join(" ")} style={{ width }}>
      {out && (
        <span key={`out-${out.id}`} className="ui-agmc__morph-layer" data-leaving="" aria-hidden="true" inert onAnimationEnd={(e) => e.target === e.currentTarget && setOut(null)}>
          {out.node}
        </span>
      )}
      <span ref={cur} key={id} className="ui-agmc__morph-layer" data-coming={out ? "" : undefined}>
        {children}
      </span>
    </span>
  );
}

/* ---------- The component ---------- */

export function AgentMonitor({
  state = "idle",
  agent: agentProp,
  steps = [],
  current,
  since,
  until,
  pausedFor = 0,
  cost,
  ask,
  outcome,
  error,
  defaultFolded = false,
  onPause,
  onResume,
  onCancel,
  onAllow,
  onDecline,
  onRetry,
  onOpenLog,
  labels,
  className,
}: AgentMonitorProps) {
  const L = { ...LABELS, ...labels };
  const agent = agentProp ?? { name: L.agent };
  const LABEL = L.states;
  const KIND_NAME = L.kinds;
  const uid = useId();
  const [folded, setFolded] = useState(defaultFolded);
  const tile = useRef<HTMLButtonElement>(null);
  const fold = useRef<HTMLButtonElement>(null);
  // After folding or opening, the focus moves to the control that does the opposite – it never falls off the page
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (folded ? tile : fold).current?.focus();
  }, [folded]);
  const toggle = (next: boolean) => {
    moveFocus.current = true;
    setFolded(next);
  };

  // A bar and its row belong together: pointing at one lights up both and fades the rest
  const [pointed, setHot] = useState<string | null>(null);
  // A clicked bar or row opens the step's info card, anchored under what was clicked
  const [info, setInfo] = useState<{ id: string; from: "row" | "bar" } | null>(null);
  const hot = pointed ?? info?.id ?? null;
  const card = useRef<HTMLElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const openInfo = (id: string, from: "row" | "bar") => setInfo((o) => (o?.id === id ? null : { id, from }));
  const closeInfo = (refocus: boolean) => {
    const id = info?.id;
    setInfo(null);
    if (refocus && id) card.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"] .ui-agmc__step-hit`)?.focus();
  };
  useEffect(() => {
    if (!info) return;
    pop.current?.querySelector<HTMLElement>(".ui-agmc__info-close")?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!pop.current?.contains(t) && !t.closest?.(".ui-agmc__step, .ui-agmc__strip .ui-agmc__seg")) setInfo(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [info?.id]);
  useLayoutEffect(() => {
    // Under the row – or under the time strip when a bar was clicked
    const box = card.current;
    const el = pop.current;
    if (!info || !box || !el) return;
    const anchor = info.from === "row" ? box.querySelector(`[data-id="${CSS.escape(info.id)}"]`) : box.querySelector(".ui-agmc__strip-wrap");
    if (anchor) el.style.top = `${anchor.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 6}px`;
  });
  const list = useRef<HTMLOListElement>(null);
  // Moving from one row (or bar) to the next fires leave before enter: letting go a beat later means the next enter
  // takes over directly, instead of everything flashing back to full for a frame and fading again
  const letGo = useRef(0);
  useEffect(() => () => window.clearTimeout(letGo.current), []);
  const point = (id: string, reveal = false) => ({
    onPointerEnter: () => {
      window.clearTimeout(letGo.current);
      setHot(id);
      // A bar whose row has scrolled out of the list brings the row back into view
      const box = list.current;
      const row = reveal ? box?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) : null;
      if (box && row && (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)) {
        box.scrollTo({ top: row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2, behavior: "smooth" });
      }
    },
    onPointerLeave: () => {
      window.clearTimeout(letGo.current);
      letGo.current = window.setTimeout(() => setHot((h) => (h === id ? null : h)), 70);
    },
  });
  // More rows than fit: the list scrolls, and fades at the edge that has more
  const [edge, setEdge] = useState({ top: false, bottom: false });
  const measure = () => {
    const box = list.current;
    if (!box) return;
    const next = { top: box.scrollTop > 2, bottom: box.scrollTop + box.clientHeight < box.scrollHeight - 2 };
    setEdge((e) => (e.top === next.top && e.bottom === next.bottom ? e : next));
  };

  // The clock – and the running step's bar – move while the agent works or waits on you; paused, both stand still
  const live = state === "running" || state === "waiting";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(t);
  }, [live]);
  const stoodStill = useRef(now);
  if (live) stoodStill.current = now;
  const still = live ? now : stoodStill.current;
  const at = until ?? still;
  const elapsed = since ? Math.max(0, at - since - pausedFor) : 0;

  // Waiting on you: Enter allows and Escape declines while the card (not one of its buttons) has the focus
  const onKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (state !== "waiting" || e.target !== e.currentTarget) return;
    if (e.key === "Enter" && onAllow) {
      e.preventDefault();
      onAllow();
    } else if (e.key === "Escape" && onDecline) {
      e.preventDefault();
      onDecline();
    }
  };

  const running = steps.find((s) => s.state === "running");
  // Where the run is: every step that has run (a failed one too), and the one running now
  const position = Math.min(steps.length, steps.filter((s) => s.state !== "queued").length);
  const doing = current ?? (running ? { label: running.label, kind: running.kind, icon: running.icon } : undefined);
  const iconOf = (x?: { kind?: AgentStepKind; icon?: ReactNode }) => x?.icon ?? KIND_ICON[x?.kind ?? "think"];
  const tookOf = (s: AgentRunStep) => (s.state === "running" ? (s.since ? Math.max(0, still - s.since) : 0) : (s.took ?? 0));
  const changes = outcome && (outcome.added != null || outcome.removed != null);
  const said = L.said(agent.name, LABEL[state], state === "running" && doing ? doing.label : state === "waiting" && ask ? ask.title : undefined);

  // The time strip and the latest steps: what has run so far
  const ran = steps.filter((s) => s.state !== "queued");
  const ranTotal = ran.reduce((n, s) => n + Math.max(tookOf(s), 1), 0);
  // Newest first: a step that finishes drops out of the well into the top of the list – the fourth slides away under the clip
  const recent = ran.filter((s) => s.state !== "running").reverse();
  const opened = info ? ran.find((x) => x.id === info.id) : undefined;
  // When it started into the run: from its own start time if it has one, otherwise the steps before it added up
  const openedAt = !opened ? 0 : opened.since != null && since != null ? Math.max(0, opened.since - since) : ran.slice(0, ran.indexOf(opened)).reduce((n, x) => n + tookOf(x), 0);
  useEffect(() => {
    if (info && !opened) setInfo(null);
  }, [info, opened]);
  useEffect(measure, [recent.length, folded]);

  // Folded away: the tools it has used so far, each once, in the order it first picked them up – told apart by their logo or their kind
  // Each keeps the latest step it was used for – that is what its hover card tells
  const tools: { id: string; icon: ReactNode; live?: "run" | "ask"; tip: { title: string; sub?: string } }[] = [];
  const seen = new Map<unknown, number>();
  const addTool = (id: string, x: { kind?: AgentStepKind; icon?: ReactNode }, tip: (typeof tools)[number]["tip"], live?: "run" | "ask") => {
    const k = isValidElement(x.icon) ? x.icon.type : (x.icon ?? `kind-${x.kind ?? "think"}`);
    const at = seen.get(k);
    // Used again: it keeps its place (and key), so the bar never shrinks – only what it tells and whether it's lit change
    if (at != null) {
      tools[at] = { ...tools[at], live: live ?? tools[at].live, tip };
      return;
    }
    seen.set(k, tools.length);
    tools.push({ id, icon: iconOf(x), live, tip });
  };
  ran.forEach((x) =>
    addTool(
      x.id,
      x,
      { title: x.label, sub: [x.tool ?? KIND_NAME[x.kind ?? "think"], x.state === "failed" ? L.failed : secs(tookOf(x))].join(" · ") },
      x.state === "running" && state === "running" ? "run" : undefined,
    ),
  );
  if (state === "waiting" && ask?.icon) addTool("ask", { icon: ask.icon }, { title: ask.title, sub: L.waitingOnYou }, "ask");
  const shownTools = tools.slice(-4);
  const strip = (className: string, interactive: boolean) => (
    <span className={className} aria-hidden="true">
      {ran.map((s) => (
        <span
          key={s.id}
          className="ui-agmc__seg"
          data-state={s.state}
          data-hot={interactive && hot === s.id ? "" : undefined}
          style={{ flexGrow: Math.max(tookOf(s), 1) / ranTotal }}
          title={interactive ? `${s.label} · ${secs(tookOf(s))}` : undefined}
          {...(interactive ? { ...point(s.id, true), onClick: () => openInfo(s.id, "bar") } : {})}
        />
      ))}
      {state === "waiting" && <span className="ui-agmc__seg" data-state="waiting" />}
    </span>
  );

  // The well: one line, rolled in whenever it changes
  const well: { id: string; node: ReactNode } =
    state === "running" && doing
      ? {
          id: `r-${doing.label}`,
          node: (
            <>
              <span className="ui-agmc__tile">{iconOf(doing)}</span>
              <span className="ui-agmc__task ui-agmc__shine">{doing.label}</span>
            </>
          ),
        }
      : state === "waiting"
        ? {
            id: `w-${ask?.title ?? ""}-${ask?.command ?? ""}`,
            node: (
              <>
                {ask?.icon && <span className="ui-agmc__tile">{ask.icon}</span>}
                <span className="ui-agmc__task">{ask?.title ?? L.waitingOnYou}</span>
                {ask?.command && (
                  <code className="ui-agmc__code" title={ask.command}>
                    {ask.command}
                  </code>
                )}
              </>
            ),
          }
        : state === "paused"
          ? { id: "p", node: <span className="ui-agmc__task ui-agmc__task--quiet">{LABEL.paused}{doing ? ` · ${doing.label}` : ""}</span> }
          : state === "finished"
            ? {
                id: "f",
                node: (
                  <>
                    <span className="ui-agmc__task">{L.finishedIn(words(elapsed))}</span>
                    {changes && (
                      <span className="ui-agmc__diff">
                        <span className="ui-agmc__add">+{num.format(outcome!.added ?? 0)}</span>
                        <span className="ui-agmc__del">−{num.format(outcome!.removed ?? 0)}</span>
                      </span>
                    )}
                    {outcome?.files != null && <span className="ui-agmc__note">{L.files(outcome.files)}</span>}
                    {outcome?.note && <span className="ui-agmc__note">{outcome.note}</span>}
                  </>
                ),
              }
            : state === "failed"
              ? {
                  id: `x-${error ?? ""}`,
                  node: (
                    <>
                      <span className="ui-agmc__flag" aria-hidden="true" />
                      <span className="ui-agmc__task">{error ?? L.errorFallback}</span>
                    </>
                  ),
                }
              : state === "cancelled"
                ? { id: "c", node: <span className="ui-agmc__task ui-agmc__task--quiet">{L.cancelledAfter(words(elapsed))}</span> }
                : { id: "i", node: <span className="ui-agmc__task ui-agmc__task--quiet">{L.noTask}</span> };
  const mark = agent.mark ?? agent.name.trim().slice(0, 1).toUpperCase();
  const showClock = since != null && (state === "running" || state === "paused" || state === "waiting" || state === "failed");

  return (
    <div className={["ui-agmc", className].filter(Boolean).join(" ")} data-status={state} data-folded={folded ? "" : undefined} data-pointing={hot ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && info) {
          e.stopPropagation();
          closeInfo(true);
        }
      }}
    >
      <style href="ui-agent-monitor-clean" precedence="default">
        {css}
      </style>

      {folded ? (
        // Folded away: a small bar – the mark and name, the tools used so far, the clock or the state
        <button ref={tile} type="button" className="ui-agmc__icon" title={said} aria-label={L.open(said)} aria-expanded={false} aria-controls={uid} onClick={() => toggle(false)}>
          <span className="ui-agmc__face" aria-hidden="true">
            {mark}
          </span>
          <span className="ui-agmc__icon-name">{agent.name}</span>
          {shownTools.length > 0 && (
            <span className="ui-agmc__tools" aria-hidden="true">
              {tools.length > shownTools.length && <span className="ui-agmc__tools-more">+{tools.length - shownTools.length}</span>}
              {shownTools.map((t) => (
                <span key={t.id} className="ui-agmc__tool" data-live={t.live}>
                  {t.icon}
                  {/* On hover the tile lifts and this card shows above it */}
                  <span className="ui-agmc__tip">
                    <span className="ui-agmc__tip-title">{t.tip.title}</span>
                    {t.tip.sub && <span className="ui-agmc__tip-sub">{t.tip.sub}</span>}
                  </span>
                </span>
              ))}
            </span>
          )}
          {/* The clock while it runs – or a small tag for what needs a look: it swaps in with a soft fade, and the bar eases to its new width */}
          <Morph id={state === "running" || state === "paused" ? "clock" : state} className="ui-agmc__icon-end">
            {state === "finished" ? (
              <span className="ui-agmc__done-tag" data-tone="done">
                <CheckIcon />
                {words(elapsed)}
              </span>
            ) : state === "waiting" ? (
              <span className="ui-agmc__done-tag" data-tone="ask">
                <WarnIcon />
                {LABEL[state]}
              </span>
            ) : state === "failed" ? (
              <span className="ui-agmc__done-tag" data-tone="fail">
                <CancelIcon />
                {LABEL[state]}
              </span>
            ) : (
              <span className={["ui-agmc__icon-meta", state === "running" ? "ui-agmc__shine" : ""].filter(Boolean).join(" ")} data-status={state}>
                {state === "running" || state === "paused" ? clock(elapsed) : LABEL[state]}
              </span>
            )}
          </Morph>
        </button>
      ) : (
        <section ref={card} id={uid} className="ui-agmc__card" aria-label={said} tabIndex={state === "waiting" ? 0 : undefined} onKeyDown={onKeys}>
          <div className="ui-agmc__top">
            <span className="ui-agmc__face" aria-hidden="true">
              {mark}
            </span>
            <span className="ui-agmc__who">
              <span className="ui-agmc__name">{agent.name}</span>
              {agent.role && <span className="ui-agmc__role">{agent.role}</span>}
            </span>
            {cost != null && state !== "idle" && (
              <span className="ui-agmc__cost" data-live={live ? "" : undefined} aria-label={L.costSoFar(usd(cost))}>
                {usd(cost)}
              </span>
            )}
            <span className="ui-agmc__state" data-status={state}>
              <span className="ui-agmc__dot" />
              <Roll id={state}>{LABEL[state]}</Roll>
            </span>
            <button ref={fold} type="button" className="ui-agmc__fold" aria-label={L.foldAway} title={L.foldAway} aria-expanded={true} aria-controls={uid} onClick={() => toggle(true)}>
              <Fold />
            </button>
          </div>

          {/* The current step – or what it wants from you, what came of it, what went wrong */}
          <div className="ui-agmc__well" data-status={state}>
            <Roll id={well.id} className="ui-agmc__well-line">
              {well.node}
            </Roll>
            {showClock && (
              <span className="ui-agmc__clock" aria-label={L.runningFor(words(elapsed))}>
                {clock(elapsed)}
              </span>
            )}
          </div>

          {/* The time strip: a step as wide as it took – the running one grows */}
          {ran.length > 0 && (
            <div className="ui-agmc__strip-wrap" role="img" aria-label={ran.map((x) => `${x.label}, ${secs(tookOf(x))}`).join("; ")}>
              {strip("ui-agmc__strip", true)}
            </div>
          )}

          {recent.length > 0 && (
            <ol
              ref={list}
              className="ui-agmc__steps"
              style={{ ["--ui-agmc-shown" as string]: Math.min(recent.length, 3) }}
              data-fade-top={edge.top ? "" : undefined}
              data-fade-bottom={edge.bottom ? "" : undefined}
              tabIndex={recent.length > 3 ? 0 : undefined}
              aria-label={recent.length > 3 ? L.finishedSteps : undefined}
              onScroll={measure}
            >
              {recent.map((x) => (
                <li key={x.id} className="ui-agmc__step" data-id={x.id} data-state={x.state} data-hot={hot === x.id ? "" : undefined} {...point(x.id)}>
                  <button type="button" className="ui-agmc__step-hit" aria-label={L.details(x.label)} aria-expanded={info?.id === x.id} onClick={() => openInfo(x.id, "row")} />
                  <span className="ui-agmc__step-icon">{iconOf(x)}</span>
                  <span className="ui-agmc__step-label" title={x.label}>
                    {x.label}
                  </span>
                  <span className="ui-agmc__step-time">{x.state === "failed" ? L.failed : secs(tookOf(x))}</span>
                </li>
              ))}
            </ol>
          )}

          {/* The info card of a clicked step: what it did, with which tool, when and for how long */}
          {opened && (
            <div ref={pop} key={opened.id} className="ui-agmc__info" role="dialog" aria-label={opened.label} data-state={opened.state}>
              <div className="ui-agmc__info-head">
                <span className="ui-agmc__tile">{iconOf(opened)}</span>
                <span className="ui-agmc__info-title">
                  <span className="ui-agmc__info-label">{opened.label}</span>
                  <span className="ui-agmc__info-sub">{opened.tool ?? KIND_NAME[opened.kind ?? "think"]}</span>
                </span>
                <button type="button" className="ui-agmc__info-close" aria-label={L.close} onClick={() => closeInfo(true)}>
                  <CancelIcon />
                </button>
              </div>
              <dl className="ui-agmc__info-facts">
                <div>
                  <dt>{L.started}</dt>
                  <dd>+{clock(openedAt)}</dd>
                </div>
                <div>
                  <dt>{L.took}</dt>
                  <dd>{secs(tookOf(opened))}</dd>
                </div>
                <div>
                  <dt>{L.share}</dt>
                  <dd>{Math.max(1, Math.round((Math.max(tookOf(opened), 1) / ranTotal) * 100))}%</dd>
                </div>
                <div>
                  <dt>{L.state}</dt>
                  <dd data-state={opened.state}>{opened.state === "running" ? L.running : opened.state === "failed" ? L.failed : L.done}</dd>
                </div>
              </dl>
              {opened.detail && <p className="ui-agmc__info-detail">{opened.detail}</p>}
              {opened.output && (
                <code className="ui-agmc__info-output" title={opened.output}>
                  {opened.output}
                </code>
              )}
            </div>
          )}

          {/* The controls for where the run is: answer it, steer it, open its log */}
          <div className="ui-agmc__foot">
            {/* The controls swap with a soft fade as the state changes – Pause and Resume share one slot, so the focus stays */}
            <Morph id={state === "waiting" ? "answer" : state === "failed" && onRetry ? "retry" : state === "running" || state === "paused" ? "steer" : "none"} className="ui-agmc__controls">
            {state === "waiting" ? (
              <>
                {onDecline && (
                  <button type="button" className="ui-agmc__btn" onClick={onDecline}>
                    {L.decline} <kbd>Esc</kbd>
                  </button>
                )}
                {onAllow && (
                  <button type="button" className="ui-agmc__btn ui-agmc__btn--go" onClick={onAllow}>
                    {L.allow} <kbd>⏎</kbd>
                  </button>
                )}
              </>
            ) : state === "failed" && onRetry ? (
              <button type="button" className="ui-agmc__btn ui-agmc__btn--go" onClick={onRetry}>
                <RetryIcon /> {L.retry}
              </button>
            ) : (
              (state === "running" || state === "paused") &&
              (onPause || onResume || onCancel) && (
                // Steering: Pause or Resume and Cancel, side by side
                <span className="ui-agmc__group">
                  {(state === "running" ? onPause : onResume) && (
                    // One button for both, so it keeps the focus; its label rolls between Pause and Resume
                    <button type="button" className="ui-agmc__seg-btn" onClick={state === "running" ? onPause : onResume}>
                      <Morph id={state} className="ui-agmc__seg-label">
                        {state === "running" ? <PauseIcon /> : <PlayIcon />}
                        {state === "running" ? L.pause : L.resume}
                      </Morph>
                    </button>
                  )}
                  {onCancel && (
                    <button type="button" className="ui-agmc__seg-btn" onClick={onCancel}>
                      <CancelIcon /> {L.cancel}
                    </button>
                  )}
                </span>
              )
            )}
            </Morph>
            <span className="ui-agmc__where">{steps.length > 0 && state !== "idle" ? `${position}/${steps.length}` : ""}</span>
            {onOpenLog && (
              <button type="button" className="ui-agmc__btn ui-agmc__btn--quiet" onClick={onOpenLog}>
                {L.log} <LogIcon />
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

const css = /* css */ `
/* Colors, sizes and motion as variables – override them on .ui-agmc */
.ui-agmc {
  --ui-agmc-card: #ffffff;
  --ui-agmc-strong: #000000;
  --ui-agmc-ink: var(--aui-ink, rgba(0, 0, 0, 0.88));
  --ui-agmc-text: var(--aui-muted, rgba(0, 0, 0, 0.61));
  --ui-agmc-muted: var(--aui-muted, rgba(0, 0, 0, 0.45));
  --ui-agmc-faint: var(--aui-placeholder, rgba(0, 0, 0, 0.27));
  --ui-agmc-line: var(--aui-border, rgba(0, 0, 0, 0.06));
  --ui-agmc-edge: var(--aui-border, #efeeee);
  --ui-agmc-lane: var(--aui-subtle, #f4f4f5);
  --ui-agmc-well: var(--aui-subtle, rgba(0, 0, 0, 0.025));
  --ui-agmc-fill: var(--aui-subtle, rgba(0, 0, 0, 0.05));
  --ui-agmc-accent: var(--aui-info, #0070d6);
  --ui-agmc-accent-bg: rgba(0, 96, 226, 0.08);
  --ui-agmc-green: var(--aui-success, #1e8a4f);
  --ui-agmc-green-bg: color-mix(in srgb, var(--aui-green, #5fc88a) 9%, transparent);
  --ui-agmc-red: var(--aui-danger, #c4320a);
  --ui-agmc-red-bg: color-mix(in srgb, var(--aui-red, #f04438) 7%, transparent);
  --ui-agmc-amber: var(--aui-warning, #b25e00);
  --ui-agmc-amber-bg: color-mix(in srgb, var(--aui-amber, #e8b000) 13%, transparent);
  --ui-agmc-shine: rgba(0, 0, 0, 0.22);
  --ui-agmc-focus: var(--aui-focus, rgba(0, 96, 226, 0.7));
  /* The time strip: quiet gray steps, the running one in the accent (as r, g, b) */
  --ui-agmc-seg: rgba(0, 0, 0, 0.08);
  --ui-agmc-live: 0, 96, 226;
  --ui-agmc-hot: rgba(0, 0, 0, 0.3);
  /* Soft, layered – like the cards in Agent Handoff */
  --ui-agmc-lift: 0 10px 6px rgba(0, 0, 0, 0.02), 0 5px 5px rgba(0, 0, 0, 0.03), 0 1px 2px rgba(0, 0, 0, 0.04);
  --ui-agmc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-agmc-ease: cubic-bezier(0.32, 0.72, 0.24, 1);
  position: relative;
  display: inline-block;
  max-width: 100%;
  font-family: var(--aui-font, "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  font-size: 13px;
  line-height: 20px;
  color: var(--ui-agmc-text);
  -webkit-font-smoothing: antialiased;
}
.ui-agmc *, .ui-agmc *::before, .ui-agmc *::after { box-sizing: border-box; }
:where(.ui-agmc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
.ui-agmc :is(button, .ui-agmc__card, .ui-agmc__steps):focus-visible { outline: 2px solid var(--ui-agmc-focus); outline-offset: 2px; }
.ui-agmc :is(ol, ul) { margin: 0; padding: 0; list-style: none; }

/* ----- The card ----- */
.ui-agmc__card {
  position: relative;
  display: grid;
  gap: 10px;
  width: 340px;
  max-width: 100%;
  padding: 14px 14px 10px;
  border-radius: calc(var(--aui-radius-lg, 10px) + 4px);
  background: var(--aui-surface, var(--ui-agmc-card));
  box-shadow: var(--aui-shadow-card, 0 0 0 1px var(--ui-agmc-edge), var(--ui-agmc-lift));
  transform-origin: 22px 22px;
  animation: ui-agmc-open 340ms var(--ui-agmc-ease) both;
  transition: box-shadow 300ms ease;
}
.ui-agmc__top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ui-agmc__face { display: grid; flex: none; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: var(--ui-agmc-card); box-shadow: var(--ui-agmc-shadow); font-size: 11px; font-weight: 500; color: var(--ui-agmc-ink); }
.ui-agmc__face > svg { width: 14px; height: 14px; }
.ui-agmc__face > img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.ui-agmc__who { display: grid; flex: 1; min-width: 3em; }
.ui-agmc__name { overflow: hidden; font-weight: 500; line-height: 16px; color: var(--aui-ink, var(--ui-agmc-strong)); white-space: nowrap; text-overflow: ellipsis; }
.ui-agmc__role { overflow: hidden; font-size: 11px; line-height: 14px; color: var(--ui-agmc-muted); white-space: nowrap; text-overflow: ellipsis; }
.ui-agmc__cost { animation: ui-agmc-morph-in 380ms var(--ui-agmc-ease) both; flex: none; font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; color: var(--ui-agmc-muted); }
.ui-agmc__cost[data-live] { background: linear-gradient(90deg, var(--ui-agmc-ink) 0%, var(--ui-agmc-ink) 38%, var(--ui-agmc-shine) 50%, var(--ui-agmc-ink) 62%, var(--ui-agmc-ink) 100%) 0 0 / 300% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: ui-agmc-shine 1500ms linear infinite; }
/* The state, as a small tag: blue while it runs, amber when it needs you, green finished, red failed */
.ui-agmc__state { display: inline-flex; flex: none; align-items: center; gap: 5px; height: 18px; padding: 0 6px; overflow: hidden; border-radius: calc(var(--aui-radius-sm, 5px) - 1px); background: var(--ui-agmc-well); font-size: 11px; font-weight: 500; line-height: 18px; color: var(--ui-agmc-muted); transition: background-color 300ms ease, color 300ms ease; }
.ui-agmc__dot { flex: none; width: 6px; height: 6px; border-radius: 2px; background: currentColor; opacity: 0.55; }
.ui-agmc__state:is([data-status="running"], [data-status="waiting"]) .ui-agmc__dot { opacity: 1; animation: ui-agmc-breathe 1400ms ease-in-out infinite; }
.ui-agmc__state .ui-agmc__roll { flex: none; height: 18px; }
.ui-agmc__state[data-status="running"] { background: var(--ui-agmc-accent-bg); color: var(--ui-agmc-accent); }
.ui-agmc__state[data-status="waiting"] { background: var(--ui-agmc-amber-bg); color: var(--ui-agmc-amber); }
.ui-agmc__state[data-status="finished"] { background: var(--ui-agmc-green-bg); color: var(--ui-agmc-green); }
.ui-agmc__state[data-status="failed"] { background: var(--ui-agmc-red-bg); color: var(--ui-agmc-red); }
.ui-agmc__fold { display: grid; flex: none; place-items: center; width: 22px; height: 22px; margin: -2px -4px -2px -2px; border-radius: calc(var(--aui-radius-sm, 5px) + 1px); color: var(--ui-agmc-faint); transition: background-color 150ms ease, color 150ms ease; }
.ui-agmc__fold:hover { background: var(--ui-agmc-fill); color: var(--ui-agmc-ink); }

/* The well: what it's doing now – one line, rolled in whenever it changes */
.ui-agmc__well { display: flex; align-items: center; gap: 8px; min-width: 0; height: 36px; padding: 0 10px 0 6px; border-radius: 8px; background: var(--ui-agmc-lane); font-size: 12px; transition: background-color 300ms ease; }
.ui-agmc__well[data-status="waiting"] { background: var(--ui-agmc-amber-bg); }
.ui-agmc__well:not([data-status="running"]):not(:has(.ui-agmc__tile)) { padding-left: 10px; }
.ui-agmc__roll { display: inline-grid; flex: 1; grid-template-columns: minmax(0, 1fr); align-items: center; min-width: 0; height: 36px; overflow: hidden; }
.ui-agmc__roll-layer { grid-area: 1 / 1; display: flex; align-items: center; gap: 7px; min-width: 0; }
.ui-agmc__roll-layer[data-leaving] { animation: ui-agmc-out 380ms var(--ui-agmc-ease) both; pointer-events: none; }
.ui-agmc__roll-layer[data-coming] { animation: ui-agmc-in 380ms var(--ui-agmc-ease) both; }
.ui-agmc__tile { display: grid; flex: none; place-items: center; width: 24px; height: 24px; border-radius: 6px; background: var(--ui-agmc-card); box-shadow: var(--ui-agmc-shadow); color: var(--ui-agmc-text); }
.ui-agmc__tile > svg { width: 14px; height: 14px; }
.ui-agmc__task { min-width: 0; overflow: hidden; font-weight: 500; color: var(--ui-agmc-ink); white-space: nowrap; text-overflow: ellipsis; }
/* Waiting on you: the title stays whole, the command gives way */
.ui-agmc__well[data-status="waiting"] .ui-agmc__task { flex: none; }
.ui-agmc__task--quiet { font-weight: 400; color: var(--ui-agmc-faint); }
.ui-agmc__flag { flex: none; width: 6px; height: 6px; border-radius: 2px; background: var(--ui-agmc-red); }
.ui-agmc__shine { background: linear-gradient(90deg, var(--ui-agmc-ink) 0%, var(--ui-agmc-ink) 38%, var(--ui-agmc-shine) 50%, var(--ui-agmc-ink) 62%, var(--ui-agmc-ink) 100%) 0 0 / 300% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: ui-agmc-shine 1500ms linear infinite; }
.ui-agmc__code { flex: 0 1 auto; min-width: 0; overflow: hidden; padding: 0 6px; border-radius: var(--aui-radius-sm, 5px); background: var(--ui-agmc-card); box-shadow: var(--ui-agmc-shadow); font-family: var(--aui-font-mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 11px; line-height: 20px; color: var(--ui-agmc-ink); white-space: nowrap; text-overflow: ellipsis; }
.ui-agmc__diff { display: inline-flex; flex: none; gap: 5px; font-weight: 500; font-variant-numeric: tabular-nums; }
.ui-agmc__add { color: var(--ui-agmc-green); }
.ui-agmc__del { color: var(--ui-agmc-red); }
.ui-agmc__note { flex: none; color: var(--ui-agmc-muted); }
.ui-agmc__clock { animation: ui-agmc-morph-in 380ms var(--ui-agmc-ease) both; flex: none; font-variant-numeric: tabular-nums; color: var(--ui-agmc-muted); }

/* The time strip: a step as wide as it took; the running one grows in the accent with a soft sheen */
.ui-agmc__strip-wrap { margin: 2px 0; }
.ui-agmc__strip { display: flex; gap: 2px; height: 6px; }
.ui-agmc__seg {
  position: relative;
  min-width: 3px;
  border-radius: 3px;
  background: var(--ui-agmc-seg);
  transition: flex-grow 300ms linear, background-color 400ms ease, opacity 200ms ease;
  animation: ui-agmc-grow 420ms var(--ui-agmc-ease) backwards;
}
/* A taller, invisible target, so a 6px bar is easy to point at */
.ui-agmc__strip .ui-agmc__seg::after { content: ""; position: absolute; inset: -7px -1px; }
.ui-agmc__seg[data-state="running"] { background: rgba(var(--ui-agmc-live), 0.28); }
.ui-agmc__seg[data-state="running"]::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.75) 50%, transparent 100%) 0 0 / 50% 100% no-repeat; animation: ui-agmc-sheen 1600ms ease-in-out infinite; }
.ui-agmc__seg[data-state="failed"] { background: repeating-linear-gradient(-45deg, var(--ui-agmc-red-bg) 0 2px, transparent 2px 4px), var(--ui-agmc-seg); }
/* Waiting on you: a short amber step at the end that breathes */
.ui-agmc__seg[data-state="waiting"] { flex: 0 0 12px; background: var(--ui-agmc-amber); opacity: 0.6; animation: ui-agmc-grow 420ms var(--ui-agmc-ease) backwards, ui-agmc-breathe 1600ms ease-in-out infinite; }
.ui-agmc:not([data-status="running"]) .ui-agmc__seg[data-state="running"]::before { animation: none; opacity: 0; }
.ui-agmc[data-status="finished"] .ui-agmc__seg:not([data-state="failed"]) { background: var(--ui-agmc-green-bg); }
/* Paused: the running bar stands still and steps back */
.ui-agmc[data-status="paused"] .ui-agmc__seg[data-state="running"] { opacity: 0.45; }

/* Pointing at a bar or a row: the pair stays, the rest fade back */
.ui-agmc[data-pointing] .ui-agmc__strip .ui-agmc__seg:not([data-hot]),
.ui-agmc[data-pointing] .ui-agmc__step:not([data-hot]) { opacity: 0.35; }
.ui-agmc__strip .ui-agmc__seg[data-hot]:not([data-state="running"]) { background: var(--ui-agmc-hot); }

/* The finished steps, newest first, three rows tall and scrollable: each with its tool's logo – a finished one drops in from the top */
.ui-agmc__steps::-webkit-scrollbar { display: none; }
.ui-agmc__steps[data-fade-top] { --ui-agmc-fade-top: transparent; }
.ui-agmc__steps[data-fade-bottom] { --ui-agmc-fade-bottom: transparent; }
.ui-agmc__steps { position: relative; display: grid; align-content: start; height: calc(var(--ui-agmc-shown, 0) * 26px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; margin: -2px -6px 0; --ui-agmc-fade-top: #000; --ui-agmc-fade-bottom: #000; -webkit-mask-image: linear-gradient(to bottom, var(--ui-agmc-fade-top), #000 14px, #000 calc(100% - 14px), var(--ui-agmc-fade-bottom)); mask-image: linear-gradient(to bottom, var(--ui-agmc-fade-top), #000 14px, #000 calc(100% - 14px), var(--ui-agmc-fade-bottom)); transition: height 420ms var(--ui-agmc-ease); }
.ui-agmc__step { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 8px; border-radius: calc(var(--aui-radius-sm, 5px) + 2px); font-size: 12px; cursor: default; transition: opacity 200ms ease, background-color 200ms ease; animation: ui-agmc-drop 460ms var(--ui-agmc-ease) backwards; }
.ui-agmc__step[data-hot] { background: var(--ui-agmc-lane); }
.ui-agmc__step { position: relative; cursor: pointer; }
.ui-agmc__strip .ui-agmc__seg { cursor: pointer; }
/* The whole row is the button; its content sits on top, untouched by it */
.ui-agmc__step-hit { position: absolute; inset: 0; border-radius: inherit; }
.ui-agmc .ui-agmc__step-hit:focus-visible { outline-offset: -2px; }
.ui-agmc__step > :not(.ui-agmc__step-hit) { position: relative; pointer-events: none; }

/* The info card: a step's details, floating under the row or the time strip that was clicked */
.ui-agmc__info { position: absolute; z-index: 2; right: 10px; left: 10px; display: grid; gap: 10px; padding: 12px; border-radius: calc(var(--aui-radius-lg, 10px) + 2px); background: var(--aui-overlay, var(--ui-agmc-card)); box-shadow: var(--aui-shadow-popover, 0 0 0 1px var(--ui-agmc-edge), 0 12px 24px -8px rgba(0, 0, 0, 0.14), 0 4px 8px -4px rgba(0, 0, 0, 0.06)); transform-origin: 50% 0; animation: ui-agmc-pop 260ms var(--ui-agmc-ease) both; }
.ui-agmc__info-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ui-agmc__info-title { display: grid; flex: 1; min-width: 0; }
.ui-agmc__info-label { overflow: hidden; font-size: 13px; font-weight: 500; line-height: 18px; color: var(--aui-ink, var(--ui-agmc-strong)); white-space: nowrap; text-overflow: ellipsis; }
.ui-agmc__info-sub { font-size: 11px; line-height: 14px; color: var(--ui-agmc-muted); }
.ui-agmc__info-close { display: grid; flex: none; place-items: center; width: 22px; height: 22px; margin: -2px -4px 0 0; border-radius: calc(var(--aui-radius-sm, 5px) + 1px); color: var(--ui-agmc-faint); transition: background-color 150ms ease, color 150ms ease; }
.ui-agmc__info-close:hover { background: var(--ui-agmc-fill); color: var(--ui-agmc-ink); }
.ui-agmc__info-facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; overflow: hidden; border-radius: 8px; background: var(--ui-agmc-line); box-shadow: 0 0 0 1px var(--ui-agmc-line); }
.ui-agmc__info-facts > div { display: grid; gap: 1px; padding: 6px 8px; background: var(--ui-agmc-card); }
.ui-agmc__info-facts dt { font-size: 10.5px; line-height: 14px; color: var(--ui-agmc-muted); }
.ui-agmc__info-facts dd { margin: 0; font-size: 12px; font-weight: 500; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--ui-agmc-ink); }
.ui-agmc__info-facts dd[data-state="failed"] { color: var(--ui-agmc-red); }
.ui-agmc__info-facts dd[data-state="running"] { color: var(--ui-agmc-accent); }
.ui-agmc__info-detail { margin: 0; font-size: 12px; line-height: 18px; color: var(--ui-agmc-text); }
.ui-agmc__info-output { display: block; overflow: hidden; padding: 5px 8px; border-radius: 6px; background: var(--ui-agmc-lane); font-family: var(--aui-font-mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 11px; line-height: 16px; color: var(--ui-agmc-ink); white-space: nowrap; text-overflow: ellipsis; }
.ui-agmc__step-icon { display: grid; flex: none; place-items: center; width: 18px; height: 18px; border-radius: 5px; background: var(--ui-agmc-card); box-shadow: var(--ui-agmc-shadow); color: var(--ui-agmc-muted); }
.ui-agmc__step-icon > svg { width: 11px; height: 11px; }
.ui-agmc__step-label { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-agmc-text); white-space: nowrap; text-overflow: ellipsis; }
.ui-agmc__step-time { flex: none; font-variant-numeric: tabular-nums; color: var(--ui-agmc-faint); }
.ui-agmc__step[data-state="failed"] .ui-agmc__step-time { color: var(--ui-agmc-red); }

/* The controls: small, at the foot */
.ui-agmc__foot { display: flex; align-items: center; gap: 4px; min-height: 28px; margin: 0 -4px; }
.ui-agmc__where { flex: 1; padding-right: 4px; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--ui-agmc-faint); text-align: right; }
/* Swapping content: the old fades and shrinks away, the new fades and grows in, the width eases between them */
.ui-agmc__morph { display: inline-grid; flex: none; align-items: center; transition: width 380ms var(--ui-agmc-ease); }
.ui-agmc__morph-layer { grid-area: 1 / 1; justify-self: start; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.ui-agmc__morph-layer[data-leaving] { animation: ui-agmc-morph-out 240ms ease both; pointer-events: none; }
.ui-agmc__morph-layer[data-coming] { animation: ui-agmc-morph-in 380ms var(--ui-agmc-ease) both; }
.ui-agmc__icon-end { overflow: hidden; }
.ui-agmc__icon-meta.ui-agmc__shine { color: transparent; }
.ui-agmc__seg-label .ui-agmc__morph-layer > svg { color: var(--ui-agmc-muted); }
.ui-agmc__icon-end .ui-agmc__morph-layer { transform-origin: 0 50%; }
.ui-agmc__controls .ui-agmc__morph-layer { transform-origin: 0 50%; }
/* Pause / Resume and Cancel: two small gray buttons side by side */
.ui-agmc__group { display: inline-flex; gap: 4px; margin-left: 4px; }
.ui-agmc__seg-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px 0 7px; border-radius: var(--aui-radius, 7px); background: var(--ui-agmc-lane); font-size: 11.5px; font-weight: 500; color: var(--ui-agmc-text); white-space: nowrap; transition: background-color 150ms ease, box-shadow 150ms ease, color 150ms ease, transform 150ms ease; }
.ui-agmc__seg-btn > svg { color: var(--ui-agmc-muted); }
.ui-agmc__seg-btn:hover { background: var(--ui-agmc-seg); color: var(--ui-agmc-ink); }
.ui-agmc__seg-btn:active { transform: scale(0.96); }
.ui-agmc__btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px; border-radius: var(--aui-radius, 7px); font-size: 12px; font-weight: 500; color: var(--ui-agmc-text); white-space: nowrap; transition: background-color 150ms ease, color 150ms ease, transform 150ms ease; }
.ui-agmc__btn:hover { background: var(--ui-agmc-fill); color: var(--ui-agmc-ink); }
.ui-agmc__btn:active { transform: scale(0.97); }
.ui-agmc__btn--go { padding: 0 10px; background: var(--aui-primary, var(--ui-agmc-strong)); color: var(--aui-on-primary, var(--ui-agmc-card)); }
.ui-agmc__btn--go:hover { background: var(--aui-primary, var(--ui-agmc-strong)); color: var(--aui-on-primary, var(--ui-agmc-card)); opacity: 0.86; }
.ui-agmc__btn--quiet { color: var(--ui-agmc-muted); }
.ui-agmc__btn kbd { padding: 0 4px; border-radius: calc(var(--aui-radius-sm, 5px) - 1px); background: var(--ui-agmc-fill); font-family: inherit; font-size: 10px; line-height: 15px; color: var(--ui-agmc-muted); }
.ui-agmc__btn--go kbd { background: rgba(255, 255, 255, 0.18); color: rgba(255, 255, 255, 0.8); }

/* ----- Folded away: a small bar – the mark and name, the tools used so far, the clock or state ----- */
.ui-agmc__icon { position: relative; display: inline-flex; align-items: center; gap: 12px; height: 44px; padding: 0 12px 0 9px; border-radius: calc(var(--aui-radius-lg, 10px) + 3px); background: var(--aui-surface, var(--ui-agmc-card)); box-shadow: var(--aui-shadow-card, 0 0 0 1px var(--ui-agmc-edge), var(--ui-agmc-lift)); text-align: left; transform-origin: 22px 50%; animation: ui-agmc-open 300ms var(--ui-agmc-ease) both; }
/* The bar itself stays put on hover – only a tool tile lifts */
.ui-agmc__icon-name { max-width: 140px; margin-left: -4px; overflow: hidden; font-size: 12.5px; font-weight: 500; color: var(--aui-ink, var(--ui-agmc-strong)); white-space: nowrap; text-overflow: ellipsis; }
/* The tools, slightly stacked – each tile opaque with a ring in the card's color, so the overlap stays clean */
.ui-agmc__tools { display: flex; align-items: center; }
.ui-agmc__tool { position: relative; display: grid; flex: none; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: var(--ui-agmc-card); box-shadow: inset 0 0 0 1px var(--ui-agmc-edge), 0 0 0 2px var(--ui-agmc-card), 0 1px 3px 1px rgba(0, 0, 0, 0.06); color: var(--ui-agmc-muted); animation: ui-agmc-join 480ms var(--ui-agmc-ease) backwards; transition: transform 220ms var(--ui-agmc-ease); }
.ui-agmc__tool + .ui-agmc__tool { margin-left: -6px; }
.ui-agmc__tool > svg { width: 12px; height: 12px; opacity: 0.4; filter: grayscale(1); transition: opacity 300ms ease, filter 300ms ease; }
/* Used before: faded back; the one in use – or the one it asks to use – in full color */
.ui-agmc__tool[data-live] { z-index: 1; }
/* Pointing at a tool: its tile lifts above the stack, and its card fades in above it */
.ui-agmc__tool:hover { z-index: 3; transform: translateY(-4px); box-shadow: inset 0 0 0 1px var(--ui-agmc-edge), 0 0 0 2px var(--ui-agmc-card), 0 6px 12px -2px rgba(0, 0, 0, 0.14); }
.ui-agmc__tool:hover > svg { opacity: 1; filter: none; }
.ui-agmc__tool > svg { pointer-events: none; }
.ui-agmc__tip { position: absolute; bottom: calc(100% + 10px); left: 50%; display: grid; gap: 1px; width: max-content; max-width: 220px; padding: 7px 10px; border-radius: calc(var(--aui-radius-lg, 10px) - 1px); background: var(--aui-overlay, var(--ui-agmc-card)); box-shadow: var(--aui-shadow-popover, 0 0 0 1px var(--ui-agmc-edge), 0 12px 24px -8px rgba(0, 0, 0, 0.16), 0 4px 8px -4px rgba(0, 0, 0, 0.06)); font-weight: 400; text-align: left; white-space: normal; opacity: 0; transform: translate(-50%, 4px) scale(0.97); transform-origin: 50% 100%; pointer-events: none; transition: opacity 160ms ease, transform 220ms var(--ui-agmc-ease); }
.ui-agmc__tool:hover .ui-agmc__tip { opacity: 1; transform: translate(-50%, 0); }
.ui-agmc__tip-title { overflow: hidden; font-size: 12px; font-weight: 500; line-height: 16px; color: var(--aui-ink, var(--ui-agmc-strong)); white-space: nowrap; text-overflow: ellipsis; }
.ui-agmc__tip-sub { font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; color: var(--ui-agmc-muted); }
.ui-agmc__tool[data-live] > svg, .ui-agmc[data-status="finished"] .ui-agmc__tool > svg { opacity: 1; filter: none; }
.ui-agmc__tool[data-live="ask"] { background: linear-gradient(var(--ui-agmc-amber-bg), var(--ui-agmc-amber-bg)), var(--ui-agmc-card); }
.ui-agmc__tools-more { flex: none; margin-right: 4px; font-size: 10px; font-weight: 500; color: var(--ui-agmc-faint); }
.ui-agmc__icon-meta { flex: none; min-width: 34px; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--ui-agmc-ink); white-space: nowrap; }
.ui-agmc__done-tag { display: inline-flex; flex: none; align-items: center; gap: 4px; height: 22px; padding: 0 8px 0 6px; border-radius: calc(var(--aui-radius-sm, 5px) + 1px); background: var(--ui-agmc-green-bg); font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--ui-agmc-green); white-space: nowrap; }
.ui-agmc__done-tag > svg { stroke-width: 1.8; }
.ui-agmc__done-tag[data-tone="ask"] { background: var(--ui-agmc-amber-bg); color: var(--ui-agmc-amber); }
.ui-agmc__done-tag[data-tone="ask"] > svg { stroke-width: 1.5; }
.ui-agmc__done-tag[data-tone="fail"] { background: var(--ui-agmc-red-bg); color: var(--ui-agmc-red); }
.ui-agmc__icon-meta:is([data-status="idle"], [data-status="paused"], [data-status="cancelled"]) { color: var(--ui-agmc-muted); }
@keyframes ui-agmc-breathe { 50% { opacity: 0.35; } }
@keyframes ui-agmc-pop { from { opacity: 0; transform: translateY(-4px) scale(0.97); } }
/* A new tool opens its own room – the bar grows with it – while the tile scales in */
@keyframes ui-agmc-morph-in { from { opacity: 0; transform: scale(0.88); filter: blur(3px); } }
@keyframes ui-agmc-morph-out { to { opacity: 0; transform: scale(0.88); filter: blur(3px); } }
@keyframes ui-agmc-join { from { width: 0; margin-left: 0; opacity: 0; transform: scale(0.5); } 40% { opacity: 0; } }
@keyframes ui-agmc-drop { from { margin-top: -26px; opacity: 0; filter: blur(2px); } }
@keyframes ui-agmc-open { from { opacity: 0; transform: scale(0.92); } }
@keyframes ui-agmc-in { from { opacity: 0; transform: translateY(70%); filter: blur(2px); } }
@keyframes ui-agmc-out { to { opacity: 0; transform: translateY(-70%); filter: blur(2px); } }
@keyframes ui-agmc-shine { from { background-position: 100% 0; } to { background-position: 0 0; } }
@keyframes ui-agmc-grow { from { clip-path: inset(0 100% 0 0 round 3px); } to { clip-path: inset(0 0 0 0 round 3px); } }
@keyframes ui-agmc-sheen { from { background-position: -100% 0; } to { background-position: 200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .ui-agmc *, .ui-agmc *::before, .ui-agmc *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-agmc {
  --ui-agmc-card: #1c1c1f;
  --ui-agmc-strong: #ffffff;
  --ui-agmc-ink: var(--aui-ink, rgba(255, 255, 255, 0.9));
  --ui-agmc-text: var(--aui-muted, rgba(255, 255, 255, 0.62));
  --ui-agmc-muted: var(--aui-muted, rgba(255, 255, 255, 0.45));
  --ui-agmc-faint: var(--aui-placeholder, rgba(255, 255, 255, 0.28));
  --ui-agmc-line: var(--aui-border, rgba(255, 255, 255, 0.08));
  --ui-agmc-edge: var(--aui-border, rgba(255, 255, 255, 0.08));
  --ui-agmc-lane: var(--aui-subtle, #161618);
  --ui-agmc-well: var(--aui-subtle, rgba(255, 255, 255, 0.04));
  --ui-agmc-fill: var(--aui-subtle, rgba(255, 255, 255, 0.07));
  --ui-agmc-accent: var(--aui-info, #4fb0fe);
  --ui-agmc-accent-bg: color-mix(in srgb, var(--aui-blue, #4fb0fe) 16%, transparent);
  --ui-agmc-green: var(--aui-green, #5fc88a);
  --ui-agmc-green-bg: color-mix(in srgb, var(--aui-green, #7dcf9f) 14%, transparent);
  --ui-agmc-red: var(--aui-red, #ff6b5f);
  --ui-agmc-red-bg: color-mix(in srgb, var(--aui-red, #ff6b5f) 12%, transparent);
  --ui-agmc-amber: var(--aui-amber, #e6c24d);
  --ui-agmc-amber-bg: color-mix(in srgb, var(--aui-amber, #e6c24d) 14%, transparent);
  --ui-agmc-shine: rgba(255, 255, 255, 0.95);
  --ui-agmc-focus: var(--aui-focus, rgba(77, 141, 255, 0.8));
  --ui-agmc-seg: rgba(255, 255, 255, 0.09);
  --ui-agmc-live: 91, 154, 255;
  --ui-agmc-hot: rgba(255, 255, 255, 0.4);
  --ui-agmc-lift: 0 10px 16px -6px rgba(0, 0, 0, 0.5);
  --ui-agmc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
}
:where(.dark, [data-theme="dark"]) .ui-agmc__btn--go { color: var(--aui-on-primary, #111113); }
:where(.dark, [data-theme="dark"]) .ui-agmc__btn--go kbd { background: rgba(0, 0, 0, 0.1); color: rgba(0, 0, 0, 0.6); }
:where(.dark, [data-theme="dark"]) .ui-agmc__seg[data-state="running"]::before { background-image: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.22) 50%, transparent 100%); }
`;
