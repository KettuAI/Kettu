// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

/*
 * Settings / Profile – the personal profile page of an app's settings, in a single file.
 * A settings sidebar (‹ Settings, search, Personal and Workspace), then the page: a note that the profile applies to
 * every workspace, a card of rows – picture, first and last name, role, email – and sections for time preferences,
 * personal context for the assistant and the password. Every field works; changes save on their own and answer
 * with a short toast.
 * Sits in the affectUI App Shell; Button from the library, icons from the Hugeicons free set.
 */

import { useRef, useState, type ChangeEvent } from "react";
import {
  ArrowDown01Icon,
  Briefcase01Icon,
  Calendar03Icon,
  ChartIncreaseIcon,
  CodeIcon,
  Globe02Icon,
  Megaphone01Icon,
  PackageIcon,
  PaintBoardIcon,
  Settings02Icon,
  Cancel01Icon,
  CreditCardIcon,
  Notification01Icon,
  InformationCircleIcon,
  Settings01Icon,
  Shield01Icon,
  SlidersHorizontalIcon,
  Upload04Icon,
  UserIcon,
  UserMultiple02Icon,
  CpuIcon,
  SquareLock02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Button } from "./button";
import { AppShell, Dropdown, Icon, useToast, type AppShellProps, type ShellGroup } from "./app-shell";

/* ---------- Sample content – replace with your own data ---------- */

/** The settings sidebar: personal pages first, then the workspace's */
export const settingsGroups: ShellGroup[] = [
  {
    label: "Personal",
    items: [
      { label: "Profile", icon: UserIcon },
      { label: "Preferences", icon: SlidersHorizontalIcon },
      { label: "Notifications", icon: Notification01Icon },
      { label: "Privacy", icon: Shield01Icon },
    ],
  },
  {
    label: "Workspace",
    items: [
      { label: "General", icon: Settings01Icon },
      { label: "Members", icon: UserMultiple02Icon },
      { label: "Models", icon: CpuIcon },
      { label: "Security", icon: SquareLock02Icon },
      { label: "Billing", icon: CreditCardIcon },
    ],
  },
];

const roles = ["Engineering", "Design", "Product", "Marketing", "Sales", "Operations", "Other"];
// Every menu item gets an icon – one per role, a globe for time zones, a calendar for the week
const roleIcons: Record<string, IconSvgElement> = {
  Engineering: CodeIcon,
  Design: PaintBoardIcon,
  Product: PackageIcon,
  Marketing: Megaphone01Icon,
  Sales: ChartIncreaseIcon,
  Operations: Settings02Icon,
  Other: Briefcase01Icon,
};
const timezones = ["Europe/Vienna", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];
const weekStarts = ["Monday", "Sunday", "Saturday"];
const CONTEXT_MAX = 500;

export type ProfileValues = {
  firstName: string;
  lastName: string;
  email: string;
  role?: string;
  timezone: string;
  weekStart: string;
  context: string;
  /** An image URL; without one the initials show */
  avatar?: string;
  hasPassword?: boolean;
};

const sample: ProfileValues = {
  firstName: "Alex",
  lastName: "Morgan",
  email: "alex@acme.com",
  timezone: "Europe/Vienna",
  weekStart: "Monday",
  context: "",
  hasPassword: false,
};

export type SettingsProfileScreenProps = Pick<AppShellProps, "onNavigate" | "workspace" | "className"> & {
  /** The person's profile – the sample profile when left out */
  profile?: ProfileValues;
  /** Called with the whole profile whenever something is saved */
  onSave?: (profile: ProfileValues) => void;
};

/** The first letters of first and last name, as people see them */
const initials = (first: string, last: string) =>
  [first, last]
    .map((part) => Array.from(part.trim())[0] ?? "")
    .join("")
    .toUpperCase();

export function SettingsProfileScreen({ profile = sample, onSave, ...props }: SettingsProfileScreenProps) {
  const [values, setValues] = useState(profile);
  const saved = useRef(profile);
  const [toast, showToast] = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadBtn = useRef<HTMLButtonElement>(null);

  const set = <K extends keyof ProfileValues>(key: K, value: ProfileValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  // Saves what changed – on blur for text, at once for choices
  const commit = (next: ProfileValues = values, note = "Profile updated") => {
    if (JSON.stringify(next) === JSON.stringify(saved.current)) return;
    saved.current = next;
    onSave?.(next);
    showToast(note);
  };
  const choose = <K extends keyof ProfileValues>(key: K, value: ProfileValues[K]) => {
    const next = { ...values, [key]: value };
    setValues(next);
    commit(next);
  };

  const pickImage = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return showToast("Pick an image under 10 MB");
    choose("avatar", URL.createObjectURL(file));
  };

  const name = `${values.firstName} ${values.lastName}`.trim();

  return (
    <AppShell
      active="Profile"
      nav={[]}
      groups={settingsGroups}
      back={{ title: "Settings" }}
      user={{ name: name || "You", avatar: values.avatar }}
      {...props}
    >
      <style href="ui-settings-profile" precedence="default">
        {css}
      </style>
      <div className="ui-as-page ui-sp">
        <h1 className="ui-as-page-title">Profile</h1>
        <p className="ui-as-page-sub">
          Manage your personal details. <a href="#learn-more">Learn more</a>
        </p>

        <p className="ui-sp-note">
          <Icon icon={InformationCircleIcon} size={15} />
          Changes to your profile apply to all of your workspaces.
        </p>

        {/* The person: picture, name, role, email */}
        <section className="ui-sp-card" aria-label="Profile">
          <div className="ui-sp-row">
            <span className="ui-sp-label">
              <b>Profile picture</b>
              <small>PNG, JPEG or GIF, under 10 MB</small>
            </span>
            <span className="ui-sp-control">
              <span className="ui-sp-avatar">
                {values.avatar ? <img src={values.avatar} alt="" /> : <span aria-hidden="true">{initials(values.firstName, values.lastName) || "?"}</span>}
                {values.avatar && (
                  <button
                    type="button"
                    className="ui-sp-avatar__remove"
                    aria-label="Remove picture"
                    onClick={() => {
                      choose("avatar", undefined);
                      // The × goes with the picture – focus moves on to Upload
                      setTimeout(() => uploadBtn.current?.focus());
                    }}
                  >
                    <Icon icon={Cancel01Icon} size={10} />
                  </button>
                )}
              </span>
              <Button ref={uploadBtn} size="sm" variant="secondary" icon={<Icon icon={Upload04Icon} size={15} />} onClick={() => fileInput.current?.click()}>
                {values.avatar ? "Replace" : "Upload"}
              </Button>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif" hidden onChange={pickImage} />
            </span>
          </div>

          <label className="ui-sp-row">
            <span className="ui-sp-label">
              <b>First name</b>
            </span>
            <input className="ui-sp-input" value={values.firstName} autoComplete="given-name" onChange={(e) => set("firstName", e.target.value)} onBlur={() => commit()} />
          </label>

          <label className="ui-sp-row">
            <span className="ui-sp-label">
              <b>Last name</b>
            </span>
            <input className="ui-sp-input" value={values.lastName} autoComplete="family-name" onChange={(e) => set("lastName", e.target.value)} onBlur={() => commit()} />
          </label>

          <div className="ui-sp-row">
            <span className="ui-sp-label">
              <b>Role</b>
              <small>Helps tailor suggestions to your work</small>
            </span>
            <Select label="Role" value={values.role} placeholder="Choose your role" options={roles} icon={(o) => roleIcons[o] ?? UserIcon} onChange={(v) => choose("role", v)} />
          </div>

          <div className="ui-sp-row">
            <span className="ui-sp-label">
              <b>Email</b>
            </span>
            <span className="ui-sp-control">
              <input className="ui-sp-input ui-sp-input--quiet" value={values.email} readOnly aria-label="Email" title={values.email} />
              <Button size="sm" variant="secondary" onClick={() => showToast(`We sent a link to change it to ${values.email}`)}>
                Change
              </Button>
            </span>
          </div>
        </section>

        {/* When the person works */}
        <header className="ui-sp-head">
          <h2>Time preferences</h2>
          <p>Used for reminders, schedules and reports.</p>
        </header>
        <section className="ui-sp-card" aria-label="Time preferences">
          <div className="ui-sp-row">
            <span className="ui-sp-label">
              <b>Timezone</b>
            </span>
            <Select label="Timezone" value={values.timezone} options={timezones} icon={() => Globe02Icon} onChange={(v) => choose("timezone", v)} />
          </div>
          <div className="ui-sp-row">
            <span className="ui-sp-label">
              <b>Start week on</b>
            </span>
            <Select label="Start week on" value={values.weekStart} options={weekStarts} icon={() => Calendar03Icon} onChange={(v) => choose("weekStart", v)} />
          </div>
        </section>

        {/* What the assistant should know */}
        <header className="ui-sp-head">
          <h2>Personal context</h2>
          <p>Describe what you do and how you work, so the assistant can adapt to you.</p>
        </header>
        <section className="ui-sp-card ui-sp-card--pad" aria-label="Personal context">
          <textarea
            className="ui-sp-textarea"
            rows={4}
            maxLength={CONTEXT_MAX}
            value={values.context}
            placeholder="E.g. I lead product at a small team, prefer short answers and write in British English."
            aria-label="Personal context"
            onChange={(e) => set("context", e.target.value)}
            onBlur={() => commit(values, "Context saved")}
          />
          <span className="ui-sp-count">
            {values.context.length}/{CONTEXT_MAX}
          </span>
        </section>

        {/* Signing in */}
        <section className="ui-sp-card ui-sp-card--alone" aria-label="Password">
          <div className="ui-sp-row">
            <span className="ui-sp-label">
              <b>Password</b>
              <small>{values.hasPassword ? "Last changed 3 months ago" : "You sign in with a link sent to your email"}</small>
            </span>
            <Button size="sm" variant="secondary" onClick={() => showToast(`Check ${values.email} to ${values.hasPassword ? "change" : "set"} your password`)}>
              {values.hasPassword ? "Change password" : "Add password"}
            </Button>
          </div>
        </section>
      </div>
      {toast}
    </AppShell>
  );
}

/** A select in the shell's style: the value and a chevron, the options in the shell's menu */
function Select({
  label,
  value,
  placeholder,
  options,
  icon,
  onChange,
}: {
  label: string;
  value?: string;
  placeholder?: string;
  options: string[];
  icon: (option: string) => IconSvgElement;
  onChange: (value: string) => void;
}) {
  return (
    <Dropdown
      align="end"
      items={options.map((o) => ({ label: o, icon: icon(o), checked: o === value, onSelect: () => onChange(o) }))}
      trigger={({ open, toggle }) => (
        <button type="button" className="ui-sp-select" aria-label={label} title={value} aria-expanded={open} data-empty={value ? undefined : ""} onClick={toggle}>
          <span>{value ?? placeholder}</span>
          <Icon icon={ArrowDown01Icon} size={14} />
        </button>
      )}
    />
  );
}

/* ---------- Styles ---------- */

const css = /* css */ `
/* Settings / Profile – rows in cards, the label on the left and its control on the right */
.ui-sp { max-width: 760px; margin: 0 auto; }

/* A quiet note on the faint frame */
.ui-sp-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 24px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--frame);
  box-shadow: inset 0 0 0 0.5px var(--line);
  font-size: 13px;
  line-height: 20px;
  color: var(--text);
}
.ui-sp-note svg { flex: none; color: var(--muted); }

.ui-sp-head { margin-top: 36px; }
.ui-sp-head h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-sp-head p { margin: 2px 0 0; font-size: 13px; line-height: 20px; color: var(--muted); }

.ui-sp-card { position: relative; margin-top: 12px; border-radius: 12px; background: var(--card); box-shadow: var(--card-shadow); }
.ui-sp-note + .ui-sp-card { margin-top: 16px; }
.ui-sp-card--alone { margin-top: 24px; }
.ui-sp-card--pad { padding: 4px; }

.ui-sp-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 60px; padding: 10px 12px 10px 16px; }
.ui-sp-row + .ui-sp-row { box-shadow: inset 0 0.5px 0 var(--line); }
.ui-sp-label { display: grid; min-width: 0; }
.ui-sp-label b { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-sp-label b, .ui-sp-label small { overflow-wrap: anywhere; }
.ui-sp-label small { overflow: hidden; font-size: 12px; line-height: 16px; color: var(--muted); text-overflow: ellipsis; }
.ui-sp-control { display: flex; flex: none; align-items: center; gap: 8px; min-width: 0; }
.ui-sp-row > :is(.ui-buttonc, .ui-as-anchor), .ui-sp-control > .ui-buttonc { flex: none; }

/* Fields: white, a hairline, 32px – the focus ring in the accent's tint */
.ui-sp-input, .ui-sp-select {
  box-sizing: border-box;
  width: 240px;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--card);
  box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 1px 1px rgba(0, 0, 0, 0.03);
  font: inherit;
  font-size: 13px;
  color: var(--ink);
  outline: none;
  transition: box-shadow 140ms ease;
}
.ui-sp-input:focus, .ui-sp-select:focus-visible, .ui-sp-select[aria-expanded="true"] { outline: none; box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 0 0 3px var(--accent-soft); }
.ui-sp-input--quiet { width: 200px; background: var(--frame); color: var(--text); text-overflow: ellipsis; }
.ui-sp-select { display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; cursor: pointer; }
.ui-sp-select span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-sp-select[data-empty] span { color: var(--placeholder); }
.ui-sp-select svg { flex: none; color: var(--faint); }
.ui-sp-row .ui-as-menu { min-width: 240px; }

/* The picture: initials until there is one; a small × to remove it */
.ui-sp-avatar { position: relative; display: grid; flex: none; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--accent-soft); font-size: 13px; font-weight: 500; color: var(--accent); }
.ui-sp-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
.ui-sp-avatar__remove { position: absolute; top: -3px; right: -3px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--card); box-shadow: var(--card-shadow); color: var(--muted); }
.ui-sp-avatar__remove:hover { color: var(--ink); }
/* A 32px target around the small × */
.ui-sp-avatar__remove::before { content: ""; position: absolute; inset: -7px; }
.ui-sp-avatar__remove:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: var(--card-shadow); color: var(--ink); }

.ui-sp-textarea { display: block; box-sizing: border-box; width: 100%; min-height: 96px; padding: 10px 12px 22px; border: 0; border-radius: 9px; background: none; font: inherit; font-size: 13px; line-height: 20px; color: var(--ink); resize: vertical; outline: none; }
.ui-sp-textarea::placeholder { color: var(--placeholder); }
.ui-sp-card--pad:focus-within { box-shadow: var(--card-shadow), 0 0 0 3px var(--accent-soft); }
.ui-sp-count { position: absolute; right: 14px; bottom: 10px; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--faint); pointer-events: none; }

/* Narrow: each control goes under its label, full width */
@container ui-as-main (max-width: 600px) {
  .ui-sp-row { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px 14px; }
  .ui-sp-input, .ui-sp-select { width: 100%; }
  .ui-sp-control { flex: 1; }
  .ui-sp-control .ui-sp-input { flex: 1; width: auto; min-width: 0; }
  .ui-sp-row > .ui-as-anchor { display: flex; }
  .ui-sp-row > .ui-as-anchor > .ui-sp-select { flex: 1; }
}
`;
