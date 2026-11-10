// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/*
 * Permission Request – an agent asks for one specific right, in a single self-contained file.
 * One quiet white card: who asks for what ("Coder wants to push to main"), why, and exactly what will happen –
 * the files, recipients or amounts – before anything does.
 *   · pick how long the right holds: just this once, for a while (e.g. 1 hour) or always
 *   · Allow or Deny – Enter and Esc work while the card has focus
 *   · then the card folds into one line: "Allowed for 1 hour" with a bar that drains until the right expires,
 *     and Revoke to take it back; destructive actions can never be allowed for always
 * Controlled or uncontrolled. The styles are injected below, so no extra files are needed.
 */

export type PermissionRisk = "safe" | "risky" | "destructive";
export type PermissionScope = "once" | "timed" | "always";

export type PermissionDecision = {
  allow: boolean;
  scope: PermissionScope;
  /** When it was decided (ms) */
  at: number;
  /** When a timed right runs out (ms) */
  until?: number;
};

export type PermissionPreviewItem = {
  id: string;
  label: string;
  /** Right-aligned, e.g. "+12 −4" or "$240.00" */
  meta?: ReactNode;
  /** A 16px glyph or a small brand mark */
  icon?: ReactNode;
};

export type PermissionRequestProps = {
  /** Who asks: { name, model?, avatar? } */
  agent: { name: string; model?: string; avatar?: ReactNode };
  /** What it wants to do, lower case after "wants to", e.g. "push to main" */
  action: string;
  /** Where, e.g. "acme/web" – shown with the tool's mark */
  target?: string;
  /** The tool's mark next to the target */
  toolIcon?: ReactNode;
  risk?: PermissionRisk;
  /** The agent's own words on why it needs this */
  reason?: string;
  /** What will happen if you allow it – files, recipients, amounts */
  preview?: PermissionPreviewItem[];
  previewTitle?: string;
  /** Rows shown before "N more" – default 3 */
  previewLimit?: number;
  /** The choices offered – default all three; "always" is never offered for destructive actions */
  scopes?: PermissionScope[];
  /** Controlled choice of how long */
  scope?: PermissionScope;
  defaultScope?: PermissionScope;
  onScopeChange?: (scope: PermissionScope) => void;
  /** Draws the how-long choice in place of the built-in chips, e.g. with a Segmented Control */
  renderScopes?: (props: {
    scopes: PermissionScope[];
    scope: PermissionScope;
    onChange: (scope: PermissionScope) => void;
    label: (scope: PermissionScope) => string;
  }) => ReactNode;
  /** Minutes a timed right holds – default 60 */
  duration?: number;
  /** Controlled decision – null while it waits */
  decision?: PermissionDecision | null;
  defaultDecision?: PermissionDecision | null;
  /** Allow, Deny, Revoke (null) – the agent should listen to this */
  onDecisionChange?: (decision: PermissionDecision | null) => void;
  /** The clock for the countdown – defaults to now */
  now?: number;
  /** false leaves out Change and Revoke, e.g. where an answer can't be taken back */
  revocable?: boolean;
  /** More buttons before Deny, e.g. the agent's other answers */
  actions?: ReactNode;
  /** More buttons after Allow, e.g. the agent's longer-lasting allows */
  trailingActions?: ReactNode;
  /** More of what will happen under the preview, e.g. a diff or the whole command */
  children?: ReactNode;
  /** Locks the buttons, e.g. while the answer is on its way */
  disabled?: boolean;
  /** Every word the card shows, for a translation */
  labels?: Partial<PermissionLabels>;
  className?: string;
};

export type PermissionLabels = {
  /** The title: who asks for what */
  title: (name: string, action: string) => ReactNode;
  risk: (risk: Exclude<PermissionRisk, "safe">) => string;
  scope: (scope: PermissionScope, minutes: number) => ReactNode;
  allow: (scope: PermissionScope, minutes: number) => ReactNode;
  deny: string;
  howLong: string;
  more: (count: number) => string;
  showLess: string;
  noAlways: string;
  /** The decided line's head and note */
  result: (
    kind: "allowed" | "denied" | "expired",
    decision: PermissionDecision,
    context: { name: string; minutes: number; left?: string; until?: string; at: string },
  ) => { headline: string; note: string };
  change: string;
  revoke: string;
  askAgain: string;
};

/* ---------- Helpers ---------- */

const MIN = 60_000;
const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const DAY = 24 * 60;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const count = new Intl.NumberFormat("en");
const RISKS: PermissionRisk[] = ["safe", "risky", "destructive"];
const SCOPES: PermissionScope[] = ["once", "timed", "always"];
// The time of day – with the weekday or the date once it isn't today
const hhmm = (t: number, from = Date.now()) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date(from).toDateString()) return time;
  const week = Math.abs(t - from) < 6 * DAY * MIN;
  return `${d.toLocaleDateString([], week ? { weekday: "short" } : { month: "short", day: "numeric" })} ${time}`;
};
const span = (min: number) =>
  min >= DAY && min % DAY === 0
    ? `${min / DAY} day${min === DAY ? "" : "s"}`
    : min % 60 === 0
      ? `${min / 60} hour${min === 60 ? "" : "s"}`
      : `${min} min`;
const left = (ms: number) => {
  const m = Math.max(0, Math.ceil(ms / MIN));
  if (m >= DAY) {
    const h = Math.floor((m % DAY) / 60);
    return `${Math.floor(m / DAY)} d ${h ? `${h} h ` : ""}left`;
  }
  return m >= 60
    ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min ` : ""}left`
    : `${m} min left`;
};
const RISK: Record<PermissionRisk, string> = {
  safe: "",
  risky: "Risky",
  destructive: "Destructive",
};

/* ---------- Icons ---------- */

/* Risk, check, cross and quote: Hugeicons Free (MIT, © Hugeicons, hugeicons.com) – rounded 1.5px strokes */
const RiskyIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M13.9248 21H10.0752C5.44476 21 3.12955 21 2.27636 19.4939C1.42317 17.9879 2.60736 15.9914 4.97574 11.9985L6.90057 8.75333C9.17559 4.91778 10.3131 3 12 3C13.6869 3 14.8244 4.91777 17.0994 8.75332L19.0243 11.9985C21.3926 15.9914 22.5768 17.9879 21.7236 19.4939C20.8704 21 18.5552 21 13.9248 21Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
    <path
      d="M12 9V13"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
    <path
      d="M12.125 16.75H12M12.25 16.75C12.25 16.8881 12.1381 17 12 17C11.8619 17 11.75 16.8881 11.75 16.75C11.75 16.6119 11.8619 16.5 12 16.5C12.1381 16.5 12.25 16.6119 12.25 16.75Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);
const DestructiveIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M5.92089 5.92089C8.15836 3.68342 9.2771 2.56468 10.5857 2.19562C11.5105 1.93479 12.4895 1.93479 13.4143 2.19562C14.7229 2.56468 15.8416 3.68342 18.0791 5.92089C20.3166 8.15836 21.4353 9.2771 21.8044 10.5857C22.0652 11.5105 22.0652 12.4895 21.8044 13.4143C21.4353 14.7229 20.3166 15.8416 18.0791 18.0791C15.8416 20.3166 14.7229 21.4353 13.4143 21.8044C12.4895 22.0652 11.5105 22.0652 10.5857 21.8044C9.2771 21.4353 8.15836 20.3166 5.92089 18.0791C3.68342 15.8416 2.56468 14.7229 2.19562 13.4143C1.93479 12.4895 1.93479 11.5105 2.19562 10.5857C2.56468 9.2771 3.68342 8.15836 5.92089 5.92089Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
    <path
      d="M12 8V12"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
    <path
      d="M12.125 15.75H12M12.25 15.75C12.25 15.8881 12.1381 16 12 16C11.8619 16 11.75 15.8881 11.75 15.75C11.75 15.6119 11.8619 15.5 12 15.5C12.1381 15.5 12.25 15.6119 12.25 15.75Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);
const CheckIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M8 12.5L10.5 15L16 9"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);
const CrossIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M14.9994 15L9 9M9.00064 15L15 9"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);
const ClockIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"
      stroke="currentColor"
      strokeWidth="1.5"
    />
    <path
      d="M12 8V12L14 14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);
const DotIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="2.4" fill="currentColor" />
  </svg>
);

// The first whole letter or digit of the first two words – emoji and marks are skipped
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
// A logo that fails to load hides itself instead of showing a broken image
const hideBroken = (e: { target: EventTarget }) => {
  if (e.target instanceof HTMLImageElement) e.target.style.visibility = "hidden";
};

export function PermissionRequest({
  agent,
  action,
  target,
  toolIcon,
  risk: riskProp = "risky",
  reason,
  preview = [],
  previewTitle = "What will happen",
  previewLimit: limitProp = 3,
  scopes: scopesProp = ["once", "timed", "always"],
  scope: scopeProp,
  defaultScope = "once",
  onScopeChange,
  renderScopes,
  duration: durationProp = 60,
  decision,
  defaultDecision = null,
  onDecisionChange,
  now: nowIn,
  revocable = true,
  actions,
  trailingActions,
  children,
  disabled = false,
  labels,
  className,
}: PermissionRequestProps) {
  const uid = useId();
  // Unknown or broken values fall back to the defaults instead of showing NaN or the wrong words
  const risk = RISKS.includes(riskProp) ? riskProp : "risky";
  const scopes = scopesProp.filter((s) => SCOPES.includes(s));
  const duration = finite(durationProp) && durationProp > 0 ? Math.max(1, Math.round(durationProp)) : 60;
  const previewLimit = finite(limitProp) && limitProp >= 0 ? Math.floor(limitProp) : 3;
  const nowProp = finite(nowIn) ? nowIn : undefined;
  const name = agent.name?.trim() || "Agent";
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [innerDecision, setInnerDecision] = useState<PermissionDecision | null>(
    defaultDecision,
  );
  const current = decision === undefined ? innerDecision : decision;
  const offered = scopes.filter(
    (s) => !(s === "always" && risk === "destructive"),
  );
  const [innerScope, setInnerScope] = useState<PermissionScope>(defaultScope);
  const wanted = scopeProp ?? innerScope;
  const scope = offered.includes(wanted) ? wanted : (offered[0] ?? "once");
  const setScope = (next: PermissionScope) => {
    setInnerScope(next);
    onScopeChange?.(next);
  };
  const [open, setOpen] = useState(false);

  // A tick for the countdown, only while a timed right runs and no clock is passed in
  const [tick, setTick] = useState(() => Date.now());
  const running =
    current?.allow && current.scope === "timed" && finite(current.until) && nowProp === undefined;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  const now = nowProp ?? tick;

  const decide = (next: PermissionDecision | null) => {
    setInnerDecision(next);
    onDecisionChange?.(next);
  };
  const allow = () => {
    const at = nowProp ?? Date.now();
    decide({
      allow: true,
      scope,
      at,
      until: scope === "timed" ? at + duration * MIN : undefined,
    });
  };
  const deny = () => decide({ allow: false, scope, at: nowProp ?? Date.now() });

  const onKey = (e: KeyboardEvent) => {
    if (current || disabled) return;
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "Enter" && tag !== "BUTTON") {
      e.preventDefault();
      allow();
    } else if (e.key === "Escape") {
      e.preventDefault();
      deny();
    }
  };

  const expired = !!(current?.allow && finite(current.until) && now >= current.until);

  /* ---------- Motion: the card folds to one line and back ---------- */

  const cardRef = useRef<HTMLDivElement>(null);
  const height = useRef(0);
  const shape = current
    ? expired
      ? "expired"
      : current.allow
        ? "allowed"
        : "denied"
    : `pending:${open}`;
  const lastShape = useRef(shape);
  if (cardRef.current && shape !== lastShape.current)
    height.current = cardRef.current.offsetHeight;
  useLayoutEffect(() => {
    if (lastShape.current === shape) return;
    lastShape.current = shape;
    const card = cardRef.current;
    if (!card || reduced() || !height.current) return;
    const to = card.offsetHeight;
    if (Math.abs(to - height.current) > 1) {
      card.animate([{ height: `${height.current}px` }, { height: `${to}px` }], {
        duration: 380,
        easing: EASE,
      });
    }
  }, [shape]);

  const allowLabel = labels?.allow
    ? labels.allow(scope, duration)
    : scope === "once"
      ? "Allow once"
      : scope === "timed"
        ? `Allow for ${span(duration)}`
        : "Always allow";
  const scopeLabel = (s: PermissionScope): string =>
    s === "once" ? "Just once" : s === "timed" ? span(duration) : "Always";
  const scopeWords = (s: PermissionScope) => labels?.scope?.(s, duration) ?? scopeLabel(s);
  const shown = open ? preview : preview.slice(0, previewLimit);
  const hidden = preview.length - shown.length;

  /* ---------- The decided line ---------- */

  const result = () => {
    if (!current) return null;
    const at = finite(current.at) ? current.at : now;
    const until = finite(current.until) ? current.until : undefined;
    const total = until !== undefined ? until - at : 0;
    const share = total > 0 ? Math.max(0, Math.min(1, (until! - now) / total)) : 0;
    const kind = expired ? "expired" : current.allow ? "allowed" : "denied";
    const words = labels?.result?.(kind, current, {
      name,
      minutes: Math.round(total / MIN),
      left: until !== undefined ? left(until - now) : undefined,
      until: until !== undefined ? hhmm(until, now) : undefined,
      at: hhmm(at, now),
    });
    const headline = words ? words.headline : expired
      ? "Access expired"
      : !current.allow
        ? "Denied"
        : current.scope === "once"
          ? "Allowed once"
          : current.scope === "timed"
            ? total > 0
              ? `Allowed for ${span(Math.round(total / MIN))}`
              : "Allowed"
            : "Always allowed";
    const note = words ? words.note : expired
      ? `${name} will ask again`
      : !current.allow
        ? `${name} was told and won't do it`
        : current.scope === "timed"
          ? until !== undefined
            ? `${left(until - now)} · until ${hhmm(until, now)}`
            : "No end time given"
          : current.scope === "once"
            ? `At ${hhmm(at, now)} · it won't carry over`
            : `${name} won't ask for this again`;
    return (
      <div className="ui-prc__result" data-kind={kind} role="status">
        <span className="ui-prc__result-icon">
          {kind === "allowed" ? (
            <CheckIcon />
          ) : kind === "denied" ? (
            <CrossIcon />
          ) : (
            <ClockIcon />
          )}
        </span>
        <span className="ui-prc__result-text">
          <span className="ui-prc__result-head" title={`${headline} · ${action}`}>
            {headline}
            <span className="ui-prc__result-action">
              {" · "}
              <span dir="auto">{action}</span>
            </span>
          </span>
          <span className="ui-prc__result-note" title={note}>
            {note}
          </span>
        </span>
        {!revocable ? null : current.allow && !expired && current.scope !== "once" ? (
          <button
            type="button"
            className="ui-prc__ghost"
            onClick={() => decide(null)}
          >
            {labels?.revoke ?? "Revoke"}
          </button>
        ) : (
          <button
            type="button"
            className="ui-prc__ghost"
            onClick={() => decide(null)}
          >
            {expired ? (labels?.askAgain ?? "Ask again") : (labels?.change ?? "Change")}
          </button>
        )}
        {current.allow && current.scope === "timed" && until !== undefined && !expired && (
          <span className="ui-prc__drain" aria-hidden="true">
            <span style={{ transform: `scaleX(${share})` }} />
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      className={["ui-prc", className].filter(Boolean).join(" ")}
      data-risk={risk}
      data-state={shape.split(":")[0]}
    >
      <style href="ui-permission-request-clean" precedence="default">
        {css}
      </style>

      <div
        ref={cardRef}
        className="ui-prc__card"
        role={current ? undefined : "dialog"}
        aria-labelledby={current ? undefined : `${uid}-title`}
        aria-describedby={current || !reason ? undefined : `${uid}-why`}
        onKeyDown={onKey}
      >
        {current ? (
          result()
        ) : (
          <div className="ui-prc__ask" key="ask">
            <div className="ui-prc__body">
              {/* ----- Who asks for what ----- */}
              <header className="ui-prc__head">
                <span
                  className="ui-prc__avatar"
                  data-logo={agent.avatar && !avatarFailed ? "" : undefined}
                  onErrorCapture={() => setAvatarFailed(true)}
                >
                  {agent.avatar && !avatarFailed ? agent.avatar : initials(name) || "AI"}
                </span>
                <span className="ui-prc__heading">
                  <span className="ui-prc__title" id={`${uid}-title`}>
                    {labels?.title ? (
                      labels.title(name, action)
                    ) : (
                      <>
                        <b dir="auto">{name}</b> wants to <b dir="auto">{action}</b>
                      </>
                    )}
                  </span>
                  {(target || agent.model) && (
                    <span className="ui-prc__sub" title={target ?? agent.model}>
                      {toolIcon && (
                        <span className="ui-prc__tool" onErrorCapture={hideBroken}>
                          {toolIcon}
                        </span>
                      )}
                      <span className="ui-prc__sub-text" dir="auto">
                        {target ?? agent.model}
                      </span>
                    </span>
                  )}
                </span>
                {risk !== "safe" && (
                  <span className="ui-prc__risk" data-risk={risk}>
                    {risk === "risky" ? <RiskyIcon /> : <DestructiveIcon />}
                    {labels?.risk?.(risk) ?? RISK[risk]}
                  </span>
                )}
              </header>

              {reason && (
                <p className="ui-prc__why" id={`${uid}-why`} dir="auto">
                  {reason}
                </p>
              )}

              {/* ----- Exactly what will happen ----- */}
              {preview.length > 0 && (
                <section
                  className="ui-prc__preview"
                  aria-labelledby={`${uid}-what`}
                  data-open={open ? "" : undefined}
                >
                  <h4 className="ui-prc__label" id={`${uid}-what`}>
                    <span className="ui-prc__label-text" dir="auto">
                      {previewTitle}
                    </span>
                    <span className="ui-prc__count">{count.format(preview.length)}</span>
                  </h4>
                  <ul className="ui-prc__list">
                    {shown.map((p, i) => (
                      <li
                        key={`${p.id}#${i}`}
                        className="ui-prc__item"
                        style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                      >
                        <span className="ui-prc__item-icon" onErrorCapture={hideBroken}>
                          {p.icon ?? <DotIcon />}
                        </span>
                        <span className="ui-prc__item-label" dir="auto" title={p.label}>
                          {p.label}
                        </span>
                        {p.meta != null && (
                          <span className="ui-prc__item-meta">{p.meta}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {(hidden > 0 || open) && preview.length > previewLimit && (
                    <button
                      type="button"
                      className="ui-prc__more"
                      aria-expanded={open}
                      onClick={() => setOpen((o) => !o)}
                    >
                      {open ? (labels?.showLess ?? "Show less") : (labels?.more?.(hidden) ?? `${count.format(hidden)} more`)}
                    </button>
                  )}
                </section>
              )}
              {children != null && <div className="ui-prc__more-body">{children}</div>}
            </div>

            {/* ----- How long, and the answer ----- */}
            <div className="ui-prc__answer">
              {offered.length > 1 && renderScopes?.({ scopes: offered, scope, onChange: setScope, label: scopeLabel })}
              {/* The words a translation gives the built-in chips */}
              {offered.length > 1 && !renderScopes && (
                <div
                  className="ui-prc__scopes"
                  role="radiogroup"
                  aria-label={labels?.howLong ?? "How long"}
                >
                  {offered.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={s === scope}
                      className="ui-prc__scope"
                      onClick={() => setScope(s)}
                      onKeyDown={(e) => {
                        const step =
                          e.key === "ArrowRight"
                            ? 1
                            : e.key === "ArrowLeft"
                              ? -1
                              : 0;
                        if (!step) return;
                        e.preventDefault();
                        const next =
                          offered[
                            (offered.indexOf(scope) + step + offered.length) %
                              offered.length
                          ];
                        setScope(next);
                        (
                          e.currentTarget.parentElement?.querySelector(
                            `[data-scope="${next}"]`,
                          ) as HTMLElement | null
                        )?.focus();
                      }}
                      data-scope={s}
                      tabIndex={s === scope ? 0 : -1}
                    >
                      {scopeWords(s)}
                    </button>
                  ))}
                </div>
              )}
              {risk === "destructive" && scopes.includes("always") && (
                <span className="ui-prc__hint">
                  {labels?.noAlways ?? "Destructive actions can't be allowed for always"}
                </span>
              )}
              <div className="ui-prc__buttons">
                {actions}
                <button type="button" className="ui-prc__btn" onClick={deny} disabled={disabled}>
                  {labels?.deny ?? "Deny"}
                  <kbd className="ui-prc__kbd">Esc</kbd>
                </button>
                <button
                  type="button"
                  className="ui-prc__btn ui-prc__btn--primary"
                  onClick={allow}
                  disabled={disabled}
                >
                  <span key={scope} className="ui-prc__btn-label">
                    {allowLabel}
                  </span>
                  <kbd className="ui-prc__kbd">↵</kbd>
                </button>
                {trailingActions}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const css = /* css */ `
/* Colors and motion as variables – override them on .ui-prc */
.ui-prc {
  --ui-prc-card: #ffffff;
  --ui-prc-strong: #000000;
  --ui-prc-ink: rgba(0, 0, 0, 0.88);
  --ui-prc-text: rgba(0, 0, 0, 0.61);
  --ui-prc-muted: rgba(0, 0, 0, 0.45);
  --ui-prc-faint: rgba(0, 0, 0, 0.27);
  --ui-prc-icon: rgba(0, 0, 0, 0.447);
  --ui-prc-line: rgba(0, 0, 0, 0.06);
  --ui-prc-wash: rgba(0, 0, 0, 0.03);
  --ui-prc-fill: rgba(0, 0, 0, 0.06);
  --ui-prc-accent: rgba(0, 96, 226, 0.765);
  /* Subtle tones after Interfere's tokens (Radix scales): a soft background and its foreground */
  --ui-prc-ok-bg: #00a43319;
  --ui-prc-ok-fg: #007d2ee0;
  --ui-prc-warn-bg: #ff9c0029;
  --ui-prc-warn-fg: #cc4e00;
  --ui-prc-danger-bg: #f52b0018;
  --ui-prc-danger-fg: #d72400da;
  --ui-prc-primary: #171717;
  --ui-prc-on-primary: #ffffff;
  --ui-prc-focus: rgba(0, 96, 226, 0.35);
  /* Strokes are shadows: a 0.5px hairline plus a soft lift */
  --ui-prc-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ui-prc-ease: cubic-bezier(0.32, 0.72, 0.24, 1);
  position: relative;
  box-sizing: border-box;
  width: 100%;
  max-width: 400px;
  container-type: inline-size;
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  color: var(--ui-prc-text);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
.ui-prc *, .ui-prc *::before, .ui-prc *::after { box-sizing: border-box; }
:where(.ui-prc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ui-prc button:focus-visible { outline: 2px solid var(--ui-prc-focus); outline-offset: 1px; }
.ui-prc ul { margin: 0; padding: 0; list-style: none; }
.ui-prc h4, .ui-prc p { margin: 0; }
.ui-prc svg { display: block; flex: none; }

/* One white card – the edge is a shadow, not a border */
.ui-prc__card { overflow: hidden; border-radius: 10px; background: var(--ui-prc-card); box-shadow: var(--ui-prc-shadow); }
.ui-prc__card:focus-within { outline: none; }
.ui-prc__ask { animation: ui-prc-in 260ms var(--ui-prc-ease) both; }

/* ----- Who asks for what ----- */
.ui-prc__head { display: flex; align-items: center; gap: 10px; padding: 14px 14px 0 16px; }
.ui-prc__avatar { display: grid; flex: none; place-items: center; width: 28px; height: 28px; border-radius: 7px; background: var(--ui-prc-card); box-shadow: var(--ui-prc-shadow); font-size: 11px; font-weight: 500; color: var(--ui-prc-text); overflow: hidden; }
.ui-prc__avatar[data-logo] > svg { width: 16px; height: 16px; }
.ui-prc__heading { display: grid; flex: 1; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.ui-prc__title { color: var(--ui-prc-text); overflow-wrap: anywhere; }
.ui-prc__title b { font-weight: 500; color: var(--ui-prc-strong); }
.ui-prc__sub { display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-prc-muted); white-space: nowrap; text-overflow: ellipsis; }
.ui-prc__tool { display: grid; flex: none; place-items: center; width: 12px; height: 12px; overflow: hidden; }
.ui-prc__sub-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* Image marks fit their tile, whatever their size */
.ui-prc__tool > img { width: 12px; height: 12px; object-fit: contain; }
.ui-prc__avatar > img { width: 16px; height: 16px; object-fit: contain; }
.ui-prc__item-icon > img { width: 16px; height: 16px; object-fit: contain; }
.ui-prc__tool > svg { width: 12px; height: 12px; }
/* Risk: a small tag – glyph and word on a subtle tone */
.ui-prc__risk { display: inline-flex; flex: none; align-self: start; align-items: center; gap: 3px; height: 18px; margin-top: 1px; padding: 0 6px 0 4px; border-radius: 4px; background: var(--ui-prc-warn-bg); font-size: 11px; font-weight: 500; line-height: 16px; color: var(--ui-prc-warn-fg); }
.ui-prc__risk[data-risk="destructive"] { background: var(--ui-prc-danger-bg); color: var(--ui-prc-danger-fg); }

/* The agent's reason: a quiet line with a rule on the left */
.ui-prc__why { margin: 12px 16px 0 54px !important; padding-left: 10px; border-left: 2px solid var(--ui-prc-fill); font-size: 12px; line-height: 18px; color: var(--ui-prc-text); white-space: pre-line; overflow-wrap: anywhere; }

/* ----- What will happen ----- */
.ui-prc__preview { margin-top: 14px; padding: 12px 10px 4px; border-top: 0.5px solid var(--ui-prc-line); }
.ui-prc__label { display: flex; align-items: center; gap: 6px; margin: 0 6px 4px !important; font-size: 12px; font-weight: 400; line-height: 16px; color: var(--ui-prc-muted); }
.ui-prc__count { display: grid; flex: none; place-items: center; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 4px; background: var(--ui-prc-card); box-shadow: var(--ui-prc-shadow); font-size: 10px; font-weight: 500; line-height: 16px; color: var(--ui-prc-text); font-variant-numeric: tabular-nums; }
.ui-prc__label-text { min-width: 0; overflow-wrap: anywhere; }
/* All of a long preview: the list scrolls instead of growing the card */
.ui-prc__preview[data-open] .ui-prc__list { max-height: 320px; overflow-y: auto; overscroll-behavior: contain; }
.ui-prc__list { display: grid; grid-template-columns: minmax(0, 1fr); }
.ui-prc__item { display: flex; align-items: center; gap: 10px; min-height: 30px; padding: 0 6px; border-radius: 6px; animation: ui-prc-in 260ms var(--ui-prc-ease) both; }
.ui-prc__item-icon { display: grid; flex: none; place-items: center; width: 16px; height: 16px; color: var(--ui-prc-icon); overflow: hidden; }
.ui-prc__item-icon > svg { width: 16px; height: 16px; }
.ui-prc__item-label { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-prc-ink); white-space: nowrap; text-overflow: ellipsis; }
.ui-prc__item-meta { flex: none; font-size: 12px; color: var(--ui-prc-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.ui-prc__more { margin: 0 0 4px 32px; padding: 2px 0; font-size: 12px; line-height: 16px; color: var(--ui-prc-muted); transition: color 160ms ease; }
.ui-prc__more:hover { color: var(--ui-prc-ink); }

/* ----- How long, and the answer ----- */
.ui-prc__answer { display: grid; gap: 12px; padding: 12px 16px 16px; border-top: 0.5px solid var(--ui-prc-line); }
/* Without a preview the answer sits a little below the heading or the reason */
.ui-prc__body:not(:has(.ui-prc__preview)) { padding-bottom: 14px; }
/* Separate buttons: the others are gray, the chosen one is white with a hairline and a soft lift */
.ui-prc__scopes { display: flex; gap: 8px; }
.ui-prc__scope { flex: 1; padding: 3px 8px; border-radius: 6px; background: var(--ui-prc-fill); font-size: 12px; font-weight: 500; line-height: 18px; color: var(--ui-prc-text); text-align: center !important; white-space: nowrap; transition: color 180ms ease, background-color 180ms ease, box-shadow 180ms ease; }
.ui-prc__scope[aria-checked="true"] { background: var(--ui-prc-card); box-shadow: var(--ui-prc-shadow); color: var(--ui-prc-strong); }
.ui-prc__scope[aria-checked="false"]:hover { background: rgba(0, 0, 0, 0.08); color: var(--ui-prc-ink); }
.ui-prc__hint { margin-top: -6px; font-size: 11px; line-height: 16px; color: var(--ui-prc-muted); }
.ui-prc__buttons { display: flex; justify-content: flex-end; gap: 8px; }
.ui-prc__btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 28px; padding: 0 8px 0 12px; border-radius: 6px; background: var(--ui-prc-card); box-shadow: var(--ui-prc-shadow); font-size: 13px; font-weight: 500; color: var(--ui-prc-ink); white-space: nowrap; transition: background-color 160ms ease, transform 120ms ease; }
.ui-prc__btn:hover { background: var(--ui-prc-wash); }
.ui-prc__btn:active { transform: scale(0.98); }
.ui-prc__more-body { display: grid; gap: 8px; min-width: 0; padding: 10px 16px 0; }
.ui-prc__btn:disabled { opacity: 0.6; cursor: default; transform: none; }
.ui-prc__btn--primary { background: var(--ui-prc-primary); box-shadow: none; color: var(--ui-prc-on-primary); }
.ui-prc__btn--primary:hover { background: var(--ui-prc-primary); opacity: 0.88; }
/* Destructive: the Allow button carries the warning */
.ui-prc[data-risk="destructive"] .ui-prc__btn--primary { background: var(--ui-prc-danger-fg); }
.ui-prc__btn-label { animation: ui-prc-swap 220ms var(--ui-prc-ease) both; }
.ui-prc__kbd { display: grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; background: var(--ui-prc-fill); font-family: inherit; font-size: 10px; font-weight: 500; line-height: 16px; color: var(--ui-prc-muted); }
.ui-prc__btn--primary .ui-prc__kbd { background: rgba(255, 255, 255, 0.16); color: rgba(255, 255, 255, 0.72); }

/* ----- The decided line ----- */
.ui-prc__result { position: relative; display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 10px 10px 10px 16px; animation: ui-prc-in 300ms var(--ui-prc-ease) both; }
.ui-prc__result-icon { display: grid; flex: none; place-items: center; width: 16px; height: 16px; animation: ui-prc-pop 360ms var(--ui-prc-ease) both; }
.ui-prc__result[data-kind="allowed"] .ui-prc__result-icon { color: var(--ui-prc-ok-fg); }
.ui-prc__result[data-kind="denied"] .ui-prc__result-icon { color: var(--ui-prc-danger-fg); }
.ui-prc__result[data-kind="expired"] .ui-prc__result-icon { color: var(--ui-prc-muted); }
.ui-prc__result-text { display: grid; flex: 1; min-width: 0; }
.ui-prc__result-head { overflow: hidden; font-weight: 500; color: var(--ui-prc-strong); white-space: nowrap; text-overflow: ellipsis; }
.ui-prc__result-action { font-weight: 400; color: var(--ui-prc-muted); }
.ui-prc__result-note { overflow: hidden; font-size: 12px; line-height: 16px; color: var(--ui-prc-muted); white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.ui-prc__ghost { flex: none; height: 28px; padding: 0 10px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--ui-prc-text); transition: background-color 160ms ease, color 160ms ease; }
.ui-prc__ghost:hover { background: var(--ui-prc-fill); color: var(--ui-prc-ink); }
/* The time left: a thin bar along the bottom that drains until the right runs out */
.ui-prc__drain { position: absolute; right: 0; bottom: 0; left: 0; height: 2px; background: var(--ui-prc-wash); }
.ui-prc__drain > span { display: block; height: 100%; background: var(--ui-prc-ok-fg); opacity: 0.7; transform-origin: left; transition: transform 900ms linear; }

@keyframes ui-prc-in { from { opacity: 0; transform: translateY(3px); } }
@keyframes ui-prc-swap { from { opacity: 0; transform: translateY(2px); } }
@keyframes ui-prc-pop { 0% { opacity: 0; transform: scale(0.5); } 60% { opacity: 1; transform: scale(1.12); } }

/* Narrow containers: the reason loses its indent, the buttons share the width */
@container (max-width: 340px) {
  .ui-prc__why { margin-left: 16px !important; }
  .ui-prc__scopes { gap: 4px; }
  .ui-prc__scope { padding: 4px 4px; }
  .ui-prc__buttons > .ui-prc__btn { flex: 1; }
  .ui-prc__kbd { display: none; }
}
/* Touch: no keyboard hints, bigger targets */
@media (hover: none) {
  .ui-prc__kbd { display: none; }
}
@media (pointer: coarse) {
  .ui-prc__scope { padding: 8px 10px; }
  .ui-prc__btn, .ui-prc__ghost { height: 40px; }
  .ui-prc__btn { padding: 0 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-prc *, .ui-prc *::before, .ui-prc *::after { animation: none !important; transition: none !important; }
}

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html> */
:where(.dark, [data-theme="dark"]) .ui-prc__scope[aria-checked="false"]:hover { background: rgba(255, 255, 255, 0.11); }
:where(.dark, [data-theme="dark"]) .ui-prc__btn--primary .ui-prc__kbd { background: rgba(0, 0, 0, 0.1); color: rgba(0, 0, 0, 0.55); }
:where(.dark, [data-theme="dark"]) .ui-prc[data-risk="destructive"] .ui-prc__btn--primary { background: #e5484d; color: #ffffff; }
:where(.dark, [data-theme="dark"]) .ui-prc[data-risk="destructive"] .ui-prc__btn--primary .ui-prc__kbd { background: rgba(255, 255, 255, 0.18); color: rgba(255, 255, 255, 0.75); }
:where(.dark, [data-theme="dark"]) .ui-prc {
  --ui-prc-card: #1c1c1f;
  --ui-prc-strong: #ffffff;
  --ui-prc-ink: rgba(255, 255, 255, 0.9);
  --ui-prc-text: rgba(255, 255, 255, 0.62);
  --ui-prc-muted: rgba(255, 255, 255, 0.45);
  --ui-prc-faint: rgba(255, 255, 255, 0.28);
  --ui-prc-icon: rgba(255, 255, 255, 0.5);
  --ui-prc-line: rgba(255, 255, 255, 0.08);
  --ui-prc-wash: rgba(255, 255, 255, 0.04);
  --ui-prc-fill: rgba(255, 255, 255, 0.08);
  --ui-prc-accent: #5b9aff;
  --ui-prc-ok-bg: #00f04a1f;
  --ui-prc-ok-fg: #3dd68c;
  --ui-prc-warn-bg: #fb6a0025;
  --ui-prc-warn-fg: #ffa057;
  --ui-prc-danger-bg: #ff35232b;
  --ui-prc-danger-fg: #ff977d;
  --ui-prc-primary: #ededed;
  --ui-prc-on-primary: #111113;
  --ui-prc-focus: rgba(91, 154, 255, 0.45);
  --ui-prc-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.4);
}
`;
