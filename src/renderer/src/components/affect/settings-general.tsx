// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

/*
 * Settings / General – the basics of a workspace, in a single file.
 * The settings sidebar, then the page: a card of rows – the workspace's icon, name and address – a company context
 * the assistant reads with every chat, and a danger zone that deletes the workspace once its name is typed.
 * Every field works; changes save on their own and answer with a short toast.
 * Sits in the affectUI App Shell; Button from the library, icons from the Hugeicons free set.
 */

import { useRef, useState, type ChangeEvent } from "react";
import { Cancel01Icon, Delete02Icon, MaximizeScreenIcon, MinimizeScreenIcon, Upload04Icon } from "@hugeicons/core-free-icons";
import { Button } from "./button";
import { AppShell, Icon, useToast, type AppShellProps } from "./app-shell";
import { settingsGroups } from "./settings-profile";

/* ---------- Sample content – replace with your own data ---------- */

export type WorkspaceValues = {
  name: string;
  /** The part of the address after the domain */
  slug: string;
  /** What the assistant should know about the company – added to every chat */
  context: string;
  /** An image URL; without one the first letter shows */
  icon?: string;
};

const sample: WorkspaceValues = { name: "Acme", slug: "acme", context: "" };
const DOMAIN = "app.workspace.ai/";
const CONTEXT_MAX = 2000;

export type SettingsGeneralScreenProps = Pick<AppShellProps, "onNavigate" | "user" | "className"> & {
  /** The workspace – the sample workspace when left out */
  workspace?: WorkspaceValues;
  /** Called with the whole workspace whenever something is saved */
  onSave?: (workspace: WorkspaceValues) => void;
  /** Called once the deletion is confirmed */
  onDelete?: () => void;
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** First character as a whole grapheme, so an emoji or accented letter stays in one piece */
const firstChar = (s: string) => Array.from(s.trim())[0]?.toUpperCase() ?? "";

export function SettingsGeneralScreen({ workspace = sample, onSave, onDelete, ...props }: SettingsGeneralScreenProps) {
  const [values, setValues] = useState(workspace);
  const saved = useRef(workspace);
  const [toast, showToast] = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [wide, setWide] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const deleteBtn = useRef<HTMLButtonElement>(null);
  // Closing the confirm hands focus back to the button that opened it
  const closeDelete = () => {
    setDeleting(false);
    setConfirm("");
    setTimeout(() => deleteBtn.current?.focus());
  };

  const set = <K extends keyof WorkspaceValues>(key: K, value: WorkspaceValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  // Saves what changed – on blur for text, at once for the icon
  const commit = (next: WorkspaceValues = values, note = "Workspace updated") => {
    if (!next.name.trim()) {
      setValues((v) => ({ ...v, name: saved.current.name }));
      return showToast("A workspace needs a name");
    }
    if (JSON.stringify(next) === JSON.stringify(saved.current)) return;
    saved.current = next;
    onSave?.(next);
    showToast(note);
  };

  const pickIcon = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 512 * 1024) return showToast("Pick an image under 512 KB");
    const next = { ...values, icon: URL.createObjectURL(file) };
    setValues(next);
    commit(next, "Icon updated");
  };
  const uploadBtn = useRef<HTMLButtonElement>(null);
  const removeIcon = () => {
    const next = { ...values, icon: undefined };
    setValues(next);
    commit(next, "Icon removed");
    // The × goes with the picture – focus moves on to Upload
    setTimeout(() => uploadBtn.current?.focus());
  };

  // About four characters make a token – enough for a sense of the cost
  const tokens = Math.ceil(values.context.trim().length / 4);
  const canDelete = confirm.trim() === saved.current.name.trim();

  return (
    <AppShell active="General" nav={[]} groups={settingsGroups} back={{ title: "Settings" }} workspace={values.name || "Workspace"} {...props}>
      <style href="ui-settings-general" precedence="default">
        {css}
      </style>
      <div className="ui-as-page ui-sg">
        <h1 className="ui-as-page-title">General</h1>
        <p className="ui-as-page-sub">Set up the basics of your workspace.</p>

        {/* The workspace: icon, name, address */}
        <section className="ui-sg-card" aria-label="Workspace">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Workspace icon</b>
              <small>Square, PNG or JPEG, up to 512 KB</small>
            </span>
            <span className="ui-sg-control">
              <span className="ui-sg-icon">
                {values.icon ? <img src={values.icon} alt="" /> : <span aria-hidden="true">{firstChar(values.name) || "?"}</span>}
                {values.icon && (
                  <button type="button" className="ui-sg-icon__remove" aria-label="Remove icon" onClick={removeIcon}>
                    <Icon icon={Cancel01Icon} size={10} />
                  </button>
                )}
              </span>
              <Button ref={uploadBtn} size="sm" variant="secondary" icon={<Icon icon={Upload04Icon} size={15} />} onClick={() => fileInput.current?.click()}>
                {values.icon ? "Replace" : "Upload"}
              </Button>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg" hidden onChange={pickIcon} />
            </span>
          </div>

          <label className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Workspace name</b>
              <small>Shown in the sidebar and in invites</small>
            </span>
            <input className="ui-sg-input" value={values.name} maxLength={60} onChange={(e) => set("name", e.target.value)} onBlur={() => commit()} />
          </label>

          <label className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Workspace URL</b>
              <small>Changing it breaks links people have saved</small>
            </span>
            <span className="ui-sg-url">
              <span aria-hidden="true">{DOMAIN}</span>
              <input
                value={values.slug}
                aria-label="Workspace URL"
                spellCheck={false}
                onChange={(e) => set("slug", slugify(e.target.value) || "")}
                onBlur={() => commit({ ...values, slug: values.slug || slugify(values.name) || "workspace" }, "Address updated")}
              />
            </span>
          </label>
        </section>

        {/* What the assistant should know about the company */}
        <header className="ui-sg-head">
          <h2>Company context</h2>
          <p>Added to every chat in this workspace, so the assistant already knows how your company works. Keep it short – it counts toward every message.</p>
        </header>
        <section className="ui-sg-card ui-sg-card--pad" aria-label="Company context">
          <textarea
            className="ui-sg-textarea"
            data-wide={wide || undefined}
            maxLength={CONTEXT_MAX}
            value={values.context}
            placeholder="E.g. We have three business units – Sales, Operations and Finance. Common terms: CRM (customer relationship management), SLA (service level agreement). Regional leads escalate to the COO."
            aria-label="Company context"
            onChange={(e) => set("context", e.target.value)}
            onBlur={() => commit(values, "Context saved")}
          />
          <span className="ui-sg-tools">
            <span className="ui-sg-count">
              {values.context.length > 0 && `~${tokens} tokens · `}
              {values.context.length}/{CONTEXT_MAX}
            </span>
            <button type="button" className="ui-as-icon-btn" aria-label={wide ? "Smaller field" : "Bigger field"} onClick={() => setWide((w) => !w)}>
              <Icon icon={wide ? MinimizeScreenIcon : MaximizeScreenIcon} size={14} />
            </button>
          </span>
        </section>
        <p className="ui-sg-hint">Two or three short paragraphs work best: what the company does, how it's organised and the terms people use. Leave out slogans and history.</p>

        {/* Danger zone */}
        <header className="ui-sg-head">
          <h2>Danger zone</h2>
        </header>
        <section className="ui-sg-card ui-sg-card--danger" aria-label="Danger zone">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Delete workspace</b>
              <small>All chats, files and agents of {saved.current.name} go for good, for every member.</small>
            </span>
            {!deleting && (
              <button ref={deleteBtn} type="button" className="ui-sg-danger" onClick={() => setDeleting(true)}>
                <Icon icon={Delete02Icon} size={15} />
                Delete workspace
              </button>
            )}
          </div>
          {/* Confirm by typing the name – the button wakes up once it matches */}
          {deleting && (
            <form
              className="ui-sg-confirm"
              onKeyDown={(e) => e.key === "Escape" && closeDelete()}
              onSubmit={(e) => {
                e.preventDefault();
                if (!canDelete) return;
                onDelete?.();
                showToast(`${saved.current.name} deleted`);
                closeDelete();
              }}
            >
              <label>
                <span>
                  Type <b>{saved.current.name}</b> to confirm
                </span>
                <input className="ui-sg-input" value={confirm} autoFocus autoComplete="off" spellCheck={false} onChange={(e) => setConfirm(e.target.value)} />
              </label>
              <span className="ui-sg-control">
                <Button size="sm" variant="secondary" type="button" onClick={closeDelete}>
                  Cancel
                </Button>
                <button type="submit" className="ui-sg-danger ui-sg-danger--solid" disabled={!canDelete}>
                  Delete for good
                </button>
              </span>
            </form>
          )}
        </section>
      </div>
      {toast}
    </AppShell>
  );
}

/* ---------- Styles ---------- */

/** Shared with Settings / Security, which builds on these rows */
export const css = /* css */ `
/* Settings / General – rows in cards like Settings / Profile, the company context as a field of its own */
.ui-sg { max-width: 760px; margin: 0 auto; }

.ui-sg-head { margin-top: 36px; }
.ui-sg-head h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-sg-head p { max-width: 620px; margin: 2px 0 0; font-size: 13px; line-height: 20px; color: var(--muted); }

.ui-sg-card { position: relative; margin-top: 12px; border-radius: 12px; background: var(--card); box-shadow: var(--card-shadow); }
.ui-as-page-sub + .ui-sg-card { margin-top: 24px; }
.ui-sg-card--pad { padding: 4px; }

.ui-sg-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 60px; padding: 10px 12px 10px 16px; }
.ui-sg-row + .ui-sg-row { box-shadow: inset 0 0.5px 0 var(--line); }
.ui-sg-label { display: grid; min-width: 0; }
.ui-sg-label b { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-sg-label small { font-size: 12px; line-height: 16px; color: var(--muted); }
/* Long names, addresses and links wrap instead of pushing the control out */
.ui-sg-label b, .ui-sg-label small { overflow-wrap: anywhere; }
/* Buttons never squeeze into an ellipsis next to a long label */
.ui-sg-row > :is(button, .ui-buttonc, .ui-as-anchor), .ui-sg-control > :is(button, .ui-buttonc) { flex: none; }
.ui-sg-control { display: flex; flex: none; align-items: center; gap: 8px; min-width: 0; }

/* Fields: white, a hairline, 32px – the focus ring in the accent's tint */
.ui-sg-input, .ui-sg-url {
  box-sizing: border-box;
  width: 260px;
  height: 32px;
  border-radius: 8px;
  background: var(--card);
  box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 1px 1px rgba(0, 0, 0, 0.03);
  font: inherit;
  font-size: 13px;
  color: var(--ink);
  transition: box-shadow 140ms ease;
}
.ui-sg-input { padding: 0 10px; border: 0; outline: none; }
.ui-sg-input:focus, .ui-sg-url:focus-within { box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 0 0 3px var(--accent-soft); }
/* The address: the domain in gray, the part you type in ink */
.ui-sg-url { display: flex; align-items: center; padding-left: 10px; }
.ui-sg-url > span { flex: none; color: var(--muted); }
.ui-sg-url input { flex: 1; min-width: 0; height: 100%; padding: 0 10px 0 0; border: 0; outline: none; background: none; font: inherit; color: var(--ink); }

/* The icon: the first letter until there is a picture; a small × to remove it */
.ui-sg-icon { position: relative; display: grid; flex: none; place-items: center; width: 36px; height: 36px; border-radius: 10px; background: var(--logo-bg, #fff); box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 1px 2px rgba(0, 0, 0, 0.06); font-size: 14px; font-weight: 500; color: var(--ink); }
.ui-sg-icon img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.ui-sg-icon__remove { position: absolute; top: -4px; right: -4px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--card); box-shadow: var(--card-shadow); color: var(--muted); }
.ui-sg-icon__remove:hover { color: var(--ink); }
/* A 32px target around the small × */
.ui-sg-icon__remove::before { content: ""; position: absolute; inset: -7px; }
.ui-sg-icon__remove:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: var(--card-shadow); color: var(--ink); }

/* Company context: a calm writing field; a count and a button to give it more room */
.ui-sg-textarea { display: block; box-sizing: border-box; width: 100%; min-height: 140px; margin-bottom: 30px; padding: 12px 12px 6px; border: 0; border-radius: 9px; background: none; font: inherit; font-size: 13px; line-height: 20px; color: var(--ink); resize: none; outline: none; transition: min-height 280ms var(--ease); }
.ui-sg-textarea[data-wide] { min-height: 340px; }
.ui-sg-textarea::placeholder { color: var(--placeholder); }
.ui-sg-card--pad:focus-within { box-shadow: var(--card-shadow), 0 0 0 3px var(--accent-soft); }
.ui-sg-tools { position: absolute; right: 8px; bottom: 8px; display: flex; align-items: center; gap: 6px; }
.ui-sg-count { font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--faint); }
.ui-sg-tools .ui-as-icon-btn { width: 26px; height: 26px; }
.ui-sg-hint { max-width: 640px; margin: 10px 2px 0; font-size: 12.5px; line-height: 18px; color: var(--muted); }

/* Danger zone: the same card, the action in red; confirming asks for the name */
.ui-sg-danger { display: inline-flex; flex: none; align-items: center; gap: 6px; height: 30px; padding: 0 12px 0 10px; border-radius: 8px; box-shadow: inset 0 0 0 0.5px rgba(220, 38, 38, 0.35); font-size: 13px; font-weight: 500; color: #dc2626; transition: background-color 140ms ease, opacity 140ms ease; }
.ui-sg-danger:hover { background: rgba(220, 38, 38, 0.06); }
.ui-sg-danger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: inset 0 0 0 0.5px rgba(220, 38, 38, 0.35); }
.ui-sg-danger--solid { padding: 0 12px; background: #dc2626; box-shadow: none; color: #fff; }
.ui-sg-danger--solid:hover { background: #c81e1e; }
.ui-sg-danger:disabled { opacity: 0.4; cursor: default; }
.ui-sg-danger--solid:disabled:hover { background: #dc2626; }
.ui-sg-confirm { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; padding: 12px 12px 14px 16px; box-shadow: inset 0 0.5px 0 var(--line); animation: ui-as-rise 260ms var(--ease) both; }
.ui-sg-confirm label { display: grid; gap: 6px; font-size: 12.5px; color: var(--muted); }
.ui-sg-confirm b { font-weight: 500; color: var(--ink); }
:where(.dark, [data-theme="dark"]) .ui-sg-danger:not(.ui-sg-danger--solid) { color: #f87171; }

/* A list that lost its last focusable row takes the focus itself – ringed like a field */
.ui-sg-card[tabindex="-1"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: var(--card-shadow); }

/* Narrow: each control goes under its label, full width */
@container ui-as-main (max-width: 600px) {
  .ui-sg-row, .ui-sg-confirm { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px 14px; }
  .ui-sg-input, .ui-sg-url { width: 100%; }
  .ui-sg-danger { justify-content: center; }
  .ui-sg-confirm .ui-sg-control > * { flex: 1; justify-content: center; }
}
`;
