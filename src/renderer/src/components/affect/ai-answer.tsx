// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

/*
 * AI Answer (Clean) – an assistant's answer with its sources, in a single self-contained file.
 * Clean style: quiet gray type, a sparkle that shimmers while it works. No surface of its own, so it sits in your thread,
 * panel or sheet – `framed` puts it on one white card with hairline shadows.
 * The sources pop in first, then the answer streams in word by word with citation chips.
 * Hovering a chip previews its source and lights up the matching card above (and the other way round).
 * When it's done: copy, regenerate, thumbs up / down with a reason, and follow-up questions.
 * The answer is plain text: blank lines make paragraphs, "- " makes a list, **bold**, [1] or [1,3] cite sources.
 * The styles are injected below, so no extra files are needed.
 */

export type AnswerSource = {
  /** Headline of the page, message or document */
  title: string;
  /** Short name shown on the citation chip, e.g. "Notion" */
  name: string;
  /** Opens in a new tab */
  href?: string;
  /** A favicon or logo, ideally square */
  icon?: ReactNode;
  /** The passage the answer relies on – shown in the preview */
  snippet?: string;
};

export type AIAnswerProps = {
  /** The question above the answer */
  question?: string;
  sources: AnswerSource[];
  /** The answer text – may grow while `streaming` is true */
  answer: string;
  /** More text is still coming from your model, keep the cursor going */
  streaming?: boolean;
  /** Stream the text in; false shows it at once */
  animate?: boolean;
  /** Words per second while streaming in */
  speed?: number;
  followUps?: string[];
  onFollowUp?: (question: string) => void;
  onRegenerate?: () => void;
  onStop?: () => void;
  onFeedback?: (value: "up" | "down", reason?: string) => void;
  /** Reasons offered after a thumbs down */
  feedbackReasons?: string[];
  onCopy?: (text: string) => void;
  /** Its own white card – leave it off where the answer already sits on a surface (a thread, panel or sheet) */
  framed?: boolean;
  className?: string;
  /** Your own mark in front of the label, in place of the sparkle – it should show the work going on */
  mark?: ReactNode;
  /** Called once the answer has finished writing */
  onDone?: () => void;
  /** Your own rendering of the answer (e.g. Markdown) in place of the parsed text: it shows as it is, and the answer
   * writes while `streaming` is true and is done once it turns false */
  children?: ReactNode;
  /** The label's words while it writes and once done, for a translation */
  labels?: { writing?: string; answer?: string };
};

type Token = { i: number; kind: "word"; text: string; bold?: boolean; code?: boolean } | { i: number; kind: "cite"; ids: number[] };
type Block = { kind: "p"; tokens: Token[] } | { kind: "ul"; items: Token[][] };
type Phase = "reading" | "writing" | "done" | "stopped";

/* ---------- Parsing: paragraphs, lists, **bold** and [1] citations ---------- */

function parse(text: string, sourceCount: number) {
  let i = 0;
  const line = (s: string) => {
    const tokens: Token[] = [];
    for (const part of s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/)) {
      if (!part) continue;
      // `code` is one step of its own, so it never shows half a name
      if (/^`[^`]+`$/.test(part)) {
        tokens.push({ i: i++, kind: "word", text: part.slice(1, -1), code: true });
        continue;
      }
      const cite = part.match(/^\[([\d,\s]+)\]$/);
      if (cite) {
        const ids = cite[1]
          .split(",")
          .map((n) => Number(n) - 1)
          .filter((n) => n >= 0 && n < sourceCount);
        if (!ids.length) continue;
        const last = tokens[tokens.length - 1];
        // [1][3] right after each other become one chip
        if (last?.kind === "cite") last.ids = [...new Set([...last.ids, ...ids])];
        else tokens.push({ i: i++, kind: "cite", ids });
        continue;
      }
      const bold = part.startsWith("**");
      for (const word of (bold ? part.slice(2, -2) : part).match(/\S+\s*|\s+/g) ?? []) {
        // Spaces before a word stick to the word in front, so only words count as steps
        const last = tokens[tokens.length - 1];
        if (!word.trim()) {
          if (last?.kind === "word") last.text += word;
          continue;
        }
        tokens.push({ i: i++, kind: "word", text: word, bold });
      }
    }
    return tokens;
  };
  const blocks: Block[] = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*[-*]\s/.test(l))) {
      blocks.push({ kind: "ul", items: lines.map((l) => line(l.replace(/^\s*[-*]\s/, ""))) });
    } else {
      blocks.push({ kind: "p", tokens: line(lines.join(" ")) });
    }
  }
  return { blocks, total: i };
}

/** The answer as plain text with a numbered source list, for the clipboard */
function plain(text: string, sources: AnswerSource[]) {
  const body = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, ids: string) => ` [${ids.replace(/\s/g, "")}]`)
    .trim();
  if (!sources.length) return body;
  return `${body}\n\nSources:\n${sources.map((s, i) => `[${i + 1}] ${s.title}${s.href ? ` – ${s.href}` : ""}`).join("\n")}`;
}

/* ---------- Icons: 16px, thin 1px lines and solid shapes ---------- */

const Glyph = ({ d, solid, className }: { d: string; solid?: boolean; className?: string }) => (
  <svg viewBox="0 0 16 16" className={["ui-ansc__glyph", className].filter(Boolean).join(" ")} data-solid={solid || undefined} aria-hidden="true">
    <path d={d} />
  </svg>
);
const icons = {
  copy: "M5.5 2A1.5 1.5 0 0 0 4 3.5V4h5A3 3 0 0 1 12 7v5h.5a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 12.5 2h-7ZM3.5 5A1.5 1.5 0 0 0 2 6.5v6A1.5 1.5 0 0 0 3.5 14H9a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 9 5H3.5Z",
  check: "M1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0Zm8.9-1.2a.5.5 0 0 0-.8-.6L7.44 9.23 6.35 8.15a.5.5 0 1 0-.7.7l1.5 1.5a.5.5 0 0 0 .76-.06l2.5-3.5Z",
  redo: "M13 8a5 5 0 1 1-1.46-3.54M13 2.5v2.5h-2.5",
  thumb: "M4.5 7v6.5H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1.5Zm1 6.5h5.95a1.5 1.5 0 0 0 1.47-1.2l.86-4.3A1.5 1.5 0 0 0 12.31 6.2H9.5l.42-2.08A1.4 1.4 0 0 0 7.3 3.1L5.5 6.8v6.7Z",
  chevron: "M10.85 7.65a.5.5 0 0 1 0 .7L7.2 12a.5.5 0 0 1-.7-.7L9.79 8 6.5 4.7a.5.5 0 1 1 .7-.7l3.65 3.65Z",
};

/** The assistant: a solid blue sparkle with a small one beside it – while it works the small one twinkles and the big one breathes */
function AssistantMark() {
  return (
    <svg viewBox="0 0 16 16" className="ui-ansc__mark" aria-hidden="true">
      <path className="ui-ansc__mark-big" d="M6.5 2.2c.2 0 .36.14.4.33.53 2.6 1.4 3.48 4 4.02a.4.4 0 0 1 0 .79c-2.6.53-3.47 1.4-4 4a.4.4 0 0 1-.8 0c-.53-2.6-1.4-3.47-4-4a.4.4 0 0 1 0-.79c2.6-.54 3.47-1.42 4-4.02a.4.4 0 0 1 .4-.33Z" />
      <path className="ui-ansc__mark-small" d="M12 9.6c.12 0 .22.08.25.2.28 1.3.72 1.75 2.03 2.03a.25.25 0 0 1 0 .49c-1.31.28-1.75.72-2.03 2.03a.25.25 0 0 1-.5 0c-.28-1.31-.72-1.75-2.03-2.03a.25.25 0 0 1 0-.49c1.31-.28 1.75-.73 2.03-2.03a.25.25 0 0 1 .25-.2Z" />
    </svg>
  );
}

const READ_MS = 700;
const CARD_MS = 90;
/** Source cards in the row – the rest are a "+N" tile (narrow containers show one card less) */
const MAX_SOURCES = 3;
const count = new Intl.NumberFormat("en");
/** "4.2s", then "5m 12s", then "1h 04m" */
const took = (s: number) => {
  if (s < 60) return `${s}s`;
  const t = Math.round(s);
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
};

export function AIAnswer({
  question,
  sources,
  answer,
  streaming = false,
  animate = true,
  speed = 38,
  followUps = [],
  onFollowUp,
  onRegenerate,
  onStop,
  onFeedback,
  feedbackReasons = ["Not accurate", "Wrong source", "Too long", "Out of date"],
  onCopy,
  framed = false,
  className,
  mark,
  onDone,
  children,
  labels,
}: AIAnswerProps) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const custom = children !== undefined;
  // Your own content glides to its new height only while it writes; once done it takes its own height
  const glide = useRef(true);
  glide.current = !custom || streaming;
  const { blocks, total } = useMemo(() => parse(answer, sources.length), [answer, sources.length]);
  const [run, setRun] = useState(0);
  const [ownPhase, setPhase] = useState<Phase>("reading");
  const phase: Phase = custom ? (streaming ? "writing" : "done") : ownPhase;
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (custom && wasStreaming.current && !streaming) doneRef.current?.();
    wasStreaming.current = streaming;
  }, [custom, streaming]);
  const [shown, setShown] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pop, setPop] = useState<{ ids: number[]; left: number; top: number; width: number } | null>(null);
  const [hoverSource, setHoverSource] = useState<number[] | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const started = useRef(0);
  const prevAnswer = useRef(answer);
  const closeTimer = useRef(0);
  const popId = useId();

  const finished = phase === "done" || phase === "stopped";
  const instant = !animate || reducedMotion();
  // A broken speed (NaN, 0, negative) would never finish – fall back to the default
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 38;

  // A new answer (not just more of the same one) starts over
  useEffect(() => {
    if (!answer.startsWith(prevAnswer.current)) setRun((r) => r + 1);
    prevAnswer.current = answer;
  }, [answer]);

  // Each run: read the sources, then write
  useEffect(() => {
    started.current = performance.now();
    progress.current = 0;
    setShown(0);
    setVote(null);
    setReason(null);
    setCopied(false);
    setPop(null);
    if (instant) {
      progress.current = Infinity;
      setPhase("writing");
      return;
    }
    setPhase("reading");
    const t = window.setTimeout(() => setPhase("writing"), sources.length ? READ_MS + Math.min(sources.length, MAX_SOURCES + 1) * CARD_MS : 0);
    return () => clearTimeout(t);
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps

  // Writing: words appear at `speed`; waits for more text while `streaming`
  useEffect(() => {
    if (phase !== "writing" || custom) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      progress.current = Math.min(total, progress.current + ((now - last) / 1000) * rate);
      last = now;
      setShown(Math.floor(progress.current));
      if (progress.current >= total && !streaming) {
        setSeconds(Math.max(0.1, Math.round((performance.now() - started.current) / 100) / 10));
        setPhase("done");
        doneRef.current?.();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, total, streaming, rate]);

  // The card glides to its new height instead of jumping
  useLayoutEffect(() => {
    const card = cardRef.current;
    const inner = innerRef.current;
    if (!card || !inner) return;
    const set = () => (card.style.height = glide.current ? `${inner.offsetHeight}px` : "");
    set();
    const ro = new ResizeObserver(set);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [streaming]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  const openPop = (ids: number[], el: HTMLElement) => {
    clearTimeout(closeTimer.current);
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const width = Math.min(300, box.width - 16);
    const left = Math.max(8, Math.min(box.width - width - 8, r.left - box.left + r.width / 2 - width / 2));
    setPop({ ids, left, top: r.bottom - box.top + 6, width });
  };
  const closePop = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPop(null), 140);
  };

  const lit = new Set(pop ? pop.ids : (hoverSource ?? []));
  // The "+N" tile lights for cited sources it stands for – from the 4th on, or the 3rd on narrow containers
  const litRest = [...lit].some((id) => id >= MAX_SOURCES);
  const litRestNarrow = [...lit].some((id) => id >= MAX_SOURCES - 1);

  const copy = () => {
    const text = plain(answer, sources);
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    onCopy?.(text);
  };
  const stop = () => {
    setSeconds(Math.max(0.1, Math.round((performance.now() - started.current) / 100) / 10));
    setPhase("stopped");
    onStop?.();
  };
  const regenerate = () => {
    setRun((r) => r + 1);
    onRegenerate?.();
  };
  const voteFor = (value: "up" | "down") => {
    const next = vote === value ? null : value;
    setVote(next);
    setReason(null);
    if (next === "up") onFeedback?.("up");
  };

  const status = copied
    ? "Copied"
    : vote === "up" || reason
      ? "Thanks for the feedback"
      : vote === "down"
        ? "What went wrong?"
        : phase === "stopped"
          ? "Stopped"
          : `Answered in ${took(seconds)}`;

  const label =
    phase === "reading"
      ? `Reading ${count.format(sources.length)} ${sources.length === 1 ? "source" : "sources"}`
      : phase === "writing"
        ? (labels?.writing ?? "Writing")
        : (labels?.answer ?? "Answer");

  // Handlers for the chips stay the same object across renders, so finished paragraphs don't render again on every word
  const latest = useRef({ openPop, closePop, setPop, pop });
  latest.current = { openPop, closePop, setPop, pop };
  const chip = useMemo<ChipHandlers>(
    () => ({
      open: (ids, el) => latest.current.openPop(ids, el),
      close: () => latest.current.closePop(),
      toggle: (ids, el) => (latest.current.pop?.ids === ids ? latest.current.setPop(null) : latest.current.openPop(ids, el)),
      dismiss: () => latest.current.setPop(null),
    }),
    [],
  );
  const litKey = [...lit].sort((a, b) => a - b).join(",");


  return (
    <div
      ref={rootRef}
      className={["ui-ansc", className].filter(Boolean).join(" ")}
      data-phase={phase}
      data-framed={framed || undefined}
      onMouseLeave={() => setHoverSource(null)}
    >
      {/* React 19 hoists this into <head> once, no matter how many answers render */}
      <style href="ui-ai-answer-clean" precedence="default">
        {css}
      </style>

      <div className="ui-ansc__card">
        {/* Only the content glides to its new height – the last row below always stays in view */}
        <div ref={cardRef} className="ui-ansc__body">
          <div ref={innerRef} className="ui-ansc__inner">
            {question && <h3 className="ui-ansc__question" dir="auto">
              {question}
            </h3>}

            {sources.length > 0 && (
              <div
                className="ui-ansc__sources"
                key={`s${run}`}
                aria-label="Sources"
                role="list"
                data-more={sources.length > MAX_SOURCES || undefined}
                data-more-narrow={sources.length > MAX_SOURCES - 1 || undefined}
              >
                {sources.slice(0, MAX_SOURCES).map((s, i) => {
                  const inner = (
                    <>
                      <span className="ui-ansc__site">
                        {s.icon && <span className="ui-ansc__favicon" onErrorCapture={hideBroken}>
                    {s.icon}
                  </span>}
                        <span className="ui-ansc__site-name" title={s.name}>
                        {s.name}
                      </span>
                        <span className="ui-ansc__num">{i + 1}</span>
                      </span>
                      <span className="ui-ansc__title" dir="auto" title={s.title}>
                        {s.title}
                      </span>
                    </>
                  );
                  const props = {
                    className: "ui-ansc__source",
                    "data-lit": lit.has(i) || undefined,
                    style: { animationDelay: instant ? "0ms" : `${120 + i * CARD_MS}ms` },
                    onMouseEnter: () => setHoverSource([i]),
                    onMouseLeave: () => setHoverSource(null),
                  };
                  return (
                    <div key={i} role="listitem" className="ui-ansc__source-wrap">
                      {s.href ? (
                        <a {...props} href={s.href} target="_blank" rel="noreferrer">
                          {inner}
                        </a>
                      ) : (
                        <div {...props}>{inner}</div>
                      )}
                    </div>
                  );
                })}
                {/* The rest: one count tile – their chips in the answer still preview them */}
                {sources.length > MAX_SOURCES - 1 && (
                  <div role="listitem" className="ui-ansc__source-wrap ui-ansc__rest-wrap">
                    <div
                      className="ui-ansc__source ui-ansc__rest"
                      data-lit={litRest || undefined}
                      data-lit-narrow={litRestNarrow || undefined}
                      style={{ animationDelay: instant ? "0ms" : `${120 + MAX_SOURCES * CARD_MS}ms` }}
                      onMouseEnter={(e) => setHoverSource(restIds(e.currentTarget, sources.length))}
                      onMouseLeave={() => setHoverSource(null)}
                    >
                      <span className="ui-ansc__rest-count">
                        <span data-wide>+{count.format(sources.length - MAX_SOURCES)}</span>
                        <span data-narrow>+{count.format(sources.length - MAX_SOURCES + 1)}</span>
                      </span>
                      <span className="ui-ansc__rest-label">more</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="ui-ansc__label">
              {mark ?? <AssistantMark />}
              <span key={label} className={finished ? "ui-ansc__label-text" : "ui-ansc__label-text ui-ansc__shimmer"} data-text={label}>
                {label}
              </span>
            </div>

            <div className="ui-ansc__answer" aria-busy={!finished}>
              {custom ? children : (<>
              {phase === "writing" && shown === 0 && (
                <p>
                  <span className="ui-ansc__caret" aria-hidden="true" />
                </p>
              )}
              {phase === "stopped" && shown === 0 && <p className="ui-ansc__empty">Stopped before answering.</p>}
              {blocks.map((b, bi) => {
                const [first, end] = span(b);
                if (first >= shown) return null;
                return (
                  <AnswerBlock
                    key={`${run}-${bi}`}
                    block={b}
                    shown={Math.min(shown, end)}
                    caret={phase === "writing" && shown <= end}
                    lit={litKey}
                    popIds={pop?.ids ?? null}
                    popId={popId}
                    sources={sources}
                    chip={chip}
                  />
                );
              })}
              </>)}
            </div>

            {phase === "done" && followUps.length > 0 && (
              <div className="ui-ansc__follow">
                <span className="ui-ansc__follow-label">Related</span>
                {followUps.map((q, i) => (
                  <button
                    key={i}
                    type="button"
                    className="ui-ansc__follow-item"
                    style={{ animationDelay: `${instant ? 0 : 80 + i * 60}ms` }}
                    onClick={() => onFollowUp?.(q)}
                  >
                    <span dir="auto">{q}</span>
                    <Glyph d={icons.chevron} solid />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* The last row of the card, under a hairline: stop while writing, actions once done */}
        <div className="ui-ansc__foot">
          {finished ? (
            <div className="ui-ansc__actions" key="actions">
              <button type="button" className="ui-ansc__action" aria-label={copied ? "Copied" : "Copy answer"} onClick={copy}>
                <Glyph d={copied ? icons.check : icons.copy} solid className={copied ? "ui-ansc__ok" : undefined} />
              </button>
              <button type="button" className="ui-ansc__action ui-ansc__redo" aria-label="Regenerate" onClick={regenerate}>
                <Glyph d={icons.redo} />
              </button>
              <button type="button" className="ui-ansc__action" aria-label="Good answer" aria-pressed={vote === "up"} onClick={() => voteFor("up")}>
                <Glyph d={icons.thumb} solid />
              </button>
              <button
                type="button"
                className="ui-ansc__action ui-ansc__down"
                aria-label="Bad answer"
                aria-pressed={vote === "down"}
                onClick={() => voteFor("down")}
              >
                <Glyph d={icons.thumb} solid />
              </button>
            </div>
          ) : (
            <button type="button" className="ui-ansc__stop" key="stop" onClick={stop}>
              <span className="ui-ansc__stop-icon" aria-hidden="true" />
              Stop
            </button>
          )}
          {finished && (
            <span className="ui-ansc__status" key={status} aria-live="polite" title={status}>
              {status.startsWith("Answered in ") ? (
                <>
                  {/* Very narrow screens show just the time */}
                  <span className="ui-ansc__status-lead">Answered in </span>
                  {status.slice("Answered in ".length)}
                </>
              ) : (
                status
              )}
            </span>
          )}
        </div>

        <div className="ui-ansc__reasons" data-open={vote === "down" && !reason}>
          <div>
            {feedbackReasons.map((r, i) => (
              <button
                key={i}
                dir="auto"
                type="button"
                tabIndex={vote === "down" && !reason ? 0 : -1}
                onClick={() => {
                  setReason(r);
                  onFeedback?.("down", r);
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* One preview for whichever chip is hovered or focused */}
      {pop && (
        <div
          id={popId}
          role="tooltip"
          className="ui-ansc__pop"
          style={{ left: pop.left, top: pop.top, width: pop.width }}
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={closePop}
        >
          {pop.ids.map((id) => {
            const s = sources[id];
            return (
              <a key={id} className="ui-ansc__pop-item" href={s.href} target="_blank" rel="noreferrer" tabIndex={-1}>
                <span className="ui-ansc__site">
                  {s.icon && <span className="ui-ansc__favicon" onErrorCapture={hideBroken}>
                    {s.icon}
                  </span>}
                  <span className="ui-ansc__site-name">{s.href ? s.href.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] : s.name}</span>
                  <span className="ui-ansc__num">{id + 1}</span>
                </span>
                <span className="ui-ansc__pop-title" dir="auto">
                  {s.title}
                </span>
                {s.snippet && pop.ids.length === 1 && <span className="ui-ansc__snippet" dir="auto">
                    {s.snippet}
                  </span>}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- One paragraph or list of the answer – renders again only when its own words change ---------- */

type ChipHandlers = {
  open: (ids: number[], el: HTMLElement) => void;
  close: () => void;
  toggle: (ids: number[], el: HTMLElement) => void;
  dismiss: () => void;
};

/** The first token of a block and the one after its last */
const span = (b: Block): [number, number] => {
  const tokens = b.kind === "p" ? b.tokens : b.items.flat();
  return tokens.length ? [tokens[0].i, tokens[tokens.length - 1].i + 1] : [Infinity, Infinity];
};

const AnswerBlock = memo(function AnswerBlock({
  block,
  shown,
  caret,
  lit,
  popIds,
  popId,
  sources,
  chip,
}: {
  block: Block;
  shown: number;
  caret: boolean;
  lit: string;
  popIds: number[] | null;
  popId: string;
  sources: AnswerSource[];
  chip: ChipHandlers;
}) {
  const litSet = new Set(lit ? lit.split(",").map(Number) : []);
  const tokens = (list: Token[]) =>
    list.map((t) => {
      if (t.i >= shown) return null;
      const mark = caret && t.i === shown - 1 ? <span className="ui-ansc__caret" aria-hidden="true" /> : null;
      if (t.kind === "word") {
        return (
          <span key={t.i} className="ui-ansc__w" data-bold={t.bold || undefined}>
            {t.code ? (
              <>
                <code className="ui-ansc__code">{t.text.trimEnd()}</code>
                {t.text.slice(t.text.trimEnd().length)}
              </>
            ) : (
              t.text
            )}
            {mark}
          </span>
        );
      }
      const first = sources[t.ids[0]];
      const names = t.ids.map((id) => sources[id].title).join(", ");
      return (
        <span key={t.i} className="ui-ansc__w">
          <button
            type="button"
            className="ui-ansc__cite"
            title={names}
            data-lit={t.ids.some((id) => litSet.has(id)) || undefined}
            aria-label={`Source: ${names}`}
            aria-describedby={popIds === t.ids ? popId : undefined}
            onMouseEnter={(e) => chip.open(t.ids, e.currentTarget)}
            onMouseLeave={chip.close}
            onFocus={(e) => chip.open(t.ids, e.currentTarget)}
            onBlur={chip.close}
            onClick={(e) => chip.toggle(t.ids, e.currentTarget)}
            onKeyDown={(e) => e.key === "Escape" && chip.dismiss()}
          >
            <span className="ui-ansc__cite-name">{first.name}</span>
            {t.ids.length > 1 && <span className="ui-ansc__more">+{t.ids.length - 1}</span>}
          </button>
          {mark}
        </span>
      );
    });
  return block.kind === "p" ? (
    <p dir="auto">{tokens(block.tokens)}</p>
  ) : (
    <ul>
      {block.items.map((item, ii) =>
        item[0] && item[0].i < shown ? (
          <li key={ii} dir="auto">
            {tokens(item)}
          </li>
        ) : null,
      )}
    </ul>
  );
});

/** The sources behind the "+N" tile – the CSS says how many cards the row shows at its current width */
const restIds = (tile: HTMLElement, total: number) => {
  const from = Number(getComputedStyle(tile).getPropertyValue("--ui-ansc-shown")) || MAX_SOURCES;
  return Array.from({ length: Math.max(0, total - from) }, (_, k) => from + k);
};

/** A favicon that fails to load leaves its tile – the name stays */
const hideBroken = (e: { currentTarget: HTMLElement }) => (e.currentTarget.hidden = true);

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* ---------- Styles ---------- */

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-ansc */
.ui-ansc {
  --ui-ansc-card: #ffffff;
  --ui-ansc-ink: rgba(0, 0, 0, 0.88);
  --ui-ansc-strong: #000000;
  --ui-ansc-text: rgba(0, 0, 0, 0.61);
  --ui-ansc-muted: rgba(0, 0, 0, 0.45);
  --ui-ansc-faint: rgba(0, 0, 0, 0.27);
  --ui-ansc-icon: rgba(0, 0, 0, 0.447);
  --ui-ansc-line: rgba(0, 0, 0, 0.06);
  --ui-ansc-fill: rgba(0, 0, 0, 0.06);
  --ui-ansc-fill-strong: rgba(0, 0, 0, 0.1);
  --ui-ansc-wash: rgba(0, 0, 0, 0.015);
  --ui-ansc-accent: rgba(0, 96, 226, 0.765);
  --ui-ansc-ok: #1a9a52;
  --ui-ansc-shine: rgba(255, 255, 255, 0.82);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-ansc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-ansc-shadow-pop: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 12px 28px -10px rgba(0, 0, 0, 0.16), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-ansc-focus: rgba(0, 96, 226, 0.35);
  --ui-ansc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  position: relative;
  box-sizing: border-box;
  container-type: inline-size;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  max-width: 640px;
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-ansc-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-ansc *, .ui-ansc *::before, .ui-ansc *::after { box-sizing: border-box; }
:where(.ui-ansc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
:where(.ui-ansc) svg { display: block; flex: none; }
.ui-ansc button:focus-visible, .ui-ansc a:focus-visible { outline: 2px solid var(--ui-ansc-focus); outline-offset: 1px; }

/* No surface by default: the content sits right in its thread, panel or sheet.
   The height glide clips only top and bottom – with 4px of room there, so focus rings stay whole */
.ui-ansc__body { overflow: visible clip; margin: -4px 0; transition: height 360ms var(--ui-ansc-ease); }
.ui-ansc__inner { display: flow-root; padding: 4px 0; }

/* framed: one white card – the edge is a shadow, not a border */
.ui-ansc[data-framed] .ui-ansc__card {
  overflow: hidden;
  border-radius: 10px;
  background: var(--ui-ansc-card);
  box-shadow: var(--ui-ansc-shadow);
}
.ui-ansc[data-framed] .ui-ansc__body { overflow: hidden; margin: 0; }
.ui-ansc[data-framed] .ui-ansc__inner { padding: 20px 20px 16px; }
.ui-ansc__question { margin: 0 0 14px; font-size: 15px; font-weight: 500; line-height: 24px; color: var(--ui-ansc-strong); overflow-wrap: anywhere; }

/* Sources: up to three small white cards in a row that fits the width, then a "+N" tile */
.ui-ansc__sources {
  --ui-ansc-shown: 3;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.ui-ansc__sources[data-more] { grid-template-columns: repeat(3, minmax(0, 1fr)) auto; }
.ui-ansc__source-wrap { display: flex; min-width: 0; }
.ui-ansc__sources:not([data-more]) > .ui-ansc__rest-wrap { display: none; }
.ui-ansc__source {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 8px 10px 9px;
  border-radius: 8px;
  background: var(--ui-ansc-card);
  box-shadow: var(--ui-ansc-shadow);
  color: inherit;
  text-decoration: none;
  transition: background-color 160ms ease, box-shadow 200ms ease;
  animation: ui-ansc-card 460ms var(--ui-ansc-ease) both;
}
a.ui-ansc__source:hover { background: var(--ui-ansc-wash); }
.ui-ansc__source[data-lit] { background: var(--ui-ansc-wash); box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
.ui-ansc__site { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--ui-ansc-text); }
.ui-ansc__site-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-ansc__num { flex: none; font-size: 10px; line-height: 16px; font-weight: 500; letter-spacing: 0.5px; font-variant-numeric: tabular-nums; color: var(--ui-ansc-faint); }
.ui-ansc__favicon {
  display: grid;
  flex: none;
  width: 14px;
  height: 14px;
  overflow: hidden;
  border-radius: 4px;
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1);
}
.ui-ansc__favicon[hidden] { display: none; }
.ui-ansc__favicon > * { width: 100%; height: 100%; object-fit: contain; }
.ui-ansc__rest { justify-content: space-between; min-width: 52px; }
.ui-ansc__rest-count { font-size: 13px; font-weight: 500; line-height: 20px; font-variant-numeric: tabular-nums; color: var(--ui-ansc-strong); white-space: nowrap; }
.ui-ansc__rest-count [data-narrow] { display: none; }
.ui-ansc__rest-label { font-size: 12px; line-height: 16px; color: var(--ui-ansc-text); }
.ui-ansc__title {
  overflow-wrap: anywhere;
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--ui-ansc-strong);
}

/* "Reading 6 sources" → "Writing" → "Answer" */
.ui-ansc__label { display: flex; align-items: center; gap: 6px; margin: 16px 0 6px; font-size: 12px; line-height: 16px; color: var(--ui-ansc-text); }
.ui-ansc__mark { width: 16px; height: 16px; fill: var(--ui-ansc-accent); overflow: visible; }
.ui-ansc__mark path { transform-box: fill-box; transform-origin: center; }
/* While it works the big sparkle breathes and the small one twinkles */
.ui-ansc[data-phase="reading"] .ui-ansc__mark-big,
.ui-ansc[data-phase="writing"] .ui-ansc__mark-big { animation: ui-ansc-breathe 1.4s ease-in-out infinite; }
.ui-ansc[data-phase="reading"] .ui-ansc__mark-small,
.ui-ansc[data-phase="writing"] .ui-ansc__mark-small { animation: ui-ansc-twinkle 1.4s ease-in-out infinite; }
.ui-ansc__label-text { position: relative; animation: ui-ansc-fade 320ms var(--ui-ansc-ease) both; }
.ui-ansc[data-phase="done"] .ui-ansc__label-text,
.ui-ansc[data-phase="stopped"] .ui-ansc__label-text { color: var(--ui-ansc-text); }

/* The answer */
.ui-ansc__answer { font-size: 13px; line-height: 20px; color: var(--ui-ansc-ink); overflow-wrap: anywhere; }
.ui-ansc__answer p { margin: 0 0 8px; }
.ui-ansc__answer ul { margin: 0 0 8px; padding: 0 0 0 18px; }
.ui-ansc__answer li { margin: 0 0 4px; padding-left: 2px; }
.ui-ansc__answer li::marker { color: var(--ui-ansc-faint); }
.ui-ansc__answer > :last-child { margin-bottom: 0; }
.ui-ansc__empty { color: var(--ui-ansc-muted); }
.ui-ansc__w { animation: ui-ansc-word 420ms var(--ui-ansc-ease) both; }
.ui-ansc__w[data-bold] { font-weight: 500; color: var(--ui-ansc-strong); }
.ui-ansc__code { padding: 1px 4px; border-radius: 4px; background: var(--ui-ansc-fill); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em; }
.ui-ansc__caret {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 4px;
  border-radius: 1.5px;
  background: var(--ui-ansc-accent);
  vertical-align: 0.1em;
  animation: ui-ansc-pulse 1s ease-in-out infinite;
}

/* Citation chips: the gray tab look; the linked one gets a touch darker */
.ui-ansc__cite {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 3px;
  height: 18px;
  margin: 0 1px 0 3px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--ui-ansc-fill);
  box-shadow: inset 0 0 0 0.5px var(--ui-ansc-line);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  color: var(--ui-ansc-text);
  vertical-align: 0.1em;
  transition: background-color 160ms ease, color 160ms ease;
  animation: ui-ansc-chip 380ms var(--ui-ansc-ease) both;
}
.ui-ansc__cite:hover,
.ui-ansc__cite[data-lit] { background: var(--ui-ansc-fill-strong); color: var(--ui-ansc-ink); }
.ui-ansc__cite-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-ansc__more { flex: none; opacity: 0.7; }

/* Preview of the cited source */
.ui-ansc__pop {
  position: absolute;
  z-index: 5;
  display: grid;
  gap: 2px;
  padding: 4px;
  border-radius: 10px;
  background: var(--ui-ansc-card);
  box-shadow: var(--ui-ansc-shadow-pop);
  animation: ui-ansc-pop 200ms var(--ui-ansc-ease) both;
}
.ui-ansc__pop-item { display: grid; gap: 2px; padding: 8px 10px 9px; border-radius: 6px; color: inherit; text-decoration: none; transition: background-color 140ms ease; }
.ui-ansc__pop-item[href]:hover { background: var(--ui-ansc-wash); }
.ui-ansc__pop-title { font-size: 13px; font-weight: 500; line-height: 20px; color: var(--ui-ansc-strong); overflow-wrap: anywhere; }
.ui-ansc__snippet {
  overflow-wrap: anywhere;
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  font-size: 12px;
  line-height: 16px;
  color: var(--ui-ansc-text);
}

/* Follow-up questions */
.ui-ansc__follow { display: grid; grid-template-columns: minmax(0, 1fr); margin-top: 16px; }
.ui-ansc__follow-label {
  padding-bottom: 4px;
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--ui-ansc-muted);
  animation: ui-ansc-fade 320ms var(--ui-ansc-ease) both;
}
.ui-ansc__follow-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
  padding: 6px 0;
  border-top: 0.5px solid var(--ui-ansc-line);
  text-align: left;
  color: var(--ui-ansc-ink);
  animation: ui-ansc-fade 380ms var(--ui-ansc-ease) both;
}
.ui-ansc__follow-item > span { min-width: 0; overflow-wrap: anywhere; }
.ui-ansc__follow-item .ui-ansc__glyph { color: var(--ui-ansc-faint); transition: transform 220ms var(--ui-ansc-ease), color 160ms ease; }
.ui-ansc__follow-item:hover .ui-ansc__glyph { color: var(--ui-ansc-ink); transform: translateX(2px); }

/* The last row: stop or actions – inside the card under a hairline when framed */
.ui-ansc__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  margin-top: 4px;
}
.ui-ansc[data-framed] .ui-ansc__foot { margin-top: 0; padding: 0 12px 0 8px; border-top: 0.5px solid var(--ui-ansc-line); }
.ui-ansc__actions { display: flex; flex: none; gap: 2px; }
.ui-ansc__action {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--ui-ansc-icon);
  transition: background-color 160ms ease, color 160ms ease, box-shadow 160ms ease;
  animation: ui-ansc-fade 320ms var(--ui-ansc-ease) both;
}
.ui-ansc__action:nth-child(2) { animation-delay: 40ms; }
.ui-ansc__action:nth-child(3) { animation-delay: 80ms; }
.ui-ansc__action:nth-child(4) { animation-delay: 120ms; }
.ui-ansc__action:hover { background: var(--ui-ansc-wash); color: var(--ui-ansc-ink); }
/* Pressed: the selected-tab look */
.ui-ansc__action[aria-pressed="true"] { background: var(--ui-ansc-fill); box-shadow: inset 0 0 0 0.5px var(--ui-ansc-line); color: var(--ui-ansc-ink); }
.ui-ansc__glyph { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; }
.ui-ansc__glyph[data-solid] { fill: currentColor; stroke: none; }
.ui-ansc__down .ui-ansc__glyph { transform: scaleY(-1); }
.ui-ansc__redo:active .ui-ansc__glyph { transform: rotate(120deg); transition: transform 300ms var(--ui-ansc-ease); }
.ui-ansc__ok { color: var(--ui-ansc-ok); animation: ui-ansc-chip 260ms var(--ui-ansc-ease) both; }
.ui-ansc__action:has(.ui-ansc__ok) { color: var(--ui-ansc-ok); }
.ui-ansc__status { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 12px; line-height: 16px; white-space: nowrap; color: var(--ui-ansc-muted); animation: ui-ansc-fade 260ms var(--ui-ansc-ease) both; }
@container (max-width: 330px) {
  .ui-ansc__status-lead { display: none; }
}
/* Stop: the white button with the hairline shadow */
.ui-ansc__stop {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px 0 8px;
  border-radius: 6px;
  background: var(--ui-ansc-card);
  box-shadow: var(--ui-ansc-shadow);
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-ansc-strong);
  transition: background-color 160ms ease;
  animation: ui-ansc-fade 260ms var(--ui-ansc-ease) both;
}
.ui-ansc__stop:hover { background: #fafafa; }
.ui-ansc__stop-icon { width: 8px; height: 8px; margin: 0 2px; border-radius: 2px; background: var(--ui-ansc-ink); }

/* Reasons after a thumbs down fold out below – in the tab-button look */
.ui-ansc__reasons { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 320ms var(--ui-ansc-ease), opacity 200ms ease; }
.ui-ansc__reasons[data-open="true"] { grid-template-rows: 1fr; opacity: 1; }
/* Clipped only top and bottom while folding, with 4px of room so the focus rings stay whole */
.ui-ansc__reasons > div { display: flex; flex-wrap: wrap; gap: 8px; min-height: 0; overflow: visible clip; margin-top: -4px; padding: 4px 0 0; }
.ui-ansc__reasons[data-open="true"] > div { padding-bottom: 4px; }
.ui-ansc[data-framed] .ui-ansc__reasons > div { overflow: hidden; padding: 4px 12px 0; }
.ui-ansc[data-framed] .ui-ansc__reasons[data-open="true"] > div { padding-bottom: 12px; }
.ui-ansc__reasons button {
  min-height: 28px;
  max-width: 100%;
  padding: 4px 10px;
  overflow-wrap: anywhere;
  text-align: start;
  border-radius: 6px;
  box-shadow: inset 0 0 0 0.5px var(--ui-ansc-line);
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-ansc-text);
  transition: color 140ms ease, background-color 140ms ease;
}
.ui-ansc__reasons button:hover { color: var(--ui-ansc-ink); background: var(--ui-ansc-fill); }

/* Shimmer over the working label – a darker band runs through the gray text */
.ui-ansc__shimmer::after {
  content: attr(data-text);
  content: attr(data-text) / "";
  position: absolute;
  inset: 0;
  white-space: nowrap;
  color: transparent;
  background: linear-gradient(90deg, transparent 38%, var(--ui-ansc-shine) 50%, transparent 62%) 100% 0 / 300% 100% no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  animation: ui-ansc-sweep 1.6s linear infinite;
  pointer-events: none;
}

@keyframes ui-ansc-word { from { opacity: 0; filter: blur(3px); } to { opacity: 1; filter: none; } }
@keyframes ui-ansc-card { from { opacity: 0; transform: translateY(4px) scale(0.97); } to { opacity: 1; transform: none; } }
@keyframes ui-ansc-chip { from { opacity: 0; transform: scale(0.8); } to { opacity: 1; transform: none; } }
@keyframes ui-ansc-fade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes ui-ansc-pop { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes ui-ansc-pulse { 50% { opacity: 0.3; } }
@keyframes ui-ansc-breathe { 50% { transform: scale(0.86); } }
@keyframes ui-ansc-twinkle { 0%, 100% { opacity: 1; transform: none; } 50% { opacity: 0.3; transform: scale(0.6) rotate(45deg); } }
@keyframes ui-ansc-sweep { from { background-position: 100% 0; } to { background-position: 0% 0; } }

/* Narrow (phones) */
@container (max-width: 480px) {
  .ui-ansc[data-framed] .ui-ansc__inner { padding: 16px 16px 14px; }
  /* Two cards, the third joins the "+N" tile */
  .ui-ansc__sources { --ui-ansc-shown: 2; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ui-ansc__sources[data-more-narrow] { grid-template-columns: repeat(2, minmax(0, 1fr)) auto; }
  .ui-ansc__sources[data-more-narrow] > :nth-child(3) { display: none; }
  .ui-ansc__sources[data-more-narrow] > .ui-ansc__rest-wrap { display: flex; }
  .ui-ansc__rest-count [data-wide] { display: none; }
  .ui-ansc__rest-count [data-narrow] { display: inline; }
  .ui-ansc__rest[data-lit-narrow] { background: var(--ui-ansc-wash); box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05); }
}
/* Touch screens: bigger tap targets – the citation chips keep their size but get a larger invisible hit area */
@media (hover: none) and (pointer: coarse) {
  .ui-ansc__action { width: 36px; height: 36px; }
  .ui-ansc__foot { height: 52px; }
  .ui-ansc__stop { height: 34px; }
  .ui-ansc__reasons button { min-height: 34px; padding: 4px 12px; }
  .ui-ansc__follow-item { min-height: 44px; }
  .ui-ansc__cite { position: relative; }
  .ui-ansc__cite::after { content: ""; position: absolute; inset: -10px -4px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-ansc *, .ui-ansc *::before, .ui-ansc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-ansc {
  --ui-ansc-card: #1c1c1e;
  --ui-ansc-ink: rgba(255, 255, 255, 0.9);
  --ui-ansc-strong: #ffffff;
  --ui-ansc-text: rgba(255, 255, 255, 0.62);
  --ui-ansc-muted: rgba(255, 255, 255, 0.46);
  --ui-ansc-faint: rgba(255, 255, 255, 0.28);
  --ui-ansc-icon: rgba(255, 255, 255, 0.5);
  --ui-ansc-line: rgba(255, 255, 255, 0.08);
  --ui-ansc-fill: rgba(255, 255, 255, 0.08);
  --ui-ansc-fill-strong: rgba(255, 255, 255, 0.13);
  --ui-ansc-wash: rgba(255, 255, 255, 0.025);
  --ui-ansc-accent: #4d8dff;
  --ui-ansc-ok: #3ec27a;
  --ui-ansc-shine: #ffffff;
  --ui-ansc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-ansc-shadow-pop: 0 0 0 0.5px rgba(255, 255, 255, 0.12), 0 12px 28px -10px rgba(0, 0, 0, 0.6);
  --ui-ansc-focus: rgba(77, 141, 255, 0.5);
}
:where(.dark, [data-theme="dark"]) .ui-ansc__source[data-lit] { box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.16); }
@container (max-width: 480px) {
  :where(.dark, [data-theme="dark"]) .ui-ansc__rest[data-lit-narrow] { box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.16); }
}
:where(.dark, [data-theme="dark"]) .ui-ansc__stop:hover { background: #232326; }
:where(.dark, [data-theme="dark"]) .ui-ansc__favicon { box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.14); }
`;
