// affectUI - licensed under https://www.affectui.com/license, not under this project's open-source license.
"use client";

import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Key,
  type ReactElement,
  type ReactNode,
} from "react";

/*
 * Tool Call Card (Clean) – one tool call of an AI agent, in a single self-contained file.
 * Clean style: one white card with hairline shadows, no tile and no tray. The header row holds the
 * tool's icon, its name in mono, a short summary and the status: a blue spinner with a live timer,
 * a blue check with the duration, or a red "Failed". Click it open to see the arguments and the
 * result as highlighted JSON on a faint panel, each with a small white copy button; long blocks are
 * capped with a fade and "Show all". Errors show the message and a white Retry button.
 * ToolCallGroup folds several cards into one quiet line: "Used 3 tools · 2.4s".
 * With chevron="before" the chevron leads the header instead of closing it, pointing right while folded.
 * The styles are injected below, so no extra files are needed.
 */

export type ToolCallStatus = "running" | "success" | "error" | "cancelled";

/** Every word the card and the group show, for a translation */
export type ToolCallLabels = {
  failed: string;
  cancelled: string;
  arguments: string;
  result: string;
  waiting: string;
  empty: string;
  errorFallback: string;
  retry: string;
  showAll: string;
  showLess: string;
  copied: string;
  copy: (what: string) => string;
  announce: (name: string, status: ToolCallStatus, error?: string) => string;
  used: (count: number) => string;
  usingTools: string;
  failedCount: (count: number) => string;
};

const LABELS: ToolCallLabels = {
  failed: "Failed",
  cancelled: "Cancelled",
  arguments: "Arguments",
  result: "Result",
  waiting: "Waiting for result…",
  empty: "No arguments or result.",
  errorFallback: "The tool call failed.",
  retry: "Retry",
  showAll: "Show all",
  showLess: "Show less",
  copied: "Copied",
  copy: (what) => `Copy ${what.toLowerCase()}`,
  announce: (name, status, error) =>
    status === "running"
      ? `${name} running`
      : status === "success"
        ? `${name} finished`
        : status === "cancelled"
          ? `${name} cancelled`
          : `${name} failed${error ? `: ${error}` : ""}`,
  used: (count) => `Used ${count.toLocaleString("en-US")} ${count === 1 ? "tool" : "tools"}`,
  usingTools: "Using tools…",
  failedCount: (count) => `${count} failed`,
};

export type ToolCallCardProps = {
  /** Tool name as the agent calls it, shown in mono – e.g. "search_web" */
  name: string;
  /** Short human summary – e.g. "Searched the web for 'CRM pricing 2026'" */
  summary?: ReactNode;
  /** Icon in the tile on the left – defaults to a wrench */
  icon?: ReactNode;
  status: ToolCallStatus;
  /** Arguments the tool was called with – objects are pretty-printed, JSON strings parsed */
  args?: unknown;
  /** What the tool returned – objects are pretty-printed, JSON strings parsed, other text shown as is */
  result?: unknown;
  /** Error message, shown when status is "error" */
  error?: string;
  /** When the call started (ms since epoch, e.g. Date.now()) – the live timer counts from here */
  startedAt?: number;
  /** Final duration in ms – otherwise measured while the card shows "running" */
  duration?: number;
  /** Start expanded (uncontrolled) */
  defaultOpen?: boolean;
  /** Expanded state (controlled) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Opens the card when the call fails and closes it again on the next run, unless someone toggled it */
  openOnError?: boolean;
  /** Shows a Retry button next to the error */
  onRetry?: () => void;
  /** Height in px after which arguments and result are capped with a fade and "Show all" */
  maxCodeHeight?: number;
  /** Where the chevron sits: at the end of the header, or in front, pointing right while folded */
  chevron?: "after" | "before";
  /** Your own content for the open card, in place of the error, arguments and result; false leaves the card without a body */
  children?: ReactNode;
  /** Beside the header at its end, outside the toggle, e.g. thumbnails that are buttons themselves */
  trail?: ReactNode;
  /** false shows no time, e.g. when it is not known when the call started */
  time?: boolean;
  /** Sweeps a light over the name and summary while running; style its .ui-tcc__glint */
  shine?: boolean;
  labels?: Partial<ToolCallLabels>;
  className?: string;
};

export type ToolCallGroupProps = {
  /** ToolCallCard elements – the group reads their name, icon, status and duration */
  children: ReactNode;
  /** Label once all calls are done – defaults to "Used 3 tools" */
  label?: string;
  /** Label while any call is running */
  runningLabel?: string;
  /** Total duration in ms – otherwise the sum of the cards' durations, or the time measured while running */
  duration?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where the chevron sits: at the end of the line, or in front, pointing right while folded */
  chevron?: "after" | "before";
  /** Beside the line at its end, outside the toggle */
  trail?: ReactNode;
  /** The stacked icons, oldest first – defaults to the last three cards' icons */
  icons?: { key: Key; icon: ReactNode }[];
  /** false shows no time, e.g. when it is not known when the calls started */
  time?: boolean;
  labels?: Partial<ToolCallLabels>;
  className?: string;
};

/* ---------- Card ---------- */

export function ToolCallCard({
  name,
  summary,
  icon,
  status,
  args,
  result,
  error,
  startedAt,
  duration,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  openOnError = true,
  onRetry,
  maxCodeHeight = 220,
  chevron = "after",
  children,
  trail,
  time = true,
  shine = false,
  labels,
  className,
}: ToolCallCardProps) {
  const id = useId();
  const L = { ...LABELS, ...labels };
  const bodyless = children === false;
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  // Open on failure, close again on the next run – only while nobody has toggled it by hand
  const [prevStatus, setPrevStatus] = useState(status);
  const [autoOpened, setAutoOpened] = useState(false);
  if (status !== prevStatus) {
    setPrevStatus(status);
    if (openProp === undefined && openOnError) {
      if (status === "error" && !openState) {
        setOpenState(true);
        setAutoOpened(true);
      } else if (prevStatus === "error" && autoOpened) {
        setOpenState(false);
        setAutoOpened(false);
      }
    }
  }

  const measured = useStopwatch(status === "running", startedAt, false);
  const ms = !time ? null : status === "running" ? (measured ?? 0) : (duration ?? measured);

  const announce = L.announce(name, status, error);
  const glint = shine && status === "running";

  return (
    <div
      className={["ui-tcc", className].filter(Boolean).join(" ")}
      data-status={status}
      data-open={open || undefined}
    >
      {/* React 19 hoists this into <head> once, no matter how many cards render */}
      <style href="ui-tool-call-clean" precedence="default">
        {css}
      </style>
      <span className="ui-tcc-sr" role="status" aria-live="polite">
        {announce}
      </span>

      <div className="ui-tcc__top">
      <button
        type="button"
        className="ui-tcc__head"
        aria-expanded={bodyless ? undefined : open}
        aria-controls={bodyless ? undefined : `${id}-body`}
        data-chevron={chevron}
        data-bodyless={bodyless || undefined}
        tabIndex={bodyless ? -1 : undefined}
        onClick={() => {
          if (bodyless) return;
          setAutoOpened(false);
          setOpen(!open);
        }}
      >
        {chevron === "before" && <Chevron />}
        <span className="ui-tcc__icon" aria-hidden="true">
          {icon ?? <WrenchIcon />}
        </span>
        <span className="ui-tcc__main">
          <code className="ui-tcc__name" title={name}>
            {name}
            {glint && <Glint>{name}</Glint>}
          </code>
          {summary != null && (
            <span className="ui-tcc__summary" dir="auto" title={typeof summary === "string" ? summary : undefined}>
              {summary}
              {glint && <Glint>{summary}</Glint>}
            </span>
          )}
        </span>
        <span className="ui-tcc__status" key={status}>
          {status === "running" && <Spinner />}
          {status === "success" && (
            <svg className="ui-tcc__ok" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="7" />
              <path d="M5.1 8.2 7.1 10.1 10.9 6" pathLength={1} />
            </svg>
          )}
          {status === "error" && <ErrorIcon />}
          {status === "cancelled" && <CancelIcon />}
          <span className="ui-tcc__time">
            {status === "error" ? L.failed : status === "cancelled" ? L.cancelled : ms != null ? formatMs(ms, status === "running") : null}
          </span>
        </span>
        {chevron === "after" && <Chevron />}
      </button>
      {trail != null && <span className="ui-tcc__trail">{trail}</span>}
      </div>

      {!bodyless && (
      <div className="ui-tcc__body" id={`${id}-body`} inert={!open}>
        <div className="ui-tcc__clip">
          <div className="ui-tcc__sections">
            {children !== undefined ? children : (<>
            {status === "error" && (
              <div className="ui-tcc__error">
                <ErrorIcon />
                <p className="ui-tcc__error-text" dir="auto">{error ?? L.errorFallback}</p>
                {onRetry && (
                  <button type="button" className="ui-tcc__retry" onClick={onRetry}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77" />
                      <path d="M2.5 2.5v2.75h2.75" />
                    </svg>
                    {L.retry}
                  </button>
                )}
              </div>
            )}
            {args !== undefined && <CodeSection label={L.arguments} value={args} cap={maxCodeHeight} labels={L} />}
            {result !== undefined ? (
              <CodeSection label={L.result} value={result} cap={maxCodeHeight} labels={L} />
            ) : status === "running" ? (
              <div className="ui-tcc__section">
                <div className="ui-tcc__section-head">
                  <span className="ui-tcc__label">{L.result}</span>
                </div>
                <p className="ui-tcc__pending">{L.waiting}</p>
              </div>
            ) : null}
            {args === undefined && result === undefined && status === "success" && (
              <p className="ui-tcc__pending">{L.empty}</p>
            )}
            </>)}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

/* ---------- Group ---------- */

export function ToolCallGroup({
  children,
  label,
  runningLabel: runningLabelProp,
  duration,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  chevron = "after",
  trail,
  icons: iconsProp,
  time = true,
  labels,
  className,
}: ToolCallGroupProps) {
  const id = useId();
  const L = { ...LABELS, ...labels };
  const runningLabel = runningLabelProp ?? L.usingTools;
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;

  // Read the cards' props to summarise them in the header
  const calls = Children.toArray(children)
    .filter(isValidElement)
    .map((c) => (c as ReactElement<Partial<ToolCallCardProps>>).props);
  const running = calls.some((c) => c.status === "running");
  const failed = calls.filter((c) => c.status === "error").length;

  // Time spent with tools running, added up across stretches (e.g. a pause before a retry)
  // Counts from the earliest running card that knows when it started, so the group never shows less than its cards
  const since = calls.reduce<number | undefined>(
    (min, c) => (c.status === "running" && c.startedAt != null && (min == null || c.startedAt < min) ? c.startedAt : min),
    undefined,
  );
  const measured = useStopwatch(running, since, true);
  const sum = calls.length && calls.every((c) => c.duration != null) ? calls.reduce((t, c) => t + (c.duration ?? 0), 0) : null;
  const ms = !time ? null : running ? measured : (duration ?? sum ?? measured);

  const count = L.used(calls.length);
  const title = running ? runningLabel : (label ?? count);
  const icons =
    iconsProp ??
    calls.slice(-3).map((c, i, last) => ({ key: calls.length - last.length + i, icon: c.icon ?? <WrenchIcon /> }));

  return (
    <div
      className={["ui-tcc-group", className].filter(Boolean).join(" ")}
      data-running={running || undefined}
      data-open={open || undefined}
    >
      <style href="ui-tool-call-clean" precedence="default">
        {css}
      </style>
      <span className="ui-tcc-sr" role="status" aria-live="polite">
        {running ? runningLabel : `${label ?? count}${failed ? `, ${L.failedCount(failed)}` : ""}`}
      </span>

      <div className="ui-tcc-group__top">
      <button
        type="button"
        className="ui-tcc-group__head"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        data-chevron={chevron}
        onClick={() => {
          if (openProp === undefined) setOpenState(!open);
          onOpenChange?.(!open);
        }}
      >
        {chevron === "before" && <Chevron />}
        <span className="ui-tcc-group__stack" aria-hidden="true">
          {icons.map(({ key, icon }) => (
            <span className="ui-tcc__icon" key={key}>
              {icon}
            </span>
          ))}
        </span>
        <span className="ui-tcc-group__title" key={running ? "busy" : "done"}>
          <span className={running ? "ui-tcc-group__label ui-tcc__shine" : "ui-tcc-group__label"}>
            {title}
            {running && <Glint>{title}</Glint>}
          </span>
          {!running && failed > 0 && <span className="ui-tcc-group__failed">· {L.failedCount(failed)}</span>}
          {ms != null && <span className="ui-tcc-group__time">· {formatMs(ms, running)}</span>}
        </span>
        {chevron === "after" && <Chevron />}
      </button>
      {trail != null && <span className="ui-tcc__trail">{trail}</span>}
      </div>

      <div className="ui-tcc__body" id={`${id}-list`} inert={!open}>
        <div className="ui-tcc__clip">
          <div className="ui-tcc-group__list">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Pieces ---------- */

/**
 * A copy of the words in the light's color, seen through a band that sweeps across them. The band
 * moves one way and the copy the other, so the copy stays in place and only transforms animate.
 */
function Glint({ children }: { children: ReactNode }) {
  return (
    <span className="ui-tcc__glint" aria-hidden="true">
      <span>{children}</span>
    </span>
  );
}

/**
 * A section of your own card content, drawn as the card's arguments and result are: a small
 * uppercase label, anything beside it, and white buttons at its end, Copy among them when `copy`
 * gives the text.
 */
export function ToolCallSection({
  label,
  extra,
  actions,
  copy,
  labels,
  children,
  className,
}: {
  label: string;
  extra?: ReactNode;
  actions?: ReactNode;
  copy?: string;
  labels?: Partial<ToolCallLabels>;
  children: ReactNode;
  className?: string;
}) {
  const L = { ...LABELS, ...labels };
  return (
    <div className={["ui-tcc__section", className].filter(Boolean).join(" ")}>
      <div className="ui-tcc__section-head">
        <span className="ui-tcc__label">{label}</span>
        {extra}
        <span className="ui-tcc__section-actions">
          {actions}
          {copy !== undefined && <CopyButton text={copy} label={L.copy(label)} copiedLabel={L.copied} />}
        </span>
      </div>
      {children}
    </div>
  );
}

/** A white icon button beside a section's Copy, in the same look */
export function ToolCallAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="ui-tcc__copy" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

const OPEN_MAX = 640;

function CodeSection({ label, value, cap, labels }: { label: string; value: unknown; cap: number; labels: ToolCallLabels }) {
  const { text, json } = toText(value);
  const pre = useRef<HTMLPreElement>(null);
  const [full, setFull] = useState(false);
  const [height, setHeight] = useState(0);

  // Natural height of the block – decides whether it needs the cap and how far "Show all" opens
  useLayoutEffect(() => {
    const el = pre.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const measure = () => setHeight(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [text]);

  const capped = height > cap + 24;

  return (
    <div className="ui-tcc__section">
      <div className="ui-tcc__section-head">
        <span className="ui-tcc__label">{label}</span>
        <CopyButton text={text} label={labels.copy(label)} copiedLabel={labels.copied} />
      </div>
      <pre
        ref={pre}
        className="ui-tcc__code"
        data-capped={(capped && !full) || undefined}
        data-scroll={(capped && full && height > OPEN_MAX) || undefined}
        // Open, a very long block stops at a few screens and scrolls inside – no 200,000px card
        style={capped ? { maxHeight: full ? Math.min(height, OPEN_MAX) : cap } : undefined}
      >
        <code>{json ? highlight(text) : text}</code>
      </pre>
      {capped && (
        <button type="button" className="ui-tcc__more" aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? labels.showLess : labels.showAll}
        </button>
      )}
    </div>
  );
}

function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      className="ui-tcc__copy"
      data-copied={copied || undefined}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={() => copyText(text).then((ok) => ok && setCopied(true))}
    >
      <svg className="ui-tcc__copy-icon" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="2" />
        <path d="M10.5 3.75v-.25A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h.25" />
      </svg>
      <svg className="ui-tcc__copy-done" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
      </svg>
    </button>
  );
}

function Spinner() {
  return (
    <svg className="ui-tcc__spinner" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="ui-tcc__err" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" />
      <path d="M8 4.9v3.5M8 10.9v.1" />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg className="ui-tcc__cancel" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.6 8h4.8" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg className="ui-tcc__chevron" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.5 5.25 6 7.75l2.5-2.5" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg viewBox="0 0 16 16">
      <path d="M10.2 2.4a3.5 3.5 0 0 0-4.3 4.6L2.6 10.3a1.4 1.4 0 0 0 2 2L7.9 9a3.5 3.5 0 0 0 4.6-4.3l-2 2-1.6-.4-.4-1.6 1.7-2.3Z" />
    </svg>
  );
}

/* ---------- Helpers ---------- */

/** Live ms while running, the final value after. accumulate = add up several running stretches. */
function useStopwatch(running: boolean, startedAt: number | undefined, accumulate: boolean) {
  const start = useRef<number | null>(null);
  const base = useRef(0);
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!running) {
      if (start.current !== null) {
        base.current += Date.now() - start.current;
        start.current = null;
        setMs(base.current);
      }
      return;
    }
    if (!accumulate) base.current = 0;
    start.current = startedAt ?? Date.now();
    const tick = () => setMs(base.current + Date.now() - (start.current ?? Date.now()));
    tick();
    const t = window.setInterval(tick, 100);
    return () => window.clearInterval(t);
  }, [running, startedAt, accumulate]);
  return ms;
}

/** 0.4s, 12.3s, 2m 05s, 3h 12m, 2d 4h – the live timer always shows tenths below a minute */
function formatMs(ms: number, live: boolean) {
  if (!live && ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function toText(value: unknown): { text: string; json: boolean } {
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return { text: JSON.stringify(JSON.parse(t), null, 2), json: true };
      } catch {
        /* not JSON – shown as plain text */
      }
    }
    return { text: value, json: false };
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s === undefined ? { text: String(value), json: false } : { text: s, json: true };
  } catch {
    return { text: String(value), json: false };
  }
}

// Strings (keys when followed by a colon), literals and numbers – everything else stays punctuation
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(TOKEN.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] && m[2]) {
      out.push(
        <span key={m.index} className="ui-tcc__t-key">
          {m[1]}
        </span>,
        m[2],
      );
    } else {
      const kind = m[1] ? "str" : /^[tfn]/.test(m[0]) ? "lit" : "num";
      out.push(
        <span key={m.index} className={`ui-tcc__t-${kind}`}>
          {m[0]}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure contexts
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-tcc / .ui-tcc-group */
.ui-tcc,
.ui-tcc-group {
  --ui-tcc-card: #ffffff;
  --ui-tcc-strong: #000000;
  --ui-tcc-ink: rgba(0, 0, 0, 0.88);
  --ui-tcc-text: rgba(0, 0, 0, 0.61);
  --ui-tcc-muted: rgba(0, 0, 0, 0.45);
  --ui-tcc-faint: rgba(0, 0, 0, 0.27);
  --ui-tcc-icon: rgba(0, 0, 0, 0.447);
  --ui-tcc-line: rgba(0, 0, 0, 0.06);
  --ui-tcc-wash: rgba(0, 0, 0, 0.03);
  --ui-tcc-wash-big: rgba(0, 0, 0, 0.015);
  /* The code panel: a 2% black frame, kept opaque so the fade of capped blocks can end on it */
  --ui-tcc-code: #fafafa;
  --ui-tcc-accent: rgba(0, 96, 226, 0.765);
  --ui-tcc-red: #d93a2b;
  --ui-tcc-red-bg: rgba(217, 58, 43, 0.04);
  --ui-tcc-red-line: rgba(217, 58, 43, 0.14);
  --ui-tcc-key: rgba(0, 0, 0, 0.88);
  --ui-tcc-str: rgba(0, 123, 172, 0.9);
  --ui-tcc-num: #b25b0c;
  --ui-tcc-lit: #5b5bd6;
  --ui-tcc-shine: rgba(255, 255, 255, 0.82);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-tcc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-tcc-focus: rgba(0, 96, 226, 0.35);
  --ui-tcc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ui-tcc-mono: ui-monospace, "SF Mono", Menlo, monospace;
  box-sizing: border-box;
  container-type: inline-size;
  min-width: 0;
  color: var(--ui-tcc-ink);
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
}
.ui-tcc *,
.ui-tcc-group * { box-sizing: border-box; }

.ui-tcc {
  position: relative;
  border-radius: 10px;
  background: var(--ui-tcc-card);
  box-shadow: var(--ui-tcc-shadow);
}
.ui-tcc-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* The header and anything beside it at its end, outside the toggle */
.ui-tcc__top { display: flex; align-items: center; min-width: 0; }
.ui-tcc__top > .ui-tcc__head { flex: 1; min-width: 0; }
/* The head's pull to the left moves to the row, so the row's fit-content width counts it */
.ui-tcc-group__top { display: flex; align-items: center; justify-self: start; max-width: calc(100% + 6px); min-width: 0; margin-left: -6px; }
.ui-tcc-group__top > .ui-tcc-group__head { min-width: 0; margin-left: 0; }
.ui-tcc__trail { display: flex; flex: none; align-items: center; gap: 4px; padding: 0 10px 0 2px; }
.ui-tcc__head[data-bodyless] { cursor: default; }
.ui-tcc__head[data-bodyless] .ui-tcc__chevron { visibility: hidden; }
@media (hover: hover) { .ui-tcc__head[data-bodyless]:hover { background: none; } }

/* Header row: icon, name + summary, status, chevron – everything truncates before it overflows */
.ui-tcc__head {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color 160ms ease, border-radius 0ms linear 380ms;
}
.ui-tcc[data-open] .ui-tcc__head {
  border-radius: 10px 10px 0 0;
  transition: background-color 160ms ease;
}
.ui-tcc__head:focus-visible,
.ui-tcc-group__head:focus-visible,
.ui-tcc__copy:focus-visible,
.ui-tcc__more:focus-visible,
.ui-tcc__retry:focus-visible {
  outline: 2px solid var(--ui-tcc-focus);
  outline-offset: 1px;
}
@media (hover: hover) {
  .ui-tcc__head:hover { background: var(--ui-tcc-wash-big); }
  .ui-tcc__head:hover .ui-tcc__chevron { stroke: var(--ui-tcc-ink); }
  .ui-tcc-group__head:hover { background: var(--ui-tcc-wash); color: var(--ui-tcc-ink); }
  .ui-tcc__copy:hover { background: var(--ui-tcc-wash-big); color: var(--ui-tcc-ink); }
  .ui-tcc__more:hover { color: var(--ui-tcc-ink); }
  .ui-tcc__retry:hover { background: var(--ui-tcc-wash-big); }
}

/* The tool's icon: a plain 16px glyph, no tile */
.ui-tcc__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ui-tcc-icon);
}
.ui-tcc__icon > svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }

.ui-tcc__main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.ui-tcc__name {
  flex: 0 1 auto;
  max-width: 55%;
  overflow: hidden;
  color: var(--ui-tcc-strong);
  font-family: var(--ui-tcc-mono);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-tcc__summary {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-tcc-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-tcc__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--ui-tcc-muted);
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  animation: ui-tcc-in 360ms var(--ui-tcc-ease) both;
}
.ui-tcc[data-status="error"] .ui-tcc__status { color: var(--ui-tcc-red); font-weight: 500; }
.ui-tcc__status > svg { width: 14px; height: 14px; flex: none; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.ui-tcc__spinner circle { stroke: var(--ui-tcc-line); stroke-width: 1.6; }
.ui-tcc__spinner path { stroke: var(--ui-tcc-accent); stroke-width: 1.6; }
.ui-tcc__spinner { animation: ui-tcc-spin 800ms linear infinite; }
/* Done: a solid blue dot whose white check draws itself */
.ui-tcc__ok { animation: ui-tcc-pop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.ui-tcc__ok circle { fill: var(--ui-tcc-accent); }
.ui-tcc__ok path { stroke: #fff; stroke-width: 1.5; stroke-dasharray: 1; stroke-dashoffset: 1; animation: ui-tcc-draw 360ms var(--ui-tcc-ease) 160ms forwards; }
.ui-tcc__err circle { fill: var(--ui-tcc-red); }
.ui-tcc__cancel circle, .ui-tcc__cancel path { stroke: var(--ui-tcc-muted); stroke-width: 1.4; }
.ui-tcc__err path { stroke: #fff; stroke-width: 1.6; stroke-linecap: round; }

.ui-tcc__chevron {
  flex: none;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--ui-tcc-icon);
  stroke-width: 1.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 360ms var(--ui-tcc-ease), stroke 160ms ease;
}
.ui-tcc[data-open] > .ui-tcc__top > .ui-tcc__head .ui-tcc__chevron,
.ui-tcc-group[data-open] > .ui-tcc-group__top > .ui-tcc-group__head .ui-tcc__chevron { transform: rotate(180deg); }
/* A leading chevron is bigger, points right while folded and turns down once open */
:is(.ui-tcc__head, .ui-tcc-group__head)[data-chevron="before"] .ui-tcc__chevron { width: 16px; height: 16px; stroke-width: 1.1; transform: rotate(-90deg); }
.ui-tcc[data-open] > .ui-tcc__top > .ui-tcc__head[data-chevron="before"] .ui-tcc__chevron,
.ui-tcc-group[data-open] > .ui-tcc-group__top > .ui-tcc-group__head[data-chevron="before"] .ui-tcc__chevron { transform: none; }

/* Body: grows from 0fr to 1fr, so the height animates without measuring */
.ui-tcc__body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 380ms var(--ui-tcc-ease), opacity 240ms ease;
}
.ui-tcc[data-open] > .ui-tcc__body,
.ui-tcc-group[data-open] > .ui-tcc__body {
  grid-template-rows: 1fr;
  opacity: 1;
}
.ui-tcc__clip { min-height: 0; overflow: hidden; }
.ui-tcc__sections {
  display: grid;
  gap: 14px;
  padding: 12px 14px 14px;
  border-top: 0.5px solid var(--ui-tcc-line);
}

.ui-tcc__section { display: grid; gap: 6px; min-width: 0; }
.ui-tcc__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
}
.ui-tcc__section-actions { display: flex; gap: 4px; margin-left: auto; }
/* Tiny uppercase labels: "ARGUMENTS", "RESULT" */
.ui-tcc__label {
  color: var(--ui-tcc-muted);
  font-size: 10px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.ui-tcc__pending { margin: 0; color: var(--ui-tcc-muted); font-size: 12px; line-height: 16px; }

/* Copy: a small white icon button with the card's hairline */
.ui-tcc__copy {
  all: unset;
  position: relative;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--ui-tcc-card);
  box-shadow: var(--ui-tcc-shadow);
  color: var(--ui-tcc-icon);
  cursor: pointer;
  transition: background-color 160ms ease, color 160ms ease;
}
.ui-tcc__copy svg {
  position: absolute;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: opacity 200ms ease, transform 320ms var(--ui-tcc-ease), filter 200ms ease;
}
.ui-tcc__copy-icon rect { fill: currentColor; stroke: none; }
.ui-tcc__copy-done { opacity: 0; transform: scale(0.6); filter: blur(2px); stroke-width: 1.7; }
.ui-tcc__copy[data-copied] { color: var(--ui-tcc-accent); }
.ui-tcc__copy[data-copied] .ui-tcc__copy-icon { opacity: 0; transform: scale(0.6); filter: blur(2px); }
.ui-tcc__copy[data-copied] .ui-tcc__copy-done { opacity: 1; transform: none; filter: none; }

/* Code: a faint panel with a 0.5px frame; wraps instead of scrolling sideways, capped blocks fade out */
.ui-tcc__code {
  position: relative;
  margin: 0;
  padding: 10px 12px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--ui-tcc-code);
  box-shadow: inset 0 0 0 0.5px var(--ui-tcc-line);
  color: var(--ui-tcc-muted);
  font-family: var(--ui-tcc-mono);
  font-size: 12px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
  transition: max-height 420ms var(--ui-tcc-ease);
}
.ui-tcc__code code { display: block; font: inherit; }
.ui-tcc__code::after {
  content: "";
  position: absolute;
  left: 0.5px;
  right: 0.5px;
  bottom: 0.5px;
  height: 56px;
  border-radius: 0 0 7.5px 7.5px;
  background: linear-gradient(to bottom, transparent, var(--ui-tcc-code));
  opacity: 0;
  transition: opacity 240ms ease;
  pointer-events: none;
}
.ui-tcc__code[data-capped]::after { opacity: 1; }
.ui-tcc__code[data-scroll] { overflow-y: auto; overscroll-behavior: contain; }
.ui-tcc__t-key { color: var(--ui-tcc-key); }
.ui-tcc__t-str { color: var(--ui-tcc-str); }
.ui-tcc__t-num { color: var(--ui-tcc-num); }
.ui-tcc__t-lit { color: var(--ui-tcc-lit); }

.ui-tcc__more {
  all: unset;
  justify-self: start;
  padding: 2px 4px;
  margin-left: -4px;
  border-radius: 6px;
  color: var(--ui-tcc-text);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: color 160ms ease;
}

/* Error: the message on a faint red panel and an optional white Retry button */
.ui-tcc__error {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 8px 8px 8px 12px;
  border-radius: 8px;
  background: var(--ui-tcc-red-bg);
  box-shadow: inset 0 0 0 0.5px var(--ui-tcc-red-line);
}
.ui-tcc__error > .ui-tcc__err { flex: none; align-self: flex-start; width: 16px; height: 16px; margin-top: 6px; }
.ui-tcc__error-text {
  flex: 1;
  min-width: 0;
  /* A stack trace stops at 10 lines and scrolls, so Retry and the arguments stay close */
  max-height: 200px;
  margin: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  white-space: pre-line;
  color: var(--ui-tcc-red);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.ui-tcc__retry {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 28px;
  padding: 0 10px 0 6px;
  border-radius: 6px;
  background: var(--ui-tcc-card);
  box-shadow: var(--ui-tcc-shadow);
  color: var(--ui-tcc-strong);
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 160ms ease;
}
.ui-tcc__retry svg { width: 16px; height: 16px; fill: none; stroke: var(--ui-tcc-icon); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.ui-tcc__retry:active svg { transform: rotate(-60deg); transition: transform 200ms var(--ui-tcc-ease); }

/* Group: one quiet line with the tool icons stacked on small white tiles, the cards below */
.ui-tcc-group { display: grid; }
.ui-tcc-group__head {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  justify-self: start;
  max-width: 100%;
  min-height: 32px;
  margin-left: -6px;
  padding: 4px 10px 4px 6px;
  border-radius: 8px;
  color: var(--ui-tcc-ink);
  cursor: pointer;
  transition: background-color 160ms ease, color 160ms ease;
}
.ui-tcc-group__stack { display: flex; flex: none; padding: 0.5px; }
.ui-tcc-group__stack .ui-tcc__icon {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--ui-tcc-card);
  box-shadow: var(--ui-tcc-shadow);
  animation: ui-tcc-pop 420ms var(--ui-tcc-ease) both;
}
.ui-tcc-group__stack .ui-tcc__icon + .ui-tcc__icon { margin-left: -4px; }
.ui-tcc-group__stack .ui-tcc__icon > svg { width: 12px; height: 12px; stroke-width: 1.5; }
.ui-tcc-group__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  animation: ui-tcc-in 360ms var(--ui-tcc-ease) both;
}
.ui-tcc-group__label {
  position: relative;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: inherit;
  font-weight: 500;
}
.ui-tcc-group__label.ui-tcc__shine { color: var(--ui-tcc-muted); }
.ui-tcc-group__failed { flex: none; color: var(--ui-tcc-red); }
.ui-tcc-group__time { flex: none; color: var(--ui-tcc-faint); font-variant-numeric: tabular-nums; }
.ui-tcc-group__list { display: grid; gap: 8px; padding: 6px 0 2px; }

/* A soft light sweeping over "Using tools…" */
.ui-tcc__glint {
  position: absolute;
  inset: 0;
  pointer-events: none;
  user-select: none;
  mask: linear-gradient(90deg, transparent 38%, black 50%, transparent 62%) center / 300% 100% no-repeat;
  animation: ui-tcc-glint 1.8s linear infinite;
}
.ui-tcc__glint > span {
  display: block;
  overflow: hidden;
  color: var(--ui-tcc-shine);
  text-overflow: ellipsis;
  white-space: nowrap;
  animation: ui-tcc-glint-back 1.8s linear infinite;
}

@keyframes ui-tcc-in {
  from { opacity: 0; transform: translateY(3px); filter: blur(2px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes ui-tcc-pop {
  from { opacity: 0; transform: scale(0.6); }
  to { opacity: 1; transform: none; }
}
@keyframes ui-tcc-spin { to { transform: rotate(360deg); } }
@keyframes ui-tcc-draw { to { stroke-dashoffset: 0; } }
@keyframes ui-tcc-glint { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
@keyframes ui-tcc-glint-back { from { transform: translateX(100%); } to { transform: translateX(-100%); } }

/* Narrow (phones): a little less padding, the summary gives way first */
@container (max-width: 360px) {
  .ui-tcc__head { gap: 8px; padding: 0 12px; }
  .ui-tcc__sections { padding: 12px 12px 12px; }
}
/* Touch screens: bigger tap targets */
@media (pointer: coarse) {
  .ui-tcc__head { min-height: 52px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-tcc *,
  .ui-tcc-group *,
  .ui-tcc *::after,
  .ui-tcc-group *::after {
    animation-duration: 1ms !important;
    animation-delay: 0ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
  }
  .ui-tcc__glint { display: none; }
  .ui-tcc__ok path { stroke-dashoffset: 0; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-tcc,
:where(.dark, [data-theme="dark"]) .ui-tcc-group {
  --ui-tcc-card: #1c1c1e;
  --ui-tcc-strong: #ffffff;
  --ui-tcc-ink: rgba(255, 255, 255, 0.9);
  --ui-tcc-text: rgba(255, 255, 255, 0.62);
  --ui-tcc-muted: rgba(255, 255, 255, 0.46);
  --ui-tcc-faint: rgba(255, 255, 255, 0.3);
  --ui-tcc-icon: rgba(255, 255, 255, 0.5);
  --ui-tcc-line: rgba(255, 255, 255, 0.08);
  --ui-tcc-wash: rgba(255, 255, 255, 0.04);
  --ui-tcc-wash-big: rgba(255, 255, 255, 0.025);
  --ui-tcc-code: #212123;
  --ui-tcc-accent: #4d8dff;
  --ui-tcc-red: #ff7b72;
  --ui-tcc-red-bg: rgba(255, 110, 100, 0.07);
  --ui-tcc-red-line: rgba(255, 110, 100, 0.18);
  --ui-tcc-key: rgba(255, 255, 255, 0.9);
  --ui-tcc-str: #5fc8e8;
  --ui-tcc-num: #f2a65a;
  --ui-tcc-lit: #a5a5ff;
  --ui-tcc-shine: #ffffff;
  --ui-tcc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-tcc-focus: rgba(77, 141, 255, 0.5);
}
`;
