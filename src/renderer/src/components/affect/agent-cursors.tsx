// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/*
 * Agent Cursors – agents working in a document like teammates in a multiplayer editor, in a single self-contained file.
 * Every agent has a pointer with its name on a small flag – a dark card with a pink-to-blue edge – and you see live where each one is and
 * what it is doing – in the text, on an image, in a code block or in a comment next to the page.
 *   · pointers glide from place to place; while an agent types, its pointer and caret follow every letter
 *   · an agent can select a passage – it lights up in the agent's color – and the flag tells what it does with it
 *   · changes arrive as suggestions in the agent's color: new text underlined, removed text struck through;
 *     hover or focus one to accept or reject it, or accept them all from the header
 *   · images shimmer while they load; an agent can take one by its corner and resize it – frame, handles and size in its color
 *   · comments are pins on the page: open while an agent writes, then a round pin with the agent's mark;
 *     hover or focus a pin to read it, reply, or resolve it
 *   · the faces in the header show who is here and who is typing; click one to follow that agent – the others fade back
 *   · with a fixed height the page fades out towards the bottom, like a long document seen through a window
 * The positions are measured from the page itself, so any width, font or zoom works.
 * The styles are injected below, so no extra files are needed.
 */

export type CursorAgent = {
  id: string;
  name: string;
  /** The agent's color – pointer, caret, selection, frame and suggestions. Leave it out for the one shared ink
   *  (near-black, light in dark mode), so every agent looks the same and only the logos tell them apart */
  color?: string;
  /** A small mark, e.g. the model maker's logo – defaults to the initial */
  avatar?: ReactNode;
  /** The fill of its face while you follow it – defaults to a light wash of its color (e.g. a gray for a black logo) */
  tint?: string;
  /** What it has cost so far – shown on its flag, and summed up in the header */
  cost?: number;
};

export type DocBlock = {
  id: string;
  kind?: "title" | "heading" | "paragraph" | "item" | "code" | "image" | "table";
  /** The text – for an image its caption */
  text?: string;
  /** Image: its width as a share of the page, 0–1 (default 1) – change it and the image resizes smoothly */
  width?: number;
  /** Image: width ÷ height (default 16 / 9). A floated image without a ratio is as tall as the text beside it */
  ratio?: number;
  /** Image: let the following text flow around it, on its right ("left") or its left ("right") */
  float?: "left" | "right";
  /** Image: still loading – a shimmer instead of the picture */
  loading?: boolean;
  /** Image: the picture */
  src?: string;
  alt?: string;
  /** Table: its rows of cells, the first one the header. Every cell is a block of its own (id and text),
   *  so cursors, selections, suggestions and comment pins work in it like anywhere else */
  rows?: DocBlock[][];
  /** Table: shows an "Add row" line under the rows, like the Data Table – a cursor can point at it
   *  with the block id `${table id}:add` (and press it); add the row to `rows` and the table grows smoothly */
  addRow?: boolean;
  /** Table cell: shows its text as a small status pill in this tone */
  tone?: "gray" | "blue" | "green" | "amber";
};

export type DocTab = { id: string; label: string };

export type DocSuggestion = {
  id: string;
  /** Who suggests it */
  agent: string;
  block: string;
  /** Where it starts, as a character offset in the block's text */
  at: number;
  /** How many characters it removes from there */
  remove?: number;
  /** What it puts in their place */
  insert?: string;
  /** Why – shown when you open the suggestion */
  note?: string;
};

export type DocComment = {
  id: string;
  agent: string;
  /** The block it is pinned to – the pin sits at its top edge */
  block: string;
  /** Pins it to a character in the block's text – the pin's point sits right on it */
  at?: number;
  /** Without `at`: where along the page the pin sits, 0 (left) – 1 (right); default 0.9 */
  x?: number;
  /** Moves the pin down from the block's top edge, in px */
  y?: number;
  text: string;
  /** Keeps the comment open, e.g. while the agent writes it – otherwise it shows as a pin that opens on hover */
  open?: boolean;
};

export type AgentCursor = {
  /** A block id – or a comment id, for an agent writing a comment */
  block: string;
  /** Character offset in the text – or in the suggestion's new text when `in` is set */
  at?: number;
  /** The id of a suggestion the agent is typing into */
  in?: string;
  /** Text: a selected passage of this many characters from `at`. Image: any number – the agent holds the image (frame and handles) */
  select?: number;
  /** Image: where the pointer rests – on the middle or on the corner handle (default "center") */
  point?: "center" | "corner";
  /** What it is doing, on its flag – e.g. "Checking the numbers" */
  doing?: string;
  /** Typing: the caret holds still instead of blinking and the pointer follows each letter */
  typing?: boolean;
  /** A click: the arrow presses in and what it points at lights up */
  press?: boolean;
};

export type AgentCursorsProps = {
  agents: CursorAgent[];
  blocks: DocBlock[];
  suggestions?: DocSuggestion[];
  /** Comment pins on the page */
  comments?: DocComment[];
  /** Resolves a comment – the black check in its window */
  onResolveComment?: (comment: DocComment) => void;
  /** A reply typed into a comment's window and sent with Enter */
  onReply?: (comment: DocComment, text: string) => void;
  /** Where each agent is – a missing or null entry means the agent has left the document */
  cursors: Record<string, AgentCursor | null | undefined>;
  onAccept?: (suggestion: DocSuggestion) => void;
  onReject?: (suggestion: DocSuggestion) => void;
  /** Shows "Accept all" in the header when there is more than one suggestion */
  onAcceptAll?: () => void;
  /** Controlled: the agent you follow (the others fade back) */
  following?: string | null;
  onFollowingChange?: (agent: string | null) => void;
  /** A fixed page height in px – the rest of the document fades out towards the bottom */
  height?: number;
  /** Formats every cost – defaults to dollars, e.g. "$0.42" */
  formatCost?: (amount: number) => string;
  /** Tabs above the page, e.g. the document and a table view of it */
  tabs?: DocTab[];
  /** The open tab – controlled; the page content is yours to switch */
  tab?: string;
  onTabChange?: (tab: string) => void;
  title?: string;
  className?: string;
};

/** Accepts a suggestion: writes it into the text and moves the other suggestions in that block along */
export function acceptSuggestion(blocks: DocBlock[], suggestions: DocSuggestion[], id: string) {
  const s = suggestions.find((x) => x.id === id);
  if (!s) return { blocks, suggestions };
  const remove = s.remove ?? 0;
  const insert = s.insert ?? "";
  const shift = insert.length - remove;
  return {
    blocks: blocks.map(function write(b: DocBlock): DocBlock {
      if (b.id === s.block) return { ...b, text: (b.text ?? "").slice(0, s.at) + insert + (b.text ?? "").slice(s.at + remove) };
      // Table cells are blocks too
      return b.rows ? { ...b, rows: b.rows.map((row) => row.map(write)) } : b;
    }),
    suggestions: suggestions
      .filter((x) => x.id !== id)
      .map((x) => (x.block === s.block && x.at >= s.at + remove ? { ...x, at: x.at + shift } : x)),
  };
}

type Point = { x: number; y: number; h: number; free?: boolean };
type Box = { x: number; y: number; w: number; h: number };

const textOf = (el: Element | null) => {
  const n = el?.firstChild;
  return n && n.nodeType === 3 ? (n as Text) : null;
};

/** The text node and offset for a place in a block: in the plain text, or inside a suggestion's new text */
function locate(block: HTMLElement, at: number, inSuggestion?: string): [Text, number] | null {
  if (inSuggestion) {
    const el = block.querySelector(`[data-ins="${CSS.escape(inSuggestion)}"]`);
    if (el) {
      const t = textOf(el);
      if (t) return [t, Math.max(0, Math.min(at, t.length))];
      // Nothing typed yet: right after the struck-through text (past the line-break hint), or before what follows
      let before = el.previousElementSibling;
      if (before?.tagName === "WBR") before = before.previousElementSibling;
      const prev = textOf(before);
      if (prev) return [prev, prev.length];
      const next = textOf(el.nextElementSibling);
      if (next) return [next, 0];
    }
  }
  let best: [Text, number] | null = null;
  for (const seg of block.querySelectorAll<HTMLElement>("[data-from]")) {
    const t = textOf(seg);
    if (!t) continue;
    const from = Number(seg.dataset.from);
    if (at >= from && at <= from + t.length) {
      best = [t, at - from];
      if (at < from + t.length) break;
    }
  }
  return best;
}

/** The caret's box at a place in a text node */
function caret(node: Text, offset: number): DOMRect | null {
  const r = document.createRange();
  if (!node.length) return null;
  if (offset < node.length) {
    r.setStart(node, offset);
    r.setEnd(node, offset + 1);
    return r.getClientRects()[0] ?? null;
  }
  r.setStart(node, offset - 1);
  r.setEnd(node, offset);
  const rects = r.getClientRects();
  const b = rects[rects.length - 1];
  return b ? new DOMRect(b.right, b.top, 0, b.height) : null;
}

// The first whole letter or digit – never half an emoji
const initial = (name: string) => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
// Dollars with separators – a sliver of a cent reads "<$0.01" instead of "$0.00"
const dollars = (n: number) => (n !== 0 && Math.abs(n) < 0.005 ? `${n < 0 ? "-" : ""}<$0.01` : usd.format(n));
/** A usable number, or nothing – NaN and Infinity count as not given */
const finite = (n?: number) => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
// Faces in the header: the rest go into "+N", fewer on a narrow page
const MAX_FACES = 6;
/** A zero-width space keeps an empty comment measurable, so a caret can sit in it */
const EMPTY = "​";

export function AgentCursors({
  agents,
  blocks,
  suggestions = [],
  comments = [],
  onResolveComment,
  onReply,
  cursors,
  onAccept,
  onReject,
  onAcceptAll,
  following: followingProp,
  onFollowingChange,
  height,
  tabs,
  tab,
  onTabChange,
  formatCost = dollars,
  title = "Untitled",
  className,
}: AgentCursorsProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<Record<string, Point>>({});
  const [marks, setMarks] = useState<Record<string, Box[]>>({});
  const [notes, setNotes] = useState<Record<string, { x: number; y: number }>>({});
  // The height of each comment's content – the pin grows to it when it opens
  const [pinH, setPinH] = useState<Record<string, number>>({});
  // Floated images without a ratio take the height of the text beside them
  const [fit, setFit] = useState<Record<string, { w: number; h: number }>>({});
  // The comment pin that is open from hover or focus, and the reply being typed
  const [pinOpen, setPinOpen] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const pinTimer = useRef(0);
  const [width, setWidth] = useState(0);
  const [sheetW, setSheetW] = useState(0);
  const [stageH, setStageH] = useState(0);
  // The right edge of whatever clips the component (a scroll area, a preview frame), and every flag's width –
  // a flag may stick out past the page, but moves in before that edge would cut it off
  const [clipR, setClipR] = useState(Infinity);
  const flags = useRef(new Map<string, HTMLElement>());
  const [flagW, setFlagW] = useState<Record<string, number>>({});
  const [innerFollow, setInnerFollow] = useState<string | null>(null);
  const following = followingProp !== undefined ? followingProp : innerFollow;
  const follow = (id: string | null) => {
    if (followingProp === undefined) setInnerFollow(id);
    onFollowingChange?.(id);
  };

  // The suggestion that is open: hovered or focused, with its box for the little window
  const [open, setOpen] = useState<{ id: string; box: Box } | null>(null);
  const closeTimer = useRef(0);

  /* ---------- Measuring: every pointer, selection and comment from the page itself ---------- */

  const measure = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const outer = stage.getBoundingClientRect();
    const scale = stage.offsetWidth ? outer.width / stage.offsetWidth : 1;
    const rel = (b: DOMRect | DOMRectReadOnly): Box => ({ x: (b.left - outer.left) / scale, y: (b.top - outer.top) / scale, w: b.width / scale, h: b.height / scale });
    const r10 = (n: number) => Math.round(n * 10) / 10;
    const nextPoints: Record<string, Point> = {};
    const nextMarks: Record<string, Box[]> = {};
    for (const a of agents) {
      const c = cursors[a.id];
      if (!c) continue;
      const block = stage.querySelector<HTMLElement>(`[data-block="${CSS.escape(c.block)}"]`);
      if (!block) continue;
      // An image: the pointer rests on its middle or on the corner handle
      const img = block.dataset.kind === "image" ? block.querySelector<HTMLElement>(".ui-agc__img") : null;
      if (img) {
        const b = rel(img.getBoundingClientRect());
        // On the corner: right on the bottom-right handle
        const at = c.point === "corner" ? { x: r10(b.x + b.w), y: r10(b.y + b.h), h: 0, free: true } : { x: r10(b.x + b.w * 0.55), y: r10(b.y + b.h * 0.5), h: 0, free: true };
        nextPoints[a.id] = at;
        // Holding it: move the pointer in this very frame, so it never trails the handle while the image resizes
        if (c.point === "corner" && c.select) {
          const el = stage.querySelector<HTMLElement>(`[data-agent="${CSS.escape(a.id)}"]`);
          if (el) el.style.transform = `translate(${at.x}px, ${at.y}px)`;
        }
        continue;
      }
      const spot = locate(block, c.at ?? 0, c.in);
      const box = spot ? caret(...spot) : null;
      if (box) {
        const b = rel(box);
        nextPoints[a.id] = { x: r10(b.x), y: r10(b.y), h: r10(b.h) };
      }
      if (c.select && !c.in) {
        const from = locate(block, c.at ?? 0);
        const to = locate(block, (c.at ?? 0) + c.select);
        if (from && to) {
          const r = document.createRange();
          r.setStart(...from);
          r.setEnd(...to);
          // One box per line: the rects of the inline pieces joined
          const lines: Box[] = [];
          for (const rect of r.getClientRects()) {
            if (rect.width < 0.5) continue;
            const b = rel(rect);
            const line = lines.find((l) => Math.abs(l.y - b.y) < 3);
            if (line) {
              const right = Math.max(line.x + line.w, b.x + b.w);
              line.x = Math.min(line.x, b.x);
              line.w = right - line.x;
            } else lines.push({ ...b });
          }
          nextMarks[a.id] = lines.map((l) => ({ x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h) }));
        }
      }
    }
    // Comment pins: on their block's top edge, at their place along the page
    const sheetBox = sheetRef.current ? rel(sheetRef.current.getBoundingClientRect()) : { x: 0, w: stage.offsetWidth };
    const nextNotes: Record<string, { x: number; y: number }> = {};
    for (const cm of comments) {
      const block = stage.querySelector<HTMLElement>(`[data-block="${CSS.escape(cm.block)}"]`);
      if (!block) continue;
      // On a character: the pin's point touches the top of the letter
      const spot = cm.at !== undefined ? locate(block, cm.at) : null;
      const letter = spot ? caret(...spot) : null;
      if (letter) {
        const l = rel(letter);
        nextNotes[cm.id] = { x: Math.round(l.x), y: Math.round(l.y + 3 + (cm.y ?? 0)) };
        continue;
      }
      const b = rel(block.getBoundingClientRect());
      nextNotes[cm.id] = { x: Math.round(sheetBox.x + sheetBox.w * Math.max(0, Math.min(1, cm.x ?? 0.9))), y: Math.round(b.y + (cm.y ?? 0)) };
    }
    const nextFit: Record<string, { w: number; h: number }> = {};
    for (const fig of stage.querySelectorAll<HTMLElement>("figure[data-fit]")) {
      // Only while text runs beside it – on a narrow page the image sits above its text and keeps its own shape
      if (getComputedStyle(fig).float === "none") continue;
      const beside = fig.nextElementSibling as HTMLElement | null;
      // No room beside it (a float as wide as the page): the text starts below, and taking its height would grow both forever
      if (beside) {
        const r = document.createRange();
        r.selectNodeContents(beside);
        const first = r.getClientRects()[0];
        if (first && first.top >= fig.getBoundingClientRect().bottom - 1) continue;
      }
      if (beside && fig.dataset.block) nextFit[fig.dataset.block] = { w: Math.round(fig.offsetWidth), h: Math.max(48, Math.round(beside.offsetHeight)) };
    }
    const nextPinH: Record<string, number> = {};
    for (const cm of comments) {
      const body = stage.querySelector<HTMLElement>(`[data-comment="${CSS.escape(cm.id)}"] .ui-agc__pin-body`);
      if (body) nextPinH[cm.id] = body.offsetHeight;
    }
    const same = <T,>(prev: T, next: T) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    setPoints((prev) => same(prev, nextPoints));
    setMarks((prev) => same(prev, nextMarks));
    setNotes((prev) => same(prev, nextNotes));
    setPinH((prev) => same(prev, nextPinH));
    setFit((prev) => same(prev, nextFit));
    setWidth(stage.offsetWidth);
    setSheetW(sheetRef.current?.offsetWidth ?? stage.offsetWidth);
    setStageH(stage.offsetHeight);
    let clip: HTMLElement | null = stage.parentElement;
    while (clip && clip !== document.body && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
    const right = clip && clip !== document.body ? clip.getBoundingClientRect().right : window.innerWidth;
    setClipR(Math.round((right - outer.left) / scale));
    const nextW: Record<string, number> = {};
    for (const [id, el] of flags.current) nextW[id] = el.offsetWidth;
    setFlagW((prev) => (JSON.stringify(prev) === JSON.stringify(nextW) ? prev : nextW));
  };
  const latest = useRef(measure);
  latest.current = measure;

  // Tables grow and shrink smoothly: the card's height follows its table with a transition,
  // so a new row opens up and everything below slides down instead of jumping
  useLayoutEffect(() => {
    for (const card of stageRef.current?.querySelectorAll<HTMLElement>(".ui-agc__table-card") ?? []) {
      const table = card.firstElementChild as HTMLElement | null;
      if (!table) continue;
      const h = `${table.offsetHeight}px`;
      if (card.style.height === h) continue;
      if (!card.style.height) {
        // First time: no animation
        card.style.transition = "none";
        card.style.height = h;
        void card.offsetHeight;
        card.style.transition = "";
      } else card.style.height = h;
    }
  });

  // After every change – when the page changes size, the fonts arrive, and every frame while an image resizes
  useLayoutEffect(() => latest.current());
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => latest.current());
    ro.observe(stage);
    document.fonts?.ready.then(() => latest.current());
    let raf = 0;
    let until = 0;
    const loop = () => {
      latest.current();
      raf = performance.now() < until ? requestAnimationFrame(loop) : 0;
    };
    const onRun = (e: TransitionEvent) => {
      const el = e.target as HTMLElement;
      if (!el.classList?.contains("ui-agc__figure") && !el.classList?.contains("ui-agc__table-card")) return;
      until = performance.now() + 900;
      if (!raf) raf = requestAnimationFrame(loop);
    };
    stage.addEventListener("transitionrun", onRun);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      stage.removeEventListener("transitionrun", onRun);
    };
  }, []);

  /* ---------- Arriving pointers pop in where they are, instead of flying in from the corner ---------- */

  const present = agents.filter((a) => cursors[a.id] && points[a.id]).map((a) => a.id);
  const seen = useRef(new Set<string>());
  const [, rerender] = useState(0);
  const arriving = present.filter((id) => !seen.current.has(id));
  useEffect(() => {
    if (!arriving.length) {
      // Left agents arrive anew next time
      for (const id of [...seen.current]) if (!present.includes(id)) seen.current.delete(id);
      return;
    }
    const t = window.setTimeout(() => {
      arriving.forEach((id) => seen.current.add(id));
      rerender((n) => n + 1);
    }, 40);
    return () => window.clearTimeout(t);
  });
  // The last place of every agent, so one that leaves fades out where it was
  const last = useRef<Record<string, Point>>({});
  Object.assign(last.current, points);

  /* ---------- New suggestions and comments are announced ---------- */

  const [announce, setAnnounce] = useState("");
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set([...suggestions.map((s) => s.id), ...comments.map((c) => c.id)]);
    if (known.current) {
      const fresh = suggestions.find((s) => !known.current!.has(s.id));
      const note = comments.find((c) => !known.current!.has(c.id));
      const who = (id?: string) => agents.find((a) => a.id === id)?.name;
      if (fresh && who(fresh.agent)) setAnnounce(`${who(fresh.agent)} suggests a change${fresh.note ? `: ${fresh.note}` : ""}`);
      else if (note && who(note.agent)) setAnnounce(`${who(note.agent)} is writing a comment`);
    }
    known.current = ids;
  }, [suggestions, comments, agents]);

  /* ---------- The open suggestion ---------- */

  const show = (id: string, el: HTMLElement) => {
    window.clearTimeout(closeTimer.current);
    const stage = stageRef.current;
    if (!stage) return;
    const outer = stage.getBoundingClientRect();
    const scale = stage.offsetWidth ? outer.width / stage.offsetWidth : 1;
    const rects = el.getClientRects();
    const b = rects[rects.length - 1] ?? el.getBoundingClientRect();
    setOpen({ id, box: { x: (b.left - outer.left) / scale, y: (b.top - outer.top) / scale, w: b.width / scale, h: b.height / scale } });
  };
  const hide = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(null), 140);
  };
  const openSug = open ? suggestions.find((s) => s.id === open.id) : undefined;
  // The window is 260px, or the page's width when that is narrower
  const popW = sheetW > 0 ? Math.min(260, sheetW) : 260;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(
    () => () => {
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(pinTimer.current);
    },
    [],
  );

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const colorOf = (id: string) => agentOf(id)?.color;
  const nameOf = (id: string) => agentOf(id)?.name ?? "Agent";
  const mark = (a?: CursorAgent) => a?.avatar ?? <span className="ui-agc__face-initial">{initial(a?.name ?? "?")}</span>;

  /* ---------- One block: its text with the suggestions inline ---------- */

  const textParts = (b: DocBlock) => {
    const text = b.text ?? "";
    const list = suggestions.filter((s) => s.block === b.id).sort((x, y) => x.at - y.at);
    const parts: ReactNode[] = [];
    let pos = 0;
    for (const s of list) {
      const at = Math.max(pos, Math.min(s.at, text.length));
      if (at > pos) parts.push(<span key={`t${pos}`} data-from={pos}>{text.slice(pos, at)}</span>);
      const remove = Math.min(s.remove ?? 0, text.length - at);
      const style = { ["--ui-agc-c" as string]: colorOf(s.agent) };
      const events = {
        tabIndex: 0,
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(s.id, e.currentTarget),
        onMouseLeave: hide,
        onFocus: (e: React.FocusEvent<HTMLElement>) => show(s.id, e.currentTarget),
        onBlur: hide,
        "data-open": open?.id === s.id ? "" : undefined,
      };
      if (remove) {
        parts.push(
          <del key={`d${s.id}`} className="ui-agc__del" data-from={at} data-sug={s.id} style={style} {...events} aria-label={`${nameOf(s.agent)} suggests removing: ${text.slice(at, at + remove)}`}>
            {text.slice(at, at + remove)}
          </del>,
        );
      }
      // A possible line break between the old and the new text, so a narrow cell can wrap them
      if (remove && s.insert !== undefined) parts.push(<wbr key={`b${s.id}`} />);
      if (s.insert !== undefined) {
        parts.push(
          <ins key={`i${s.id}`} className="ui-agc__ins" data-ins={s.id} data-sug={s.id} style={style} {...events} aria-label={`${nameOf(s.agent)} suggests adding: ${s.insert}`}>
            {s.insert}
          </ins>,
        );
      }
      pos = at + remove;
    }
    // An empty block keeps an invisible character, so a caret can sit in it while an agent starts typing
    if (pos < text.length || !parts.length) parts.push(<span key={`t${pos}`} data-from={pos}>{text.slice(pos) || EMPTY}</span>);
    return parts;
  };

  // Who holds an image: an agent on it with a selection
  const holder = (blockId: string) => agents.find((a) => cursors[a.id]?.block === blockId && cursors[a.id]?.select);

  const renderBlock = (b: DocBlock) => {
    const kind = b.kind ?? "paragraph";
    if (kind === "image") {
      const w = Math.max(0.2, Math.min(1, finite(b.width) ?? 1));
      const given = finite(b.ratio);
      const ratio = given && given > 0 ? given : 16 / 9;
      const fits = !!b.float && !(given && given > 0);
      const box = fits ? fit[b.id] : undefined;
      const by = holder(b.id);
      return (
        <figure key={b.id} className="ui-agc__figure" data-block={b.id} data-kind="image" data-float={b.float} data-fit={fits ? "" : undefined} style={{ width: `${w * 100}%` }}>
          <div
            className="ui-agc__img"
            data-loading={b.loading ? "" : undefined}
            data-held={by ? "" : undefined}
            style={{ ...(fits && box ? { height: box.h } : { aspectRatio: String(ratio) }), ["--ui-agc-c" as string]: by?.color }}
            role="img"
            aria-label={b.loading ? "Image loading" : b.alt || b.text || "Image"}
          >
            {/* Loading: gray with a light sweeping across – the picture fades in once it's there */}
            {b.loading || !b.src ? <span className="ui-agc__shimmer" aria-hidden="true" /> : <img src={b.src} alt="" draggable={false} />}
            {by && (
              <>
                {["tl", "tr", "bl", "br"].map((h) => (
                  <span key={h} className="ui-agc__handle" data-at={h} aria-hidden="true" />
                ))}
                <span className="ui-agc__size" aria-hidden="true">
                  {box ? `${box.w * 2} × ${box.h * 2}` : `${Math.round(1200 * w)} × ${Math.round((1200 * w) / ratio)}`}
                </span>
              </>
            )}
          </div>
          {b.text && (
            <figcaption className="ui-agc__caption" dir="auto">
              {b.text}
            </figcaption>
          )}
        </figure>
      );
    }
    if (kind === "table") {
      const [head, ...body] = b.rows ?? [];
      const cell = (c: DocBlock) =>
        c.tone ? (
          <span className="ui-agc__pill" data-tone={c.tone} data-block={c.id}>
            {textParts(c)}
          </span>
        ) : (
          <span className="ui-agc__cell" data-block={c.id}>
            {textParts(c)}
          </span>
        );
      return (
        <div key={b.id} className="ui-agc__table-card">
          <table className="ui-agc__table">
            {head && (
              <thead>
                <tr>
                  {head.map((c) => (
                    <th key={c.id} title={c.text || undefined}>
                      {cell(c)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, i) => (
                <tr key={row[0]?.id ?? i}>
                  {row.map((c) => (
                    <td key={c.id} title={c.text || undefined}>
                      {cell(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {b.addRow && (
              <tfoot>
                <tr>
                  <td colSpan={head?.length ?? 1}>
                    {/* "Add row", like the Data Table – lit while a pointer is on it, pressed when it clicks */}
                    <span
                      className="ui-agc__add"
                      data-block={`${b.id}:add`}
                      data-hover={agents.some((a) => cursors[a.id]?.block === `${b.id}:add`) ? "" : undefined}
                      data-pressed={agents.some((a) => cursors[a.id]?.block === `${b.id}:add` && cursors[a.id]?.press) ? "" : undefined}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      <span data-from={0}>Add row</span>
                    </span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      );
    }
    if (kind === "code") {
      return (
        <pre key={b.id} className="ui-agc__code" data-block={b.id}>
          <code>{textParts(b)}</code>
        </pre>
      );
    }
    const Tag = kind === "title" ? "h2" : kind === "heading" ? "h3" : kind === "item" ? "li" : "p";
    return (
      <Tag key={b.id} className={`ui-agc__block ui-agc__block--${kind}`} data-block={b.id} dir="auto">
        {textParts(b)}
      </Tag>
    );
  };

  // Consecutive items form one list
  const body: ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind === "item") {
      const items: DocBlock[] = [];
      while (i < blocks.length && blocks[i].kind === "item") items.push(blocks[i++]);
      i--;
      body.push(
        <ul key={`l${items[0].id}`} className="ui-agc__list">
          {items.map(renderBlock)}
        </ul>,
      );
    } else body.push(renderBlock(blocks[i]));
  }

  const here = agents.filter((a) => cursors[a.id]);
  const spent = agents.some((a) => finite(a.cost) !== undefined) ? agents.reduce((sum, a) => sum + (finite(a.cost) ?? 0), 0) : null;
  // Many agents: as many faces as fit, the followed one always among them, the rest in "+N"
  const maxFaces = width > 0 && width < 480 ? 3 : MAX_FACES;
  const lead = agents.slice(0, maxFaces - 1);
  const faces =
    agents.length <= maxFaces
      ? agents
      : following && !lead.some((a) => a.id === following)
        ? [...lead.slice(0, -1), ...agents.filter((a) => a.id === following)]
        : lead;
  const rest = agents.filter((a) => !faces.includes(a));
  // Comments being written: the agent's own flag steps aside – the window already shows its name
  const noteIds = new Set(comments.map((cm) => cm.id));
  const typing = here.filter((a) => cursors[a.id]?.typing).length;

  return (
    <div
      className={["ui-agc", className].filter(Boolean).join(" ")}
      data-following={following ?? undefined}
      data-fade={height ? "" : undefined}
      style={height ? { ["--ui-agc-height" as string]: `${height}px` } : undefined}
    >
      <style href="ui-agent-cursors" precedence="default">
        {css}
      </style>

      {tabs && tabs.length > 0 && (
        <div className="ui-agc__tabs" role="tablist" aria-label="Views">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="ui-agc__tab" aria-selected={t.id === (tab ?? tabs[0].id)} onClick={() => onTabChange?.(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="ui-agc__stage" ref={stageRef}>
        {/* The page's stroke and shadow on their own layer – the page itself is masked to fade out, which would cut them off */}
        <div className="ui-agc__shade" aria-hidden="true">
          <span />
        </div>
        <div className="ui-agc__sheet" ref={sheetRef}>
          {/* The header: the document, who is here, and the suggestions */}
          <header className="ui-agc__bar">
            <span className="ui-agc__doc" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2.5H7.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
                <path d="M14 2.5V7h4.5M9 12.5h6M9 16h4" />
              </svg>
            </span>
            <span className="ui-agc__title" title={title}>
              {title}
            </span>

            <div className="ui-agc__people" role="group" aria-label="Agents in this document">
              {faces.map((a) => {
                const c = cursors[a.id];
                const isOn = following === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    className="ui-agc__face"
                    data-here={c ? "" : undefined}
                    data-typing={c?.typing ? "" : undefined}
                    aria-pressed={isOn}
                    aria-label={`${isOn ? "Stop following" : "Follow"} ${a.name}${c?.doing ? ` – ${c.doing}` : c ? "" : " (not in the document)"}`}
                    style={{ ["--ui-agc-c" as string]: a.color, ["--ui-agc-tint" as string]: a.tint }}
                    onClick={() => follow(isOn ? null : a.id)}
                  >
                    <span className="ui-agc__face-mark">{mark(a)}</span>
                    {/* The name, and below it in one short line what the agent is doing */}
                    <span className="ui-agc__face-tip" aria-hidden="true">
                      <b>{a.name}</b>
                      <span>{c?.doing ?? (c ? "In the document" : "Away")}</span>
                    </span>
                  </button>
                );
              })}
              {rest.length > 0 && (
                <span className="ui-agc__face ui-agc__face-more" title={rest.map((a) => a.name).join(", ")} aria-label={`${rest.length} more: ${rest.map((a) => a.name).join(", ")}`}>
                  +{rest.length.toLocaleString("en-US")}
                </span>
              )}
            </div>

            <span className="ui-agc__sum">
              {suggestions.length > 0
                ? `${suggestions.length.toLocaleString("en-US")} suggestion${suggestions.length === 1 ? "" : "s"}`
                : typing
                  ? `${typing.toLocaleString("en-US")} typing`
                  : `${here.length.toLocaleString("en-US")} here`}
              {spent !== null && (
                <b className="ui-agc__spent" data-zero={spent === 0 ? "" : undefined}>
                  {formatCost(spent)}
                </b>
              )}
            </span>
            {/* Always there, so the header doesn't shift – faded and off until there is something to accept */}
            {onAcceptAll && (
              <button type="button" className="ui-agc__all" disabled={suggestions.length === 0} onClick={onAcceptAll}>
                Accept all
              </button>
            )}
          </header>

          {/* Classic: the white page sits in the gray tray, under the header */}
          <div className="ui-agc__paper" aria-hidden="true" />
          {/* The page: selections behind the text */}
          <div className="ui-agc__marks" aria-hidden="true">
            {agents.map((a) =>
              (marks[a.id] ?? []).map((m, i) => (
                <span
                  key={`${a.id}-${i}`}
                  className="ui-agc__mark"
                  data-dim={following && following !== a.id ? "" : undefined}
                  style={{ left: m.x - 1, top: m.y, width: m.w + 2, height: m.h, ["--ui-agc-c" as string]: a.color }}
                />
              )),
            )}
          </div>
          <div className="ui-agc__text" key={tab}>
            {body}
          </div>
        </div>

        {/* Comment pins: open while written, then a round pin that opens on hover or focus */}
        <div className="ui-agc__notes">
          {comments.map((cm) => {
            const a = agentOf(cm.agent);
            const at = notes[cm.id];
            if (!at) return null;
            const isOpen = !!cm.open || pinOpen === cm.id;
            // The window is as wide as fits, and moves in from the pin just enough to stay on the page
            const cardW = Math.min(248, Math.max(160, width - 16));
            const slide = isOpen ? Math.max(8 - at.x, Math.min(0, width - 8 - (at.x + cardW))) : 0;
            // Near the bottom it opens upwards
            const up = stageH > 0 && at.y + 190 > stageH;
            const keep = () => window.clearTimeout(pinTimer.current);
            const close = () => {
              window.clearTimeout(pinTimer.current);
              pinTimer.current = window.setTimeout(() => setPinOpen((o) => (o === cm.id ? null : o)), 160);
            };
            return (
              <div
                key={cm.id}
                className="ui-agc__pin"
                data-comment={cm.id}
                data-open={isOpen ? "" : undefined}
                data-up={up ? "" : undefined}
                style={{ left: at.x, top: at.y, ["--ui-agc-c" as string]: a?.color, ["--ui-agc-pin-h" as string]: `${pinH[cm.id] ?? 120}px`, ["--ui-agc-pin-w" as string]: `${cardW}px`, ["--ui-agc-pin-x" as string]: `${slide}px` }}
                onMouseEnter={() => {
                  keep();
                  setPinOpen(cm.id);
                }}
                onMouseLeave={close}
                onFocus={() => {
                  keep();
                  setPinOpen(cm.id);
                }}
                onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && close()}
              >
                {/* One shape: the round pin grows into the comment's window – the mark stays and moves to its corner */}
                <div className="ui-agc__pin-box">
                  <span className="ui-agc__pin-mark">{mark(a)}</span>
                  <button
                    type="button"
                    className="ui-agc__pin-hit"
                    aria-expanded={isOpen}
                    aria-label={`Comment from ${a?.name ?? "an agent"}: ${cm.text}`}
                    tabIndex={isOpen ? -1 : 0}
                  />
                  <div className="ui-agc__pin-body" role="group" aria-label={`Comment from ${a?.name ?? "an agent"}`} aria-hidden={!isOpen}>
                  <div className="ui-agc__note-head">
                    <b title={a?.name}>{a?.name}</b>
                    <span>now</span>
                  </div>
                  <p className="ui-agc__note-text" data-block={cm.id} dir="auto">
                    <span data-from={0}>{cm.text || EMPTY}</span>
                  </p>
                  {(onReply || onResolveComment) && (
                    <div className="ui-agc__pin-actions">
                      {onReply ? (
                        <input
                          className="ui-agc__reply"
                          value={pinOpen === cm.id ? reply : ""}
                          placeholder="Reply"
                          aria-label={`Reply to ${a?.name ?? "the agent"}`}
                          tabIndex={isOpen ? 0 : -1}
                          onChange={(e) => setReply(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && reply.trim()) {
                              onReply(cm, reply.trim());
                              setReply("");
                            }
                            if (e.key === "Escape") setPinOpen(null);
                          }}
                        />
                      ) : (
                        <span className="ui-agc__reply" aria-hidden="true" />
                      )}
                      {onResolveComment && (
                        <button
                          type="button"
                          className="ui-agc__resolve"
                          aria-label="Resolve"
                          title="Resolve"
                          tabIndex={isOpen ? 0 : -1}
                          onClick={() => {
                            setPinOpen(null);
                            onResolveComment(cm);
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12.5l4.5 4.5L19 7.5" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* The pointers, over everything */}
        <div className="ui-agc__cursors" aria-hidden="true">
          {agents.map((a) => {
            const c = cursors[a.id];
            const p = (c && points[a.id]) || last.current[a.id];
            if (!p) return null;
            const gone = !c || !points[a.id];
            const cost = finite(a.cost);
            const tags = cost !== undefined ? [formatCost(cost)] : [];
            // Moves in only as far as needed to stay inside what clips the component – but never past its left edge
            const shift = Math.max(Math.min(0, 8 - (p.x + 16)), Math.min(0, clipR - 8 - (p.x + 16 + (flagW[a.id] ?? 0))));
            // On a fading page, a pointer fades with the page below it
            const fade = height ? Math.max(0, Math.min(1, (height * 0.97 - p.y) / (height * 0.47))) : 1;
            return (
              <div
                key={a.id}
                className="ui-agc__cursor"
                data-agent={a.id}
                data-gone={gone ? "" : undefined}
                data-arrive={!gone && arriving.includes(a.id) ? "" : undefined}
                data-typing={c?.typing ? "" : undefined}
                data-free={p.free ? "" : undefined}
                data-in-note={c && noteIds.has(c.block) ? "" : undefined}
                data-press={c?.press ? "" : undefined}
                data-drag={c?.point === "corner" && c.select ? "" : undefined}
                data-dim={following && following !== a.id ? "" : undefined}
                style={{ transform: `translate(${p.x}px, ${p.y}px)`, ["--ui-agc-c" as string]: a.color, ["--ui-agc-h" as string]: `${p.h}px`, ["--ui-agc-shift" as string]: `${shift}px` }}
              >
                <div className="ui-agc__cursor-in" style={fade < 1 ? { opacity: fade } : undefined}>
                <span className="ui-agc__caret" />
                {/* The pointer from the affectUI videos: a soft, rounded arrow */}
                <svg className="ui-agc__arrow" viewBox="-2.186 -0.256 18.514 22.277">
                  <path transform="rotate(21.37)" d="M13.92 4.07c1.69.66 3.03 1.18 3.94 1.68.46.25.87.53 1.16.86.31.35.51.79.48 1.29-.03.51-.27.92-.62 1.23-.33.3-.77.53-1.25.74-.96.4-2.36.78-4.12 1.26-.56.15-.98.27-1.26.37-.26.1-.38.18-.47.27-.09.09-.17.21-.27.47-.1.28-.22.7-.37 1.26-.48 1.76-.86 3.16-1.26 4.12-.2.49-.44.93-.74 1.25-.32.35-.72.6-1.23.62-.51.03-.94-.17-1.29-.48-.33-.29-.61-.7-.86-1.16-.5-.91-1.02-2.25-1.68-3.94L1.66 7.76C.96 5.99.41 4.59.16 3.51-.09 2.44-.12 1.39.63.63 1.39-.12 2.44-.09 3.51.16c1.08.25 2.48.8 4.25 1.5l6.16 2.41Z" />
                </svg>
                {/* The flag: a little below and to the right of the arrow – it may stick out past the page */}
                <span
                  className="ui-agc__flag"
                  ref={(el) => {
                    if (el) flags.current.set(a.id, el);
                    else flags.current.delete(a.id);
                  }}
                >
                  {/* The name with its cost as a small tag on the right, what it's doing below */}
                  <span className="ui-agc__flag-row">
                    <span className="ui-agc__flag-name" dir="auto">
                      {a.name}
                    </span>
                    {tags.length > 0 && (
                      <span className="ui-agc__flag-tags">
                        {tags.map((t, i) => (
                          <span key={i} className="ui-agc__flag-tag">
                            {t}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="ui-agc__flag-doing" data-on={c?.doing ? "" : undefined}>
                    <span>{c?.doing ?? ""}</span>
                  </span>
                </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* The open suggestion: who, why, accept or reject */}
        {open && openSug && (
          <div
            className="ui-agc__pop"
            role="dialog"
            aria-label={`Suggestion from ${nameOf(openSug.agent)}`}
            style={{ left: Math.max(0, Math.min(open.box.x, sheetW - popW)), top: open.box.y + open.box.h + 6, width: popW, ["--ui-agc-c" as string]: colorOf(openSug.agent) }}
            onMouseEnter={() => window.clearTimeout(closeTimer.current)}
            onMouseLeave={hide}
            onFocus={() => window.clearTimeout(closeTimer.current)}
            onBlur={hide}
          >
            <div className="ui-agc__pop-head">
              <span className="ui-agc__pop-mark">{mark(agentOf(openSug.agent))}</span>
              <b title={nameOf(openSug.agent)}>{nameOf(openSug.agent)}</b>
              <span>{openSug.remove && openSug.insert ? "suggests a rewrite" : openSug.remove ? "suggests removing" : "suggests adding"}</span>
            </div>
            {openSug.note && (
              <p className="ui-agc__pop-note" dir="auto">
                {openSug.note}
              </p>
            )}
            <div className="ui-agc__pop-actions">
              {onReject && (
                <button
                  type="button"
                  className="ui-agc__btn"
                  onClick={() => {
                    setOpen(null);
                    onReject(openSug);
                  }}
                >
                  Reject
                </button>
              )}
              {onAccept && (
                <button
                  type="button"
                  className="ui-agc__btn ui-agc__btn--primary"
                  onClick={() => {
                    setOpen(null);
                    onAccept(openSug);
                  }}
                >
                  Accept
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <span className="ui-agc__live" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-agc */
.ui-agc {
  --ui-agc-card: #ffffff;
  --ui-agc-tray: #f0f0f0;
  --ui-agc-ink: #171717;
  --ui-agc-text: #3d3d3d;
  --ui-agc-muted: #8a8a8a;
  --ui-agc-line: #ececec;
  --ui-agc-grid: #f0f0f0;
  --ui-agc-stroke: #efefef;
  --ui-agc-gap: 18px;
  --ui-agc-chip: #f5f5f5;
  --ui-agc-shimmer: #f0f0f0;
  --ui-agc-shine: #fafafa;
  --ui-agc-code: rgba(0, 0, 0, 0.035);
  --ui-agc-ring: rgba(23, 23, 23, 0.22);
  /* The one ink every agent shares unless it brings its own color */
  --ui-agc-agent: #1f1f22;
  /* Flags and comment pins: dark cards with a pink-to-blue edge */
  --ui-agc-flag: #141416;
  --ui-agc-flag-ink: #ffffff;
  --ui-agc-flag-soft: rgba(255, 255, 255, 0.14);
  --ui-agc-edge: linear-gradient(90deg, #ff4fa3, #8b6bff 55%, #3b8bff);
  --ui-agc-c: var(--ui-agc-agent);
  --ui-agc-glide: 560ms;
  --ui-agc-ease: cubic-bezier(0.22, 1, 0.36, 1);
  position: relative;
  box-sizing: border-box;
  width: 100%;
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 20px;
  letter-spacing: -0.006em;
  color: var(--ui-agc-text);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
.ui-agc *, .ui-agc *::before, .ui-agc *::after { box-sizing: border-box; }
:where(.ui-agc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ui-agc button:focus-visible { outline: 2px solid var(--ui-agc-ring); outline-offset: 2px; }
.ui-agc svg { display: block; flex: none; }
.ui-agc__stage { position: relative; }
.ui-agc { container: agc / inline-size; }

/* ----- Tabs above the page: the open one white with a gray stroke, the others a plain gray ----- */
.ui-agc__tabs { display: flex; gap: 6px; margin: 0 0 6px; }
.ui-agc__tab { height: 30px; padding: 0 12px; border-radius: 9px; background: rgba(0, 0, 0, 0.05); font-size: 13px; font-weight: 500; color: var(--ui-agc-muted); transition: background-color 160ms ease, color 160ms ease, box-shadow 160ms ease; }
.ui-agc__tab:hover { color: var(--ui-agc-ink); }
.ui-agc__tab[aria-selected="true"] { background: var(--ui-agc-card); box-shadow: inset 0 0 0 1px var(--ui-agc-stroke), 0 1px 2px rgba(0, 0, 0, 0.05); color: var(--ui-agc-ink); }
:where(.dark, [data-theme="dark"]) .ui-agc__tab { background: rgba(255, 255, 255, 0.06); }
/* A new view fades in softly */
.ui-agc__text { animation: ui-agc-view 380ms var(--ui-agc-ease) both; }
@keyframes ui-agc-view { from { opacity: 0; filter: blur(2px); transform: translateY(4px); } }

/* ----- Tables: like the library's Data Table – a bordered card, 40px rows, gray header ----- */
.ui-agc__table-card { overflow: hidden; border-radius: 12px; box-shadow: inset 0 0 0 1px var(--ui-agc-line), 0 1px 2px rgba(0, 0, 0, 0.04); transition: height 420ms var(--ui-agc-ease); }
.ui-agc__table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13.5px; line-height: 20px; }
.ui-agc__table :is(th, td) { height: 40px; padding: 0 12px; border-top: 1px solid var(--ui-agc-grid); border-left: 1px solid var(--ui-agc-grid); text-align: left; vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-agc__table :is(th, td):first-child { border-left: 0; }
/* The first column names the row – it gets the room */
.ui-agc__table th:first-child { width: 38%; }
.ui-agc__table th { border-top: 0; font-size: 12.5px; font-weight: 500; color: var(--ui-agc-muted); }
.ui-agc__table td { color: var(--ui-agc-ink); }
/* "Add row": a quiet line under the rows, like the Data Table */
.ui-agc__table tfoot td { height: 44px; padding: 0 6px; }
.ui-agc__add { display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border-radius: 8px; font-size: 13.5px; font-weight: 500; color: var(--ui-agc-muted); transition: background-color 140ms ease, color 140ms ease, transform 140ms ease; }
.ui-agc__add[data-hover] { background: rgba(0, 0, 0, 0.04); color: var(--ui-agc-ink); }
.ui-agc__add[data-pressed] { background: rgba(0, 0, 0, 0.08); transform: scale(0.97); }
:where(.dark, [data-theme="dark"]) .ui-agc__add[data-hover] { background: rgba(255, 255, 255, 0.06); }
:where(.dark, [data-theme="dark"]) .ui-agc__add[data-pressed] { background: rgba(255, 255, 255, 0.1); }
/* Rows an agent adds slide in */
.ui-agc__table tbody tr { animation: ui-agc-row 420ms var(--ui-agc-ease) both; }
@keyframes ui-agc-row { from { opacity: 0; transform: translateY(-6px); } }
.ui-agc__pill { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; background: var(--ui-agc-pill-bg); font-size: 12px; font-weight: 500; color: var(--ui-agc-pill-fg); }
.ui-agc__pill[data-tone="gray"] { --ui-agc-pill-bg: rgba(0, 0, 0, 0.05); --ui-agc-pill-fg: #6b6b6b; }
.ui-agc__pill[data-tone="blue"] { --ui-agc-pill-bg: #eaf1ff; --ui-agc-pill-fg: #2456d6; }
.ui-agc__pill[data-tone="green"] { --ui-agc-pill-bg: #e6f6ec; --ui-agc-pill-fg: #1a7f45; }
.ui-agc__pill[data-tone="amber"] { --ui-agc-pill-bg: #fff3e0; --ui-agc-pill-fg: #b85c00; }
:where(.dark, [data-theme="dark"]) .ui-agc__pill[data-tone="gray"] { --ui-agc-pill-bg: rgba(255, 255, 255, 0.08); --ui-agc-pill-fg: #a1a1a6; }
:where(.dark, [data-theme="dark"]) .ui-agc__pill[data-tone="blue"] { --ui-agc-pill-bg: #16243f; --ui-agc-pill-fg: #8ab4ff; }
:where(.dark, [data-theme="dark"]) .ui-agc__pill[data-tone="green"] { --ui-agc-pill-bg: #12301f; --ui-agc-pill-fg: #3dd68c; }
:where(.dark, [data-theme="dark"]) .ui-agc__pill[data-tone="amber"] { --ui-agc-pill-bg: #3a2410; --ui-agc-pill-fg: #ffa057; }

/* ----- The page: a sheet of paper; with a height it fades out towards the bottom ----- */
/* A light gray stroke sets the page off from what's behind it */
/* Classic: a gray tray carries the header, the page is a white card inside it */
.ui-agc__sheet { position: relative; overflow: hidden; border-radius: 20px; background: var(--ui-agc-tray); }
.ui-agc__paper { position: absolute; inset: 48px 4px 4px; z-index: 0; border-radius: 16px; background: var(--ui-agc-card); box-shadow: 0 0 0 1px var(--ui-agc-line), 0 1px 2px rgba(0, 0, 0, 0.04); }
.ui-agc[data-fade] .ui-agc__sheet { height: var(--ui-agc-height); }
/* Stroke and shadow: a box as big as the page inside a larger, transparent one – so the fade-out mask
   (applied to the larger box) leaves the shadow on every side, the top included */
.ui-agc__shade { position: absolute; inset: -40px; pointer-events: none; }
.ui-agc__shade > span { position: absolute; inset: 40px; border-radius: 20px; box-shadow: 0 0 0 1px var(--ui-agc-stroke), 0 1px 2px rgba(0, 0, 0, 0.05), 0 2px 10px rgba(0, 0, 0, 0.055); }
.ui-agc[data-fade] .ui-agc__shade { bottom: auto; height: calc(var(--ui-agc-height) + 80px); }
.ui-agc[data-fade] .ui-agc__sheet {
  -webkit-mask: linear-gradient(#000 0, #000 calc(var(--ui-agc-height) * 0.5), transparent calc(var(--ui-agc-height) * 0.97));
  mask: linear-gradient(#000 0, #000 calc(var(--ui-agc-height) * 0.5), transparent calc(var(--ui-agc-height) * 0.97));
}
.ui-agc[data-fade] .ui-agc__shade {
  -webkit-mask: linear-gradient(#000 0, #000 calc(40px + var(--ui-agc-height) * 0.5), transparent calc(40px + var(--ui-agc-height) * 0.97));
  mask: linear-gradient(#000 0, #000 calc(40px + var(--ui-agc-height) * 0.5), transparent calc(40px + var(--ui-agc-height) * 0.97));
}

/* ----- The header ----- */
.ui-agc__bar { position: relative; z-index: 3; display: flex; align-items: center; gap: 8px; min-width: 0; height: 48px; padding: 0 12px 0 16px; }
.ui-agc__doc { display: grid; flex: none; place-items: center; color: var(--ui-agc-muted); }
.ui-agc__title { flex: 1; min-width: 0; overflow: hidden; font-size: 13.5px; font-weight: 500; color: var(--ui-agc-muted); white-space: nowrap; text-overflow: ellipsis; }
.ui-agc__sum { flex: none; font-size: 12.5px; color: var(--ui-agc-muted); font-variant-numeric: tabular-nums; }
.ui-agc__spent { margin-left: 8px; font-weight: 600; color: var(--ui-agc-ink); transition: opacity 200ms ease; }
.ui-agc__spent[data-zero] { opacity: 0.35; }
.ui-agc__all { flex: none; height: 28px; padding: 0 11px; border-radius: 9px; background: var(--ui-agc-ink); font-size: 12.5px; font-weight: 500; color: var(--ui-agc-card); transition: opacity 160ms ease; }
.ui-agc__all:hover:not(:disabled) { opacity: 0.86; }
.ui-agc__all:disabled { opacity: 0.2; cursor: default; }

/* Who is here: overlapping faces with a ring in the agent's color */
.ui-agc__people { display: flex; flex: none; align-items: center; }
/* Side by side with a little room, so every working arc can be seen in full */
.ui-agc__face:first-child { margin-left: 0; }
.ui-agc__face { position: relative; display: grid; place-items: center; width: 28px; height: 28px; margin-left: 4px; border-radius: 50%; background: var(--ui-agc-card); box-shadow: 0 0 0 2px var(--ui-agc-tray), inset 0 0 0 1.5px var(--ui-agc-line); transition: transform 220ms var(--ui-agc-ease), opacity 220ms ease, box-shadow 220ms ease; }
.ui-agc__face:not([data-here]) { opacity: 0.4; }
/* Working: an arc in the agent's color runs around the face, fading in from nothing to full – like a loader */
.ui-agc__face[data-here]::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0deg, transparent 60deg, var(--ui-agc-c) 360deg); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px)); mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px)); animation: ui-agc-spin 850ms linear infinite; }
.ui-agc__face:hover, .ui-agc__face[aria-pressed="true"] { z-index: 1; transform: translateY(-1px); }
/* Followed: the face fills with a light wash of its color instead of a second ring */
.ui-agc__face[aria-pressed="true"] { background: var(--ui-agc-tint, color-mix(in srgb, var(--ui-agc-c) 16%, var(--ui-agc-card))); }
.ui-agc__face-mark, .ui-agc__note-mark { display: grid; place-items: center; width: 14px; height: 14px; }
.ui-agc__face-mark svg, .ui-agc__note-mark svg { width: 14px; height: 14px; }
.ui-agc__face-initial { font-size: 11px; font-weight: 600; line-height: 1; color: var(--ui-agc-c); }
.ui-agc__face-tip { position: absolute; top: calc(100% + 8px); right: -6px; z-index: 4; padding: 5px 9px; border-radius: 8px; background: var(--ui-agc-ink); font-size: 12px; line-height: 16px; color: var(--ui-agc-card); white-space: nowrap; opacity: 0; transform: translateY(-2px); pointer-events: none; transition: opacity 140ms ease, transform 140ms ease; }
.ui-agc__face-tip { display: grid; gap: 1px; text-align: left; }
.ui-agc__face-tip b { font-weight: 600; }
.ui-agc__face-tip > span { opacity: 0.75; }
.ui-agc__face:hover .ui-agc__face-tip, .ui-agc__face:focus-visible .ui-agc__face-tip { opacity: 1; transform: none; }

/* ----- The text ----- */
.ui-agc__text { position: relative; z-index: 1; padding: 36px 48px 48px; font-size: 14px; line-height: 23px; color: var(--ui-agc-text); }
.ui-agc__block { margin: 0; }
.ui-agc__text > * + * { margin-top: var(--ui-agc-gap); }
.ui-agc__block--title { font-size: 22px; font-weight: 650; line-height: 28px; letter-spacing: -0.022em; color: var(--ui-agc-ink); }
.ui-agc__text > .ui-agc__block--title + * { margin-top: 12px; }
.ui-agc__block--heading { font-size: 15.5px; font-weight: 600; line-height: 24px; letter-spacing: -0.012em; color: var(--ui-agc-ink); }
.ui-agc__text > .ui-agc__block--heading:not(:first-child) { margin-top: calc(var(--ui-agc-gap) + 10px); }
.ui-agc__text > .ui-agc__block--heading + * { margin-top: 8px; }
.ui-agc__list { margin: 0; padding: 0 0 0 20px; }
.ui-agc__list .ui-agc__block + .ui-agc__block { margin-top: 4px; }
.ui-agc__block--item::marker { color: var(--ui-agc-muted); }

/* Code: a soft panel, monospace, same suggestions inside */
.ui-agc__code { margin: 0; padding: 14px 16px; overflow: hidden; border-radius: 12px; background: var(--ui-agc-code); box-shadow: inset 0 0 0 1px var(--ui-agc-line); font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-size: 12.5px; line-height: 20px; letter-spacing: 0; color: var(--ui-agc-ink); white-space: pre-wrap; }
.ui-agc__code code { font: inherit; }

/* Images: loading with a shimmer; held by an agent: frame, handles and size in its color */
.ui-agc__figure { margin: 0; }
.ui-agc__text::after { content: ""; display: block; clear: both; }
.ui-agc__figure { max-width: 100%; transition: width 620ms var(--ui-agc-ease); }
/* Floated: the next text runs beside the image and follows it as it gets narrower */
/* A floated image and the text beside it start together, one gap below what came before */
.ui-agc__figure[data-float="left"] { float: left; margin: var(--ui-agc-gap) 24px 8px 0; }
.ui-agc__figure[data-float="right"] { float: right; margin: var(--ui-agc-gap) 0 8px 24px; }
.ui-agc__text > .ui-agc__figure[data-float] { margin-top: var(--ui-agc-gap); }
.ui-agc__text > :is(.ui-agc__block--heading, .ui-agc__code, .ui-agc__list) { clear: both; }
/* Narrow pages: the image above its text instead of beside it */
.ui-agc__sheet { container-type: inline-size; }
@container (max-width: 480px) {
  .ui-agc__figure[data-float] { float: none; margin: 0 0 12px; }
}
.ui-agc__img { position: relative; display: grid; width: 100%; border-radius: 12px; background: var(--ui-agc-shimmer); transition: box-shadow 200ms ease; }
.ui-agc__img > img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; animation: ui-agc-fade 500ms ease both; }
.ui-agc__shimmer { display: block; width: 100%; height: 100%; border-radius: inherit; background: linear-gradient(100deg, var(--ui-agc-shimmer) 35%, var(--ui-agc-shine) 50%, var(--ui-agc-shimmer) 65%) 0 0 / 300% 100%; animation: ui-agc-shimmer 1600ms linear infinite; }
.ui-agc__img[data-held] { box-shadow: 0 0 0 2px var(--ui-agc-c); }
.ui-agc__handle { position: absolute; width: 10px; height: 10px; border-radius: 3px; background: #ffffff; box-shadow: 0 0 0 1.5px var(--ui-agc-c), 0 1px 3px rgba(0, 0, 0, 0.18); animation: ui-agc-fade 160ms ease both; }
.ui-agc__handle[data-at="tl"] { top: -5px; left: -5px; }
.ui-agc__handle[data-at="tr"] { top: -5px; right: -5px; }
.ui-agc__handle[data-at="bl"] { bottom: -5px; left: -5px; }
.ui-agc__handle[data-at="br"] { right: -5px; bottom: -5px; }
.ui-agc__size { position: absolute; bottom: 10px; left: 50%; translate: -50% 0; padding: 0 7px; border-radius: 6px; background: var(--ui-agc-c); font-size: 11.5px; font-weight: 600; line-height: 20px; color: #ffffff; white-space: nowrap; font-variant-numeric: tabular-nums; animation: ui-agc-fade 160ms ease both; }
.ui-agc__caption { margin-top: 8px; font-size: 12.5px; line-height: 18px; color: var(--ui-agc-muted); }

/* Suggestions: new text underlined in the agent's color, removed text struck through */
.ui-agc__ins, .ui-agc__del { border-radius: 3px; outline: none; cursor: pointer; transition: background-color 160ms ease; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.ui-agc__ins { padding: 1px 0; background: color-mix(in srgb, var(--ui-agc-c) 12%, transparent); color: var(--ui-agc-ink); text-decoration: underline 1.5px var(--ui-agc-c); text-underline-offset: 4px; animation: ui-agc-in 300ms ease both; }
.ui-agc__del { color: var(--ui-agc-muted); text-decoration: line-through 1.5px var(--ui-agc-c); }
.ui-agc__ins:hover, .ui-agc__ins[data-open], .ui-agc__ins:focus-visible { background: color-mix(in srgb, var(--ui-agc-c) 22%, transparent); }
.ui-agc__del:hover, .ui-agc__del[data-open], .ui-agc__del:focus-visible { background: color-mix(in srgb, var(--ui-agc-c) 10%, transparent); }

/* Selections: the passage lights up in the agent's color, behind the text */
.ui-agc__marks { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.ui-agc__mark { position: absolute; border-radius: 3px; background: color-mix(in srgb, var(--ui-agc-c) 20%, transparent); animation: ui-agc-fade 220ms ease both; transition: opacity 220ms ease; }
.ui-agc__mark[data-dim] { opacity: 0.25; }

/* ----- Comment pins ----- */
.ui-agc__notes { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.ui-agc__pin { position: absolute; width: 0; height: 0; pointer-events: auto; animation: ui-agc-fade 260ms ease both; }
/* One shape: closed, a round pin with three soft corners and a sharp one pointing at its spot;
   open, it grows into the comment's window – to the bottom right, to the left near the edge, upwards near the bottom */
.ui-agc__pin { --ui-agc-pin: 30px; }
.ui-agc__pin-box { position: absolute; top: calc(var(--ui-agc-pin) * -1); left: var(--ui-agc-pin-x, 0px); width: var(--ui-agc-pin); height: var(--ui-agc-pin); overflow: hidden; border-radius: 15px 15px 15px 3px; background: var(--ui-agc-flag); color: var(--ui-agc-flag-ink); box-shadow: 0 0 0 1px var(--ui-agc-flag-soft), 0 8px 20px -8px rgba(0, 0, 0, 0.45); transition: left 340ms var(--ui-agc-ease), width 340ms var(--ui-agc-ease), height 340ms var(--ui-agc-ease), border-radius 340ms var(--ui-agc-ease), box-shadow 340ms ease; }
.ui-agc__pin[data-up] .ui-agc__pin-box { top: auto; bottom: 0; }
.ui-agc__pin[data-open] { z-index: 1; }
.ui-agc__pin[data-open] .ui-agc__pin-box { width: var(--ui-agc-pin-w, 248px); height: var(--ui-agc-pin-h); border-radius: 14px; box-shadow: 0 0 0 1px var(--ui-agc-flag-soft), 0 16px 32px -14px rgba(0, 0, 0, 0.4); }
/* Logos drawn in "ink" (OpenAI, GitHub, Notion) take the pin's own ink */
.ui-agc__pin-mark { --ui-agc-ink: var(--ui-agc-flag-ink); }
/* The mark: centered in the pin, in the window's corner once open */
.ui-agc__pin-mark { position: absolute; z-index: 1; top: 7px; left: 7px; display: grid; place-items: center; width: 16px; height: 16px; transition: top 340ms var(--ui-agc-ease), left 340ms var(--ui-agc-ease), width 340ms var(--ui-agc-ease), height 340ms var(--ui-agc-ease); pointer-events: none; }
.ui-agc__pin-mark svg { width: 100%; height: 100%; }
.ui-agc__pin[data-open] .ui-agc__pin-mark { top: 11px; left: 12px; width: 14px; height: 14px; }
.ui-agc__pin-hit { position: absolute; inset: 0; z-index: 2; border-radius: inherit; }
.ui-agc__pin[data-open] .ui-agc__pin-hit { pointer-events: none; }
/* The content: fixed width, so its height is the open height; it fades in once the window has room */
.ui-agc__pin-body { position: absolute; top: 0; left: 0; display: grid; gap: 4px; width: var(--ui-agc-pin-w, 248px); padding: 10px 10px 10px 12px; opacity: 0; transition: opacity 120ms ease; }
.ui-agc__pin[data-up] .ui-agc__pin-body { top: auto; bottom: 0; }
.ui-agc__pin[data-open] .ui-agc__pin-body { opacity: 1; transition: opacity 200ms ease 140ms; }
.ui-agc__pin-body .ui-agc__note-head { padding-left: 22px; color: color-mix(in srgb, var(--ui-agc-flag-ink) 50%, transparent); }
.ui-agc__pin-body .ui-agc__note-head b { color: var(--ui-agc-flag-ink); }
.ui-agc__pin-body .ui-agc__note-text { color: color-mix(in srgb, var(--ui-agc-flag-ink) 86%, transparent); }
.ui-agc__note-head { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--ui-agc-muted); }
.ui-agc__note-head b { font-weight: 600; color: var(--ui-agc-ink); }
.ui-agc__note-head > span:last-child { margin-left: auto; }
.ui-agc__note-text { margin: 0; font-size: 13px; line-height: 19px; color: var(--ui-agc-text); }
/* Reply and resolve: a white field and a black square with a white check */
.ui-agc__pin-actions { display: flex; gap: 6px; margin-top: 6px; }
.ui-agc__reply { flex: 1; min-width: 0; height: 30px; padding: 0 10px; border: 0; border-radius: 9px; background: var(--ui-agc-flag-soft); box-shadow: inset 0 0 0 1px var(--ui-agc-flag-soft); font: inherit; font-size: 13px; color: var(--ui-agc-flag-ink); outline: none; }
.ui-agc__reply::placeholder { color: color-mix(in srgb, var(--ui-agc-flag-ink) 45%, transparent); }
/* Typing in a field: no ring – the caret shows where you are, the edge only firms up a little */
.ui-agc__reply:is(:focus, :focus-visible) { outline: none; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-agc-flag-ink) 28%, transparent); }
.ui-agc__resolve { display: grid; flex: none; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--ui-agc-flag-ink); color: var(--ui-agc-flag); transition: opacity 160ms ease; }
.ui-agc__resolve:hover { opacity: 0.86; }

/* ----- The pointers ----- */
/* No mask here, so flags may stick out past the page's sides – pointers low on a fading page fade on their own */
.ui-agc__cursors { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.ui-agc__cursor-in { transition: opacity 260ms ease; }
.ui-agc__cursor { position: absolute; top: 0; left: 0; transition: transform var(--ui-agc-glide) var(--ui-agc-ease), opacity 260ms ease; will-change: transform; }
/* Typing: the pointer keeps up with every letter */
.ui-agc__cursor[data-typing] { transition: transform 110ms linear, opacity 260ms ease; }
/* Holding an image by its corner: the pointer sticks to the handle frame by frame, no glide behind it */
.ui-agc__cursor[data-drag] { transition: opacity 260ms ease; }
.ui-agc__cursor[data-arrive] { transition: none; opacity: 0; }
.ui-agc__cursor:not([data-arrive]):not([data-gone]) { animation: ui-agc-pop 300ms var(--ui-agc-ease) both; }
.ui-agc__cursor[data-gone] { opacity: 0; }
.ui-agc__cursor[data-dim] { opacity: 0.22; }
.ui-agc__cursor[data-gone][data-dim] { opacity: 0; }
.ui-agc__caret { position: absolute; top: 0; left: -1px; width: 2px; height: var(--ui-agc-h, 18px); border-radius: 1px; background: var(--ui-agc-c); animation: ui-agc-blink 1100ms steps(1, end) infinite; }
.ui-agc__cursor[data-typing] .ui-agc__caret { animation: none; }
.ui-agc__cursor[data-free] .ui-agc__caret { display: none; }
/* The arrow's tip sits just below the caret – or right on the point, on an image */
.ui-agc__arrow { position: absolute; z-index: 1; top: calc(var(--ui-agc-h, 18px) - 6px); left: 0; width: 19px; height: 23px; overflow: visible; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.22)); }
.ui-agc__cursor[data-free] .ui-agc__arrow { top: -0.6px; left: -2.3px; }
/* A click: the arrow presses in around its tip */
.ui-agc__arrow { transform-origin: 2px 1px; transition: transform 140ms ease; }
.ui-agc__cursor[data-press] .ui-agc__arrow { transform: scale(0.82); }
.ui-agc__arrow path { fill: var(--ui-agc-c); stroke: #ffffff; stroke-width: 1.4; paint-order: stroke; }
/* The flag: the name, and what the agent is doing slides out next to it */
.ui-agc__flag { position: absolute; top: calc(var(--ui-agc-h, 18px) + 15px); left: calc(16px + var(--ui-agc-shift, 0px)); display: grid; width: max-content; padding: 6px 10px 6px; border-bottom: 1px solid transparent; border-radius: 10px; background: linear-gradient(var(--ui-agc-flag), var(--ui-agc-flag)) padding-box, var(--ui-agc-edge) border-box; box-shadow: 0 8px 18px -8px rgba(255, 79, 163, 0.5), 6px 8px 18px -8px rgba(59, 139, 255, 0.5), 0 2px 6px -2px rgba(0, 0, 0, 0.3); font-size: 12px; font-weight: 600; line-height: 16px; color: var(--ui-agc-flag-ink); white-space: nowrap; }
/* On an image the arrow sits right on its point */
/* In a comment window the agent's own flag steps aside – the window shows its name */
.ui-agc__cursor[data-in-note] .ui-agc__flag { opacity: 0; }
.ui-agc__cursor[data-free] .ui-agc__flag { top: 21px; left: calc(14px + var(--ui-agc-shift, 0px)); }
.ui-agc__flag-row { display: flex; align-items: center; gap: 12px; }
.ui-agc__flag-tags { display: flex; gap: 4px; margin-left: auto; }
.ui-agc__flag-tag { padding: 0 5px; border-radius: 5px; background: var(--ui-agc-flag-soft); font-size: 10.5px; font-weight: 600; line-height: 16px; font-variant-numeric: tabular-nums; }
/* What it's doing: a second line that opens below the name */
.ui-agc__flag-doing { display: block; max-height: 0; overflow: hidden; opacity: 0; transition: max-height 320ms var(--ui-agc-ease), opacity 200ms ease, margin-top 320ms var(--ui-agc-ease); }
.ui-agc__flag-doing > span { display: block; width: max-content; font-size: 11.5px; font-weight: 500; white-space: nowrap; }
.ui-agc__flag-doing[data-on] { max-height: 18px; margin-top: 1px; opacity: 0.9; }
.ui-agc__cursor[data-dim] .ui-agc__flag-doing { max-height: 0; opacity: 0; }

/* ----- The open suggestion ----- */
.ui-agc__pop { position: absolute; z-index: 5; display: grid; gap: 6px; width: 260px; padding: 10px; border-radius: 14px; background: var(--ui-agc-card); box-shadow: 0 0 0 1px var(--ui-agc-line), 0 16px 32px -12px rgba(0, 0, 0, 0.22); animation: ui-agc-rise 180ms var(--ui-agc-ease) both; }
.ui-agc__pop-head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; line-height: 18px; color: var(--ui-agc-muted); }
.ui-agc__pop-head b { font-weight: 600; color: var(--ui-agc-ink); }
/* The agent's mark next to its name – the model maker's logo, or its initial */
.ui-agc__pop-mark { display: grid; flex: none; place-items: center; width: 14px; height: 14px; }
.ui-agc__pop-mark svg { width: 100%; height: 100%; }
.ui-agc__pop-note { margin: 0; font-size: 12.5px; line-height: 18px; color: var(--ui-agc-text); }
.ui-agc__pop-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
.ui-agc__btn { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 9px; background: var(--ui-agc-card); box-shadow: 0 0 0 1px var(--ui-agc-line), 0 1px 2px rgba(0, 0, 0, 0.04); font-size: 13px; font-weight: 500; color: var(--ui-agc-ink); transition: background-color 160ms ease, opacity 160ms ease; }
.ui-agc__btn:hover { background: var(--ui-agc-chip); }
.ui-agc__btn--primary { background: var(--ui-agc-ink); box-shadow: none; color: var(--ui-agc-card); }
.ui-agc__btn--primary:hover { background: var(--ui-agc-ink); opacity: 0.86; }

.ui-agc__live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

@keyframes ui-agc-blink { 0%, 55% { opacity: 1; } 56%, 100% { opacity: 0; } }
@keyframes ui-agc-pop { from { opacity: 0; scale: 0.85; } }
@keyframes ui-agc-fade { from { opacity: 0; } }
@keyframes ui-agc-in { from { background-color: transparent; } }
@keyframes ui-agc-rise { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
@keyframes ui-agc-spin { to { transform: rotate(360deg); } }
@keyframes ui-agc-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }

@media (max-width: 520px) {
  .ui-agc__text { padding: 26px 22px 36px; font-size: 14px; line-height: 23px; }
  .ui-agc__block--title { font-size: 20px; line-height: 26px; }
  .ui-agc__sum { display: none; }
}
/* Narrow (phones): a compact header, smaller flags, and tables whose cells wrap instead of cutting words */
@container agc (max-width: 480px) {
  .ui-agc__bar { gap: 6px; padding: 0 8px 0 12px; }
  .ui-agc__title { display: none; }
  .ui-agc__doc { margin-right: auto; }
  .ui-agc__face { width: 26px; height: 26px; margin-left: 2px; }
  .ui-agc__all { padding: 0 9px; font-size: 12px; }
  .ui-agc__text { padding: 24px 20px 32px; }
  .ui-agc__flag { padding: 4px 8px 4px; border-radius: 8px; font-size: 11px; line-height: 14px; }
  .ui-agc__flag-tag { padding: 0 4px; font-size: 10px; line-height: 14px; }
  .ui-agc__flag-doing > span { font-size: 10.5px; }
  .ui-agc__flag-row { gap: 8px; }
  .ui-agc__table { font-size: 11.5px; line-height: 16px; }
  .ui-agc__table :is(th, td) { height: auto; padding: 8px 5px; white-space: normal; text-overflow: clip; }
  .ui-agc__table :is(th, td):first-child { padding-left: 9px; }
  .ui-agc__table th { font-size: 11px; }
  .ui-agc__table th:first-child { width: 30%; }
  .ui-agc__pill { display: inline-block; height: auto; min-height: 18px; padding: 1px 6px; font-size: 10.5px; line-height: 16px; white-space: normal; }
}
/* The narrowest phones: a little more room for the table */
@container agc (max-width: 340px) {
  .ui-agc__text { padding-right: 12px; padding-left: 12px; }
  .ui-agc__table { font-size: 11px; }
  .ui-agc__table th:first-child { width: 28%; }
}
@media (pointer: coarse) {
  .ui-agc__face { width: 32px; height: 32px; }
  .ui-agc__btn { height: 36px; padding: 0 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-agc *, .ui-agc *::before, .ui-agc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-agc {
  --ui-agc-card: #1f1f22;
  --ui-agc-tray: #161618;
  --ui-agc-ink: #ededed;
  --ui-agc-text: #c4c4c8;
  --ui-agc-muted: #7c7c82;
  --ui-agc-line: #2e2e33;
  --ui-agc-grid: #29292d;
  --ui-agc-stroke: #2c2c31;
  --ui-agc-chip: #2a2a2e;
  --ui-agc-shimmer: #29292d;
  --ui-agc-shine: #36363b;
  --ui-agc-code: rgba(255, 255, 255, 0.04);
  --ui-agc-ring: rgba(237, 237, 237, 0.3);
  --ui-agc-agent: #e4e4e7;
  --ui-agc-flag: #f4f4f5;
  --ui-agc-flag-ink: #141416;
  --ui-agc-flag-soft: rgba(0, 0, 0, 0.08);
}
:where(.dark, [data-theme="dark"]) .ui-agc__arrow path { stroke: #1f1f22; }
:where(.dark, [data-theme="dark"]) .ui-agc__handle { background: #1f1f22; }
/* ----- Worst-case data: long words wrap, long names shorten, nothing leaves the card ----- */
.ui-agc__text, .ui-agc__code, .ui-agc__note-text, .ui-agc__pop-note { overflow-wrap: anywhere; }
.ui-agc__block, .ui-agc__caption, .ui-agc__note-text, .ui-agc__pop-note { text-align: start; }
.ui-agc__block, .ui-agc__note-text { white-space: pre-line; }
.ui-agc__tabs { flex-wrap: wrap; }
.ui-agc__tab { max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-agc__face-more { flex: none; width: auto; min-width: 24px; padding: 0 5px; border-radius: 999px; font-size: 10.5px; font-weight: 600; line-height: 1; color: var(--ui-agc-muted); font-variant-numeric: tabular-nums; cursor: default; }
.ui-agc__face-tip { grid-template-columns: minmax(0, 1fr); max-width: 240px; }
.ui-agc__face-tip > * { overflow: hidden; text-overflow: ellipsis; }
.ui-agc__pin-body { grid-template-columns: minmax(0, 1fr); }
.ui-agc__note-head b, .ui-agc__pop-head b { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-agc__note-head > span, .ui-agc__pop-head > span { flex: none; }
.ui-agc__flag { grid-template-columns: minmax(0, 1fr); max-width: min(260px, calc(100cqw - 16px)); }
.ui-agc__flag-row { min-width: 0; }
.ui-agc__flag-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-agc__flag-tags { flex: none; }
.ui-agc__flag-doing > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
`;

/* Kettu wiring: the face and the pointer on their own, for the artifact canvas, which is no text
   document. They draw with the component's own classes, inside an element with the .ui-agc class. */

/** The component's styles, once, for the face and the pointer used on their own. */
export function AgentCursorStyles() {
  return (
    <style href="ui-agent-cursors" precedence="default">
      {css}
    </style>
  );
}

/** One agent's face, as the header shows it: its mark, a turning ring while it is here. */
export function AgentFace({
  agent,
  here,
  following,
  doing,
  label,
  onFollow,
}: {
  agent: CursorAgent;
  here: boolean;
  following: boolean;
  doing: string | null;
  label: string;
  onFollow: () => void;
}) {
  const mark = agent.avatar ?? <span className="ui-agc__face-initial">{initial(agent.name)}</span>;
  return (
    <button
      type="button"
      className="ui-agc__face"
      data-here={here ? "" : undefined}
      aria-pressed={following}
      aria-label={label}
      style={{ ["--ui-agc-c" as string]: agent.color, ["--ui-agc-tint" as string]: agent.tint }}
      onClick={onFollow}
    >
      <span className="ui-agc__face-mark">{mark}</span>
      <span className="ui-agc__face-tip" aria-hidden="true">
        <b>{agent.name}</b>
        {doing && <span>{doing}</span>}
      </span>
    </button>
  );
}

/** One agent's pointer with its flag, at `x`, `y` in the element that holds it. */
export function AgentPointer({
  agent,
  x,
  y,
  doing,
  dim,
  gone,
}: {
  agent: CursorAgent;
  x: number;
  y: number;
  doing: string | null;
  dim?: boolean;
  gone?: boolean;
}) {
  return (
    <div
      className="ui-agc__cursor"
      data-free=""
      data-dim={dim ? "" : undefined}
      data-gone={gone ? "" : undefined}
      style={{ transform: `translate(${x}px, ${y}px)`, ["--ui-agc-c" as string]: agent.color }}
      aria-hidden="true"
    >
      <div className="ui-agc__cursor-in">
        <svg className="ui-agc__arrow" viewBox="-2.186 -0.256 18.514 22.277">
          <path
            transform="rotate(21.37)"
            d="M13.92 4.07c1.69.66 3.03 1.18 3.94 1.68.46.25.87.53 1.16.86.31.35.51.79.48 1.29-.03.51-.27.92-.62 1.23-.33.3-.77.53-1.25.74-.96.4-2.36.78-4.12 1.26-.56.15-.98.27-1.26.37-.26.1-.38.18-.47.27-.09.09-.17.21-.27.47-.1.28-.22.7-.37 1.26-.48 1.76-.86 3.16-1.26 4.12-.2.49-.44.93-.74 1.25-.32.35-.72.6-1.23.62-.51.03-.94-.17-1.29-.48-.33-.29-.61-.7-.86-1.16-.5-.91-1.02-2.25-1.68-3.94L1.66 7.76C.96 5.99.41 4.59.16 3.51-.09 2.44-.12 1.39.63.63 1.39-.12 2.44-.09 3.51.16c1.08.25 2.48.8 4.25 1.5l6.16 2.41Z"
          />
        </svg>
        <span className="ui-agc__flag">
          <span className="ui-agc__flag-row">
            <span className="ui-agc__flag-name" dir="auto">
              {agent.name}
            </span>
          </span>
          <span className="ui-agc__flag-doing" data-on={doing ? "" : undefined}>
            <span>{doing ?? ""}</span>
          </span>
        </span>
      </div>
    </div>
  );
}
