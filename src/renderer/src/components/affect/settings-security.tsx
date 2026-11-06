// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

/*
 * Settings / Security – who may sign in to a workspace and how, in a single file.
 * The settings sidebar, then the page: the company's email domains (added, verified, joined by), the sign-in rules
 * – single sign-on, two-step verification, how long a session lasts – the details an identity provider needs,
 * the IP ranges the workspace answers to, and a danger zone that signs everyone out.
 * Every control works; changes save at once and answer with a short toast.
 * Sits in the affectUI App Shell; Button from the library, icons from the Hugeicons free set.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Add01Icon, ArrowDown01Icon, Cancel01Icon, Clock01Icon, Copy01Icon, Globe02Icon, InformationCircleIcon, Logout03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "./button";
import { AppShell, Dropdown, Icon, useToast, type AppShellProps } from "./app-shell";
import { settingsGroups } from "./settings-profile";
import { css as generalCss } from "./settings-general";

/* ---------- Sample content – replace with your own data ---------- */

export type SecurityDomain = { name: string; verified: boolean };

export type SecurityValues = {
  domains: SecurityDomain[];
  /** Anyone with an address at a verified domain can join without an invite */
  joinByDomain: boolean;
  /** Members sign in through the identity provider */
  sso: boolean;
  /** The identity provider's metadata URL */
  metadataUrl: string;
  twoStep: boolean;
  session: string;
  /** IP ranges in CIDR notation; empty lets every address in */
  ipRanges: string[];
};

const sample: SecurityValues = {
  domains: [
    { name: "acme.com", verified: true },
    { name: "acme.io", verified: false },
  ],
  joinByDomain: true,
  sso: true,
  metadataUrl: "https://acme.okta.com/app/exk4p2/sso/saml/metadata",
  twoStep: false,
  session: "30 days",
  ipRanges: [],
};

const sessions = ["12 hours", "1 day", "7 days", "30 days", "90 days"];
const AUDIENCE = "https://app.workspace.ai/saml/acme";
const ACS_URL = "https://app.workspace.ai/saml/acme/acs";

export type SettingsSecurityScreenProps = Pick<AppShellProps, "onNavigate" | "user" | "workspace" | "className"> & {
  /** The settings – the sample workspace when left out */
  security?: SecurityValues;
  /** Called with all settings whenever something changes */
  onSave?: (security: SecurityValues) => void;
  /** Called to check a domain's DNS record; resolve true once it is found */
  onVerifyDomain?: (domain: string) => Promise<boolean>;
  /** Called once signing everyone out is confirmed */
  onSignOutAll?: () => void;
};

const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const CIDR_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(3[0-2]|[12]?\d)$/;

// Stands in for a DNS lookup in the demo
const fakeVerify = () => new Promise<boolean>((done) => setTimeout(() => done(true), 1400));

/**
 * After a remove button takes its row away, focus goes to the next row's button (or the new last one's),
 * and to the list itself once it is empty – never lost to the page. Shared by the other settings screens.
 */
export function refocusAfterRemove(from: Element | null | undefined, selector = ".ui-ss-remove") {
  const list = from?.closest<HTMLElement>("[role=table], [role=list], section");
  if (!from || !list) return;
  const own = from.closest(selector) ?? from.closest("[role=row], [role=listitem], .ui-sg-row")?.querySelector(selector);
  const index = [...list.querySelectorAll(selector)].indexOf(own as Element);
  // After React has taken the row away
  setTimeout(() => {
    const left = [...list.querySelectorAll<HTMLElement>(selector)];
    const next = left[Math.max(0, Math.min(index, left.length - 1))];
    if (next) return next.focus();
    list.tabIndex = -1;
    list.focus();
  });
}

/** Gives focus back to a button that was hidden while what it opened was showing, once that closes */
export function useFocusBack<K extends string>(open: K | null | false) {
  const buttons = useRef<Partial<Record<K, HTMLElement | null>>>({});
  const last = useRef(open);
  useEffect(() => {
    if (!open && last.current) buttons.current[last.current]?.focus();
    last.current = open;
  }, [open]);
  return (key: K) => (el: HTMLElement | null) => {
    buttons.current[key] = el;
  };
}

export function SettingsSecurityScreen({ security = sample, onSave, onVerifyDomain = fakeVerify, onSignOutAll, ...props }: SettingsSecurityScreenProps) {
  const [values, setValues] = useState(security);
  const [toast, showToast] = useToast();
  const [checking, setChecking] = useState<string | null>(null);
  const [adding, setAdding] = useState<"domain" | "range" | null>(null);
  const [draft, setDraft] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const metadataSaved = useRef(security.metadataUrl);
  const focusBack = useFocusBack(adding);
  const signOutBack = useFocusBack(signingOut && "signOut");

  const verified = values.domains.some((d) => d.verified);
  const update = (patch: Partial<SecurityValues>, note?: string) => {
    const next = { ...values, ...patch };
    setValues(next);
    onSave?.(next);
    if (note) showToast(note);
  };
  // Without a verified domain there is nothing to join by or to sign in with
  useEffect(() => {
    if (!verified && (values.joinByDomain || values.sso)) setValues((v) => ({ ...v, joinByDomain: false, sso: false }));
  }, [verified, values.joinByDomain, values.sso]);

  const verify = async (name: string) => {
    setChecking(name);
    const ok = await onVerifyDomain(name);
    setChecking(null);
    if (!ok) return showToast(`No TXT record found for ${name} yet`);
    setValues((v) => {
      const next = { ...v, domains: v.domains.map((d) => (d.name === name ? { ...d, verified: true } : d)) };
      onSave?.(next);
      return next;
    });
    showToast(`${name} verified`);
  };

  const closeAdd = () => {
    setAdding(null);
    setDraft("");
  };
  const submitAdd = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, adding === "range" ? "/" : "");
    if (adding === "domain") {
      if (!DOMAIN_RE.test(value)) return showToast("Enter a domain like acme.com");
      if (values.domains.some((d) => d.name === value)) return showToast(`${value} is already on the list`);
      update({ domains: [...values.domains, { name: value, verified: false }] }, `${value} added – verify it next`);
    } else {
      if (!CIDR_RE.test(value)) return showToast("Enter a range like 203.0.113.0/24");
      if (values.ipRanges.includes(value)) return showToast(`${value} is already on the list`);
      update({ ipRanges: [...values.ipRanges, value] }, "Range added");
    }
    closeAdd();
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast("Copied");
  };

  return (
    <AppShell active="Security" nav={[]} groups={settingsGroups} back={{ title: "Settings" }} {...props}>
      <style href="ui-settings-general" precedence="default">
        {generalCss}
      </style>
      <style href="ui-settings-security" precedence="default">
        {css}
      </style>
      <div className="ui-as-page ui-sg ui-ss">
        <h1 className="ui-as-page-title">Security</h1>
        <p className="ui-as-page-sub">Decide who can sign in to your workspace and how.</p>

        {/* Domains: the company's addresses, verified by a DNS record */}
        <header className="ui-sg-head ui-ss-head">
          <span>
            <h2>Email domains</h2>
            <p>Verify the domains your team signs in with. Verified domains unlock joining by domain and single sign-on.</p>
          </span>
          {adding !== "domain" && (
            <Button
              ref={focusBack("domain")}
              size="sm"
              variant="secondary"
              icon={<Icon icon={Add01Icon} size={15} />}
              onClick={() => {
                setDraft("");
                setAdding("domain");
              }}
            >
              Add domain
            </Button>
          )}
        </header>
        <section className="ui-sg-card" aria-label="Email domains">
          {values.domains.map((d) => (
            <div key={d.name} className="ui-sg-row ui-ss-domain">
              <span className="ui-ss-domain__name">
                <span className="ui-ss-tile" aria-hidden="true">
                  <Icon icon={Globe02Icon} size={15} />
                </span>
                <b title={d.name}>{d.name}</b>
                <span className="ui-ss-badge" data-tone={d.verified ? "ok" : undefined}>
                  {d.verified ? "Verified" : checking === d.name ? "Checking…" : "Pending"}
                </span>
              </span>
              <span className="ui-sg-control">
                {!d.verified && (
                  <Button size="sm" variant="secondary" disabled={checking === d.name} onClick={() => verify(d.name)}>
                    {checking === d.name ? <span className="ui-ss-spinner" aria-label="Checking" /> : "Verify"}
                  </Button>
                )}
                <button
                  type="button"
                  className="ui-as-icon-btn ui-ss-remove"
                  aria-label={`Remove ${d.name}`}
                  onClick={(e) => {
                    refocusAfterRemove(e.currentTarget);
                    update({ domains: values.domains.filter((x) => x.name !== d.name) }, `${d.name} removed`);
                  }}
                >
                  <Icon icon={Cancel01Icon} size={14} />
                </button>
              </span>
            </div>
          ))}
          {values.domains.length === 0 && adding !== "domain" && <p className="ui-ss-empty">No domains yet</p>}
          {adding === "domain" && <AddRow label="Domain" placeholder="acme.com" value={draft} onChange={setDraft} onSubmit={submitAdd} onCancel={closeAdd} />}
          {values.domains.some((d) => !d.verified) && (
            <p className="ui-ss-dns">
              <Icon icon={InformationCircleIcon} size={14} />
              <span>
                Add a TXT record <code>workspace-verify=7f3a9c</code> to the domain's DNS, then press Verify.
              </span>
            </p>
          )}
        </section>
        <section className="ui-sg-card" aria-label="Joining">
          <Toggle
            title="Join by domain"
            note={verified ? "Anyone with a verified address joins as a member without an invite" : "Verify a domain first"}
            on={values.joinByDomain}
            disabled={!verified}
            onChange={(on) => update({ joinByDomain: on }, on ? "Joining by domain on" : "Joining by domain off")}
          />
        </section>

        {/* Sign-in rules */}
        <header className="ui-sg-head">
          <h2>Sign-in</h2>
        </header>
        <section className="ui-sg-card" aria-label="Sign-in">
          <Toggle
            title="Require single sign-on (SAML)"
            note={verified ? "Members at a verified domain sign in through your identity provider" : "Verify a domain before turning on SSO"}
            on={values.sso}
            disabled={!verified}
            onChange={(on) => update({ sso: on }, on ? "Single sign-on required" : "Single sign-on off")}
          />
          <Toggle
            title="Two-step verification"
            note="Everyone without SSO adds a code from an authenticator app"
            on={values.twoStep}
            onChange={(on) => update({ twoStep: on }, on ? "Two-step verification required" : "Two-step verification optional")}
          />
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Session length</b>
              <small>How long people stay signed in without activity</small>
            </span>
            <Dropdown
              align="end"
              items={sessions.map((s) => ({ label: s, icon: Clock01Icon, checked: s === values.session, onSelect: () => update({ session: s }, `Sessions last ${s}`) }))}
              trigger={({ open, toggle }) => (
                <button type="button" className="ui-ss-select" aria-label="Session length" aria-expanded={open} onClick={toggle}>
                  <span>{values.session}</span>
                  <Icon icon={ArrowDown01Icon} size={14} />
                </button>
              )}
            />
          </div>
        </section>

        {/* What the identity provider needs – only while SSO is on */}
        {values.sso && (
          <>
            <header className="ui-sg-head ui-ss-rise">
              <h2>Identity provider</h2>
              <p>Copy these into Okta, Entra ID or Google Workspace, then paste the metadata URL they give you.</p>
            </header>
            <section className="ui-sg-card ui-ss-rise" aria-label="Identity provider">
              <CopyRow title="Audience URI" note="SP entity ID" value={AUDIENCE} onCopy={copy} />
              <CopyRow title="ACS URL" note="Assertion consumer service" value={ACS_URL} onCopy={copy} />
              <label className="ui-sg-row">
                <span className="ui-sg-label">
                  <b>Metadata URL</b>
                  <small>From your identity provider</small>
                </span>
                <input
                  className="ui-sg-input"
                  value={values.metadataUrl}
                  placeholder="https://idp.example.com/metadata"
                  spellCheck={false}
                  onChange={(e) => setValues((v) => ({ ...v, metadataUrl: e.target.value }))}
                  onBlur={() => {
                    if (values.metadataUrl === metadataSaved.current) return;
                    metadataSaved.current = values.metadataUrl;
                    update({}, "Metadata URL saved");
                  }}
                />
              </label>
            </section>
          </>
        )}

        {/* Network: IP ranges */}
        <header className="ui-sg-head ui-ss-head">
          <span>
            <h2>IP allowlist</h2>
            <p>Only let people in from these ranges. With none, every network can reach the workspace.</p>
          </span>
          {adding !== "range" && (
            <Button
              ref={focusBack("range")}
              size="sm"
              variant="secondary"
              icon={<Icon icon={Add01Icon} size={15} />}
              onClick={() => {
                setDraft("");
                setAdding("range");
              }}
            >
              Add range
            </Button>
          )}
        </header>
        <section className="ui-sg-card" aria-label="IP allowlist">
          {values.ipRanges.map((r) => (
            <div key={r} className="ui-sg-row ui-ss-domain">
              <code className="ui-ss-range">{r}</code>
              <button
                type="button"
                className="ui-as-icon-btn ui-ss-remove"
                aria-label={`Remove ${r}`}
                onClick={(e) => {
                  refocusAfterRemove(e.currentTarget);
                  update({ ipRanges: values.ipRanges.filter((x) => x !== r) }, "Range removed");
                }}
              >
                <Icon icon={Cancel01Icon} size={14} />
              </button>
            </div>
          ))}
          {values.ipRanges.length === 0 && adding !== "range" && <p className="ui-ss-empty">No ranges – every network is allowed</p>}
          {adding === "range" && <AddRow label="IP range" placeholder="203.0.113.0/24" value={draft} onChange={setDraft} onSubmit={submitAdd} onCancel={closeAdd} />}
        </section>

        {/* Danger zone */}
        <header className="ui-sg-head">
          <h2>Danger zone</h2>
        </header>
        <section className="ui-sg-card" aria-label="Danger zone">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Sign out everyone</b>
              <small>Ends every session in the workspace, yours included. People sign in again.</small>
            </span>
            {!signingOut ? (
              <button ref={signOutBack("signOut")} type="button" className="ui-sg-danger" onClick={() => setSigningOut(true)}>
                <Icon icon={Logout03Icon} size={15} />
                Sign out everyone
              </button>
            ) : (
              <span className="ui-sg-control ui-ss-rise" onKeyDown={(e) => e.key === "Escape" && setSigningOut(false)}>
                <Button size="sm" variant="secondary" onClick={() => setSigningOut(false)}>
                  Cancel
                </Button>
                <button
                  type="button"
                  className="ui-sg-danger ui-sg-danger--solid"
                  autoFocus
                  onClick={() => {
                    onSignOutAll?.();
                    setSigningOut(false);
                    showToast("Everyone was signed out");
                  }}
                >
                  Sign out now
                </button>
              </span>
            )}
          </div>
        </section>
      </div>
      {toast}
    </AppShell>
  );
}

/** A row with a title, a note and a switch */
function Toggle({ title, note, on, disabled, onChange }: { title: string; note: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="ui-sg-row" data-disabled={disabled || undefined}>
      <span className="ui-sg-label">
        <b>{title}</b>
        <small>{note}</small>
      </span>
      <button type="button" role="switch" aria-checked={on} aria-label={title} disabled={disabled} className="ui-ss-switch" onClick={() => onChange(!on)} />
    </div>
  );
}

/** A value to hand over – read-only, with a copy button that answers with a check */
function CopyRow({ title, note, value, onCopy }: { title: string; note: string; value: string; onCopy: (value: string) => void }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <div className="ui-sg-row">
      <span className="ui-sg-label">
        <b>{title}</b>
        <small>{note}</small>
      </span>
      <span className="ui-sg-control">
        <input className="ui-sg-input ui-ss-readonly" value={value} readOnly aria-label={title} onFocus={(e) => e.target.select()} />
        <Button
          size="sm"
          variant="secondary"
          icon={<Icon icon={done ? Tick02Icon : Copy01Icon} size={15} />}
          onClick={() => {
            onCopy(value);
            setDone(true);
          }}
        >
          {done ? "Copied" : "Copy"}
        </Button>
      </span>
    </div>
  );
}

/** The inline form that adds a domain or a range */
function AddRow({ label, placeholder, value, onChange, onSubmit, onCancel }: { label: string; placeholder: string; value: string; onChange: (v: string) => void; onSubmit: (e: FormEvent) => void; onCancel: () => void }) {
  return (
    <form className="ui-sg-row ui-ss-add ui-ss-rise" onSubmit={onSubmit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <input className="ui-sg-input" value={value} placeholder={placeholder} aria-label={label} spellCheck={false} autoFocus onChange={(e) => onChange(e.target.value)} />
      <span className="ui-sg-control">
        <Button size="sm" variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" disabled={!value.trim()}>
          Add
        </Button>
      </span>
    </form>
  );
}

/* ---------- Styles ---------- */

// Builds on Settings / General's rows (ui-sg-*); only what Security adds lives here – Settings / Models shares it
export const css = /* css */ `
/* Section heads with their action on the right */
.ui-ss-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.ui-ss-head > button { flex: none; }
.ui-sg-head + .ui-sg-card + .ui-sg-card { margin-top: 8px; }

/* Domains and ranges: a white tile, the name, a quiet badge – a × on hover */
.ui-ss-domain { min-height: 52px; }
.ui-ss-domain__name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ui-ss-domain__name b { overflow: hidden; font-size: 13px; font-weight: 500; color: var(--strong); white-space: nowrap; text-overflow: ellipsis; }
.ui-ss-tile { display: grid; flex: none; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--logo-bg, #fff); box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 1px 2px rgba(0, 0, 0, 0.05); color: var(--muted); }
.ui-ss-badge { flex: none; padding: 1px 7px; border-radius: 999px; background: var(--chip); font-size: 11.5px; line-height: 18px; font-weight: 500; color: var(--muted); }
.ui-ss-badge[data-tone="ok"] { background: rgba(22, 163, 74, 0.1); color: #15803d; }
:where(.dark, [data-theme="dark"]) .ui-ss-badge[data-tone="ok"] { background: rgba(74, 222, 128, 0.12); color: #4ade80; }
.ui-ss-remove { flex: none; width: 28px; height: 28px; opacity: 0; transition: opacity 140ms ease; }
.ui-ss-domain:hover .ui-ss-remove, .ui-ss-remove:focus-visible { opacity: 1; }
@media (hover: none) { .ui-ss-remove { opacity: 1; } }
.ui-ss-range { flex: none; white-space: nowrap; font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12.5px; color: var(--strong); }
.ui-ss-empty { margin: 0; padding: 18px 16px; font-size: 13px; color: var(--muted); }
.ui-ss-dns { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 16px 12px; box-shadow: inset 0 0.5px 0 var(--line); font-size: 12.5px; line-height: 18px; color: var(--muted); }
.ui-ss-dns svg { flex: none; margin-top: 2px; color: var(--faint); }
.ui-ss-dns code { padding: 1px 5px; border-radius: 5px; background: var(--chip); font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; color: var(--ink); white-space: nowrap; }
.ui-ss-add .ui-sg-input { flex: 1; width: auto; max-width: 320px; }
.ui-sg-row + .ui-ss-add, .ui-ss-domain + .ui-ss-add { box-shadow: inset 0 0.5px 0 var(--line); }

/* The spinner while a domain is checked */
.ui-ss-spinner { display: block; width: 12px; height: 12px; border: 1.5px solid var(--line-strong); border-top-color: var(--ink); border-radius: 50%; animation: ui-ss-spin 700ms linear infinite; }
@keyframes ui-ss-spin { to { rotate: 1turn; } }

/* Switches – the Onboarding's; a row whose switch is off-limits fades */
.ui-ss-switch { position: relative; flex: none; width: 32px; height: 20px; border-radius: 6px; background: var(--toggle-off); transition: background-color 220ms ease; }
/* A 44 × 32 target around the 32 × 20 track */
.ui-ss-switch::before { content: ""; position: absolute; inset: -6px; }
.ui-ss-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 4.5px; background: #fff; box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.16); transition: translate 280ms var(--ease); }
.ui-ss-switch[aria-checked="true"] { background: var(--switch-on); }
.ui-ss-switch[aria-checked="true"]::after { translate: 12px 0; }
.ui-ss-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ui-sg-row[data-disabled] { opacity: 0.5; }
.ui-ss-switch:disabled { cursor: default; opacity: 0.45; }
.ui-sg-row[data-disabled] .ui-ss-switch:disabled { opacity: 1; }

/* Select and read-only fields */
.ui-ss-select { display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; width: 160px; height: 32px; padding: 0 10px; border-radius: 8px; background: var(--card); box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 1px 1px rgba(0, 0, 0, 0.03); font: inherit; font-size: 13px; color: var(--ink); text-align: left; cursor: pointer; transition: box-shadow 140ms ease; }
.ui-ss-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: inset 0 0 0 0.5px var(--line-strong); }
.ui-ss-select[aria-expanded="true"] { box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 0 0 3px var(--accent-soft); }
.ui-ss-select svg { flex: none; color: var(--faint); }
.ui-ss .ui-sg-row .ui-as-menu { min-width: 180px; }
.ui-ss-readonly { width: 220px; background: var(--frame); box-shadow: none; color: var(--text, var(--ink)); text-overflow: ellipsis; }
.ui-ss-readonly:focus { box-shadow: 0 0 0 3px var(--accent-soft); }

.ui-ss-rise { animation: ui-as-rise 260ms var(--ease) both; }

@container ui-as-main (max-width: 600px) {
  .ui-ss-head { flex-direction: column; align-items: flex-start; gap: 10px; }
  .ui-ss-domain { flex-direction: row; align-items: center; }
  .ui-ss-select, .ui-ss-readonly { width: 100%; }
  .ui-sg-row:has(> .ui-ss-switch) { flex-direction: row; align-items: center; }
  .ui-ss-add .ui-sg-input { max-width: none; }
  /* Read-only values take the room their Copy button leaves */
  .ui-sg-control > .ui-ss-readonly { flex: 1; width: auto; min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-ss-rise, .ui-ss-spinner { animation-duration: 1ms; }
}
`;
