// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/*
 * Toaster – calm toasts with an imperative API, in a single self-contained file.
 * Put <Toaster /> once near the root, then call toast("Saved"), toast.success(…), toast.error(…),
 * toast.promise(promise, { loading, success, error }) or toast.dismiss(id) from anywhere – no context needed.
 * Toasts stack in a corner: the newest in front, two more peeking behind it. Hovering or focusing the stack
 * fans it out into a list; every toast is measured, so heights and positions glide instead of jumping.
 * A promise toast morphs its spinner into a check or a cross while the text crossfades and the card resizes.
 * The timer pauses on hover, focus and while the tab is hidden; swipe a toast away or press Esc.
 * The styles are injected below, so no extra files are needed.
 */

export type ToastId = string | number;
export type ToastType = "default" | "success" | "error" | "info" | "loading";
export type ToastPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export type ToastAction = {
  label: string;
  /** Runs on click; the toast closes afterwards unless you call event.preventDefault() */
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
};

export type ToastOptions = {
  /** Pass the id of an existing toast to update it in place */
  id?: ToastId;
  description?: ReactNode;
  action?: ToastAction;
  /** In ms – Infinity keeps the toast until it's dismissed. Defaults to the Toaster's duration */
  duration?: number;
  /** Replaces the status icon */
  icon?: ReactNode;
  /** Sends the toast to the <Toaster id="…"> with this id instead of the default one */
  toaster?: string;
  /** Called when the toast closes – by its timer, a swipe, Esc, the close button or toast.dismiss() */
  onDismiss?: (id: ToastId) => void;
};

/** A title, or a title with a description */
export type ToastContent = ReactNode | { title: ReactNode; description?: ReactNode };

export type ToastPromiseMessages<T> = {
  loading: ToastContent;
  success: ToastContent | ((value: T) => ToastContent);
  error: ToastContent | ((error: unknown) => ToastContent);
};

export type ToasterProps = {
  /** Corner (or edge center) the stack sits in */
  position?: ToastPosition;
  /** Positions the stack inside the nearest positioned ancestor instead of the viewport – for previews and panels */
  inline?: boolean;
  /** Only shows toasts sent with { toaster: id } – for a second, separate stack */
  id?: string;
  /** Default time on screen in ms */
  duration?: number;
  /** How many toasts are visible at once; older ones wait behind */
  visibleToasts?: number;
  /** Always show the stack fanned out */
  expand?: boolean;
  /** Distance from the edges in px */
  offset?: number;
  /** Space between toasts when fanned out, in px */
  gap?: number;
  /** Key that moves focus to the newest toast (KeyboardEvent.key or .code) – null turns it off */
  hotkey?: string | null;
  /** A 1px line along the bottom of a toast that runs down with its timer */
  hairline?: boolean;
  /** Show a close button on hover and focus (always on touch screens) */
  closeButton?: boolean;
  /** Name of the region for screen readers */
  label?: string;
  /** Accessible name of each toast's close button */
  closeLabel?: string;
  className?: string;
};

type ToastData = {
  id: ToastId;
  type: ToastType;
  title: ReactNode;
  description?: ReactNode;
  action?: ToastAction;
  duration?: number;
  icon?: ReactNode;
  toaster?: string;
  onDismiss?: (id: ToastId) => void;
  /** Goes up with every update – restarts the timer and crossfades the text */
  version: number;
  removing?: boolean;
};

/* ---------- The store: a module-level list, so toast() works from anywhere ---------- */

let toasts: ToastData[] = [];
const listeners = new Set<() => void>();
const EMPTY: ToastData[] = [];
let counter = 0;

const commit = (next: ToastData[]) => {
  toasts = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => toasts;
const getServerSnapshot = () => EMPTY;

/** Adds a toast, or updates it when the id is already on screen */
function show(type: ToastType, title: ReactNode, options: ToastOptions = {}, onlyIfAlive = false): ToastId {
  // { title, description } passed as the title is read as both, instead of crashing the render
  if (isContentObject(title)) {
    options = { description: title.description, ...options };
    title = title.title;
  }
  const { id: given, ...rest } = options;
  // 1 and "1" are the same toast – they share a key
  const existing = given !== undefined ? toasts.find((t) => same(t.id, given) && !t.removing) : undefined;
  if (existing) {
    commit(toasts.map((t) => (t === existing ? { ...t, ...rest, type, title, version: t.version + 1 } : t)));
    return existing.id;
  }
  const id = given ?? `toast-${++counter}`;
  // A promise that settles after its toast was dismissed doesn't bring it back
  if (onlyIfAlive) return id;
  commit([...toasts.filter((t) => !same(t.id, id)), { ...rest, id, type, title, version: 0 }]);
  return id;
}

const EXIT_MS = 420;
const same = (a: ToastId, b: ToastId) => String(a) === String(b);

/** Closes one toast, or all of them without an id */
function dismiss(id?: ToastId) {
  const targets = toasts.filter((t) => !t.removing && (id === undefined || same(t.id, id)));
  if (!targets.length) return;
  commit(toasts.map((t) => (targets.includes(t) ? { ...t, removing: true } : t)));
  targets.forEach((t) => t.onDismiss?.(t.id));
  // Kept a moment for the exit animation, then dropped
  window.setTimeout(() => commit(toasts.filter((t) => !(t.removing && targets.some((x) => x.id === t.id)))), EXIT_MS);
}

const isContentObject = (c: unknown): c is { title: ReactNode; description?: ReactNode } =>
  typeof c === "object" && c !== null && !isValidElement(c) && !Array.isArray(c) && "title" in c;
const split = (c: ToastContent) => (isContentObject(c) ? c : { title: c, description: undefined });

function promise<T>(
  input: Promise<T> | (() => Promise<T>),
  messages: ToastPromiseMessages<T>,
  options: Omit<ToastOptions, "id"> & { id?: ToastId } = {},
): Promise<T> {
  const run = typeof input === "function" ? input() : input;
  const first = split(messages.loading);
  const id = show("loading", first.title, { ...options, description: first.description });
  const settle = (type: "success" | "error", content: ToastContent) => {
    const c = split(content);
    // `description` is always passed, so a loading description doesn't linger
    show(type, c.title, { ...options, id, description: c.description }, true);
  };
  run.then(
    (value) => settle("success", typeof messages.success === "function" ? messages.success(value) : messages.success),
    (error: unknown) => settle("error", typeof messages.error === "function" ? messages.error(error) : messages.error),
  );
  return run;
}

/** toast("Saved"), toast.success(…), toast.error(…), toast.info(…), toast.loading(…), toast.promise(…), toast.dismiss(id?) */
export const toast = Object.assign((title: ReactNode, options?: ToastOptions) => show("default", title, options), {
  success: (title: ReactNode, options?: ToastOptions) => show("success", title, options),
  error: (title: ReactNode, options?: ToastOptions) => show("error", title, options),
  info: (title: ReactNode, options?: ToastOptions) => show("info", title, options),
  /** Stays until you update it (same id) or dismiss it */
  loading: (title: ReactNode, options?: ToastOptions) => show("loading", title, options),
  promise,
  dismiss,
});

/* ---------- Icons ---------- */

/** One drawing for every state: the ring spins as an arc while loading, then closes while a check or cross draws in */
function StatusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="ui-ts__status" aria-hidden="true">
      <g className="ui-ts__spin">
        <circle className="ui-ts__ring" cx="12" cy="12" r="9.25" pathLength={1} />
      </g>
      <path className="ui-ts__mark ui-ts__check" d="M8.3 12.4l2.5 2.5 4.9-5.3" pathLength={1} />
      <path className="ui-ts__mark ui-ts__x1" d="M9.5 9.5l5 5" pathLength={1} />
      <path className="ui-ts__mark ui-ts__x2" d="M14.5 9.5l-5 5" pathLength={1} />
      <path className="ui-ts__info" d="M12 11.2v4.6M12 8.2h.01" />
    </svg>
  );
}

const CloseGlyph = () => (
  <svg viewBox="0 0 24 24" className="ui-ts__glyph" aria-hidden="true">
    <path d="M7.5 7.5l9 9M16.5 7.5l-9 9" />
  </svg>
);

/* ---------- One toast ---------- */

type Layout = { y: number; scale: number; height: number; z: number; behind: boolean; hidden: boolean };

const keyOf = (t: ToastData) => String(t.id);
/** A usable duration in ms – Infinity keeps the toast; NaN and negative values don't count */
const msOf = (n?: number) => (typeof n === "number" && (n === Infinity || (Number.isFinite(n) && n >= 0)) ? n : undefined);
const hasText = (n: ReactNode) => n != null && n !== "" && n !== false;

function ToastItem({
  t,
  layout,
  edge,
  paused,
  defaultDuration,
  hairline,
  closeButton,
  closeLabel,
  onHeight,
}: {
  t: ToastData;
  layout: Layout;
  /** 1 when the stack sits at the bottom (down = out), -1 at the top */
  edge: 1 | -1;
  paused: boolean;
  defaultDuration: number;
  hairline: boolean;
  closeButton: boolean;
  closeLabel: string;
  onHeight: (key: string, height: number) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [swiping, setSwiping] = useState(false);
  const [ghost, setGhost] = useState<{ title: ReactNode; description?: ReactNode; version: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<HTMLDivElement>(null);
  const prev = useRef({ title: t.title, description: t.description, version: t.version });
  const ghostTimer = useRef(0);
  const timer = useRef({ version: -1, left: 0 });
  const drag = useRef<{ pointer: number; x: number; y: number; axis: "x" | "y" | null; samples: { v: number; at: number }[] } | null>(null);
  const dragged = useRef(false);
  const removing = !!t.removing;
  // A custom icon that fails to load falls back to the status icon
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => setIconFailed(false), [t.icon]);

  // Painted once off-screen, then lifted in
  useEffect(() => {
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setMounted(true)));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Every toast measures its content – the stack positions and heights are built from these
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const key = keyOf(t);
    const report = () => onHeight(key, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // New text: the old one stays on top for a moment and fades out while the new one fades in
  useLayoutEffect(() => {
    const old = prev.current;
    if (old.version === t.version) return;
    prev.current = { title: t.title, description: t.description, version: t.version };
    if (old.title === t.title && old.description === t.description) return;
    setGhost(old);
    window.clearTimeout(ghostTimer.current);
    ghostTimer.current = window.setTimeout(() => setGhost(null), 320);
  }, [t.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearTimeout(ghostTimer.current), []);

  // The timer: restarts on every update, keeps what's left while paused
  const duration = msOf(t.duration) ?? msOf(defaultDuration) ?? 4000;
  const timed = t.type !== "loading" && Number.isFinite(duration);
  const running = timed && !paused && !swiping && !removing;
  useEffect(() => {
    if (timer.current.version !== t.version) timer.current = { version: t.version, left: duration };
    if (!running) return;
    const version = t.version;
    const started = Date.now();
    const id = window.setTimeout(() => dismiss(t.id), Math.max(0, timer.current.left));
    return () => {
      window.clearTimeout(id);
      if (timer.current.version === version) timer.current.left -= Date.now() - started;
    };
  }, [running, t.version, duration, t.id]);

  /* Swipe: sideways in both directions, or out over the near edge; anything else rubber-bands back */
  const onPointerDown = (e: ReactPointerEvent<HTMLLIElement>) => {
    if (e.button !== 0 || removing) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, axis: null, samples: [] };
    dragged.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLLIElement>) => {
    const d = drag.current;
    const el = swipeRef.current;
    if (!d || d.pointer !== e.pointerId || !el) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.axis) {
      if (Math.hypot(dx, dy) < 6) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      e.currentTarget.setPointerCapture(e.pointerId);
      dragged.current = true;
      setSwiping(true);
      el.style.transition = "none";
    }
    let v = d.axis === "x" ? dx : dy;
    const outward = d.axis === "x" || v * edge > 0;
    // Pulling inwards only gives a little – like a rubber band
    if (!outward) v = Math.sign(v) * Math.pow(Math.abs(v), 0.7) * 0.6;
    const size = d.axis === "x" ? el.offsetWidth : el.offsetHeight * 2;
    el.style.transform = d.axis === "x" ? `translateX(${v}px)` : `translateY(${v}px)`;
    el.style.opacity = outward ? String(Math.max(0.25, 1 - Math.abs(v) / (size * 1.1))) : "";
    d.samples.push({ v, at: e.timeStamp });
    if (d.samples.length > 6) d.samples.shift();
  };
  const endDrag = (e: ReactPointerEvent<HTMLLIElement>) => {
    const d = drag.current;
    const el = swipeRef.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (!d.axis || !el) return;
    setSwiping(false);
    const last = d.samples[d.samples.length - 1] ?? { v: 0, at: 0 };
    const first = d.samples[0] ?? last;
    const velocity = last.at > first.at ? (last.v - first.v) / (last.at - first.at) : 0; // px per ms
    const outward = d.axis === "x" || last.v * edge > 0;
    const fast = Math.abs(velocity) > 0.45 && Math.sign(velocity) === Math.sign(last.v);
    if (e.type === "pointerup" && outward && (Math.abs(last.v) > 64 || fast)) {
      const distance = (d.axis === "x" ? el.offsetWidth : el.offsetHeight) + 48;
      el.style.transition = "transform 300ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms ease";
      el.style.transform = `${d.axis === "x" ? "translateX" : "translateY"}(${Math.sign(last.v) * distance}px)`;
      el.style.opacity = "0";
      dismiss(t.id);
    } else {
      el.style.transition = "";
      el.style.transform = "";
      el.style.opacity = "";
    }
  };

  const inward = -edge;
  let transform = `translateY(${inward * layout.y}px) scale(${layout.scale})`;
  if (!mounted) transform = `translateY(${edge * 100}%) scale(${layout.scale})`;
  if (removing) transform = `translateY(${inward * layout.y + edge * 10}px) scale(${layout.scale * 0.96})`;

  const custom = !iconFailed && t.icon != null && t.type !== "loading";
  const icon = custom ? t.icon : t.type === "default" ? null : <StatusIcon />;

  return (
    <li
      className="ui-ts__toast"
      data-toast-id={keyOf(t)}
      data-type={t.type}
      data-behind={layout.behind || undefined}
      data-removing={removing || undefined}
      data-swiping={swiping || undefined}
      tabIndex={0}
      inert={layout.hidden || removing}
      style={{
        transform,
        opacity: !mounted || removing || layout.hidden ? 0 : 1,
        height: layout.height ? `${layout.height}px` : undefined,
        zIndex: layout.z,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(e) => {
        // A swipe is not a click
        if (!dragged.current) return;
        dragged.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      <div ref={swipeRef} className="ui-ts__swipe">
        <div className="ui-ts__card">
          <div ref={contentRef} className="ui-ts__content" data-action={t.action ? "" : undefined}>
            {icon && (
              <span className="ui-ts__icon" data-type={custom ? "custom" : t.type} onErrorCapture={() => setIconFailed(true)}>
                {icon}
              </span>
            )}
            <div className="ui-ts__text">
              <div className="ui-ts__copy" key={t.version} data-changed={t.version > 0 || undefined}>
                {hasText(t.title) && (
                  <div className="ui-ts__title" dir="auto">
                    {t.title}
                  </div>
                )}
                {hasText(t.description) && (
                  <div className="ui-ts__desc" dir="auto">
                    {t.description}
                  </div>
                )}
              </div>
              {ghost && (
                <div className="ui-ts__copy ui-ts__ghost" key={`ghost-${ghost.version}`} aria-hidden="true">
                  {hasText(ghost.title) && (
                    <div className="ui-ts__title" dir="auto">
                      {ghost.title}
                    </div>
                  )}
                  {hasText(ghost.description) && (
                    <div className="ui-ts__desc" dir="auto">
                      {ghost.description}
                    </div>
                  )}
                </div>
              )}
            </div>
            {t.action && (
              <button
                type="button"
                className="ui-ts__action"
                title={typeof t.action.label === "string" ? t.action.label : undefined}
                onClick={(e) => {
                  t.action!.onClick(e);
                  if (!e.defaultPrevented) dismiss(t.id);
                }}
              >
                <span className="ui-ts__action-label" dir="auto">
                  {t.action.label}
                </span>
              </button>
            )}
          </div>
          {hairline && timed && (
            <span
              key={t.version}
              className="ui-ts__timer"
              aria-hidden="true"
              style={{ animationDuration: `${duration}ms`, animationPlayState: running ? "running" : "paused" }}
            />
          )}
        </div>
        {closeButton && (
          <button type="button" className="ui-ts__close" aria-label={closeLabel} onClick={() => dismiss(t.id)}>
            <CloseGlyph />
          </button>
        )}
      </div>
    </li>
  );
}

/* ---------- The stack ---------- */

const POSITIONS: ToastPosition[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"];
const PEEK = 10; // px each toast behind peeks out
const SHRINK = 0.05; // scale step per toast behind
const HIDDEN: Layout = { y: 0, scale: 1, height: 0, z: 0, behind: false, hidden: true };

export function Toaster({
  position = "bottom-right",
  inline = false,
  id,
  duration = 4000,
  visibleToasts = 3,
  expand = false,
  offset,
  gap = 10,
  hotkey = "F8",
  hairline = true,
  closeButton = true,
  label = "Notifications",
  closeLabel = "Dismiss notification",
  className,
}: ToasterProps) {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);
  const [tabHidden, setTabHidden] = useState(false);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const sectionRef = useRef<HTMLElement>(null);
  const frozen = useRef(new Map<string, Layout>());
  const lastFront = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pointerType = useRef("mouse");
  const announced = useRef(new Map<string, number>());

  const where = POSITIONS.includes(position) ? position : "bottom-right";
  const [yEdge, xEdge] = where.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  const edge: 1 | -1 = yEdge === "bottom" ? 1 : -1;

  // Newest first – that's the order for the stack, the DOM and Tab
  const list = all.filter((t) => (t.toaster ?? null) === (id ?? null)).reverse();
  const live = list.filter((t) => !t.removing);
  const expanded = expand || hovered || focused || touched;
  const paused = hovered || focused || touched || tabHidden;
  const limit = Number.isFinite(visibleToasts) ? Math.max(1, Math.floor(visibleToasts)) : 3;
  const space = Number.isFinite(gap) ? gap : 10;

  const onHeight = useCallback((key: string, h: number) => {
    setHeights((map) => (map[key] === h ? map : { ...map, [key]: h }));
  }, []);

  /* Layout: collapsed, every toast takes the front toast's height and peeks out a little;
     expanded, each one keeps its own height and they line up with a gap */
  const frontHeight = (live[0] && heights[keyOf(live[0])]) || lastFront.current;
  if (frontHeight) lastFront.current = frontHeight;
  const layouts = new Map<string, Layout>();
  let stacked = 0;
  live.forEach((t, i) => {
    const own = heights[keyOf(t)] ?? 0;
    const depth = Math.min(i, limit - 1);
    const layout: Layout = expanded
      ? { y: stacked, scale: 1, height: own, z: live.length - i, behind: false, hidden: i >= limit }
      : { y: depth * PEEK, scale: 1 - depth * SHRINK, height: i === 0 ? own : frontHeight, z: live.length - i, behind: i > 0, hidden: i >= limit };
    if (i < limit) stacked += own + space;
    layouts.set(keyOf(t), layout);
    // Leaving toasts stay exactly where they were while they fade
    frozen.current.set(keyOf(t), layout);
  });
  const shown = Math.min(live.length, limit);
  const stackHeight = !live.length ? 0 : expanded ? Math.max(0, stacked - space) : frontHeight + PEEK * (shown - 1);

  // Forget the sizes of toasts that are gone
  useEffect(() => {
    const keys = new Set(list.map(keyOf));
    setHeights((map) => {
      const stale = Object.keys(map).filter((k) => !keys.has(k));
      if (!stale.length) return map;
      const next = { ...map };
      stale.forEach((k) => delete next[k]);
      return next;
    });
    frozen.current.forEach((_, k) => !keys.has(k) && frozen.current.delete(k));
    if (!live.length) setTouched(false);
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read new and changed toasts out – errors right away, everything else politely
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    live.forEach((t) => {
      const key = keyOf(t);
      if (announced.current.get(key) === t.version) return;
      announced.current.set(key, t.version);
      const node = Array.from(section.querySelectorAll<HTMLElement>("[data-toast-id]")).find((el) => el.dataset.toastId === key);
      const text = node?.querySelector(".ui-ts__copy:not(.ui-ts__ghost)")?.textContent?.trim();
      if (!text) return;
      // A trailing no-break space that alternates makes the same message count as new
      const set = t.type === "error" ? setAssertive : setPolite;
      set((old) => (old === text ? `${text} ` : text));
    });
    announced.current.forEach((_, k) => !list.some((t) => keyOf(t) === k) && announced.current.delete(k));
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  // The timer also waits while the tab is in the background
  useEffect(() => {
    const sync = () => setTabHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Touch: a tap fans the stack out, a tap anywhere else folds it again
  useEffect(() => {
    if (!touched) return;
    const onDown = (e: PointerEvent) => {
      if (!sectionRef.current?.contains(e.target as Node)) setTouched(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [touched]);

  const toastNodes = () => Array.from(sectionRef.current?.querySelectorAll<HTMLElement>("[data-toast-id]:not([data-removing])") ?? []);

  // The hotkey jumps to the newest toast; Esc or Tab out gives focus back
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== hotkey && e.code !== hotkey) return;
      const first = toastNodes().find((el) => !el.inert);
      if (!first) return;
      e.preventDefault();
      if (!sectionRef.current?.contains(document.activeElement)) returnFocus.current = document.activeElement as HTMLElement | null;
      first.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || !live.length) return;
    e.preventDefault();
    e.stopPropagation();
    // The focused toast if there is one, otherwise the newest
    const host = (e.target as HTMLElement).closest<HTMLElement>("[data-toast-id]");
    const target = live.find((t) => keyOf(t) === host?.dataset.toastId) ?? live[0];
    const index = live.indexOf(target);
    dismiss(target.id);
    const next = live.filter((t) => t !== target)[Math.min(index, live.length - 2)];
    const nextNode = next && toastNodes().find((el) => el.dataset.toastId === keyOf(next));
    if (nextNode) nextNode.focus();
    else if (returnFocus.current?.isConnected) returnFocus.current.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };

  const onFocus = (e: ReactFocusEvent<HTMLElement>) => {
    // Only keyboard focus fans the stack out – a mouse click shouldn't keep it open after leaving
    if ((e.target as HTMLElement).matches(":focus-visible")) setFocused(true);
  };
  const onBlur = (e: ReactFocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
  };

  const style = { "--ui-ts-offset": offset !== undefined && Number.isFinite(offset) ? `${offset}px` : undefined } as CSSProperties;

  return (
    <section
      ref={sectionRef}
      className={["ui-ts", className].filter(Boolean).join(" ")}
      data-y={yEdge}
      data-x={xEdge}
      data-inline={inline || undefined}
      data-expanded={expanded || undefined}
      data-empty={!live.length || undefined}
      aria-label={hotkey ? `${label} (${hotkey})` : label}
      tabIndex={-1}
      style={style}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      onPointerDownCapture={(e) => (pointerType.current = e.pointerType)}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(false)}
      onClick={() => pointerType.current !== "mouse" && live.length > 1 && setTouched(true)}
    >
      {/* React 19 hoists this into <head> once, no matter how many toasters render */}
      <style href="ui-toaster" precedence="default">
        {css}
      </style>

      <ol className="ui-ts__list" style={{ height: `${stackHeight}px` }}>
        {list.map((t) => (
          <ToastItem
            key={keyOf(t)}
            t={t}
            layout={layouts.get(keyOf(t)) ?? frozen.current.get(keyOf(t)) ?? HIDDEN}
            edge={edge}
            paused={paused || (layouts.get(keyOf(t))?.hidden ?? false)}
            defaultDuration={duration}
            hairline={hairline}
            closeButton={closeButton}
            closeLabel={closeLabel}
            onHeight={onHeight}
          />
        ))}
      </ol>

      <div className="ui-ts__sr" role="status" aria-live="polite">
        {polite}
      </div>
      <div className="ui-ts__sr" role="alert">
        {assertive}
      </div>
    </section>
  );
}

/* ---------- Styles ---------- */

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-ts */
.ui-ts {
  --ui-ts-card: #ffffff;
  --ui-ts-line: #ececec;
  --ui-ts-ink: #171717;
  --ui-ts-text: #404040;
  --ui-ts-muted: #8f8f8f;
  --ui-ts-faint: #b5b5b5;
  --ui-ts-button: #f0f0f0;
  --ui-ts-button-hover: #e6e6e7;
  --ui-ts-hairline: rgba(23, 23, 23, 0.14);
  --ui-ts-success: #2f9e5b;
  --ui-ts-danger: #e5484d;
  --ui-ts-shadow: 0 0 0 1px var(--ui-ts-line), 0 1px 2px rgba(0, 0, 0, 0.04), 0 8px 24px -6px rgba(0, 0, 0, 0.1);
  --ui-ts-focus: rgba(23, 23, 23, 0.22);
  --ui-ts-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --ui-ts-width: 356px;
  --ui-ts-offset: 24px;
  position: fixed;
  z-index: 9999;
  box-sizing: border-box;
  width: var(--ui-ts-width);
  max-width: calc(100% - 2 * var(--ui-ts-offset));
  margin: 0;
  padding: 0;
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13.5px;
  line-height: 1.45;
  color: var(--ui-ts-text);
  -webkit-font-smoothing: antialiased;
  outline: none;
}
.ui-ts[data-inline] { position: absolute; z-index: 20; --ui-ts-offset: 20px; }
.ui-ts[data-empty] { pointer-events: none; }
.ui-ts *, .ui-ts *::before, .ui-ts *::after { box-sizing: border-box; }
:where(.ui-ts) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
:where(.ui-ts) svg { display: block; flex: none; }
.ui-ts button:focus-visible { outline: 2px solid var(--ui-ts-focus); outline-offset: 2px; }

/* Corners and edge centers */
.ui-ts[data-y="bottom"] { bottom: var(--ui-ts-offset); }
.ui-ts[data-y="top"] { top: var(--ui-ts-offset); }
.ui-ts[data-x="right"] { right: var(--ui-ts-offset); }
.ui-ts[data-x="left"] { left: var(--ui-ts-offset); }
.ui-ts[data-x="center"] { left: 50%; transform: translateX(-50%); }
.ui-ts:not([data-inline])[data-y="bottom"] { bottom: max(var(--ui-ts-offset), env(safe-area-inset-bottom)); }

.ui-ts__list { position: relative; margin: 0; padding: 0; list-style: none; }

/* A toast: positioned by transform, sized by height – both glide */
.ui-ts__toast {
  position: absolute;
  left: 0;
  right: 0;
  outline: none;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  transition: transform 440ms var(--ui-ts-ease), opacity 320ms ease, height 380ms var(--ui-ts-ease);
}
.ui-ts[data-y="bottom"] .ui-ts__toast { bottom: 0; transform-origin: 50% 0; }
.ui-ts[data-y="top"] .ui-ts__toast { top: 0; transform-origin: 50% 100%; }
.ui-ts__toast[data-removing] { pointer-events: none; transition: transform 380ms var(--ui-ts-ease), opacity 260ms ease, height 380ms var(--ui-ts-ease); }

/* The swipe layer moves on its own, so the stack's transform never fights the finger */
.ui-ts__swipe { position: relative; height: 100%; transition: transform 460ms cubic-bezier(0.34, 1.3, 0.64, 1), opacity 260ms ease; }
.ui-ts__toast[data-swiping] { cursor: grabbing; }

.ui-ts__card { position: relative; height: 100%; overflow: hidden; border-radius: 14px; background: var(--ui-ts-card); box-shadow: var(--ui-ts-shadow); }
.ui-ts__toast:focus-visible .ui-ts__card { outline: 2px solid var(--ui-ts-focus); outline-offset: 2px; }

/* Content is measured; the card clips it while it grows or shrinks */
.ui-ts__content { display: flex; align-items: flex-start; gap: 10px; padding: 14px; transition: opacity 260ms ease; }
.ui-ts__content[data-action] { padding-right: 10px; }
/* Toasts behind the front one only show their edge */
.ui-ts__toast[data-behind] .ui-ts__content,
.ui-ts__toast[data-behind] .ui-ts__timer { opacity: 0; }

.ui-ts__text { position: relative; flex: 1; min-width: 0; }
.ui-ts__title { color: var(--ui-ts-ink); font-weight: 500; line-height: 20px; overflow-wrap: anywhere; }
.ui-ts__desc { margin-top: 1px; font-size: 13px; line-height: 18px; color: var(--ui-ts-muted); overflow-wrap: anywhere; }
/* Changed text slides in with a soft blur; the old text fades out on top */
.ui-ts__copy[data-changed] { animation: ui-ts-text-in 300ms var(--ui-ts-ease) both; }
.ui-ts__ghost { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; animation: ui-ts-text-out 220ms ease both; }

/* Status icon: one drawing that morphs from spinner to check or cross */
.ui-ts__icon { display: grid; place-items: center; flex: none; width: 20px; height: 20px; color: var(--ui-ts-muted); transition: color 300ms ease; }
.ui-ts__icon[data-type="success"] { color: var(--ui-ts-success); }
.ui-ts__icon[data-type="error"] { color: var(--ui-ts-danger); }
.ui-ts__icon[data-type="info"] { color: var(--ui-ts-ink); }
.ui-ts__icon[data-type="custom"] { overflow: hidden; }
.ui-ts__icon[data-type="custom"] > * { width: 18px; height: 18px; object-fit: contain; }
.ui-ts__status { width: 18px; height: 18px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ui-ts__icon[data-type="success"] .ui-ts__status,
.ui-ts__icon[data-type="error"] .ui-ts__status { animation: ui-ts-pop 460ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.ui-ts__spin { transform-box: fill-box; transform-origin: center; animation: ui-ts-spin 760ms linear infinite; animation-play-state: paused; }
.ui-ts__icon[data-type="loading"] .ui-ts__spin { animation-play-state: running; }
/* The arc closes into a quiet ring; the spin freezes where it is, so nothing jumps */
.ui-ts__ring { stroke-dasharray: 1 0; stroke-opacity: 0.28; transition: stroke-dasharray 560ms var(--ui-ts-ease), stroke-opacity 360ms ease; }
.ui-ts__icon[data-type="loading"] .ui-ts__ring { stroke-dasharray: 0.28 0.72; stroke-opacity: 1; }
.ui-ts__mark { stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0; }
.ui-ts__info { opacity: 0; transition: opacity 240ms ease; }
.ui-ts__icon[data-type="success"] .ui-ts__check,
.ui-ts__icon[data-type="error"] .ui-ts__x1,
.ui-ts__icon[data-type="error"] .ui-ts__x2 { opacity: 1; stroke-dashoffset: 0; animation: ui-ts-draw 340ms var(--ui-ts-ease) 160ms both; }
.ui-ts__icon[data-type="error"] .ui-ts__x2 { animation-delay: 260ms; }
.ui-ts__icon[data-type="info"] .ui-ts__info { opacity: 1; }

.ui-ts__action {
  flex: none;
  align-self: center;
  height: 28px;
  margin: -4px 0;
  padding: 0 10px;
  border-radius: 8px;
  background: var(--ui-ts-button);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ui-ts-ink);
  white-space: nowrap;
  transition: background-color 160ms ease;
}
/* A long label shortens instead of squeezing the text or leaving the card */
.ui-ts__action { flex: 0 1 auto; min-width: 0; max-width: 50%; }
.ui-ts__action-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-ts__action:hover { background: var(--ui-ts-button-hover); }

/* Close: a small round button on the corner, shown on hover and focus */
.ui-ts__close {
  position: absolute;
  top: -7px;
  left: -7px;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--ui-ts-card);
  box-shadow: 0 0 0 1px var(--ui-ts-line), 0 1px 3px rgba(0, 0, 0, 0.08);
  color: var(--ui-ts-muted);
  opacity: 0;
  transform: scale(0.8);
  transition: opacity 160ms ease, transform 200ms var(--ui-ts-ease), color 160ms ease;
}
.ui-ts__close::before { content: ""; position: absolute; inset: -6px; }
.ui-ts__close:hover { color: var(--ui-ts-ink); }
.ui-ts__toast:not([data-behind]):hover .ui-ts__close,
.ui-ts__toast:not([data-behind]):focus-within .ui-ts__close { opacity: 1; transform: none; }
.ui-ts__glyph { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }

/* The timer as a hairline – it stops whenever the timer does */
.ui-ts__timer {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 0;
  height: 1px;
  background: var(--ui-ts-hairline);
  transform-origin: left;
  animation-name: ui-ts-timer;
  animation-timing-function: linear;
  animation-fill-mode: both;
  transition: opacity 260ms ease;
}

.ui-ts__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

@keyframes ui-ts-spin { to { transform: rotate(360deg); } }
@keyframes ui-ts-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes ui-ts-pop { 0% { transform: scale(0.82); } 55% { transform: scale(1.08); } 100% { transform: scale(1); } }
@keyframes ui-ts-timer { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@keyframes ui-ts-text-in { from { opacity: 0; transform: translateY(4px); filter: blur(3px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes ui-ts-text-out { from { opacity: 1; } to { opacity: 0; transform: translateY(-4px); filter: blur(3px); } }

/* Phones: full width along the edge with 12px gutters */
@media (max-width: 600px) {
  .ui-ts, .ui-ts[data-x] { left: 12px; right: 12px; width: auto; max-width: none; transform: none; }
  .ui-ts[data-y="bottom"] { bottom: 12px; }
  .ui-ts:not([data-inline])[data-y="bottom"] { bottom: max(12px, env(safe-area-inset-bottom)); }
  .ui-ts[data-y="top"] { top: 12px; }
}
/* Touch screens: a visible close button with a big hit area, a taller action button */
@media (hover: none) and (pointer: coarse) {
  .ui-ts__toast:not([data-behind]) .ui-ts__close { opacity: 1; transform: none; }
  .ui-ts__close { width: 24px; height: 24px; top: -8px; left: -8px; }
  .ui-ts__close::before { inset: -8px; }
  .ui-ts__action { height: 36px; margin: -8px -2px -8px 0; padding: 0 14px; border-radius: 10px; font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-ts *:not(.ui-ts__spin):not(.ui-ts__timer), .ui-ts *::before, .ui-ts *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-ts {
  --ui-ts-card: #19191b;
  --ui-ts-line: #2a2a2e;
  --ui-ts-ink: #ededed;
  --ui-ts-text: #c8c8cc;
  --ui-ts-muted: #8b8b92;
  --ui-ts-faint: #5c5c63;
  --ui-ts-button: #26262a;
  --ui-ts-button-hover: #2e2e33;
  --ui-ts-hairline: rgba(255, 255, 255, 0.16);
  --ui-ts-success: #4cc38a;
  --ui-ts-danger: #ff6369;
  --ui-ts-shadow: 0 0 0 1px var(--ui-ts-line), 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 28px -6px rgba(0, 0, 0, 0.5);
  --ui-ts-focus: rgba(255, 255, 255, 0.3);
}
`;
