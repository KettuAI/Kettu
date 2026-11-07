// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

/*
 * Context Window (clean style) – what fills an AI model's context right now, and what you can do about it, in one
 * self-contained file. One white card with hairline shadows; the caption and the action sit in its last row.
 * The window is drawn as a field of small cells: every cell is a slice of the token limit, colored by what sits in
 * it – system prompt, tools, files, the conversation, memory. Empty cells are the room that is left.
 *   · hover a part and its cells stay lit while the rest fades; the big number rolls to that part
 *   · open a part with items (files, tools) and remove single ones – the cells empty in a sweep and everything moves up
 *   · press Compact on the conversation: its cells shimmer while it works, then most of them clear
 *   · the percentage tag turns amber before the window is full, and the last row says how much is left
 * The styles are injected below, so no extra files are needed.
 */

export type ContextItem = {
  id: string;
  label: string;
  tokens: number;
  /** Shown on hover in place of the label, e.g. a whole path the label shortens */
  title?: string;
};

export type ContextPart = {
  id: string;
  label: string;
  /** Tokens of this part – when `items` are given and this is not, it is their sum */
  tokens?: number;
  /** Single things inside this part that can be removed, e.g. attached files */
  items?: ContextItem[];
  /** Nothing can be removed or compacted here, e.g. the system prompt */
  locked?: boolean;
  /** Shows a Compact button. A number is the share that stays after compacting (default 0.3) */
  compact?: boolean | number;
  /** Any CSS color – defaults to a fixed palette in the order of the parts */
  color?: string;
  /** Held back rather than used, e.g. an autocompact buffer: drawn and listed, not in the total */
  reserved?: boolean;
  /** Its row opens something elsewhere: a pointer and a pressed state */
  link?: boolean;
};

export type ContextWindowProps = {
  parts: ContextPart[];
  /** Size of the context window in tokens */
  limit: number;
  title?: string;
  /** Small tag in the head, e.g. the model name */
  model?: string;
  /** Logo in front of the model name – any node, sized to 12px */
  modelIcon?: ReactNode;
  /** Called when an item is removed. With it the card shows exactly the parts you pass; without it the removal lives inside the card */
  onRemoveItem?: (partId: string, itemId: string) => void;
  /** Called when Compact is pressed; the cells shimmer until the returned promise settles. Without it the card shrinks the part on its own */
  onCompact?: (partId: string) => void | Promise<void>;
  /** A button in the card's last row, e.g. { label: "New chat", onClick } */
  action?: { label: string; onClick: () => void };
  /** Share of the limit from which the card warns (0–1) */
  warnAt?: number;
  /** Number of cells and how many sit in one row */
  cells?: number;
  columns?: number;
  className?: string;
  /** Items can only be looked at, not removed */
  readOnly?: boolean;
  labels?: Partial<ContextLabels>;
};

/** Words the card shows – pass your own to translate them; `n` comes formatted, such as 12.4K */
export type ContextLabels = {
  free: (n: string) => string;
  left: (n: string) => string;
  over: (n: string) => string;
  full: string;
  of: (n: string) => string;
  share: (percent: string) => string;
  used: (used: string, cap: string, percent: number) => string;
  nothing: string;
  remove: (label: string) => string;
};

const defaultLabels: ContextLabels = {
  free: (n) => `${n} free`,
  left: (n) => `${n} left`,
  over: (n) => `${n} over the limit`,
  full: "Window is full",
  of: (n) => `of ${n} tokens`,
  share: (percent) => `${percent}% of the window`,
  used: (used, cap, percent) => `${used} of ${cap} tokens used, ${percent} percent`,
  nothing: "Nothing attached",
  remove: (label) => `Remove ${label}`,
};

/* ---------- Helpers ---------- */

const PALETTE = [
  "var(--ui-cwc-c1)",
  "var(--ui-cwc-c2)",
  "var(--ui-cwc-c3)",
  "var(--ui-cwc-c4)",
  "var(--ui-cwc-c5)",
  "var(--ui-cwc-c6)",
];
/** A count we can trust: NaN, Infinity and negatives read as 0 */
const count = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0);
const tokens = (n: number) => {
  const v = count(n);
  if (v >= 999_950_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 999_950) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return `${Math.round(v)}`;
};
/** For numbers that stand still: 200K instead of 200.0K */
const plain = (n: number) => tokens(n).replace(/\.0(?=[KMB]$)/, "");
/** The exact number for tooltips, e.g. 1,284,903 */
const exact = (n: number) => Math.round(count(n)).toLocaleString("en-US");
const ease = (t: number) => 1 - Math.pow(1 - t, 4);
const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Rolls a set of named numbers from where they are to their targets, in one animation frame loop */
function useRolling(target: Record<string, number>, duration: number) {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  const signature = JSON.stringify(target);
  useEffect(() => {
    const to = JSON.parse(signature) as Record<string, number>;
    const from = { ...current.current };
    if (reduced() || Object.keys(to).every((k) => from[k] === to[k])) {
      current.current = to;
      setShown(to);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      const next: Record<string, number> = {};
      for (const k in to)
        next[k] = (from[k] ?? to[k]) + (to[k] - (from[k] ?? to[k])) * e;
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [signature, duration]);
  return shown;
}

/**
 * Text that changes without a jump: the old line stays for a moment and fades out underneath while the new one fades in.
 * Quick changes (moving across rows) just retarget – nothing piles up.
 */
function Swap({ id, tone, children }: { id: string; tone?: string; children: ReactNode }) {
  type Line = { id: string; tone?: string; node: ReactNode };
  const last = useRef<Line>({ id, tone, node: children });
  const [shownId, setShownId] = useState(id);
  const [out, setOut] = useState<Line | null>(null);
  if (shownId !== id) {
    // A new line: what was on screen until now becomes the one that fades out
    setShownId(id);
    setOut(last.current);
  }
  last.current = { id, tone, node: children };
  useEffect(() => {
    if (!out) return;
    const timer = window.setTimeout(() => setOut(null), 260);
    return () => window.clearTimeout(timer);
  }, [out]);
  return (
    <span className="ui-cwc__swap">
      {out && (
        <span key={`out-${out.id}`} className="ui-cwc__swap-item" data-out="" data-tone={out.tone} aria-hidden="true">
          {out.node}
        </span>
      )}
      <span key={id} className="ui-cwc__swap-item" data-tone={tone}>
        {children}
      </span>
    </span>
  );
}

/* ---------- Icons ---------- */

const line = {
  stroke: "currentColor",
  strokeWidth: 1.1,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;
const ChevronIcon = () => (
  <svg
    className="ui-cwc__chevron"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path d="m5 6.75 3 3 3-3" {...line} />
  </svg>
);
const CloseIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path d="m5 5 6 6m0-6-6 6" {...line} />
  </svg>
);
const DoneIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m2.6 6.3 2.2 2.2 4.6-5" {...line} strokeWidth={1.3} />
  </svg>
);
const CompactIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M6 1.5v3m0 0L4.6 3.1M6 4.5l1.4-1.4M6 10.5v-3m0 0L4.6 8.9M6 7.5l1.4 1.4M2 6h8"
      {...line}
    />
  </svg>
);
const ArrowIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
  >
    <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" {...line} />
  </svg>
);

/** The removable items of one part – drawn again only when they change */
const Items = memo(function Items({
  partId,
  items,
  leaving,
  onRemove,
  readOnly,
  labels,
}: {
  partId: string;
  items: ContextItem[];
  leaving: Record<string, true>;
  onRemove: (partId: string, itemId: string) => void;
  readOnly?: boolean;
  labels: ContextLabels;
}) {
  return (
    <ul className="ui-cwc__items">
      {items.length === 0 && <li className="ui-cwc__empty">{labels.nothing}</li>}
      {items.map((it) => (
        <li key={it.id} className="ui-cwc__fold ui-cwc__fold--item" data-open={leaving[`${partId}/${it.id}`] ? undefined : ""}>
          <div className="ui-cwc__clip">
            <div className="ui-cwc__item">
              <span className="ui-cwc__item-label" title={it.title ?? it.label} dir="auto">
                {it.label}
              </span>
              <span className="ui-cwc__item-value" title={`${exact(it.tokens)} tokens`}>
                {tokens(it.tokens)}
              </span>
              {!readOnly && (
                <button type="button" className="ui-cwc__remove" aria-label={labels.remove(it.label)} onClick={() => onRemove(partId, it.id)}>
                  <CloseIcon />
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
});

export function ContextWindow({
  parts,
  limit,
  title = "Context window",
  model,
  modelIcon,
  onRemoveItem,
  onCompact,
  action,
  warnAt = 0.8,
  cells = 216,
  columns = 36,
  className,
  readOnly,
  labels: ownLabels,
}: ContextWindowProps) {
  const labels = { ...defaultLabels, ...ownLabels };
  const uid = useId();
  // Without callbacks the card keeps its own record of what was removed and compacted
  const [removed, setRemoved] = useState<Record<string, true>>({});
  const [shrunk, setShrunk] = useState<Record<string, number>>({});
  /** Items that are folding away before they go */
  const [leaving, setLeaving] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: number; amount: number } | null>(
    null,
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The items of each part keep their identity between renders, so a long list isn't drawn again on every hover
  const itemsOf = useMemo(
    () =>
      Object.fromEntries(
        parts.map((p) => [p.id, p.items?.filter((it) => onRemoveItem || !removed[`${p.id}/${it.id}`])]),
      ),
    [parts, removed, onRemoveItem],
  );
  const list = parts.map((p, i) => {
    const items = itemsOf[p.id];
    const raw = items && p.tokens === undefined
      ? items.reduce((sum, it) => sum + count(it.tokens), 0)
      : count(p.tokens);
    return {
      ...p,
      items,
      tokens:
        shrunk[p.id] !== undefined && !onCompact
          ? Math.min(raw, shrunk[p.id])
          : raw,
      color: p.color ?? PALETTE[i % PALETTE.length],
    };
  });
  const used = list.reduce((sum, p) => sum + (p.reserved ? 0 : p.tokens), 0);
  const held = list.reduce((sum, p) => sum + (p.reserved ? p.tokens : 0), 0);
  // Without a usable limit there is no window to fill
  const cap = count(limit);
  const share = cap > 0 ? used / cap : 0;
  const level = share >= 0.95 ? "full" : share >= warnAt ? "warn" : "ok";
  const hotPart = list.find((p) => p.id === hot) ?? null;

  // One tween for the total, the big figure (total or hovered part) and every row
  const target: Record<string, number> = {
    "#used": used,
    "#figure": hotPart ? hotPart.tokens : used,
  };
  for (const p of list) target[p.id] = p.tokens;
  const shown = useRolling(target, 640);

  // Which part each cell belongs to: the parts fill the field in order, the rest stays empty
  const perCell = cap / cells;
  const owner: (number | null)[] = new Array(cells).fill(null);
  let sum = 0;
  let from = 0;
  if (cap > 0) list.forEach((p, index) => {
    sum += p.tokens;
    const to = Math.min(
      cells,
      Math.max(p.tokens > 0 ? from + 1 : from, Math.round(sum / perCell)),
    );
    for (let i = from; i < to; i++) owner[i] = index;
    from = to;
  });

  /* ---------- Actions ---------- */

  const remove = async (partId: string, itemId: string) => {
    const key = `${partId}/${itemId}`;
    setLeaving((l) => ({ ...l, [key]: true }));
    if (!reduced()) await wait(240);
    if (!alive.current) return;
    setLeaving(({ [key]: _gone, ...rest }) => rest);
    if (onRemoveItem) onRemoveItem(partId, itemId);
    else setRemoved((r) => ({ ...r, [key]: true }));
  };

  const removeRef = useRef(remove);
  removeRef.current = remove;
  const onRemove = useCallback((partId: string, itemId: string) => removeRef.current(partId, itemId), []);

  const compact = async (part: (typeof list)[number]) => {
    if (busy) return;
    setBusy(part.id);
    const before = part.tokens;
    // The shimmer runs at least long enough to be seen
    await Promise.all([
      Promise.resolve(onCompact?.(part.id)).catch(() => {}),
      wait(reduced() ? 0 : 1300),
    ]);
    if (!alive.current) return;
    setBusy(null);
    // Compacted parts can't be compacted again – until they have grown past this size
    setCompacted((c) => ({ ...c, [part.id]: before }));
    setFarewell({ id: part.id, leaving: false });
    if (!onCompact) {
      const keep = typeof part.compact === "number" ? part.compact : 0.3;
      const after = Math.round(before * keep);
      setShrunk((s) => ({ ...s, [part.id]: after }));
      setCompacted((c) => ({ ...c, [part.id]: after }));
      setSaved({ id: Date.now(), amount: before - after });
    } else {
      // The parent passes the smaller part in a moment – note what it was, to say how much was saved
      watch.current = { id: part.id, before };
    }
  };
  const watch = useRef<{ id: string; before: number } | null>(null);
  const watched = watch.current
    ? (list.find((p) => p.id === watch.current?.id)?.tokens ?? 0)
    : 0;
  useEffect(() => {
    const w = watch.current;
    if (!w || watched >= w.before) return;
    watch.current = null;
    setCompacted((c) => ({ ...c, [w.id]: watched }));
    setSaved({ id: Date.now(), amount: w.before - watched });
  }, [watched]);
  // "Saved …" stays in the last row for a moment
  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(null), 3200);
    return () => window.clearTimeout(id);
  }, [saved]);

  /* ---------- What the last row says ---------- */

  const free = Math.max(0, cap - used - held);
  let caption: ReactNode = labels.free(plain(free));
  let captionKey = "rest";
  let captionTone: string | undefined;
  if (busy) {
    caption = (
      <span className="ui-cwc__shimmer" data-text="Compacting…">
        Compacting…
      </span>
    );
    captionKey = "busy";
  } else if (hotPart) {
    caption = (
      // The name may shorten, the share never does
      <span className="ui-cwc__hot">
        <b dir="auto">{hotPart.label}</b>
        <span>
          {" "}·{" "}
          {labels.share(cap > 0 ? ((hotPart.tokens / cap) * 100).toFixed(hotPart.tokens / cap < 0.1 ? 1 : 0) : "0")}
        </span>
      </span>
    );
    captionKey = `hot-${hotPart.id}`;
  } else if (saved) {
    caption = (
      <>
        Saved <b>{plain(saved.amount)}</b> tokens
      </>
    );
    captionKey = `saved-${saved.id}`;
    captionTone = "ok";
  } else if (level !== "ok") {
    caption = level !== "full" ? labels.left(plain(free)) : used > cap ? labels.over(plain(used - cap)) : labels.full;
    captionKey = level;
    captionTone = level;
  }

  /** Size of each part right after it was compacted; the button comes back once the part has grown again */
  const [compacted, setCompacted] = useState<Record<string, number>>({});
  const isCompacted = (p: { id: string; tokens: number }) => compacted[p.id] !== undefined && p.tokens <= compacted[p.id];

  // After compacting, the button says "Compacted" for a moment, then folds away
  const [farewell, setFarewell] = useState<{ id: string; leaving: boolean } | null>(null);
  useEffect(() => {
    if (!farewell) return;
    const timer = window.setTimeout(() => setFarewell(farewell.leaving ? null : { ...farewell, leaving: true }), farewell.leaving ? 420 : 1500);
    return () => window.clearTimeout(timer);
  }, [farewell]);

  const compactButton = (p: (typeof list)[number]) => (
    <button
      type="button"
      className="ui-cwc__compact"
      aria-label={isCompacted(p) ? `${p.label} is compacted` : `Compact ${p.label}`}
      disabled={Boolean(busy) || p.tokens === 0 || isCompacted(p)}
      data-busy={busy === p.id ? "" : undefined}
      data-done={isCompacted(p) ? "" : undefined}
      data-leaving={farewell?.id === p.id && farewell.leaving ? "" : undefined}
      onClick={() => compact(p)}
      onFocus={() => setHot(p.id)}
      onBlur={() => setHot(null)}
    >
      {/* Icon and word swap in place: Compact → working → Compacted */}
      <span className="ui-cwc__compact-icon" key={busy === p.id ? "icon-busy" : isCompacted(p) ? "icon-done" : "icon-idle"}>
        {busy === p.id ? <span className="ui-cwc__spinner" /> : isCompacted(p) ? <DoneIcon /> : <CompactIcon />}
      </span>
      <span className="ui-cwc__compact-text" key={isCompacted(p) ? "text-done" : "text-idle"}>
        {isCompacted(p) ? "Compacted" : "Compact"}
      </span>
    </button>
  );

  return (
    <div
      className={["ui-cwc", className].filter(Boolean).join(" ")}
      role="group"
      aria-labelledby={`${uid}-title`}
      data-level={level}
      onPointerLeave={() => setHot(null)}
    >
      <style href="ui-context-window-clean" precedence="default">
        {css}
      </style>

      <div className="ui-cwc__card">
        <div className="ui-cwc__head">
          <span id={`${uid}-title`} className="ui-cwc__title" title={title} dir="auto">
            {title}
          </span>
          {model && (
            <span className="ui-cwc__model" title={model}>
              {modelIcon && <span className="ui-cwc__model-icon">{modelIcon}</span>}
              <span>{model}</span>
            </span>
          )}
        </div>

        <div className="ui-cwc__figure">
          <span className="ui-cwc__big" aria-hidden="true">
            {tokens(shown["#figure"] ?? used)}
          </span>
          <span className="ui-cwc__of" aria-hidden="true">
            <Swap id={hotPart ? hotPart.id : "total"}>{hotPart ? hotPart.label : labels.of(plain(cap))}</Swap>
          </span>
          <span className="ui-cwc__pill" aria-hidden="true">
            {cap > 0 ? Math.round(((shown["#used"] ?? used) / cap) * 100) : 0}%
          </span>
          <span className="ui-cwc__sr">
            {labels.used(plain(used), plain(cap), Math.round(share * 100))}
          </span>
        </div>

        {/* The window as a field of cells – decorative, everything it shows is in the list */}
        <div
          className="ui-cwc__field"
          aria-hidden="true"
          data-hot={hotPart ? "" : undefined}
          style={{ ["--ui-cwc-cols" as string]: columns, ["--ui-cwc-cols-narrow" as string]: Math.max(8, Math.round((columns * 2) / 3)) }}
        >
          {owner.map((index, i) => {
            const part = index === null ? null : list[index];
            return (
              <span
                key={i}
                className="ui-cwc__cell"
                data-on={part && hot === part.id ? "" : undefined}
                data-busy={part && busy === part.id ? "" : undefined}
                data-free={part ? undefined : ""}
                style={{
                  ["--i" as string]: i,
                  ...(part ? { ["--ui-cwc-color" as string]: part.color } : {}),
                }}
                onPointerEnter={(e) =>
                  e.pointerType === "mouse" && setHot(part ? part.id : null)
                }
              />
            );
          })}
        </div>

        <ul className="ui-cwc__parts">
          {list.map((p) => {
            const canOpen = Boolean(p.items);
            const isOpen = opened === p.id;
            const main = (
              <>
                <span
                  className="ui-cwc__swatch"
                  style={{ background: p.color }}
                />
                <span className="ui-cwc__label" title={p.label}>
                  <span className="ui-cwc__label-text" dir="auto">{p.label}</span>
                  {canOpen && (
                    <span className="ui-cwc__open" data-open={isOpen ? "" : undefined}>
                      <ChevronIcon />
                    </span>
                  )}
                </span>
                {p.compact && !p.locked && (!isCompacted(p) || farewell?.id === p.id) && compactButton(p)}
                <span className="ui-cwc__value" title={`${exact(p.tokens)} tokens`}>
                  {tokens(shown[p.id] ?? p.tokens)}
                </span>
              </>
            );
            return (
              <li
                key={p.id}
                className="ui-cwc__part"
                data-hot={hot === p.id ? "" : undefined}
                data-link={p.link ? "" : undefined}
                data-dim={hot && hot !== p.id ? "" : undefined}
                onPointerEnter={(e) =>
                  e.pointerType === "mouse" && setHot(p.id)
                }
              >
                <div className="ui-cwc__row">
                  {canOpen ? (
                    <button
                      type="button"
                      className="ui-cwc__main"
                      aria-expanded={isOpen}
                      aria-controls={`${uid}-${p.id}`}
                      onClick={() => setOpened(isOpen ? null : p.id)}
                      onFocus={() => setHot(p.id)}
                      onBlur={() => setHot(null)}
                    >
                      {main}
                    </button>
                  ) : (
                    <div className="ui-cwc__main">{main}</div>
                  )}
                </div>

                {p.items && (
                  <div
                    id={`${uid}-${p.id}`}
                    className="ui-cwc__fold"
                    data-open={isOpen ? "" : undefined}
                    inert={!isOpen}
                  >
                    <div className="ui-cwc__clip">
                      <Items partId={p.id} items={p.items} leaving={leaving} onRemove={onRemove} readOnly={readOnly} labels={labels} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* The last row: what is left, compacting, what was saved – and the action */}
      <div className="ui-cwc__foot">
        <span
          className="ui-cwc__caption"
          aria-live="polite"
        >
          <Swap id={captionKey} tone={captionTone}>
            {caption}
          </Swap>
        </span>
        {action && (
          <button
            type="button"
            className="ui-cwc__action"
            onClick={action.onClick}
            title={action.label}
          >
            <span className="ui-cwc__action-label">{action.label}</span>
            <ArrowIcon />
          </button>
        )}
      </div>
    </div>
  );
}


/* ---------- Styles ---------- */

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-cwc */
.ui-cwc {
  --ui-cwc-card: #ffffff;
  --ui-cwc-strong: #000000;
  --ui-cwc-ink: rgba(0, 0, 0, 0.88);
  --ui-cwc-text: rgba(0, 0, 0, 0.61);
  --ui-cwc-muted: rgba(0, 0, 0, 0.45);
  --ui-cwc-faint: rgba(0, 0, 0, 0.27);
  --ui-cwc-icon: rgba(0, 0, 0, 0.447);
  --ui-cwc-line: rgba(0, 0, 0, 0.06);
  --ui-cwc-fill: rgba(0, 0, 0, 0.06);
  --ui-cwc-wash: rgba(0, 0, 0, 0.03);
  --ui-cwc-free: rgba(0, 0, 0, 0.06);
  /* The parts: the accent blue and its lighter tints first, then indigo, green and amber */
  --ui-cwc-c1: rgba(0, 96, 226, 0.765);
  --ui-cwc-c2: rgba(0, 96, 226, 0.5);
  --ui-cwc-c3: rgba(0, 96, 226, 0.26);
  --ui-cwc-c4: rgba(91, 91, 214, 0.8);
  --ui-cwc-c5: rgba(26, 154, 82, 0.72);
  --ui-cwc-c6: rgba(232, 162, 12, 0.8);
  --ui-cwc-accent: rgba(0, 96, 226, 0.765);
  --ui-cwc-warn: #b07800;
  --ui-cwc-warn-bg: rgba(232, 162, 12, 0.12);
  --ui-cwc-full: #d63f44;
  --ui-cwc-full-bg: rgba(229, 72, 77, 0.08);
  --ui-cwc-ok: #1a9a52;
  --ui-cwc-ok-bg: rgba(26, 154, 82, 0.08);
  /* Shimmer bands are lighter than what they run over */
  --ui-cwc-shine: rgba(255, 255, 255, 0.82);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-cwc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-cwc-focus: rgba(0, 96, 226, 0.35);
  --ui-cwc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  box-sizing: border-box;
  width: 100%;
  max-width: 360px;
  min-width: 0;
  container-type: inline-size;
  border-radius: 10px;
  background: var(--ui-cwc-card);
  box-shadow: var(--ui-cwc-shadow);
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  color: var(--ui-cwc-ink);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
.ui-cwc *, .ui-cwc *::before, .ui-cwc *::after { box-sizing: border-box; }
:where(.ui-cwc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ui-cwc button:focus-visible { outline: 2px solid var(--ui-cwc-focus); outline-offset: 1px; }
:where(.ui-cwc) svg { display: block; flex: none; }
.ui-cwc b { font-weight: 500; color: var(--ui-cwc-ink); }
.ui-cwc ul { margin: 0; padding: 0; list-style: none; }
.ui-cwc__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

.ui-cwc__card { position: relative; padding: 14px 16px 8px; }
.ui-cwc__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 20px; }
.ui-cwc__title { overflow: hidden; font-size: 13px; font-weight: 500; line-height: 20px; color: var(--ui-cwc-strong); white-space: nowrap; text-overflow: ellipsis; }
.ui-cwc__model { display: inline-flex; flex: none; align-items: center; gap: 5px; max-width: 62%; height: 20px; padding: 0 6px; border-radius: 5px; background: var(--ui-cwc-fill); font-size: 11px; font-weight: 500; line-height: 16px; color: var(--ui-cwc-text); white-space: nowrap; }
.ui-cwc__model > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-cwc__model-icon { display: grid; flex: none; place-items: center; width: 12px; height: 12px; }
.ui-cwc__model-icon > * { width: 12px; height: 12px; }

.ui-cwc__figure { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.ui-cwc__big { font-size: 24px; font-weight: 500; line-height: 32px; letter-spacing: -0.02em; color: var(--ui-cwc-strong); font-variant-numeric: tabular-nums; }
.ui-cwc__of { flex: 1; min-width: 0; overflow: hidden; padding-top: 4px; font-size: 12px; line-height: 16px; color: var(--ui-cwc-muted); white-space: nowrap; text-overflow: ellipsis; }
/* The share as a small tag – tinted amber, then red, as the window fills up */
.ui-cwc__pill { flex: none; height: 20px; padding: 0 6px; border-radius: 5px; background: var(--ui-cwc-fill); font-size: 12px; font-weight: 500; line-height: 20px; color: var(--ui-cwc-text); font-variant-numeric: tabular-nums; transition: color 300ms ease, background-color 300ms ease; }
.ui-cwc[data-level="warn"] .ui-cwc__pill { background: var(--ui-cwc-warn-bg); color: var(--ui-cwc-warn); }
.ui-cwc[data-level="full"] .ui-cwc__pill { background: var(--ui-cwc-full-bg); color: var(--ui-cwc-full); }

/* The field: one cell per slice of the window. Changes sweep through it cell by cell */
.ui-cwc__field { display: grid; grid-template-columns: repeat(var(--ui-cwc-cols), minmax(0, 1fr)); gap: 2px; margin-top: 10px; }
.ui-cwc__cell { position: relative; aspect-ratio: 1; border-radius: 2px; background: var(--ui-cwc-color); transition: background-color 380ms ease, opacity 220ms ease, transform 300ms var(--ui-cwc-ease); transition-delay: calc(var(--i) * 2ms), 0ms, 0ms; }
.ui-cwc__cell[data-free] { background: var(--ui-cwc-free); }
.ui-cwc__field[data-hot] .ui-cwc__cell:not([data-on], [data-free]) { opacity: 0.25; }
.ui-cwc__cell[data-on] { transform: scale(1.1); }
/* Compacting: a lighter wave washes through the part's cells */
.ui-cwc__cell::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--ui-cwc-shine); opacity: 0; pointer-events: none; }
.ui-cwc__cell[data-busy] { animation: ui-cwc-wave 900ms ease-in-out infinite; animation-delay: calc(var(--i) * 15ms); }
.ui-cwc__cell[data-busy]::after { animation: ui-cwc-shine 900ms ease-in-out infinite; animation-delay: calc(var(--i) * 15ms); }

/* ----- Parts ----- */
.ui-cwc__parts { margin-top: 10px !important; }
.ui-cwc__part { margin: 0 -8px; padding: 0 8px; border-radius: 6px; transition: background-color 120ms ease-out, opacity 220ms ease; }
.ui-cwc__part[data-hot] { background: var(--ui-cwc-wash); }
.ui-cwc__part[data-link] { cursor: pointer; }
.ui-cwc__part[data-link]:active { background: var(--ui-cwc-fill); }
.ui-cwc__part[data-dim] { opacity: 0.5; }
.ui-cwc__row { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.ui-cwc__main { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 0; height: 32px; border-radius: 6px; }
.ui-cwc__swatch { flex: none; width: 8px; height: 8px; border-radius: 2px; }
.ui-cwc__label { display: flex; flex: 1; align-items: center; gap: 2px; min-width: 0; overflow: hidden; color: var(--ui-cwc-ink); white-space: nowrap; text-overflow: ellipsis; }
.ui-cwc__label-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-cwc__value { flex: none; min-width: 52px; text-align: right; color: var(--ui-cwc-text); font-variant-numeric: tabular-nums; transition: color 160ms ease; }
.ui-cwc__part[data-hot] .ui-cwc__value { color: var(--ui-cwc-ink); }
.ui-cwc__open { display: grid; flex: none; place-items: center; width: 16px; height: 16px; color: var(--ui-cwc-icon); }
.ui-cwc__chevron { transition: transform 300ms var(--ui-cwc-ease); }
.ui-cwc__open[data-open] .ui-cwc__chevron { transform: rotate(180deg); }
.ui-cwc__compact { display: inline-flex; align-items: center; gap: 4px; height: 24px; margin-right: -8px; padding: 0 8px 0 6px; border-radius: 6px; font-size: 12px; font-weight: 500; line-height: 16px; color: var(--ui-cwc-text); white-space: nowrap; transition: background-color 160ms ease, color 160ms ease, opacity 200ms ease; }
.ui-cwc__compact:hover:not(:disabled) { background: var(--ui-cwc-fill); color: var(--ui-cwc-ink); }
.ui-cwc__compact:disabled { cursor: default; opacity: 0.5; }
.ui-cwc__compact[data-busy] { opacity: 1; color: var(--ui-cwc-ink); }
.ui-cwc__compact[data-done] { opacity: 1; background: var(--ui-cwc-ok-bg); color: var(--ui-cwc-ok); }
.ui-cwc__compact[data-leaving] { animation: ui-cwc-leave 400ms var(--ui-cwc-ease) both; }
.ui-cwc__compact-icon { display: grid; place-items: center; width: 12px; height: 12px; animation: ui-cwc-swap-in 300ms ease both; }
.ui-cwc__compact-text { animation: ui-cwc-swap-in 300ms ease both; }
.ui-cwc__spinner { width: 11px; height: 11px; border: 1.25px solid var(--ui-cwc-fill); border-top-color: var(--ui-cwc-accent); border-radius: 50%; animation: ui-cwc-spin 700ms linear infinite; }

/* Items of a part unfold in place; a removed one folds away before it goes */
.ui-cwc__fold { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 420ms var(--ui-cwc-ease), opacity 240ms ease; }
.ui-cwc__fold[data-open] { grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows 420ms var(--ui-cwc-ease), opacity 320ms ease 80ms; }
.ui-cwc__fold--item { transition-duration: 240ms, 180ms; }
.ui-cwc__clip { min-height: 0; overflow: hidden; }
.ui-cwc__items { padding: 0 0 6px 18px !important; }
.ui-cwc__item { display: flex; align-items: center; gap: 8px; height: 28px; margin-right: -4px; font-size: 12px; line-height: 16px; }
.ui-cwc__item-label { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-cwc-text); white-space: nowrap; text-overflow: ellipsis; }
.ui-cwc__item-value { flex: none; color: var(--ui-cwc-muted); font-variant-numeric: tabular-nums; }
.ui-cwc__remove { display: grid; flex: none; place-items: center; width: 24px; height: 24px; border-radius: 6px; color: var(--ui-cwc-icon); transition: background-color 160ms ease, color 160ms ease; }
.ui-cwc__remove:hover { background: var(--ui-cwc-full-bg); color: var(--ui-cwc-full); }
.ui-cwc__empty { height: 28px; font-size: 12px; line-height: 28px; color: var(--ui-cwc-muted); }

/* ----- The last row ----- */
.ui-cwc__foot { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px 0 16px; border-top: 0.5px solid var(--ui-cwc-line); }
.ui-cwc__caption { flex: 1; min-width: 0; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-cwc-muted); white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
/* Hovering a part: its name may shorten, its share of the window stays */
.ui-cwc__hot { display: flex; min-width: 0; }
.ui-cwc__hot > b { min-width: 32px; overflow: hidden; text-overflow: ellipsis; }
.ui-cwc__hot > span { flex: none; white-space: pre; }
/* A long action label shortens, so the caption keeps its room */
.ui-cwc__action-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-cwc__swap { display: grid; min-width: 0; }
.ui-cwc__swap-item { grid-area: 1 / 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; animation: ui-cwc-swap-in 320ms ease both; }
.ui-cwc__swap-item[data-out] { animation: ui-cwc-swap-out 220ms ease both; }
.ui-cwc__swap-item[data-tone="ok"] { color: var(--ui-cwc-ok); }
.ui-cwc__swap-item[data-tone="ok"] b { color: inherit; }
.ui-cwc__swap-item[data-tone="warn"] { color: var(--ui-cwc-warn); }
.ui-cwc__swap-item[data-tone="full"] { color: var(--ui-cwc-full); }
/* The secondary button: white with the hairline shadow */
.ui-cwc__action { display: inline-flex; flex: 0 1 auto; align-items: center; min-width: 0; max-width: 50%; gap: 6px; height: 28px; padding: 0 8px 0 10px; border-radius: 6px; background: var(--ui-cwc-card); box-shadow: var(--ui-cwc-shadow); font-size: 13px; font-weight: 500; line-height: 20px; color: var(--ui-cwc-strong); white-space: nowrap; transition: background-color 160ms ease; }
.ui-cwc__action:hover { background: #fafafa; }
.ui-cwc__action svg { color: var(--ui-cwc-icon); transition: transform 220ms var(--ui-cwc-ease), color 160ms ease; }
.ui-cwc__action:hover svg { color: var(--ui-cwc-ink); transform: translateX(2px); }

/* Shimmer over the working caption – a lighter band runs through the gray text */
.ui-cwc__shimmer { position: relative; display: inline-block; }
.ui-cwc__shimmer::after {
  content: attr(data-text);
  content: attr(data-text) / "";
  position: absolute;
  inset: 0;
  white-space: nowrap;
  color: transparent;
  background: linear-gradient(90deg, transparent 38%, var(--ui-cwc-shine) 50%, transparent 62%) 100% 0 / 300% 100% no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  animation: ui-cwc-sweep 1.6s linear infinite;
  pointer-events: none;
}

@keyframes ui-cwc-leave { to { opacity: 0; filter: blur(3px); transform: scale(0.92); } }
@keyframes ui-cwc-swap-in { from { opacity: 0; filter: blur(2px); } }
@keyframes ui-cwc-swap-out { from { opacity: 1; } to { opacity: 0; filter: blur(2px); } }
@keyframes ui-cwc-wave { 0%, 100% { transform: none; } 50% { transform: scale(0.82); } }
@keyframes ui-cwc-shine { 0%, 100% { opacity: 0; } 50% { opacity: 0.75; } }
@keyframes ui-cwc-spin { to { transform: rotate(360deg); } }
@keyframes ui-cwc-sweep { from { background-position: 100% 0; } to { background-position: 0% 0; } }

/* Narrow cards: fewer cells per row so they stay readable, the model tag gives way and Compact keeps only its icon */
@container (max-width: 310px) {
  .ui-cwc__card { padding: 12px 14px 6px; }
  .ui-cwc__foot { padding: 0 8px 0 14px; }
  .ui-cwc__model { max-width: 42%; }
  .ui-cwc__field { grid-template-columns: repeat(var(--ui-cwc-cols-narrow), minmax(0, 1fr)); }
  .ui-cwc__compact { padding: 0 6px; }
  .ui-cwc__compact-text { display: none; }
}

@media (pointer: coarse) {
  .ui-cwc__row { min-height: 38px; }
  .ui-cwc__main { height: 38px; }
  .ui-cwc__compact { height: 30px; padding: 0 9px 0 7px; }
  .ui-cwc__item { height: 34px; }
  .ui-cwc__remove { width: 30px; height: 30px; }
  .ui-cwc__foot { height: 52px; }
  .ui-cwc__action { height: 34px; }
}

@media (prefers-reduced-motion: reduce) {
  .ui-cwc *, .ui-cwc *::before, .ui-cwc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-cwc {
  --ui-cwc-card: #1c1c1e;
  --ui-cwc-strong: #ffffff;
  --ui-cwc-ink: rgba(255, 255, 255, 0.9);
  --ui-cwc-text: rgba(255, 255, 255, 0.62);
  --ui-cwc-muted: rgba(255, 255, 255, 0.46);
  --ui-cwc-faint: rgba(255, 255, 255, 0.3);
  --ui-cwc-icon: rgba(255, 255, 255, 0.5);
  --ui-cwc-line: rgba(255, 255, 255, 0.08);
  --ui-cwc-fill: rgba(255, 255, 255, 0.08);
  --ui-cwc-wash: rgba(255, 255, 255, 0.04);
  --ui-cwc-free: rgba(255, 255, 255, 0.08);
  --ui-cwc-c1: #4d8dff;
  --ui-cwc-c2: rgba(77, 141, 255, 0.7);
  --ui-cwc-c3: rgba(77, 141, 255, 0.46);
  --ui-cwc-c4: #7b7bec;
  --ui-cwc-c5: #3ec27a;
  --ui-cwc-c6: #f0b43a;
  --ui-cwc-accent: #4d8dff;
  --ui-cwc-warn: #f0b43a;
  --ui-cwc-warn-bg: rgba(232, 162, 12, 0.16);
  --ui-cwc-full: #ff8a8e;
  --ui-cwc-full-bg: rgba(229, 72, 77, 0.14);
  --ui-cwc-ok: #3ec27a;
  --ui-cwc-ok-bg: rgba(26, 154, 82, 0.14);
  --ui-cwc-shine: #ffffff;
  --ui-cwc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
  --ui-cwc-focus: rgba(77, 141, 255, 0.5);
}
:where(.dark, [data-theme="dark"]) .ui-cwc__action:hover { background: #232326; }
`;
