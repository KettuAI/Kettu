// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

/*
 * Settings / Models – which AI models a workspace may use, in a single file.
 * The settings sidebar, then the page: the default models for chat and images (Auto explains itself next to the
 * Model Wheel turning through the models it can pick), every provider's models grouped by where they are hosted – each with a
 * switch and who may use it – a filter, a search and custom models, then the workspace's own API keys.
 * Every control works; changes save at once and answer with a short toast.
 * Sits in the affectUI App Shell; Button and Segmented Control from the library, icons from the Hugeicons free set.
 */

import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Add01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
  Globe02Icon,
  Key01Icon,
  Search01Icon,
  Shield01Icon,
  SparklesIcon,
  Tick02Icon,
  UserIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "./button";
import { SegmentedControl } from "./segmented-control";
import { AppShell, Dropdown, Icon, useToast, type AppShellProps } from "./app-shell";
import { settingsGroups } from "./settings-profile";
import { css as generalCss } from "./settings-general";
import { css as securityCss, refocusAfterRemove, useFocusBack } from "./settings-security";
import { ModelWheel, defaultModels } from "./model-wheel";

/* ---------- Provider marks ---------- */

const ClaudeLogo = () => (
  <svg viewBox="0 0 1200 1200" aria-hidden="true">
    <path fill="#D97757" d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z" />
  </svg>
);
const OpenAILogo = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ color: "#0d0d0d" }}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);
const GeminiLogo = () => {
  const id = "gm" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="24" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1C7DFF" />
          <stop offset="0.52" stopColor="#1C69FF" />
          <stop offset="1" stopColor="#B04DFF" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  );
};
const MistralLogo = () => {
  const rows: [number[], string][] = [
    [[0, 4], "#FFD800"],
    [[0, 1, 3, 4], "#FFAF00"],
    [[0, 1, 2, 3, 4], "#FF8205"],
    [[0, 2, 4], "#FA500F"],
    [[0, 4], "#E10500"],
  ];
  return (
    <svg viewBox="-2 -2 29 29" aria-hidden="true">
      {rows.flatMap(([cols, fill], y) => cols.map((x) => <rect key={`${x}-${y}`} x={x * 5} y={y * 5} width="5" height="5" fill={fill} />))}
    </svg>
  );
};
/** The EU's flag: twelve stars on blue */
const EuFlag = () => (
  <svg viewBox="0 0 20 14" aria-hidden="true" className="ui-sm-flag">
    <rect width="20" height="14" fill="#1c3f94" />
    {Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return <circle key={i} cx={10 + Math.sin(a) * 4.2} cy={7 - Math.cos(a) * 4.2} r="0.75" fill="#ffcc00" />;
    })}
  </svg>
);

/* ---------- Sample content – replace with your own data ---------- */

export type ModelKind = "chat" | "image";
export type Model = { id: string; name: string; kind: ModelKind; on: boolean; access: string; custom?: boolean };
export type Provider = { id: string; name: string; region: "eu" | "global" | "custom"; logo?: ReactNode; models: Model[] };
export type ApiKey = { provider: string; masked: string; added: string };

export const providerSample: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    region: "eu",
    logo: <ClaudeLogo />,
    models: [
      { id: "claude-opus", name: "Claude Opus 5.5", kind: "chat", on: true, access: "Everyone" },
      { id: "claude-sonnet", name: "Claude Sonnet 5.5", kind: "chat", on: true, access: "Everyone" },
      { id: "claude-haiku", name: "Claude Haiku 5.5", kind: "chat", on: true, access: "Everyone" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    region: "eu",
    logo: <OpenAILogo />,
    models: [
      { id: "gpt-6", name: "GPT-6", kind: "chat", on: true, access: "Everyone" },
      { id: "gpt-6-mini", name: "GPT-6 mini", kind: "chat", on: true, access: "Everyone" },
      { id: "gpt-5-6", name: "GPT-5.6", kind: "chat", on: false, access: "Everyone" },
      { id: "gpt-image", name: "GPT Image 2", kind: "image", on: true, access: "Everyone" },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    region: "eu",
    logo: <MistralLogo />,
    models: [
      { id: "mistral-large", name: "Mistral Large 3", kind: "chat", on: false, access: "Everyone" },
      { id: "mistral-medium", name: "Mistral Medium 3", kind: "chat", on: false, access: "Everyone" },
    ],
  },
  {
    id: "google",
    name: "Google",
    region: "global",
    logo: <GeminiLogo />,
    models: [
      { id: "gemini-pro", name: "Gemini 3 Pro", kind: "chat", on: true, access: "Engineering" },
      { id: "gemini-flash", name: "Gemini 3 Flash", kind: "chat", on: false, access: "Everyone" },
      { id: "imagen", name: "Imagen 5", kind: "image", on: false, access: "Everyone" },
    ],
  },
];

const accessOptions = [
  { label: "Everyone", icon: UserMultiple02Icon },
  { label: "Admins only", icon: Shield01Icon },
  { label: "Engineering", icon: UserIcon },
  { label: "Design", icon: UserIcon },
  { label: "Sales", icon: UserIcon },
];
/** Which Model Wheel mark stands for each provider */
const wheelMark: Record<string, string> = { anthropic: "Claude", openai: "ChatGPT", google: "Gemini", mistral: "Mistral" };
const regions = [
  { id: "eu", title: "Hosted in the EU", note: "Zero data retention, data stays in Frankfurt" },
  { id: "global", title: "Global", note: "Runs where the provider runs it, mostly in the US" },
  { id: "custom", title: "Your own", note: "Models on your own endpoints" },
] as const;
type Filter = "all" | "chat" | "image" | "custom";

export type SettingsModelsScreenProps = Pick<AppShellProps, "onNavigate" | "user" | "workspace" | "className"> & {
  /** Providers and their models – the sample list when left out */
  providers?: Provider[];
  /** Model id of the default chat model, or "auto" */
  defaultChat?: string;
  /** Model id of the default image model */
  defaultImage?: string;
  keys?: ApiKey[];
  /** Called with the whole state whenever something changes */
  onSave?: (state: { providers: Provider[]; defaultChat: string; defaultImage: string; keys: ApiKey[] }) => void;
};

// A key's provider from its prefix – enough to label it
const keyProvider = (key: string) => (/^sk-ant-/.test(key) ? "anthropic" : /^sk-/.test(key) ? "openai" : /^AIza/.test(key) ? "google" : /^[A-Za-z0-9]{32}$/.test(key) ? "mistral" : null);
const mask = (key: string) => `${key.slice(0, key.startsWith("sk-ant-") ? 7 : 3)}…${key.slice(-4)}`;
const URL_RE = /^https:\/\/[^\s/]+\.[^\s]+$/;

export function SettingsModelsScreen({ providers: initial = providerSample, defaultChat = "auto", defaultImage = "gpt-image", keys: initialKeys = [], onSave, ...props }: SettingsModelsScreenProps) {
  const [providers, setProviders] = useState(initial);
  const [chat, setChat] = useState(defaultChat);
  const [image, setImage] = useState(defaultImage);
  const [keys, setKeys] = useState(initialKeys);
  const [open, setOpen] = useState<Set<string>>(() => new Set([initial[0]?.id]));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<"model" | "key" | null>(null);
  const [draft, setDraft] = useState({ name: "", url: "", key: "" });
  const [toast, showToast] = useToast();
  const focusBack = useFocusBack(adding);
  const searchInput = useRef<HTMLInputElement>(null);

  const save = (patch: Partial<{ providers: Provider[]; defaultChat: string; defaultImage: string; keys: ApiKey[] }>, note?: string) => {
    onSave?.({ providers, defaultChat: chat, defaultImage: image, keys, ...patch });
    if (note) showToast(note);
  };
  const all = providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p })));
  const find = (id: string) => all.find((m) => m.id === id);

  const setModel = (id: string, patch: Partial<Model>, note?: string) => {
    const next = providers.map((p) => ({ ...p, models: p.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
    setProviders(next);
    // A default that gets switched off falls back – to Auto for chat, to the first image model left
    let nextChat = chat;
    let nextImage = image;
    if (patch.on === false && id === chat) nextChat = "auto";
    if (patch.on === false && id === image) nextImage = next.flatMap((p) => p.models).find((m) => m.kind === "image" && m.on)?.id ?? "";
    setChat(nextChat);
    setImage(nextImage);
    const fell = nextChat !== chat ? " – default chat is Auto again" : nextImage !== image ? " – default image model changed" : "";
    save({ providers: next, defaultChat: nextChat, defaultImage: nextImage }, note && note + fell);
  };

  const q = query.trim().toLowerCase();
  const matches = (m: Model, p: Provider) =>
    (filter === "all" || (filter === "custom" ? m.custom : m.kind === filter && !m.custom)) && (!q || m.name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  const toggleOpen = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const closeAdd = () => {
    setAdding(null);
    setDraft({ name: "", url: "", key: "" });
  };
  const addModel = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) return showToast("Give the model a name");
    if (!URL_RE.test(draft.url.trim())) return showToast("Enter an https:// endpoint");
    const model: Model = { id: `custom-${Date.now()}`, name, kind: "chat", on: true, access: "Admins only", custom: true };
    const existing = providers.find((p) => p.region === "custom");
    const next = existing
      ? providers.map((p) => (p === existing ? { ...p, models: [...p.models, model] } : p))
      : [...providers, { id: "custom", name: "Custom endpoints", region: "custom" as const, models: [model] }];
    setProviders(next);
    setOpen((s) => new Set(s).add("custom"));
    if (filter !== "all" && filter !== "custom") setFilter("all");
    save({ providers: next }, `${name} added – admins can use it`);
    closeAdd();
  };
  const addKey = (e: FormEvent) => {
    e.preventDefault();
    const key = draft.key.trim();
    const provider = keyProvider(key);
    if (!provider) return showToast("That doesn't look like an Anthropic, OpenAI, Google or Mistral key");
    const next = [...keys.filter((k) => k.provider !== provider), { provider, masked: mask(key), added: "Just now" }];
    setKeys(next);
    save({ keys: next }, `${providers.find((p) => p.id === provider)?.name ?? "Provider"} key saved`);
    closeAdd();
  };

  const chatModels = all.filter((m) => m.kind === "chat" && m.on);
  const imageModels = all.filter((m) => m.kind === "image" && m.on);
  const visible = providers.map((p) => ({ p, models: p.models.filter((m) => matches(m, p)) })).filter((g) => g.models.length > 0);

  return (
    <AppShell active="Models" nav={[]} groups={settingsGroups} back={{ title: "Settings" }} {...props}>
      <style href="ui-settings-general" precedence="default">
        {generalCss}
      </style>
      <style href="ui-settings-security" precedence="default">
        {securityCss}
      </style>
      <style href="ui-settings-models" precedence="default">
        {css}
      </style>
      <div className="ui-as-page ui-sg ui-ss ui-sm">
        <h1 className="ui-as-page-title">Models</h1>
        <p className="ui-as-page-sub">Choose the models people in your workspace can use.</p>

        {/* Defaults */}
        <header className="ui-sg-head">
          <h2>Defaults</h2>
        </header>
        <section className="ui-sg-card" aria-label="Defaults">
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Chat model</b>
              <small>Every new chat starts with it. People can pick their own in their preferences.</small>
            </span>
            <ModelPick
              label="Default chat model"
              value={chat}
              options={[{ id: "auto", name: "Auto", icon: SparklesIcon }, ...chatModels.map((m) => ({ id: m.id, name: m.name, logo: m.provider.logo }))]}
              onChange={(id) => {
                setChat(id);
                save({ defaultChat: id }, `New chats use ${id === "auto" ? "Auto" : find(id)?.name}`);
              }}
            />
          </div>
          {chat === "auto" && <AutoExplainer models={chatModels} />}
          <div className="ui-sg-row">
            <span className="ui-sg-label">
              <b>Image model</b>
              <small>Used when someone asks for a picture</small>
            </span>
            <ModelPick
              label="Default image model"
              value={image}
              empty="No image model on"
              options={imageModels.map((m) => ({ id: m.id, name: m.name, logo: m.provider.logo }))}
              onChange={(id) => {
                setImage(id);
                save({ defaultImage: id }, `Pictures use ${find(id)?.name}`);
              }}
            />
          </div>
        </section>

        {/* The models: filter, search, add */}
        <div className="ui-sm-bar">
          <SegmentedControl
            size="sm"
            variant="tray"
            aria-label="Filter models"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "chat", label: "Chat" },
              { value: "image", label: "Image" },
              { value: "custom", label: "Custom" },
            ]}
          />
          <label className="ui-sm-search">
            <Icon icon={Search01Icon} size={15} />
            <input ref={searchInput} value={query} placeholder="Search models…" aria-label="Search models" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  searchInput.current?.focus();
                }}
              >
                <Icon icon={Cancel01Icon} size={12} />
              </button>
            )}
          </label>
          <Button ref={focusBack("model")} size="sm" variant="secondary" icon={<Icon icon={Add01Icon} size={15} />} aria-expanded={adding === "model"} onClick={() => setAdding((a) => (a === "model" ? null : "model"))}>
            Custom model
          </Button>
        </div>

        {adding === "model" && (
          <form className="ui-sg-card ui-sm-form ui-ss-rise" onSubmit={addModel} onKeyDown={(e) => e.key === "Escape" && closeAdd()}>
            <b>Add a custom model</b>
            <span>Any endpoint that speaks the OpenAI chat format works. Only admins can use it until you share it.</span>
            <div className="ui-sm-form__fields">
              <input className="ui-sg-input" value={draft.name} placeholder="Name, e.g. Acme Llama" aria-label="Model name" autoFocus onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              <input className="ui-sg-input" value={draft.url} placeholder="https://llm.acme.com/v1" aria-label="Endpoint" spellCheck={false} onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))} />
              <span className="ui-sg-control">
                <Button size="sm" variant="secondary" type="button" onClick={closeAdd}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" disabled={!draft.name.trim() || !draft.url.trim()}>
                  Add model
                </Button>
              </span>
            </div>
          </form>
        )}

        {regions.map((r) => {
          const groups = visible.filter((g) => g.p.region === r.id);
          if (!groups.length) return null;
          return (
            <section key={r.id} className="ui-sm-region" aria-label={r.title}>
              <h3 className="ui-sm-region__head">
                {r.id === "eu" ? <EuFlag /> : <Icon icon={r.id === "global" ? Globe02Icon : Key01Icon} size={15} />}
                {r.title}
                <small>{r.note}</small>
              </h3>
              {groups.map(({ p, models }) => {
                const isOpen = open.has(p.id) || !!q;
                const on = p.models.filter((m) => m.on).length;
                return (
                  <div key={p.id} className="ui-sg-card ui-sm-provider" data-open={isOpen || undefined}>
                    <button type="button" className="ui-sm-provider__head" aria-expanded={isOpen} onClick={() => toggleOpen(p.id)}>
                      <span className="ui-ss-tile ui-sm-logo" aria-hidden="true">
                        {p.logo ?? <Icon icon={Key01Icon} size={15} />}
                      </span>
                      <b title={p.name}>{p.name}</b>
                      <span className="ui-ss-badge">
                        {on}/{p.models.length} on
                      </span>
                      <Icon icon={ArrowDown01Icon} size={15} />
                    </button>
                    {/* Rows fold open on a grid row – no measured heights */}
                    {/* Folded rows stay out of the tab order */}
                    <div className="ui-sm-models" inert={!isOpen}>
                      <div>
                        {models.map((m) => (
                          <div key={m.id} className="ui-sg-row ui-sm-model" data-off={!m.on || undefined}>
                            <span className="ui-sg-label">
                              <b>
                                {m.name}
                                {m.kind === "image" && <span className="ui-ss-badge">Image</span>}
                                {(m.id === chat || m.id === image) && <span className="ui-ss-badge">Default</span>}
                              </b>
                              <small>{m.custom ? "Your endpoint" : `Hosted by ${p.name}${p.region === "eu" ? " in the EU" : ""}`}</small>
                            </span>
                            <span className="ui-sg-control">
                              <Dropdown
                                align="end"
                                items={accessOptions.map((a) => ({ label: a.label, icon: a.icon, checked: a.label === m.access, onSelect: () => setModel(m.id, { access: a.label }, `${m.name}: ${a.label.toLowerCase()}`) }))}
                                trigger={({ open: o, toggle }) => (
                                  <button type="button" className="ui-ss-select ui-sm-access" aria-label={`Who can use ${m.name}`} aria-expanded={o} onClick={toggle}>
                                    <Icon icon={accessOptions.find((a) => a.label === m.access)?.icon ?? UserMultiple02Icon} size={14} />
                                    <span>{m.access}</span>
                                    <Icon icon={ArrowDown01Icon} size={14} />
                                  </button>
                                )}
                              />
                              <button
                                type="button"
                                role="switch"
                                aria-checked={m.on}
                                aria-label={m.name}
                                className="ui-ss-switch"
                                onClick={() => setModel(m.id, { on: !m.on }, `${m.name} ${m.on ? "off" : "on"}`)}
                              />
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
        {visible.length === 0 && (
          <p className="ui-sg-card ui-ss-empty ui-sm-none">{filter === "custom" && !q ? "No custom models yet – add one with your own endpoint." : `No models match${q ? ` “${query.trim()}”` : ""}.`}</p>
        )}

        {/* API keys */}
        <header className="ui-sg-head ui-ss-head">
          <span>
            <h2>API keys</h2>
            <p>Bring your own key and that provider bills you directly – its usage no longer counts toward your plan.</p>
          </span>
          {adding !== "key" && (
            <Button ref={focusBack("key")} size="sm" variant="secondary" icon={<Icon icon={Add01Icon} size={15} />} onClick={() => setAdding("key")}>
              Add key
            </Button>
          )}
        </header>
        <section className="ui-sg-card" aria-label="API keys">
          {keys.map((k) => {
            const p = providers.find((x) => x.id === k.provider);
            return (
              <div key={k.provider} className="ui-sg-row ui-ss-domain">
                <span className="ui-ss-domain__name">
                  <span className="ui-ss-tile ui-sm-logo" aria-hidden="true">
                    {p?.logo}
                  </span>
                  <b title={p?.name}>{p?.name}</b>
                  <code className="ui-ss-range">{k.masked}</code>
                </span>
                <span className="ui-sg-control">
                  <span className="ui-sm-added">{k.added}</span>
                  <button
                    type="button"
                    className="ui-as-icon-btn ui-ss-remove"
                    aria-label={`Remove ${p?.name} key`}
                    onClick={(e) => {
                      refocusAfterRemove(e.currentTarget);
                      const next = keys.filter((x) => x !== k);
                      setKeys(next);
                      save({ keys: next }, `${p?.name} key removed`);
                    }}
                  >
                    <Icon icon={Cancel01Icon} size={14} />
                  </button>
                </span>
              </div>
            );
          })}
          {keys.length === 0 && adding !== "key" && <p className="ui-ss-empty">No keys yet – usage runs on your plan</p>}
          {adding === "key" && (
            <form className="ui-sg-row ui-ss-add ui-ss-rise" onSubmit={addKey} onKeyDown={(e) => e.key === "Escape" && closeAdd()}>
              <input
                className="ui-sg-input ui-sm-keyfield"
                value={draft.key}
                placeholder="sk-ant-… or sk-…"
                aria-label="API key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
              />
              <span className="ui-sg-control">
                <Button size="sm" variant="secondary" type="button" onClick={closeAdd}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" disabled={!draft.key.trim()}>
                  Save key
                </Button>
              </span>
            </form>
          )}
        </section>
      </div>
      {toast}
    </AppShell>
  );
}

/** A select of models: the current one's mark and name, the choices in the shell's menu */
export function ModelPick({ label, value, options, empty, onChange }: { label: string; value: string; options: { id: string; name: string; logo?: ReactNode; icon?: typeof SparklesIcon }[]; empty?: string; onChange: (id: string) => void }) {
  const current = options.find((o) => o.id === value);
  const mark = (o?: (typeof options)[number]) => (o?.logo ? <span className="ui-sm-mark">{o.logo}</span> : <Icon icon={o?.icon ?? SparklesIcon} size={15} />);
  return (
    <Dropdown
      align="end"
      items={options.map((o) => ({ label: o.name, ...(o.logo ? { logo: <span className="ui-sm-mark">{o.logo}</span> } : { icon: o.icon }), checked: o.id === value, onSelect: () => onChange(o.id) }))}
      trigger={({ open, toggle }) => (
        <button type="button" className="ui-ss-select ui-sm-pick" aria-label={label} title={current?.name} aria-expanded={open} disabled={!options.length} onClick={toggle}>
          {current && mark(current)}
          <span>{current?.name ?? empty ?? "None"}</span>
          <Icon icon={ArrowDown01Icon} size={14} />
        </button>
      )}
    />
  );
}

/** How Auto works – the text on the left, the Model Wheel turning through the models it can pick on the right */
export function AutoExplainer({ models }: { models: (Model & { provider: Provider })[] }) {
  // The wheel restarts when its list changes, so it only gets a new one when the models themselves change
  const key = models.map((m) => m.id).join();
  const wheel = useMemo(
    () =>
      models.flatMap((m) => {
        const mark = defaultModels.find((w) => w.name === wheelMark[m.provider.id]);
        return mark ? [{ ...mark, name: m.name }] : [];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return (
    <div className="ui-sm-auto ui-ss-rise">
      <div className="ui-sm-auto__text">
        <b>How Auto works</b>
        <p>Auto picks the model and how long it thinks for each message – the strongest one for hard questions, a fast one for quick replies.</p>
        <ul>
          <li>
            <Icon icon={Tick02Icon} size={14} />
            The best answer for what it costs
          </li>
          <li>
            <Icon icon={Tick02Icon} size={14} />
            Only models you've turned on, hosted in the EU first
          </li>
        </ul>
      </div>
      {wheel.length > 0 && (
        <div className="ui-sm-wheel">
          <ModelWheel models={wheel} hold={1800} label="The chat models Auto can pick from, turning one after another into the middle" />
        </div>
      )}
    </div>
  );
}

/* ---------- Styles ---------- */

// Builds on Settings / General's rows and Settings / Security's switches, badges and selects – Settings / Preferences shares it
export const css = /* css */ `
.ui-sm .ui-sg-card + .ui-sg-card { margin-top: 8px; }
.ui-sm-mark { display: grid; flex: none; place-items: center; width: 15px; height: 15px; }
.ui-sm-mark svg { width: 100%; height: 100%; }

/* The model pickers: the model's mark in front */
.ui-sm-pick { width: 200px; justify-content: flex-start; }
.ui-sm-pick > span:not(.ui-sm-mark) { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-sm-pick > svg:first-child { color: var(--muted); }
.ui-sm-pick:disabled { color: var(--faint); cursor: default; }

/* How Auto works: a gray block inside the card, the pick sliding between three providers */
.ui-sm-auto { display: flex; align-items: center; gap: 32px; margin: 0 12px 12px 16px; padding: 18px 20px; border-radius: 10px; background: var(--frame); }
.ui-sm-auto__text { flex: 1; min-width: 0; }
.ui-sm-auto__text b { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-sm-auto__text p { max-width: 400px; margin: 2px 0 10px; font-size: 12.5px; line-height: 18px; color: var(--muted); }
.ui-sm-auto__text ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.ui-sm-auto__text li { display: flex; align-items: center; gap: 8px; font-size: 12.5px; line-height: 18px; color: var(--text, var(--ink)); }
.ui-sm-auto__text li svg { flex: none; color: var(--muted); }
/* The Model Wheel: shorter than on its own, the model in the middle on a white card */
.ui-sm-wheel { flex: none; width: 240px; margin: -14px 0; }
.ui-sm-wheel .ui-mw { height: 196px; --ui-mw-fill: var(--card); --ui-mw-ink: var(--strong); --ui-mw-mark: var(--strong); --ui-mw-muted: var(--faint); }
.ui-sm-wheel .ui-mw-fill { box-shadow: var(--card-shadow); }
.ui-sm-wheel .ui-mw-row { font-size: 14px; }
.ui-sm-wheel .ui-mw-row svg { width: 16px; height: 16px; }
.ui-sm-auto + .ui-sg-row { box-shadow: inset 0 0.5px 0 var(--line); }

/* Filter, search and add in one bar */
.ui-sm-bar { display: flex; align-items: center; gap: 8px; margin-top: 36px; }
.ui-sm-bar > :first-child { margin-right: auto; }
.ui-sm-search { display: flex; align-items: center; gap: 8px; width: 220px; height: 32px; box-sizing: border-box; padding: 0 8px 0 10px; border-radius: 8px; background: var(--card); box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 1px 1px rgba(0, 0, 0, 0.03); color: var(--faint); transition: box-shadow 140ms ease; }
.ui-sm-search:focus-within { box-shadow: inset 0 0 0 0.5px var(--line-strong), 0 0 0 3px var(--accent-soft); }
.ui-sm-search input { flex: 1; min-width: 0; border: 0; outline: none; background: none; font: inherit; font-size: 13px; color: var(--ink); }
.ui-sm-search input::placeholder { color: var(--placeholder); }
.ui-sm-search button { position: relative; display: grid; flex: none; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--chip); color: var(--muted); }
.ui-sm-search button::before { content: ""; position: absolute; inset: -7px; }
.ui-sm-search button:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-soft); color: var(--ink); }

/* A custom model: name and endpoint side by side */
.ui-sm-form { display: grid; gap: 2px; margin-top: 12px; padding: 14px 12px 12px 16px; }
.ui-sm-form > b { font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-sm-form > span { font-size: 12px; line-height: 16px; color: var(--muted); }
.ui-sm-form__fields { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.ui-sm-form__fields .ui-sg-input { flex: 1; width: auto; min-width: 0; }

/* Regions, then a card per provider that folds open */
.ui-sm-region { margin-top: 28px; }
.ui-sm-region__head { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-sm-region__head > svg { flex: none; color: var(--muted); }
.ui-sm-region__head small { margin-left: 2px; font-size: 12px; font-weight: 400; color: var(--faint); }
.ui-sm-flag { flex: none; width: 18px; height: 13px; border-radius: 3px; box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1); }
.ui-sm-provider__head { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 56px; padding: 0 14px 0 14px; border-radius: 12px; text-align: left; }
.ui-sm-provider__head b { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; font-weight: 500; color: var(--strong); }
.ui-sm-provider__head > svg { flex: none; color: var(--faint); transition: rotate 260ms var(--ease); }
.ui-sm-provider[data-open] .ui-sm-provider__head > svg { rotate: 180deg; }
.ui-sm-provider__head:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ui-sm-logo svg { width: 15px; height: 15px; }
.ui-sm-models { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 320ms var(--ease); }
.ui-sm-models > div { min-height: 0; overflow: hidden; }
.ui-sm-provider[data-open] .ui-sm-models { grid-template-rows: 1fr; }
.ui-sm-model { min-height: 56px; box-shadow: inset 0 0.5px 0 var(--line); }
.ui-sm-model .ui-sg-label b { display: flex; align-items: center; gap: 6px; }
.ui-sm-model .ui-ss-badge { font-size: 11px; line-height: 16px; }
.ui-sm-model[data-off] .ui-sg-label { opacity: 0.5; transition: opacity 200ms ease; }
.ui-sm-access { width: auto; min-width: 130px; justify-content: flex-start; gap: 6px; }
.ui-sm-access > span { flex: 1; }
.ui-sm-access > svg:first-child { color: var(--muted); }
.ui-sm-none { margin-top: 20px; text-align: center; }

.ui-sm-added { flex: none; font-size: 12px; color: var(--faint); white-space: nowrap; }
.ui-sm-keyfield { font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace); }

@container ui-as-main (max-width: 600px) {
  .ui-sm-auto { flex-direction: column; align-items: stretch; gap: 16px; margin: 0 14px 12px; }
  .ui-sm-wheel { width: auto; margin: 0; }
  .ui-sm-pick { width: 100%; }
  .ui-sm-bar { flex-wrap: wrap; }
  .ui-sm-bar > :first-child { margin-right: 0; width: 100%; }
  .ui-sm-search { flex: 1; width: auto; }
  .ui-sm-form__fields { flex-direction: column; align-items: stretch; }
  .ui-sm-model .ui-sg-control { justify-content: space-between; }
  .ui-sm-region__head small { display: none; }
  /* A key row keeps the provider and the key; when it was added gives way */
  .ui-sm-added { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ui-sm-models { transition: none; }
}
`;
