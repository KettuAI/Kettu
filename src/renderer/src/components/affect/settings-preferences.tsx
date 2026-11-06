// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

/*
 * Settings / Preferences – how the assistant works for one person, in a single file.
 * The settings sidebar, then the page: their own default models (Auto explains itself next to the Model Wheel,
 * any other model gets a nudge back to Auto), language and appearance, the chat's extra tools, custom
 * instructions the model reads with every message, and the memories it has kept.
 * Every control works; changes save on their own and answer with a short toast.
 * Sits in the affectUI App Shell; Button and Segmented Control from the library, icons from the Hugeicons free set.
 */

import { useMemo, useRef, useState } from "react";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  ComputerIcon,
  GlobalSearchIcon,
  Image01Icon,
  InformationCircleIcon,
  MaximizeScreenIcon,
  MinimizeScreenIcon,
  Moon02Icon,
  SparklesIcon,
  Brain01Icon,
  Sun03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { Button } from "./button";
import { SegmentedControl } from "./segmented-control";
import { AppShell, Dropdown, Flag, Icon, useToast, type AppShellProps } from "./app-shell";
import { settingsGroups } from "./settings-profile";
import { css as generalCss } from "./settings-general";
import { css as securityCss, refocusAfterRemove, useFocusBack } from "./settings-security";
import { AutoExplainer, ModelPick, css as modelsCss, providerSample, type Provider } from "./settings-models";

/* ---------- Sample content – replace with your own data ---------- */

export type Theme = "system" | "light" | "dark";
export type ChatTool = "web" | "images" | "memory";
export type Memory = { id: string; text: string; saved: string };

export type PreferenceValues = {
  /** Model id, or "auto" */
  chatModel: string;
  imageModel: string;
  language: string;
  theme: Theme;
  findActions: boolean;
  tools: ChatTool[];
  instructionsOn: boolean;
  about: string;
  style: string;
  memories: Memory[];
};

const sample: PreferenceValues = {
  chatModel: "claude-sonnet",
  imageModel: "gpt-image",
  language: "English",
  theme: "system",
  findActions: false,
  tools: ["web", "images"],
  instructionsOn: true,
  about: "I lead product design at Acme, a 40-person B2B SaaS company. I mostly ask about UX copy, research synthesis and planning.",
  style: "",
  memories: [
    { id: "m1", text: "Prefers answers in English, but German examples for customer-facing copy", saved: "2 days ago" },
    { id: "m2", text: "Works in Figma and Linear; the team ships every second Thursday", saved: "last week" },
    { id: "m3", text: "Likes short bullet points over long paragraphs", saved: "3 weeks ago" },
  ],
};

const languages: { label: string; flag: "gb" | "de" | "fr" | "es" }[] = [
  { label: "English", flag: "gb" },
  { label: "Deutsch", flag: "de" },
  { label: "Français", flag: "fr" },
  { label: "Español", flag: "es" },
];
const tools: { id: ChatTool; label: string; note: string; icon: IconSvgElement }[] = [
  { id: "web", label: "Web search", note: "Looks things up when it needs fresh facts", icon: GlobalSearchIcon },
  { id: "images", label: "Image generation", note: "Draws pictures when you ask for one", icon: Image01Icon },
  { id: "memory", label: "Memory", note: "Remembers things you tell it across chats", icon: Brain01Icon },
];
const INSTRUCTIONS_MAX = 1500;

export type SettingsPreferencesScreenProps = Pick<AppShellProps, "onNavigate" | "user" | "workspace" | "className"> & {
  /** The settings – the sample person when left out */
  preferences?: PreferenceValues;
  /** The workspace's providers and models – Settings / Models' sample when left out */
  providers?: Provider[];
  /** Called with all settings whenever something is saved */
  onSave?: (preferences: PreferenceValues) => void;
};

export function SettingsPreferencesScreen({ preferences = sample, providers = providerSample, onSave, ...props }: SettingsPreferencesScreenProps) {
  const [values, setValues] = useState(preferences);
  const [savedText, setSavedText] = useState({ about: preferences.about, style: preferences.style });
  const [wide, setWide] = useState<"about" | "style" | null>(null);
  const [toast, showToast] = useToast();
  // Clearing every memory asks once more; the button that asked gets the focus back
  const [clearing, setClearing] = useState(false);
  const focusBack = useFocusBack(clearing && "clear");
  const memoryList = useRef<HTMLElement>(null);

  const update = (patch: Partial<PreferenceValues>, note?: string) => {
    const next = { ...values, ...patch };
    setValues(next);
    onSave?.(next);
    if (note) showToast(note);
  };
  // Only the models the workspace has turned on
  const all = useMemo(() => providers.flatMap((p) => p.models.filter((m) => m.on).map((m) => ({ ...m, provider: p }))), [providers]);
  const chatModels = useMemo(() => all.filter((m) => m.kind === "chat"), [all]);
  const imageModels = all.filter((m) => m.kind === "image");
  const name = (id: string) => all.find((m) => m.id === id)?.name ?? id;
  const lang = languages.find((l) => l.label === values.language) ?? languages[0];

  const saveText = (key: "about" | "style") => {
    if (values[key] === savedText[key]) return;
    setSavedText((s) => ({ ...s, [key]: values[key] }));
    update({}, "Instructions saved");
  };
  const toggleTool = (id: ChatTool) => {
    const on = !values.tools.includes(id);
    const label = tools.find((t) => t.id === id)?.label;
    update({ tools: on ? [...values.tools, id] : values.tools.filter((t) => t !== id) }, `${label} ${on ? "on" : "off"}`);
  };

  return (
    <AppShell active="Preferences" nav={[]} groups={settingsGroups} back={{ title: "Settings" }} {...props}>
      <style href="ui-settings-general" precedence="default">
        {generalCss}
      </style>
      <style href="ui-settings-security" precedence="default">
        {securityCss}
      </style>
      <style href="ui-settings-models" precedence="default">
        {modelsCss}
      </style>
      <style href="ui-settings-preferences" precedence="default">
        {css}
      </style>
      <div className="ui-as-page ui-sg ui-ss ui-sm ui-spf">
        <h1 className="ui-as-page-title">Preferences</h1>
        <p className="ui-as-page-sub">Make the assistant work the way you do.</p>

        {/* Models */}
        <header className="ui-sg-head">
          <h2>Models</h2>
        </header>
        <section className="ui-sg-card" aria-label="Models">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Default model</b>
              <small>Picked whenever you start a new chat</small>
            </span>
            <ModelPick
              label="Default model"
              value={values.chatModel}
              options={[{ id: "auto", name: "Auto", icon: SparklesIcon }, ...chatModels.map((m) => ({ id: m.id, name: m.name, logo: m.provider.logo }))]}
              onChange={(id) => update({ chatModel: id }, `New chats use ${id === "auto" ? "Auto" : name(id)}`)}
            />
          </div>
          {values.chatModel === "auto" ? (
            <AutoExplainer models={chatModels} />
          ) : (
            // A nudge back to Auto while another model is the default
            <div className="ui-spf-nudge ui-ss-rise">
              <span className="ui-spf-nudge__mark" aria-hidden="true">
                <Icon icon={SparklesIcon} size={16} />
              </span>
              <span className="ui-sg-label">
                <b>Get more out of your plan with Auto</b>
                <small>It picks the right model for each message, so quick questions don't use up your credits.</small>
              </span>
              <Button size="sm" onClick={() => update({ chatModel: "auto" }, "New chats use Auto")}>
                Switch to Auto
              </Button>
            </div>
          )}
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Image model</b>
              <small>Used when you ask for a picture</small>
            </span>
            <ModelPick
              label="Image model"
              value={values.imageModel}
              empty="None turned on"
              options={imageModels.map((m) => ({ id: m.id, name: m.name, logo: m.provider.logo }))}
              onChange={(id) => update({ imageModel: id }, `Pictures use ${name(id)}`)}
            />
          </div>
        </section>

        {/* Language and appearance */}
        <section className="ui-sg-card ui-spf-gap" aria-label="Language and appearance">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Language</b>
              <small>For menus and the assistant's answers</small>
            </span>
            <Dropdown
              align="end"
              items={languages.map((l) => ({ label: l.label, logo: <Flag code={l.flag} />, checked: l.label === values.language, onSelect: () => update({ language: l.label }, `Language: ${l.label}`) }))}
              trigger={({ open, toggle }) => (
                <button type="button" className="ui-ss-select ui-spf-lang" aria-label="Language" aria-expanded={open} onClick={toggle}>
                  <Flag code={lang.flag} />
                  <span>{lang.label}</span>
                  <Icon icon={ArrowDown01Icon} size={14} />
                </button>
              )}
            />
          </div>
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Appearance</b>
              <small>System follows your device</small>
            </span>
            <SegmentedControl
              size="sm"
              variant="tray"
              aria-label="Appearance"
              value={values.theme}
              onChange={(theme) => update({ theme }, theme === "system" ? "Following your system" : `${theme === "light" ? "Light" : "Dark"} mode`)}
              options={[
                { value: "system", label: "System", icon: <Icon icon={ComputerIcon} size={14} /> },
                { value: "light", label: "Light", icon: <Icon icon={Sun03Icon} size={14} /> },
                { value: "dark", label: "Dark", icon: <Icon icon={Moon02Icon} size={14} /> },
              ]}
            />
          </div>
        </section>
        <section className="ui-sg-card ui-spf-gap" aria-label="App actions">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>
                Find app actions on its own <span className="ui-ss-badge ui-spf-beta">Beta</span>
              </b>
              <small>The chat can use connected apps without you tagging them first</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={values.findActions}
              aria-label="Find app actions on its own"
              className="ui-ss-switch"
              onClick={() => update({ findActions: !values.findActions }, values.findActions ? "App actions only when tagged" : "App actions found on their own")}
            />
          </div>
        </section>

        {/* Chat tools */}
        <header className="ui-sg-head">
          <h2>Chat tools</h2>
          <p>Extra tools for your own chats. Agents bring their own.</p>
        </header>
        <div className="ui-spf-tools" role="group" aria-label="Chat tools">
          {tools.map((t) => {
            const on = values.tools.includes(t.id);
            return (
              <button key={t.id} type="button" role="checkbox" aria-checked={on} className="ui-spf-tool" onClick={() => toggleTool(t.id)}>
                <span className="ui-spf-tool__top">
                  <Icon icon={t.icon} size={16} />
                  <span className="ui-spf-check" aria-hidden="true">
                    {on && <Icon icon={Tick02Icon} size={11} />}
                  </span>
                </span>
                <b>{t.label}</b>
                <small>{t.note}</small>
              </button>
            );
          })}
        </div>

        {/* Custom instructions */}
        <header className="ui-sg-head">
          <h2>Custom instructions</h2>
          <p>Added to every message you send, so you don't have to repeat yourself.</p>
        </header>
        <section className="ui-sg-card" aria-label="Custom instructions">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Use my instructions</b>
              <small>Turn them off for a while without losing them</small>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={values.instructionsOn}
              aria-label="Use my instructions"
              className="ui-ss-switch"
              onClick={() => update({ instructionsOn: !values.instructionsOn }, values.instructionsOn ? "Instructions paused" : "Instructions on")}
            />
          </div>
          <div className="ui-spf-fields" data-off={!values.instructionsOn || undefined}>
            {(
              [
                { key: "about", label: "About you", placeholder: "What should the model know about you to answer better?" },
                { key: "style", label: "How it should answer", placeholder: "E.g. Short and direct. Bullet points for lists. Say when you're unsure." },
              ] as const
            ).map((f) => (
              <label key={f.key} className="ui-spf-field">
                <span>{f.label}</span>
                <span className="ui-spf-area">
                  <textarea
                    className="ui-sg-textarea"
                    data-wide={wide === f.key || undefined}
                    value={values[f.key]}
                    maxLength={INSTRUCTIONS_MAX}
                    placeholder={f.placeholder}
                    disabled={!values.instructionsOn}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    onBlur={() => saveText(f.key)}
                  />
                  <span className="ui-sg-tools">
                    <span className="ui-sg-count">
                      {values[f.key].length}/{INSTRUCTIONS_MAX}
                    </span>
                    <button
                      type="button"
                      className="ui-as-icon-btn"
                      aria-label={wide === f.key ? "Smaller field" : "Bigger field"}
                      disabled={!values.instructionsOn}
                      onClick={(e) => {
                        e.preventDefault();
                        setWide((w) => (w === f.key ? null : f.key));
                      }}
                    >
                      <Icon icon={wide === f.key ? MinimizeScreenIcon : MaximizeScreenIcon} size={14} />
                    </button>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* Memory */}
        <header className="ui-sg-head ui-ss-head">
          <span>
            <h2>Memory</h2>
            <p>What the assistant has kept from your chats. Only you can see it.</p>
          </span>
          {values.memories.length > 0 &&
            (clearing ? (
              <span className="ui-sg-control ui-ss-rise" onKeyDown={(e) => e.key === "Escape" && setClearing(false)}>
                <Button size="sm" variant="secondary" onClick={() => setClearing(false)}>
                  Cancel
                </Button>
                <button
                  type="button"
                  className="ui-sg-danger ui-sg-danger--solid"
                  autoFocus
                  onClick={() => {
                    refocusAfterRemove(memoryList.current?.querySelector(".ui-ss-remove"));
                    setClearing(false);
                    update({ memories: [] }, "Memory cleared");
                  }}
                >
                  Forget everything
                </button>
              </span>
            ) : (
              <Button ref={focusBack("clear")} size="sm" variant="secondary" onClick={() => setClearing(true)}>
                Clear all
              </Button>
            ))}
        </header>
        {!values.tools.includes("memory") && (
          <p className="ui-spf-note">
            <Icon icon={InformationCircleIcon} size={15} />
            <span>Memory is off, so nothing new is kept. Turn it on under Chat tools.</span>
          </p>
        )}
        <section ref={memoryList} className="ui-sg-card" aria-label="Memories">
          {values.memories.map((m) => (
            <div key={m.id} className="ui-sg-row ui-ss-domain ui-spf-memory">
              <span className="ui-sg-label">
                <b>{m.text}</b>
                <small>Saved {m.saved}</small>
              </span>
              <button
                type="button"
                className="ui-as-icon-btn ui-ss-remove"
                aria-label={`Forget: ${m.text}`}
                onClick={(e) => {
                  refocusAfterRemove(e.currentTarget);
                  update({ memories: values.memories.filter((x) => x.id !== m.id) }, "Forgotten");
                }}
              >
                <Icon icon={Cancel01Icon} size={14} />
              </button>
            </div>
          ))}
          {values.memories.length === 0 && <p className="ui-ss-empty ui-spf-empty">No memories yet – they show up here as you chat</p>}
        </section>
      </div>
      {toast}
    </AppShell>
  );
}

/* ---------- Styles ---------- */

// Builds on the rows of Settings / General, the switches of Settings / Security and the pickers of Settings / Models
export const css = /* css */ `
.ui-spf-gap { margin-top: 12px; }
.ui-spf .ui-sg-label b { display: flex; align-items: center; gap: 6px; }
.ui-spf-beta { font-size: 11px; line-height: 16px; }

/* The nudge back to Auto: a gray block inside the card */
.ui-spf-nudge { display: flex; align-items: center; gap: 14px; margin: 0 12px 12px 16px; padding: 14px 14px 14px 16px; border-radius: 10px; background: var(--frame); }
.ui-spf-nudge .ui-sg-label { flex: 1; }
.ui-spf-nudge__mark { display: grid; flex: none; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--card); box-shadow: var(--card-shadow); color: var(--strong); }
.ui-spf-nudge + .ui-sg-row { box-shadow: inset 0 0.5px 0 var(--line); }

.ui-spf-lang { width: 160px; justify-content: flex-start; gap: 8px; }
.ui-spf-lang > span { flex: 1; }
.ui-spf-lang .ui-as-flag { flex: none; }

/* Chat tools: three tiles that check on and off */
.ui-spf-tools { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.ui-spf-tool { display: grid; gap: 2px; padding: 12px 14px 14px; border-radius: 12px; background: var(--card); box-shadow: var(--card-shadow); text-align: left; color: var(--muted); transition: box-shadow 160ms ease; }
.ui-spf-tool:hover { box-shadow: var(--card-shadow-hover, var(--card-shadow)); }
.ui-spf-tool:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: var(--card-shadow); }
.ui-spf-tool__top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.ui-spf-tool b { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-spf-tool small { font-size: 12px; line-height: 16px; }
.ui-spf-check { display: grid; place-items: center; width: 16px; height: 16px; border-radius: 5px; box-shadow: inset 0 0 0 1px var(--line-strong); color: #fff; transition: background-color 160ms ease, box-shadow 160ms ease; }
.ui-spf-tool[aria-checked="true"] .ui-spf-check { background: var(--switch-on); box-shadow: none; }
.ui-spf-tool[aria-checked="true"] .ui-spf-tool__top > svg { color: var(--strong); }
:where(.dark, [data-theme="dark"]) .ui-spf-tool[aria-checked="true"] .ui-spf-check { color: #fff; }

/* Custom instructions: two writing fields under the switch; paused, they fade */
.ui-spf-fields { display: grid; gap: 14px; padding: 12px 12px 14px 16px; box-shadow: inset 0 0.5px 0 var(--line); transition: opacity 200ms ease; }
.ui-spf-fields[data-off] { opacity: 0.45; }
.ui-spf-field { display: grid; gap: 8px; }
.ui-spf-field > span:first-child { font-size: 12.5px; font-weight: 500; color: var(--muted); }
.ui-spf-area { position: relative; display: block; border-radius: 10px; background: var(--card); box-shadow: inset 0 0 0 0.5px var(--line-strong); transition: box-shadow 140ms ease; }
.ui-spf-area:focus-within { box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 0 0 3px var(--accent-soft); }
.ui-spf-area .ui-sg-textarea { min-height: 112px; }
.ui-spf-area .ui-sg-textarea[data-wide] { min-height: 300px; }

/* Memory */
.ui-spf-note { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--frame); font-size: 12.5px; line-height: 18px; color: var(--muted); }
.ui-spf-note svg { flex: none; margin-top: 1.5px; color: var(--faint); }
.ui-spf-memory .ui-sg-label b { display: block; font-weight: 400; color: var(--ink); }
.ui-spf-empty { text-align: center; }

@container ui-as-main (max-width: 600px) {
  .ui-spf-tools { grid-template-columns: 1fr; }
  /* The nudge: mark and text side by side, the button on its own line under the text */
  .ui-spf-nudge { flex-wrap: wrap; align-items: flex-start; margin: 0 14px 12px; }
  .ui-spf-nudge .ui-sg-label { flex: 1 1 calc(100% - 46px); }
  .ui-spf-nudge > .ui-buttonc { margin-left: 46px; }
  .ui-spf-lang { width: 100%; }
  .ui-spf-fields { padding: 12px 14px 14px; }
  .ui-spf-memory { flex-direction: row; align-items: center; }
}
`;
