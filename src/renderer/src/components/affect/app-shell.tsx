// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { createPortal } from "react-dom";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  CommandLineIcon,
  Globe02Icon,
  MoreHorizontalIcon,
  NoteEditIcon,
  ArrowUpDownIcon,
  Cancel01Icon,
  DashboardSquare02Icon,
  File02Icon,
  FilterIcon,
  Folder01Icon,
  FolderOpenIcon,
  GridViewIcon,
  LeftToRightListBulletIcon,
  PencilEdit02Icon,
  Search01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  Tick02Icon,
  PlusSignIcon,
  UserIcon,
  Settings01Icon,
  HelpCircleIcon,
  Logout01Icon,
  PinIcon,
  PinOffIcon,
  ViewIcon,
  Share08Icon,
  Copy01Icon,
  Archive02Icon,
  SquareArrowUpRight02Icon,
  ListViewIcon,
  Link01Icon,
  UserAdd01Icon,
  Analytics01Icon,
  CreditCardIcon,
  Activity01Icon,
  UserMultiple02Icon,
  InformationCircleIcon,
  ArrowLeftRightIcon,
  TranslateIcon,
  PaintBoardIcon,
  Plug01Icon,
  Download04Icon,
  Clock01Icon,
  Book02Icon,
  ComputerIcon,
  Sun03Icon,
  Moon02Icon,
  BubbleChatIcon,
} from "@hugeicons/core-free-icons";
import { FilterMenu, type FilterGroup, type FilterValue } from "./filter-menu";
import { SetupGuide, type SetupGroup } from "./setup-guide";
import { CommandMenu, defaultGroups, type CommandGroup } from "./command-menu";

/*
 * App Shell – the frame every affectUI screen sits in, in a single file.
 * A sidebar on a gray page (workspace, menu, projects, what's new, onboarding progress, user) and the main
 * area as a rounded white panel. The sidebar folds to a rail of its icons (each names itself on hover).
 * Drag the sidebar's edge to make it wider or narrower (between a minimum and a maximum; double-click resets it).
 * A work area on the right (`panel`) – WorkspacePanel below (terminal, browser, notes, suggested sources) or your
 * own content – resizable and collapsible the same way.
 * Two layouts: "inset" (the main area as a rounded panel on the gray page) and "flat" (no panel – the page runs edge
 * to edge next to the sidebar, split by a hairline). Pick one with `layout`, or for a whole app at once with
 * data-shell="flat" on any ancestor, e.g. <html> – like dark mode.
 * Also exports the small parts the screens share: icon, tabs, search, toolbar tools, section heads,
 * empty state and file cards. Icons: Hugeicons free set (stroke, rounded).
 */

/** Hugeicons, stroke + rounded with a slightly heavier stroke */
export const Icon = ({ icon, size = 16, stroke = 1.9, color = "currentColor" }: { icon: IconSvgElement; size?: number; stroke?: number; color?: string }) => (
  <HugeiconsIcon icon={icon} size={size} strokeWidth={stroke} color={color} aria-hidden />
);

/** Languages in the account menu, each with its flag */
const languages = [
  { label: "English", flag: "gb" },
  { label: "Deutsch", flag: "de" },
  { label: "Français", flag: "fr" },
  { label: "Español", flag: "es" },
] as const;

/** Small flags as drawings – the same on every system, also where flag emoji don't show */
/** Small flags for the language menus – drawn, since flag emoji look different on every system */
export const Flag = ({ code }: { code: "gb" | "de" | "fr" | "es" }) => (
  <svg className="ui-as-flag" viewBox="0 0 20 14" aria-hidden="true">
    {code === "de" && (
      <>
        <rect width="20" height="4.67" fill="#1f1f1f" />
        <rect y="4.67" width="20" height="4.67" fill="#dd0000" />
        <rect y="9.33" width="20" height="4.67" fill="#ffce00" />
      </>
    )}
    {code === "fr" && (
      <>
        <rect width="6.67" height="14" fill="#002395" />
        <rect x="6.67" width="6.67" height="14" fill="#ffffff" />
        <rect x="13.33" width="6.67" height="14" fill="#ed2939" />
      </>
    )}
    {code === "es" && (
      <>
        <rect width="20" height="14" fill="#aa151b" />
        <rect y="3.5" width="20" height="7" fill="#f1bf00" />
      </>
    )}
    {code === "gb" && (
      <>
        <rect width="20" height="14" fill="#012169" />
        <path d="M0 0 20 14M20 0 0 14" stroke="#ffffff" strokeWidth="2.8" />
        <path d="M0 0 20 14M20 0 0 14" stroke="#c8102e" strokeWidth="1" />
        <path d="M10 0v14M0 7h20" stroke="#ffffff" strokeWidth="4.2" />
        <path d="M10 0v14M0 7h20" stroke="#c8102e" strokeWidth="2.4" />
      </>
    )}
  </svg>
);

export type ShellNavItem = { label: string; icon: IconSvgElement; /** Small number at the end, e.g. unread items */ count?: number };
/** A labelled list under the menu – replaces Projects when given */
export type ShellGroup = { label: string; items: ShellNavItem[]; /** Text shown while the list is empty */ empty?: string };

export const defaultNav: ShellNavItem[] = [
  { label: "New chat", icon: PencilEdit02Icon },
  { label: "Folders", icon: Folder01Icon },
  { label: "Integrations", icon: DashboardSquare02Icon },
];

export const defaultProjects = ["Q3 Campaign", "Brand assets", "Hiring", "Research"];

/** Onboarding behind "Getting started" – shown in the library's Setup Guide */
export const defaultSetup: SetupGroup[] = [
  {
    id: "workspace",
    title: "Set up your workspace",
    tasks: [
      { id: "name", label: "Name your workspace", done: true },
      { id: "invite", label: "Invite your teammates" },
      { id: "connect", label: "Connect your first app" },
    ],
  },
  {
    id: "work",
    title: "Start working",
    tasks: [
      { id: "folder", label: "Create a folder" },
      { id: "chat", label: "Start your first chat" },
      { id: "upload", label: "Upload a file" },
    ],
  },
  {
    id: "profile",
    title: "Make it yours",
    tasks: [
      { id: "avatar", label: "Add a profile picture" },
      { id: "notify", label: "Choose your notifications" },
    ],
  },
];

/** Up to this width (of the app itself, not the window) the sidebar becomes a drawer */
const NARROW = 900;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** The first character as people see it – a whole emoji or accented letter, never half of one */
const firstChar = (text: string) => {
  const t = text.trim();
  if (!t) return "";
  const Segmenter = (Intl as unknown as { Segmenter?: new () => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (Segmenter) for (const part of new Segmenter().segment(t)) return part.segment;
  return Array.from(t)[0];
};
/** Counts in the sidebar stay short: 999+ */
const shortCount = (n: number) => (!Number.isFinite(n) ? "" : n > 999 ? "999+" : String(Math.max(0, Math.round(n))));

const cheer = (pct: number) => (pct >= 100 ? "All done!" : pct >= 60 ? "Almost there!" : pct > 0 ? "Great start!" : "Let's go!");

/** A chat in the sidebar – `folder` puts it inside one of the projects, which then open and close like folders */
export type ShellChat = { id: string; title: string; pinned?: boolean; unread?: boolean; folder?: string; logo?: ReactNode };

export type AppShellProps = {
  children: ReactNode;
  /** Label of the menu item or project that is open */
  active?: string;
  /** Called with the label of a menu item or project when it is clicked */
  onNavigate?: (label: string) => void;
  workspace?: string;
  /** Line under the workspace's name in its menu */
  workspaceMeta?: string;
  /** The account at the bottom – its menu shows the email under the name (made up from the name when left out) */
  /** `meta` is a second line under the name, such as the computer in use */
  user?: { name: string; avatar?: string; email?: string; meta?: string };
  /** "mac": the window's traffic lights in the top left corner, the sidebar toggle, Back and Forward right after them, all
   * staying put whether the sidebar shows or not; the sidebar's head only leaves them room */
  chrome?: "mac";
  /** "none" leaves the workspace switcher out, for an app whose account menu switches what it works on */
  workspacePlacement?: "head" | "none";
  nav?: ShellNavItem[];
  projects?: string[];
  /** Lists under the menu instead of Projects, e.g. Tools or Pipelines */
  groups?: ShellGroup[];
  /**
   * Chats in the sidebar: the projects turn into folders that open and close and hold their chats; the other chats
   * follow under Pinned and Chats. Pin, rename, mark as unread, move, copy or archive them from their ⋯ menu,
   * and drag them into another order or into a folder
   */
  chats?: ShellChat[];
  /** Called when a chat is clicked (default: onNavigate with its title) */
  onOpenChat?: (chat: ShellChat) => void;
  /** Your own icon for the project folders among the chats, in place of the line folder; a function gets whether it is open */
  folderIcon?: ReactNode | ((open: boolean) => ReactNode);
  /** Your own account menu in place of the built-in one, opened from the account row; gets a function that closes it */
  userMenu?: (close: () => void) => ReactNode;
  /** A button at the account row's end, such as Settings, in place of the row's chevron; the rest of the row still opens the account menu */
  userAction?: { icon: IconSvgElement; label: string; shortcut?: string; onClick: () => void };
  /** Tasks behind "Getting started" */
  setup?: SetupGroup[];
  /** Sidebar width in px – drag its edge between min and max; double-click the edge for the default again */
  sidebarWidth?: { default?: number; min?: number; max?: number };
  /** A work area on the right of the main area, e.g. tools or a preview – resizable and collapsible */
  panel?: ReactNode;
  /**
   * A header across the whole app, like Claude's: the workspace and the sidebar toggle over the sidebar, the page's title and
   * actions over the page, and the work area's title over the work area – one bar, one line under it
   */
  header?: { title: ReactNode; actions?: ReactNode } | false;
  /** The cards at the bottom of the sidebar – what's new and Getting started (default: shown) */
  sideCards?: boolean;
  /** Heading of the right work area */
  panelTitle?: string;
  /** What its head shows instead of the plain title, e.g. "Brief / Summer launch" – panelTitle still names it for screen readers */
  panelHeading?: ReactNode;
  /**
   * Turns the sidebar into a settings sidebar: a back link with this title ("‹ Settings") in place of the workspace,
   * and no news or setup cards at the bottom. Clicking it calls onNavigate with `label` (default "Back to app").
   */
  back?: { title: string; label?: string };
  /** Start with the work area folded away – its icon waits in the top right corner (default: open) */
  defaultPanelOpen?: boolean;
  /** Width of the right work area in px, like sidebarWidth */
  panelWidth?: { default?: number; min?: number; max?: number };
  /** The search's own content in place of the Command Menu's sample groups – a function gets a close callback */
  search?: (close: () => void) => ReactNode;
  /** "inset": the page as a rounded panel on the gray page; "flat": edge to edge, split by a hairline. Without it,
   *  data-shell="flat" on an ancestor makes it flat */
  layout?: "inset" | "flat";
  className?: string;
};

export function AppShell({
  children,
  active,
  onNavigate,
  workspace: workspaceName = "Acme",
  workspaceMeta = "Pro · 8 members",
  user = { name: "Alex Morgan" },
  nav = defaultNav,
  projects = defaultProjects,
  groups,
  chats,
  onOpenChat,
  folderIcon,
  userMenu,
  userAction,
  chrome,
  workspacePlacement = "head",
  setup = defaultSetup,
  sidebarWidth,
  panel,
  panelTitle = "Workspace",
  panelHeading,
  back,
  defaultPanelOpen = true,
  panelWidth,
  search: searchContent,
  header,
  sideCards = true,
  className,
  layout,
}: AppShellProps) {
  const [news, setNews] = useState(2);
  const [userOpen, setUserOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const side = { default: 272, min: 220, max: 380, ...sidebarWidth };
  const pane = { default: 360, min: 280, max: 560, ...panelWidth };
  const [sideW, setSideW] = useState(side.default);
  const [paneW, setPaneW] = useState(pane.default);
  const [paneOpen, setPaneOpen] = useState(defaultPanelOpen);
  // While an edge is dragged the columns follow the pointer directly, without their glide
  const [resizing, setResizing] = useState(false);
  // Narrow (tablet, phone): the sidebar waits off screen and slides in as a drawer over the main area
  const root = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const narrowNow = useRef(false);
  const [drawer, setDrawer] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // Same width as the @container ui-as (max-width: 900px) rules below – measured in layout pixels, so a scaled preview stays wide
    const measure = () => {
      const next = el.offsetWidth <= NARROW;
      if (next === narrowNow.current) return;
      narrowNow.current = next;
      // All in one update, so the drawers never show (or take the focus) for a render in between
      setNarrow(next);
      if (!next) setDrawer(false);
      // Narrow: the right work area waits closed and slides in over the page when asked for
      setPaneOpen(!next && defaultPanelOpen);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Collapsed on wide screens the sidebar stays as a rail of icons; on narrow ones it's a drawer that hides away
  const rail = collapsed && !narrow;
  const sideHidden = narrow ? !drawer : false;
  // Narrow: an open drawer is modal – the focus moves into it, the rest of the app waits (inert) behind the scrim,
  // and when it closes the focus goes back to the button that opened it
  const overlay = narrow ? (drawer ? "side" : panel && paneOpen ? "panel" : null) : null;
  const lastOverlay = useRef<typeof overlay>(null);
  useEffect(() => {
    const el = root.current;
    const was = lastOverlay.current;
    lastOverlay.current = overlay;
    if (!el || was === overlay) return;
    if (overlay) {
      const box = el.querySelector<HTMLElement>(overlay === "side" ? ":scope > .ui-as-side" : ":scope > .ui-as-panel");
      if (box) firstFocusable(box)?.focus({ preventScroll: true });
    } else if (was) {
      const box = el.querySelector(was === "side" ? ":scope > .ui-as-side" : ":scope > .ui-as-panel");
      const at = document.activeElement;
      if (!at || at === document.body || box?.contains(at)) el.querySelector<HTMLElement>(was === "side" ? ":scope > .ui-as-side-open" : ":scope > .ui-as-panel-open")?.focus({ preventScroll: true });
    }
  }, [overlay]);
  const go = (label: string) => {
    setDrawer(false);
    onNavigate?.(label);
  };

  // The search field opens the library's Command Menu over the app; ⌘K does too while the focus is inside the app
  const [search, setSearch] = useState(false);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    setSearch(false);
    searchBtn.current?.focus({ preventScroll: true });
  };
  // "Go to" lists the sidebar's own pages and projects; the other groups are the menu's samples
  const goTo: CommandGroup = {
    id: "go",
    label: "Go to",
    commands: [...(groups ? groups.flatMap((g) => g.items) : nav), ...(groups ? [] : projects.map((label) => ({ label, icon: FolderOpenIcon })))].map((item, i) => ({
      id: `go:${i}:${item.label}`,
      label: item.label,
      icon: <Icon icon={item.icon} size={16} />,
    })),
  };
  const commandGroups = defaultGroups.map((g) => (g.id === "go" ? goTo : g));
  // closed → open → closing → closed: while closing the guide stays, fades and the card shrinks, then the summary returns
  const [guide, setGuide] = useState<"closed" | "open" | "closing">("closed");
  const guideOpen = guide === "open";
  const setGuideOpen = (open: boolean) => {
    const at = document.activeElement;
    guideHadFocus.current = !!at && (at === document.body || !!guideInner.current?.contains(at));
    if (open) return setGuide("open");
    setGuide((g) => (g === "open" ? "closing" : g));
  };
  useEffect(() => {
    if (guide !== "closing") return;
    const t = window.setTimeout(() => setGuide("closed"), 420);
    return () => window.clearTimeout(t);
  }, [guide]);
  const guideInner = useRef<HTMLDivElement>(null);
  // The summary and the guide swap places – the focus moves with them, so the keyboard never drops to the page
  const guideHadFocus = useRef(false);
  useEffect(() => {
    const el = guideInner.current;
    if (!el) return;
    if (guide === "open" && guideHadFocus.current) firstFocusable(el)?.focus({ preventScroll: true });
    if (guide === "closed" && guideHadFocus.current) el.querySelector<HTMLElement>(".ui-as-steps")?.focus({ preventScroll: true });
    if (guide !== "closing") guideHadFocus.current = false;
  }, [guide]);
  const [guideHeight, setGuideHeight] = useState(0);
  const [closedHeight, setClosedHeight] = useState(0);
  // Read the content's height right when the state changes (not a frame later), so no step ever uses an old height;
  // the closed card's height is kept for the slot and for shrinking back
  useLayoutEffect(() => {
    const el = guideInner.current;
    if (!el) return;
    setGuideHeight(el.offsetHeight);
    if (guide === "closed") setClosedHeight(el.offsetHeight);
  }, [guide]);

  // The card's height follows its content, so opening, closing and folding groups all glide
  useLayoutEffect(() => {
    const el = guideInner.current;
    if (!el) return;
    const measure = () => setGuideHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!guideOpen) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setGuideOpen(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [guideOpen]);
  // Escape closes the drawer – unless the setup guide is open, then it closes the guide first
  useEffect(() => {
    if (!drawer || guide !== "closed") return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [drawer, guide]);
  // Narrow: Escape closes the work area that slid in from the right
  useEffect(() => {
    if (!narrow || !paneOpen) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPaneOpen(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [narrow, paneOpen]);
  const [done, setDone] = useState(() => setup.flatMap((g) => g.tasks.filter((t) => t.done).map((t) => t.id)));
  const total = setup.reduce((n, g) => n + g.tasks.length, 0);
  const pct = total ? Math.round((done.length / total) * 100) : 0;
  // First and last word, whole characters; empty names fall back to an icon and "Account"
  const workspace = workspaceName.trim() || "Workspace";
  const userName = user.name.trim();
  // Suffixes like "III" or "Jr." don't make an initial – "Christopher Montgomery III" is CM
  const words = userName.split(/\s+/).filter((w, i, all) => w && !(i > 0 && i === all.length - 1 && /^(jr\.?|sr\.?|i{2,3}|iv|v)$/i.test(w)));
  const initials = words.length ? (firstChar(words[0]) + (words.length > 1 ? firstChar(words[words.length - 1]) : "")).toUpperCase() : "";
  // An avatar that doesn't load falls back to the initials
  const [avatarFailed, setAvatarFailed] = useState<string | null>(null);
  const showAvatar = user.avatar && avatarFailed !== user.avatar;
  // Who is signed in, for the head of the account menu – the email made up from the name when none is given
  const email = user.email ?? `${(words[0] ?? "you").toLowerCase().replace(/[^a-z0-9]/g, "") || "you"}@${workspace.toLowerCase().replace(/[^a-z0-9]/g, "") || "example"}.com`;
  const [language, setLanguage] = useState("English");
  const [appearance, setAppearance] = useState("System");
  const userTrigger = ({ open, toggle }: { open: boolean; toggle: () => void }) => (
    <button type="button" className="ui-as-user" aria-haspopup="menu" aria-expanded={open} title={rail ? userName || "Account" : undefined} onClick={toggle}>
      {showAvatar ? (
        <img src={user.avatar} alt="" width={21} height={21} onError={() => setAvatarFailed(user.avatar ?? null)} />
      ) : (
        <span className="ui-as-user__initials">{initials || <Icon icon={UserIcon} size={12} />}</span>
      )}
      {user.meta ? (
        <span className="ui-as-user__text">
          <span className="ui-as-user__name" title={userName || undefined}>
            {userName || "Account"}
          </span>
          <small title={user.meta}>{user.meta}</small>
        </span>
      ) : (
        <span className="ui-as-user__name" title={userName || undefined}>
          {userName || "Account"}
        </span>
      )}
      {!userAction && <Icon icon={ArrowDown01Icon} size={13} />}
    </button>
  );

  // The workspace switcher – in the sidebar's head, or with a header in the sidebar's part of it.
  // A settings sidebar shows a way back instead
  const backLink = back && (
    <button className="ui-as-side__back" type="button" aria-label={back.label ?? "Back to app"} onClick={() => go(back.label ?? "Back to app")}>
      <Icon icon={ArrowLeft01Icon} size={15} />
      <span>{back.title}</span>
    </button>
  );
  const workspaceMenu = backLink || (
    <Dropdown
      className="ui-as-ws-menu"
      items={[
        { label: "Invite people", icon: UserAdd01Icon, onSelect: () => go("Members") },
        { label: "Workspace settings", icon: Settings01Icon, divider: true, onSelect: () => go("Members") },
        { label: "Analytics", icon: Analytics01Icon, onSelect: () => go("Analytics") },
        { label: "Billing", icon: CreditCardIcon, onSelect: () => go("Billing") },
        { label: "Usage & limits", icon: Activity01Icon, onSelect: () => go("Billing") },
        { label: "Members", icon: UserMultiple02Icon, onSelect: () => go("Members") },
        {
          label: "Learn more",
          icon: InformationCircleIcon,
          divider: true,
          submenu: [
            { label: "Documentation", icon: Book02Icon },
            { label: "Changelog", icon: Clock01Icon },
            { label: "Help & feedback", icon: HelpCircleIcon },
          ],
        },
        {
          label: "Switch workspace",
          icon: ArrowLeftRightIcon,
          divider: true,
          submenu: [
            { label: workspace, description: workspaceMeta, checked: true },
            { label: "Personal", description: "Free", checked: false },
            { label: "Create workspace", icon: PlusSignIcon, divider: true },
          ],
        },
      ]}
      trigger={({ open, toggle }) => (
        <button className="ui-as-side__workspace" type="button" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <span className="ui-as-side__logo">{firstChar(workspace).toUpperCase()}</span>
          <span className="ui-as-side__name" title={workspace}>
            {workspace}
          </span>
          <Icon icon={ArrowDown01Icon} size={13} />
        </button>
      )}
    />
  );

  return (
    <div
      ref={root}
      className={["ui-as", "ui-as-app", className].filter(Boolean).join(" ")}
      style={{ "--side-w": `${sideW}px`, "--panel-w": `${paneW}px` } as CSSProperties}
      data-collapsed={(collapsed && !narrow) || undefined}
      data-chrome={chrome}
      data-drawer={(narrow && drawer) || undefined}
      data-panel={panel ? (paneOpen ? "open" : "closed") : undefined}
      data-resizing={resizing || undefined}
      data-header={header ? "" : undefined}
      data-layout={layout}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !search) {
          e.preventDefault();
          e.stopPropagation();
          setSearch(true);
        }
      }}
    >
      <style href="ui-app-shell" precedence="default">
        {css}
      </style>
      {/* Search: the Command Menu over a soft scrim – a click outside or Esc in the empty field closes it */}
      {search && (
        <div className="ui-as-cmd" role="dialog" aria-modal="true" aria-label="Search" onPointerDown={(e) => e.target === e.currentTarget && closeSearch()}>
          {searchContent ? searchContent(closeSearch) : <CommandMenu
            groups={commandGroups}
            autoFocus
            onClose={closeSearch}
            onRun={(id) => {
              closeSearch();
              if (id.startsWith("go:")) go(id.split(":").slice(2).join(":"));
            }}
          />}
        </div>
      )}
      {/* With the sidebar hidden, the same icon sits in the top left corner of the main area to bring it back */}
      <button
        className="ui-as-icon-btn ui-as-side-open"
        type="button"
        aria-label="Open sidebar"
        tabIndex={sideHidden ? 0 : -1}
        inert={!!overlay}
        onClick={() => (narrow ? setDrawer(true) : setCollapsed(false))}
      >
        <Icon icon={SidebarLeftIcon} size={16} />
      </button>
      {/* The same for the work area on the right: its icon waits in the top right corner while it's closed */}
      {panel && (
        <button
          className="ui-as-icon-btn ui-as-panel-open"
          type="button"
          aria-label={`Open ${panelTitle.toLowerCase()}`}
          tabIndex={paneOpen ? -1 : 0}
          inert={!!overlay}
          onClick={() => setPaneOpen(true)}
        >
          <Icon icon={SidebarRightIcon} size={16} />
        </button>
      )}
      {/* Narrow only: dims the main area behind the open drawer; a tap closes it */}
      <div
        className="ui-as-scrim"
        aria-hidden="true"
        onClick={() => {
          setDrawer(false);
          if (narrow) setPaneOpen(false);
        }}
      />
      {header && (
        <>
          <div className="ui-as-bar ui-as-bar--side" inert={sideHidden}>
            {workspaceMenu}
            <button className="ui-as-icon-btn" type="button" aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} title={rail ? "Expand sidebar" : undefined} onClick={() => setCollapsed((c) => !c)}>
              <Icon icon={SidebarLeftIcon} size={16} />
            </button>
          </div>
          <div className="ui-as-bar ui-as-bar--main" inert={!!overlay}>
            <div className="ui-as-bar__title">{header.title}</div>
            {header.actions && <div className="ui-as-bar__actions">{header.actions}</div>}
          </div>
          {panel && (
            <div className="ui-as-bar ui-as-bar--panel" inert={!paneOpen}>
              <span className="ui-as-panel__title" title={typeof (panelHeading ?? panelTitle) === "string" ? String(panelHeading ?? panelTitle) : undefined}>
                {panelHeading ?? panelTitle}
              </span>
              <button className="ui-as-icon-btn" type="button" aria-label={`Close ${panelTitle.toLowerCase()}`} onClick={() => setPaneOpen(false)}>
                <Icon icon={SidebarRightIcon} size={16} />
              </button>
            </div>
          )}
        </>
      )}
      {chrome === "mac" && (
        <div className="ui-as-corner">
          {/* The traffic lights are the window's own; the prototype runs in a browser, so it draws stand-ins */}
          <span className="ui-as-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="ui-as-corner__tools">
            <button className="ui-as-icon-btn" type="button" aria-label={sideHidden ? "Show sidebar" : "Hide sidebar"} aria-expanded={!sideHidden} onClick={() => (narrow ? setDrawer((d) => !d) : setCollapsed((c) => !c))}>
              <Icon icon={SidebarLeftIcon} size={16} />
            </button>
            <button className="ui-as-icon-btn" type="button" aria-label="Back">
              <Icon icon={ArrowLeft01Icon} size={16} />
            </button>
            <button className="ui-as-icon-btn" type="button" aria-label="Forward" disabled>
              <Icon icon={ArrowRight01Icon} size={16} />
            </button>
          </span>
        </div>
      )}
      <aside ref={sideRef} className="ui-as-side" inert={sideHidden || overlay === "panel"}>
        {chrome === "mac" ? (
          <>
            <header className="ui-as-side__head" data-chrome="mac" />
            {backLink && <div className="ui-as-side__ws">{backLink}</div>}
          </>
        ) : (
          <header className="ui-as-side__head">
            {(backLink || workspacePlacement === "head") && workspaceMenu}
            <span className="ui-as-side__tools">
              <button className="ui-as-icon-btn" type="button" aria-label={narrow ? "Close sidebar" : rail ? "Expand sidebar" : "Collapse sidebar"} title={rail ? "Expand sidebar" : undefined} onClick={() => (narrow ? setDrawer(false) : setCollapsed((c) => !c))}>
                <Icon icon={SidebarLeftIcon} size={16} />
              </button>
            </span>
          </header>
        )}

        {/* Search, like the affectUI library's: a field with its shortcut */}
        <button ref={searchBtn} className="ui-as-side__search" type="button" title={rail ? "Search ⌘K" : undefined} aria-keyshortcuts="Meta+K" aria-haspopup="dialog" aria-expanded={search} onClick={() => setSearch(true)}>
          <Icon icon={Search01Icon} size={15} />
          <span>Search…</span>
          <kbd>⌘K</kbd>
        </button>

        <nav className="ui-as-side__nav" aria-label="Main menu">
          <div className="ui-as-side__group">
            {nav.map((item, i) => (
              <button
                key={`${i}-${item.label}`}
                type="button"
                className="ui-as-side__item"
                aria-current={active === item.label ? "page" : undefined}
                title={rail ? item.label : undefined}
                onClick={() => go(item.label)}
              >
                <Icon icon={item.icon} size={16} />
                <span className="ui-as-side__text" title={item.label}>
                  {item.label}
                </span>
                {!!item.count && item.count > 0 && <span className="ui-as-side__count" title={item.count.toLocaleString()}>{shortCount(item.count)}</span>}
              </button>
            ))}
          </div>
          {groups ? (
            groups.map((group, gi) => (
              <div key={`${gi}-${group.label}`} className="ui-as-side__group">
                <span className="ui-as-side__label">{group.label}</span>
                {group.items.length === 0 && group.empty && <span className="ui-as-side__empty">{group.empty}</span>}
                {group.items.map((item, i) => (
                  <button
                    key={`${i}-${item.label}`}
                    type="button"
                    className="ui-as-side__item"
                    aria-current={active === item.label ? "page" : undefined}
                    title={rail ? item.label : undefined}
                    onClick={() => go(item.label)}
                  >
                    <Icon icon={item.icon} size={16} />
                    <span className="ui-as-side__text" title={item.label}>
                      {item.label}
                    </span>
                    {!!item.count && item.count > 0 && <span className="ui-as-side__count" title={item.count.toLocaleString()}>{shortCount(item.count)}</span>}
                  </button>
                ))}
              </div>
            ))
          ) : chats ? null : (
            <>
          <span className="ui-as-side__label">Projects</span>
          {projects.length === 0 && <span className="ui-as-side__empty">No projects yet</span>}
          {projects.map((name, i) => (
            <button
              key={`${i}-${name}`}
              type="button"
              className="ui-as-side__item"
              aria-current={active === name ? "page" : undefined}
              title={rail ? name : undefined}
              onClick={() => go(name)}
            >
              <Icon icon={FolderOpenIcon} size={16} />
              <span className="ui-as-side__text" title={name}>
                {name}
              </span>
            </button>
          ))}
            </>
          )}
          {chats && (
            <ChatList
              chats={chats}
              projects={projects}
              rail={rail}
              active={active}
              side={sideRef}
              app={root}
              onOpen={(chat) => (onOpenChat ? onOpenChat(chat) : go(chat.title))}
              onOpenFolder={go}
              folderIcon={folderIcon}
            />
          )}
        </nav>

        <div className="ui-as-side__foot">
          {!back && sideCards && news > 0 && (
            <div className="ui-as-news" data-count={news}>
              <div className="ui-as-news__card ui-as-news__card--back" aria-hidden="true">
                <span className="ui-as-news__kicker">New in {workspace}</span>
                <Icon icon={Cancel01Icon} size={13} />
              </div>
              <div className="ui-as-news__card">
                <div className="ui-as-news__top">
                  <span className="ui-as-news__kicker">New in {workspace}</span>
                  <button
                    type="button"
                    className="ui-as-news__close"
                    aria-label="Dismiss"
                    onClick={() => {
                      // The last card goes away with its button – the focus moves on to Getting started (or the account)
                      if (news === 1) refocus(root.current?.querySelector<HTMLElement>(".ui-as-steps, .ui-as-user"));
                      setNews((n) => n - 1);
                    }}
                  >
                    <Icon icon={Cancel01Icon} size={13} />
                  </button>
                </div>
                <b className="ui-as-news__title">{news > 1 ? "Shared folders" : "Scheduled chats"}</b>
                <button type="button" className="ui-as-news__more">
                  Full changelog
                  <Icon icon={ArrowRight01Icon} size={13} />
                </button>
              </div>
            </div>
          )}

          {/* The card itself grows upward into the full setup guide – one block that morphs, no second panel */}
          {/* The slot keeps the closed card's height in the sidebar; the open card grows over the cards above it */}
          {!back && sideCards && total > 0 && (
          <div className="ui-as-guide-slot" style={closedHeight ? { height: closedHeight } : undefined}>
          <div
            className="ui-as-guide"
            data-open={guide !== "closed" || undefined}
            data-state={guide}
            style={{ height: (guide === "open" ? guideHeight : closedHeight) || undefined }}
          >
            <div ref={guideInner} className="ui-as-guide__inner">
              {guide !== "closed" ? (
                <div className="ui-as-guide__content" key="guide">
                  <SetupGuide
                    title="Getting started"
                    groups={setup.map((g) => ({ ...g, tasks: g.tasks.map((t) => ({ ...t, done: done.includes(t.id) })) }))}
                    onChange={setDone}
                    onClose={() => setGuideOpen(false)}
                  />
                </div>
              ) : (
                <button type="button" className="ui-as-steps ui-as-guide__content" key="summary" aria-expanded={false} onClick={() => setGuideOpen(true)}>
                  <span className="ui-as-steps__title">
                    Getting started
                    <Icon icon={ArrowRight01Icon} size={13} />
                  </span>
                  <span className="ui-as-steps__sub">
                    {pct}% done · <span className="ui-as-steps__cheer">{cheer(pct)}</span>
                  </span>
                  <span className="ui-as-steps__bar">
                    <i style={{ width: `${Math.max(pct, 4)}%` }} />
                  </span>
                </button>
              )}
            </div>
          </div>
          </div>
          )}

          {userMenu ? (
            <span className="ui-as-anchor ui-as-user-menu">
              {userTrigger({ open: userOpen, toggle: () => setUserOpen((o) => !o) })}
              {userAction && (
                <button
                  className="ui-as-icon-btn ui-as-user-action"
                  type="button"
                  aria-label={userAction.label}
                  aria-keyshortcuts={userAction.shortcut}
                  title={userAction.shortcut ? `${userAction.label} ${userAction.shortcut}` : userAction.label}
                  onClick={userAction.onClick}
                >
                  <Icon icon={userAction.icon} size={16} />
                </button>
              )}
              <Popover open={userOpen} onClose={() => setUserOpen(false)} side="top" className="ui-as-user-pop">
                {userMenu(() => setUserOpen(false))}
              </Popover>
            </span>
          ) : (
          <Dropdown
            side="top"
            className="ui-as-user-menu"
            header={
              <span className="ui-as-account">
                {showAvatar ? (
                  <img src={user.avatar} alt="" width={30} height={30} />
                ) : (
                  <span className="ui-as-user__initials">{initials || <Icon icon={UserIcon} size={14} />}</span>
                )}
                <span className="ui-as-account__text">
                  <b>{userName || "Account"}</b>
                  <small>{email}</small>
                </span>
              </span>
            }
            items={[
              {
                label: "Language",
                icon: TranslateIcon,
                submenu: languages.map(({ label, flag }) => ({ label, logo: <Flag code={flag} />, checked: label === language, onSelect: () => setLanguage(label) })),
              },
              {
                label: "Appearance",
                icon: PaintBoardIcon,
                submenu: (
                  [
                    ["System", ComputerIcon],
                    ["Light", Sun03Icon],
                    ["Dark", Moon02Icon],
                  ] as const
                ).map(([m, icon]) => ({ label: m, icon, checked: m === appearance, onSelect: () => setAppearance(m) })),
              },
              { label: "Integrations", icon: Plug01Icon, onSelect: () => go("Integrations") },
              { label: "Settings", icon: Settings01Icon, onSelect: () => go("Profile") },
              { label: "Download apps", icon: Download04Icon, divider: true },
              { label: "Changelog", icon: Clock01Icon, divider: true },
              {
                label: "Learn more",
                icon: InformationCircleIcon,
                submenu: [
                  { label: "Documentation", icon: Book02Icon },
                  { label: "Help & feedback", icon: HelpCircleIcon },
                ],
              },
              { label: "Log out", icon: Logout01Icon, divider: true },
            ]}
            trigger={userTrigger}
          />
          )}
        </div>
      </aside>
      {/* Drag handles on the edges of the main area – wide screens only; in the tab order after the sidebar and before the work area */}
      {!sideHidden && !narrow && !rail && (
        <Resizer edge="left" label="Resize sidebar" value={sideW} {...side} onChange={setSideW} onDrag={setResizing} root={root} />
      )}
      <main className="ui-as-main" inert={!!overlay}>
        {children}
      </main>
      {panel && paneOpen && !narrow && (
        <Resizer edge="right" label={`Resize ${panelTitle.toLowerCase()}`} value={paneW} {...pane} onChange={setPaneW} onDrag={setResizing} root={root} />
      )}
      {panel && (
        <aside className="ui-as-panel" aria-label={panelTitle} inert={!paneOpen || overlay === "side"}>
          <header className="ui-as-panel__head">
            <span className="ui-as-panel__title" title={typeof (panelHeading ?? panelTitle) === "string" ? String(panelHeading ?? panelTitle) : undefined}>
                {panelHeading ?? panelTitle}
              </span>
            <button className="ui-as-icon-btn" type="button" aria-label={`Close ${panelTitle.toLowerCase()}`} onClick={() => setPaneOpen(false)}>
              <Icon icon={SidebarRightIcon} size={16} />
            </button>
          </header>
          <div className="ui-as-panel__body">{panel}</div>
        </aside>
      )}
    </div>
  );
}

/**
 * The edge between the main area and a sidebar: drag it, use the arrow keys, or double-click it for the default width.
 * On hover the whole edge of the page darkens. The pointer's travel is divided by the app's scale, so a scaled-down
 * preview still follows the pointer exactly.
 */
function Resizer({
  edge,
  label,
  value,
  default: initial,
  min,
  max,
  onChange,
  onDrag,
  root,
}: {
  edge: "left" | "right";
  label: string;
  value: number;
  default: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onDrag: (dragging: boolean) => void;
  root: RefObject<HTMLDivElement | null>;
}) {
  const start = useRef<{ x: number; width: number; scale: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const sign = edge === "left" ? 1 : -1;
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = root.current;
    const scale = el && el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
    start.current = { x: e.clientX, width: value, scale: scale || 1 };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    setDragging(true);
    onDrag(true);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    onChange(clamp(Math.round(s.width + ((e.clientX - s.x) / s.scale) * sign), min, max));
  };
  const up = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    onDrag(false);
  };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onChange(clamp(value + (e.key === "ArrowRight" ? step : -step) * sign, min, max));
    }
    if (e.key === "Home") onChange(min);
    if (e.key === "End") onChange(max);
  };
  return (
    <div
      className="ui-as-resizer"
      data-edge={edge}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={() => onChange(initial)}
      onKeyDown={key}
    />
  );
}

/* ---------- Shared parts ---------- */


/** Value that works controlled (value + onChange) or on its own (defaultValue) */
function useControlled<T>(value: T | undefined, fallback: T, onChange?: (v: T) => void): [T, (v: T) => void] {
  const [inner, setInner] = useState(fallback);
  return [value ?? inner, (v: T) => (setInner(v), onChange?.(v))];
}

/**
 * Tabs and radio groups are one stop for Tab: the arrow keys (and Home, End) move between their options and pick
 * the one they land on – focus follows, inside the group's own buttons
 */
export function rove<T extends string>(e: ReactKeyboardEvent<HTMLElement>, items: readonly T[], current: T, pick: (item: T) => void) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  const at = items.indexOf(current);
  const next = step ? items[(at + step + items.length) % items.length] : e.key === "Home" ? items[0] : e.key === "End" ? items[items.length - 1] : undefined;
  if (next === undefined) return;
  e.preventDefault();
  pick(next);
  const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')];
  buttons[items.indexOf(next)]?.focus();
}

/** Segmented tabs: a soft gray pill slides to the active tab */
export function Tabs({
  items,
  value,
  defaultValue,
  onChange,
  controls,
}: {
  items: string[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** The id of the panel a tab shows, for aria-controls – leave out when there is none */
  controls?: (item: string) => string | undefined;
}) {
  const [current, setCurrent] = useControlled(value, defaultValue ?? items[0], onChange);
  const list = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  // The pill follows the active tab; measured from the layout, so it is right at any size
  useLayoutEffect(() => {
    const tab = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tab) setPill({ x: tab.offsetLeft, w: tab.offsetWidth });
  }, [current, items.join("|")]);

  return (
    <div ref={list} className="ui-as-tabs" role="tablist" onKeyDown={(e) => rove(e, items, current, setCurrent)}>
      {pill && <span className="ui-as-tabs__pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} aria-hidden="true" />}
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={current === item}
          aria-controls={controls?.(item)}
          tabIndex={current === item || !items.includes(current) ? 0 : -1}
          className="ui-as-tabs__tab"
          onClick={() => setCurrent(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

/** The page's title in the header, with a chevron – a button, so it can open a menu (rename, move, delete…) */
export function BarTitle({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" className="ui-as-bar__pick" title={typeof children === "string" ? children : undefined} onClick={onClick}>
      <span>{children}</span>
      <Icon icon={ArrowDown01Icon} size={13} />
    </button>
  );
}

export function IconButton({ icon, label, onClick, pressed }: { icon: IconSvgElement; label: string; onClick?: () => void; pressed?: boolean }) {
  return (
    <button type="button" className="ui-as-tool" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
      <Icon icon={icon} size={15} />
    </button>
  );
}

export type SortDir = "asc" | "desc";

/** Flips between A–Z and Z–A; the icon turns with it */
export function SortButton({ value, onChange }: { value?: SortDir; onChange?: (dir: SortDir) => void }) {
  const [dir, setDir] = useControlled<SortDir>(value, "asc", onChange);
  return (
    <button
      type="button"
      className="ui-as-tool ui-as-sort"
      data-dir={dir}
      aria-label={dir === "asc" ? "Sorted A to Z – sort Z to A" : "Sorted Z to A – sort A to Z"}
      title={dir === "asc" ? "A–Z" : "Z–A"}
      onClick={() => setDir(dir === "asc" ? "desc" : "asc")}
    >
      <Icon icon={ArrowUpDownIcon} size={15} />
    </button>
  );
}

export type ViewMode = "grid" | "list";

export function ViewToggle({ value, onChange }: { value?: ViewMode; onChange?: (view: ViewMode) => void }) {
  const [view, setView] = useControlled<ViewMode>(value, "grid", onChange);
  return (
    <div className="ui-as-view" role="radiogroup" aria-label="View" data-view={view} onKeyDown={(e) => rove(e, ["grid", "list"] as const, view, setView)}>
      <span className="ui-as-view__pill" aria-hidden="true" />
      {(
        [
          ["grid", GridViewIcon, "Grid"],
          ["list", LeftToRightListBulletIcon, "List"],
        ] as const
      ).map(([id, icon, label]) => (
        <button key={id} type="button" role="radio" aria-checked={view === id} tabIndex={view === id ? 0 : -1} aria-label={label} className="ui-as-view__btn" onClick={() => setView(id)}>
          <Icon icon={icon} size={15} />
        </button>
      ))}
    </div>
  );
}

export function SearchField({
  placeholder,
  width = 175,
  value,
  onChange,
}: {
  placeholder: string;
  width?: number;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const [text, setText] = useControlled(value, "", onChange);
  return (
    <label className="ui-as-search" style={{ width }}>
      <Icon icon={Search01Icon} size={15} />
      <input type="search" placeholder={placeholder} aria-label={placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setText("")} />
      {text && (
        <button type="button" className="ui-as-search__clear" aria-label="Clear search" onClick={() => setText("")}>
          <Icon icon={Cancel01Icon} size={12} />
        </button>
      )}
    </label>
  );
}

/** The nearest ancestor that cuts off what sticks out (a scroll area), or the screen itself */
function clipBox(el: HTMLElement) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX) || node.classList.contains("ui-as")) return node.getBoundingClientRect();
  }
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/**
 * Small floating panel attached to its trigger. Opens on the preferred side and flips to the other side
 * (or edge) when it would stick out of the screen or its scroll area – it is always fully reachable.
 * Closes on a click outside or Escape; fades and scales in from the side it is attached to.
 */
export function Popover({
  open,
  onClose,
  children,
  align = "start",
  side = "bottom",
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top" | "right";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ side, align });

  // Measure before paint: flip up when there is no room below, flip sideways at the right or left edge
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    let next = { side, align };
    el.dataset.side = side;
    el.dataset.align = align;
    const box = clipBox(el);
    const r = el.getBoundingClientRect();
    if (side === "bottom" && r.bottom > box.bottom - 6) next = { ...next, side: "top" };
    if (side === "top" && r.top < box.top + 6) next = { ...next, side: "bottom" };
    if (align === "start" && r.right > box.right - 6) next = { ...next, align: "end" };
    if (align === "end" && r.left < box.left + 6) next = { ...next, align: "start" };
    // Still sticking out on a narrow screen (neither edge fits): slide it sideways until it is inside
    el.dataset.side = next.side;
    el.dataset.align = next.align;
    el.style.translate = "";
    const r2 = el.getBoundingClientRect();
    const scale = r2.width / el.offsetWidth || 1;
    let dx = 0;
    if (r2.right > box.right - 6) dx = box.right - 6 - r2.right;
    if (r2.left + dx < box.left + 6) dx = box.left + 6 - r2.left;
    if (dx) el.style.translate = `${dx / scale}px 0`;
    setPlace(next);
  }, [open, side, align]);

  // A menu takes the focus on its first item (or the checked one); its trigger gets it back when Escape closes it
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    focusMenu(el.querySelector<HTMLElement>('[role="menu"]'));
    // However it closes (Escape, a pick, a form sent, the screen's own close): if the focus was inside, the trigger gets it back
    const anchor = el.parentElement;
    let inside = el.contains(document.activeElement);
    const into = () => (inside = true);
    const away = (e: FocusEvent) => (inside = !!e.relatedTarget && el.contains(e.relatedTarget as Node));
    el.addEventListener("focusin", into);
    el.addEventListener("focusout", away);
    return () => {
      el.removeEventListener("focusin", into);
      el.removeEventListener("focusout", away);
      if (inside) refocus(anchorTrigger(anchor));
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const anchor = ref.current?.parentElement;
    // The trigger: the anchor's first focusable element outside the popover
    const trigger = () => anchorTrigger(anchor ?? null);
    const down = (e: PointerEvent) => {
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    // Caught first (window, capture), so a screen's own Escape – e.g. closing a detail view – doesn't fire as well
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const inside = anchor?.contains(document.activeElement);
      onClose();
      if (inside) trigger()?.focus({ preventScroll: true });
    };
    // Tabbing out of the trigger and its popover closes it
    const out = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to && anchor && !anchor.contains(to)) onClose();
    };
    document.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key, true);
    anchor?.addEventListener("focusout", out);
    return () => {
      document.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key, true);
      anchor?.removeEventListener("focusout", out);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={["ui-as-popover", className].filter(Boolean).join(" ")} data-align={place.align} data-side={place.side} role="dialog">
      {children}
    </div>
  );
}

export type MenuItem = {
  label: string;
  /** Second line in a lighter color */
  description?: string;
  icon?: IconSvgElement;
  /** A brand mark (Gmail, Slack …) in place of the icon, at 16px */
  logo?: ReactNode;
  /** Shows a check – for choices like a model or a period */
  checked?: boolean;
  /** Red text, e.g. Delete */
  danger?: boolean;
  /** A keyboard shortcut on the right, e.g. "⌥⌘R" */
  shortcut?: string;
  /** A line above this item, to group the ones after it */
  divider?: boolean;
  /** More choices that open to the side on hover or focus */
  submenu?: MenuItem[];
  /** A small gray title over the items after it, not something to pick – its description sits at its end */
  heading?: boolean;
  /** Shown but not pickable, e.g. a host that is offline */
  disabled?: boolean;
  onSelect?: () => void;
};

/** The items of one menu level – not the ones in its submenus */
const menuItems = (menu: Element | null) =>
  menu ? [...menu.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]:not(:disabled), :scope > .ui-as-menu__sub > [role^="menuitem"]')] : [];

/** Focuses a menu's checked item, or its first one */
function focusMenu(menu: HTMLElement | null) {
  const items = menuItems(menu);
  (items.find((i) => i.getAttribute("aria-checked") === "true") ?? items[0])?.focus({ preventScroll: true });
}

/**
 * Arrow keys move through a menu's items (wrapping), Home and End jump to the ends; on an item with a submenu
 * Arrow Right, Enter or Space step into it, Arrow Left steps back out
 */
function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
  const menu = e.currentTarget;
  const items = menuItems(menu);
  const at = items.indexOf(document.activeElement as HTMLElement);
  const sub = (document.activeElement as HTMLElement | null)?.closest(".ui-as-menu__sub");
  const go = (i: number) => {
    e.preventDefault();
    e.stopPropagation();
    items[(i + items.length) % items.length]?.focus();
  };
  if (e.key === "ArrowDown") go(at + 1);
  else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
  else if (at >= 0 && sub?.parentElement === menu && ["ArrowRight", "Enter", " "].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    focusMenu(sub.querySelector<HTMLElement>('[role="menu"]'));
  } else if (e.key === "ArrowLeft" && menu.parentElement?.classList.contains("ui-as-menu__subpanel")) {
    e.preventDefault();
    e.stopPropagation();
    menu.closest(".ui-as-menu__sub")?.querySelector<HTMLElement>(':scope > [role^="menuitem"]')?.focus();
  }
}

/** List of actions or choices inside a popover */
export function MenuList({ items, onPick }: { items: MenuItem[]; onPick: () => void }) {
  return (
    <div role="menu" className="ui-as-menu__list" onKeyDown={onMenuKey}>
      {items.length === 0 && <span className="ui-as-menu__empty">Nothing here yet</span>}
      {items.map((item, i) => {
        const face = (
          <>
            {item.logo ? <span className="ui-as-menu__logo" aria-hidden="true">{item.logo}</span> : item.icon && <Icon icon={item.icon} size={15} />}
            <span className="ui-as-menu__label" title={item.label}>
              <span className="ui-as-menu__text">{item.label}</span>
              {item.description && <small>{item.description}</small>}
            </span>
            {item.shortcut && <kbd className="ui-as-menu__kbd">{item.shortcut}</kbd>}
            {item.submenu && <Icon icon={ArrowRight01Icon} size={14} />}
            {item.checked && <Icon icon={Tick02Icon} size={14} />}
          </>
        );
        if (item.heading)
          return (
            <Fragment key={`${i}-${item.label}`}>
              {item.divider && <span className="ui-as-menu__sep" role="separator" />}
              <span className="ui-as-menu__heading" role="presentation">
                {item.logo ? <span className="ui-as-menu__logo" aria-hidden="true">{item.logo}</span> : item.icon && <Icon icon={item.icon} size={13} />}
                <span className="ui-as-menu__text">{item.label}</span>
                {item.description && <span className="ui-as-menu__heading-note">{item.description}</span>}
              </span>
            </Fragment>
          );
        return (
          <Fragment key={`${i}-${item.label}`}>
            {item.divider && <span className="ui-as-menu__sep" role="separator" />}
            {item.submenu ? (
              // Opens to the side while the pointer or focus is on it
              <span className="ui-as-menu__sub">
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  tabIndex={-1}
                  className="ui-as-menu__item"
                  // A click (or tap – no hover on touch) opens it too and keeps it open
                  onClick={(e) => {
                    const sub = e.currentTarget.parentElement;
                    sub?.parentElement?.querySelectorAll(":scope > .ui-as-menu__sub[data-open]").forEach((other) => other !== sub && other.removeAttribute("data-open"));
                    sub?.toggleAttribute("data-open");
                  }}
                >
                  {face}
                </button>
                <span className="ui-as-menu ui-as-menu__subpanel">
                  <MenuList items={item.submenu} onPick={onPick} />
                </span>
              </span>
            ) : (
              <button
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                tabIndex={-1}
                className="ui-as-menu__item"
                data-danger={item.danger || undefined}
                data-rich={item.description ? true : undefined}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect?.();
                  onPick();
                }}
              >
                {face}
              </button>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** The first control inside an element that is shown and reachable by Tab */
const firstFocusable = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]")].find(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
  );

/** After a pick the menu is gone – its trigger takes the focus back, unless the pick moved it somewhere (e.g. a rename field) */
const refocus = (trigger: HTMLElement | null | undefined) =>
  window.setTimeout(() => {
    const at = document.activeElement;
    if (trigger?.isConnected && (!at || at === document.body)) trigger.focus({ preventScroll: true });
  });

/** The first focusable element of a menu's anchor that isn't inside its popover – the trigger */
const anchorTrigger = (anchor: HTMLElement | null) => anchor?.querySelector<HTMLElement>(":scope > :is(button, [href], [tabindex])") ?? anchor?.querySelector<HTMLElement>("button") ?? null;

/** Arrow Down or Up on a menu's closed trigger opens the menu, like Enter and Space do */
const openOnArrow = (open: boolean, setOpen: (open: boolean) => void) => (e: ReactKeyboardEvent<HTMLElement>) => {
  if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || (e.target as HTMLElement).closest(".ui-as-popover")) return;
  e.preventDefault();
  setOpen(true);
};

/** Any trigger with a menu: the trigger gets the open state and a toggle */
export function Dropdown({
  trigger,
  items,
  align = "start",
  side = "bottom",
  title,
  header,
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  side?: "bottom" | "top";
  /** Small heading above the items */
  title?: string;
  /** Anything above the items, e.g. who is signed in */
  header?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <span ref={anchor} className={["ui-as-anchor", className].filter(Boolean).join(" ")} onKeyDown={openOnArrow(open, setOpen)}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      <Popover open={open} onClose={() => setOpen(false)} align={align} side={side} className="ui-as-menu">
        {header}
        {title && <span className="ui-as-menu__title">{title}</span>}
        <MenuList
          items={items}
          onPick={() => {
            setOpen(false);
            refocus(anchorTrigger(anchor.current));
          }}
        />
      </Popover>
    </span>
  );
}

/** Opens the library's Filter Menu in a popover; the button shows how many filters are on */
export function FilterButton({
  label,
  groups,
  value,
  onChange,
  align = "end",
}: {
  label: string;
  groups: FilterGroup[];
  value: FilterValue;
  onChange: (value: FilterValue) => void;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const count = Object.values(value).reduce((n, ids) => n + ids.length, 0);
  return (
    <span className="ui-as-anchor">
      <button type="button" className="ui-as-tool ui-as-tool--label" aria-expanded={open} data-active={count > 0 || undefined} onClick={() => setOpen((o) => !o)}>
        <Icon icon={FilterIcon} size={15} />
        {label}
        {count > 0 ? <span className="ui-as-tool__count">{count}</span> : <Icon icon={ArrowDown01Icon} size={13} />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align={align} className="ui-as-popover--filter">
        <FilterMenu groups={groups} value={value} onChange={onChange} defaultOpen={groups.map((g) => g.id)} hints={false} title={label} />
      </Popover>
    </span>
  );
}

/** Plain menu of choices in a popover, e.g. a period picker */
export function MenuButton<T extends string>({
  value,
  options,
  onChange,
  icon,
  align = "end",
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  icon?: IconSvgElement;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <span ref={anchor} className="ui-as-anchor" onKeyDown={openOnArrow(open, setOpen)}>
      <button type="button" className={["ui-as-tool ui-as-tool--label", className].filter(Boolean).join(" ")} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        {icon && <Icon icon={icon} size={15} />}
        {current?.label}
        <Icon icon={ArrowDown01Icon} size={13} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align={align} className="ui-as-menu">
        <MenuList
          items={options.map((o) => ({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) }))}
          onPick={() => {
            setOpen(false);
            refocus(anchorTrigger(anchor.current));
          }}
        />
      </Popover>
    </span>
  );
}

/** Short confirmation at the bottom of the main area – "Saved to Reports" */
export function useToast() {
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);
  const show = (text: string) => setToast({ id: Date.now(), text });
  const node = toast ? (
    <div key={toast.id} className="ui-as-toast" role="status">
      <Icon icon={Tick02Icon} size={14} />
      <span className="ui-as-toast__text">{toast.text}</span>
    </div>
  ) : null;
  return [node, show] as const;
}

/** A section's head: a small uppercase title (with an optional count), then its tabs and tools */
export function SectionHead({ title, count, left, right }: { title: string; count?: number; left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="ui-as-section-head" data-inline={!left || undefined}>
      <h2 className="ui-as-section-head__title">
        {title}
        {count != null && <span className="ui-as-section-head__count">{count}</span>}
      </h2>
      {(left || right) && (
        <div className="ui-as-toolbar">
          <div className="ui-as-toolbar__left">{left}</div>
          <div className="ui-as-toolbar__right">{right}</div>
        </div>
      )}
    </div>
  );
}

/** `bare`: without the dashed frame – the page's only content, e.g. inside .ui-as-center */
export function EmptyState({ title, text, action, tall, bare }: { title: string; text: string; action?: ReactNode; tall?: boolean; bare?: boolean }) {
  return (
    <div className="ui-as-empty" data-tall={tall || undefined} data-bare={bare || undefined}>
      <span className="ui-as-empty__icon">
        <Icon icon={File02Icon} size={18} />
      </span>
      <b className="ui-as-empty__title">{title}</b>
      <p className="ui-as-empty__text">{text}</p>
      {action}
    </div>
  );
}

/* ---------- Chats in the sidebar ---------- */

/** Pinned chats on top, the rest below; each row has a ⋯ menu and a pin on hover, and can be dragged into place */
function ChatList({
  chats,
  projects,
  rail,
  active,
  side,
  app,
  onOpen,
  onOpenFolder,
  folderIcon,
}: {
  folderIcon?: ReactNode | ((open: boolean) => ReactNode);
  chats: ShellChat[];
  projects: string[];
  rail: boolean;
  active?: string;
  side: RefObject<HTMLElement | null>;
  app: RefObject<HTMLDivElement | null>;
  onOpen: (chat: ShellChat) => void;
  /** Opens a project's own page */
  onOpenFolder: (name: string) => void;
}) {
  const [list, setList] = useState(chats);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; left: number; below: number; above: number } | null>(null);
  // What is being dragged: a chat (by id) or a folder (by name)
  const [drag, setDragState] = useState<{ kind: "chat" | "folder"; id: string } | null>(null);
  const setDrag = (id: string | null) => setDragState(id === null ? null : { kind: "chat", id });
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  // The projects as folders, in their own order; pinned ones move up under Pinned
  const [folders, setFolders] = useState(() => projects.map((name) => ({ name, pinned: false })));
  // Folders that are open – the first one to start with
  const [openFolders, setOpenFolders] = useState(() => new Set(projects.slice(0, 1)));
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const toggleFolder = (name: string, open?: boolean) =>
    setOpenFolders((set) => {
      const next = new Set(set);
      if (open ?? !next.has(name)) next.add(name);
      else next.delete(name);
      return next;
    });
  const panel = useRef<HTMLDivElement>(null);
  const [toast, showToast] = useToast();

  const update = (id: string, change: Partial<ShellChat>) => setList((l) => l.map((c) => (c.id === id ? { ...c, ...change } : c)));
  const togglePin = (chat: ShellChat) => {
    // A newly pinned chat goes to the end of the pinned ones, an unpinned one to the top of the rest
    setList((l) => {
      const rest = l.filter((c) => c.id !== chat.id);
      const moved = { ...chat, pinned: !chat.pinned };
      const at = moved.pinned ? rest.filter((c) => c.pinned).length : rest.findIndex((c) => !c.pinned);
      rest.splice(at < 0 ? rest.length : at, 0, moved);
      return rest;
    });
  };
  const archive = (chat: ShellChat) => {
    setList((l) => l.filter((c) => c.id !== chat.id));
    showToast(`“${chat.title}” archived`);
  };
  const copy = (text: string, done: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast(done);
  };

  // Drop a dragged chat before or after another one – into that one's section
  const drop = (targetId: string, after: boolean) => {
    if (drag?.kind !== "chat" || drag.id === targetId) return;
    const id = drag.id;
    setList((l) => {
      const moving = l.find((c) => c.id === id);
      const target = l.find((c) => c.id === targetId);
      if (!moving || !target) return l;
      const rest = l.filter((c) => c.id !== id);
      const at = rest.findIndex((c) => c.id === targetId) + (after ? 1 : 0);
      rest.splice(at, 0, { ...moving, pinned: target.pinned, folder: target.pinned ? moving.folder : target.folder });
      return rest;
    });
  };
  // Dropped on a folder: the chat goes to the end of that folder, which opens
  const dropInto = (name: string) => {
    if (drag?.kind !== "chat") return;
    const id = drag.id;
    setList((l) => {
      const moving = l.find((c) => c.id === id);
      if (!moving) return l;
      return [...l.filter((c) => c.id !== id), { ...moving, folder: name, pinned: false }];
    });
    toggleFolder(name, true);
  };
  // A folder dropped before or after another one takes its place – and its section, pinned or not
  const moveFolder = (name: string, targetName: string, after: boolean) => {
    if (name === targetName) return;
    setFolders((f) => {
      const moving = f.find((x) => x.name === name);
      const target = f.find((x) => x.name === targetName);
      if (!moving || !target) return f;
      const rest = f.filter((x) => x.name !== name);
      rest.splice(rest.findIndex((x) => x.name === targetName) + (after ? 1 : 0), 0, { ...moving, pinned: target.pinned });
      return rest;
    });
  };
  const togglePinFolder = (name: string) =>
    setFolders((f) => {
      const moving = f.find((x) => x.name === name);
      if (!moving) return f;
      const rest = f.filter((x) => x.name !== name);
      const moved = { ...moving, pinned: !moving.pinned };
      const at = moved.pinned ? rest.filter((x) => x.pinned).length : rest.findIndex((x) => !x.pinned);
      rest.splice(at < 0 ? rest.length : at, 0, moved);
      return rest;
    });

  // A folder's own menu: rename it, move it between the sections, open its page, archive its chats or remove it
  const renameFolder = (from: string, to: string) => {
    const name = to.trim();
    setRenamingFolder(null);
    if (!name || name === from || folders.some((f) => f.name === name)) return;
    setFolders((f) => f.map((x) => (x.name === from ? { ...x, name } : x)));
    setList((l) => l.map((c) => (c.folder === from ? { ...c, folder: name } : c)));
    setOpenFolders((set) => new Set([...set].map((x) => (x === from ? name : x))));
  };
  const folderItems = (name: string, pinned: boolean): MenuItem[] => {
    const inside = list.filter((c) => c.folder === name);
    return [
      { label: pinned ? "Unpin" : "Pin", icon: pinned ? PinOffIcon : PinIcon, onSelect: () => togglePinFolder(name) },
      { label: "Rename", icon: PencilEdit02Icon, onSelect: () => setRenamingFolder(name) },
      {
        label: "Section",
        icon: ListViewIcon,
        divider: true,
        submenu: [
          { label: "Pinned", icon: PinIcon, checked: pinned, onSelect: () => !pinned && togglePinFolder(name) },
          { label: "Projects", icon: Folder01Icon, checked: !pinned, onSelect: () => pinned && togglePinFolder(name) },
        ],
      },
      { label: "Open project page", icon: FolderOpenIcon, onSelect: () => onOpenFolder(name) },
      {
        label: "Archive chats",
        icon: Archive02Icon,
        divider: true,
        onSelect: () => {
          setList((l) => l.filter((c) => c.folder !== name));
          showToast(inside.length ? `${inside.length} ${inside.length === 1 ? "chat" : "chats"} archived` : "No chats to archive");
        },
      },
      {
        label: "Remove project",
        icon: Cancel01Icon,
        divider: true,
        onSelect: () => {
          // Its chats stay – they move to the loose chats
          setFolders((f) => f.filter((x) => x.name !== name));
          setList((l) => l.map((c) => (c.folder === name ? { ...c, folder: undefined } : c)));
          showToast(`“${name}” removed`);
        },
      },
    ];
  };

  // The picture that follows the pointer: a copy of the row on the card's white with rounded corners, no edge, drawn outside
  // the scrolling list, so nothing shows through it and nothing cuts it off
  const lift = (e: ReactDragEvent<HTMLElement>, label: string, start: () => void) => {
    const row = e.currentTarget;
    const item = row.querySelector<HTMLElement>(".ui-as-side__item") ?? row;
    const look = getComputedStyle(item);
    const tokens = getComputedStyle(row);
    const ghost = item.cloneNode(true) as HTMLElement;
    ghost.querySelector(".ui-as-chat-folder__arrow")?.remove();
    Object.assign(ghost.style, {
      position: "fixed",
      top: "-1000px",
      left: "0",
      width: `${item.offsetWidth}px`,
      height: `${item.offsetHeight}px`,
      display: "flex",
      alignItems: "center",
      gap: look.gap,
      padding: look.padding,
      boxSizing: "border-box",
      borderRadius: "8px",
      background: tokens.getPropertyValue("--card").trim() || "#ffffff",
      border: "0",
      outline: "0",
      boxShadow: "none",
      font: look.font,
      color: look.color,
      whiteSpace: "nowrap",
      overflow: "hidden",
      pointerEvents: "none",
    });
    ghost.querySelectorAll<HTMLElement>("svg").forEach((svg) => (svg.style.flex = "none"));
    document.body.appendChild(ghost);
    const box = row.getBoundingClientRect();
    e.dataTransfer.setDragImage(ghost, Math.min(e.clientX - box.left, item.offsetWidth), e.clientY - box.top);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", label);
    setMenu(null);
    // The browser takes the picture right after this handler – then the copy goes and the row fades in its place
    window.setTimeout(() => {
      ghost.remove();
      start();
    });
  };
  const endDrag = () => {
    setDragState(null);
    setOver(null);
    setDropFolder(null);
  };

  // The menu opens under its ⋯ button – drawn in the sidebar, so the scrolling list doesn't cut it off – or above it near the bottom
  const openMenu = (id: string, button: HTMLElement) => {
    const box = side.current?.getBoundingClientRect();
    if (!box || !side.current) return;
    const r = button.getBoundingClientRect();
    const scale = box.width / side.current.offsetWidth || 1;
    setMenu((m) => (m?.id === id ? null : { id, left: (r.left - box.left) / scale, below: (r.bottom - box.top) / scale + 4, above: (r.top - box.top) / scale - 4 }));
  };
  useLayoutEffect(() => {
    const el = panel.current;
    if (!menu || !el || !side.current) return;
    const room = side.current.offsetHeight - 8;
    el.style.top = `${menu.below + el.offsetHeight > room ? Math.max(8, menu.above - el.offsetHeight) : menu.below}px`;
    // Never past the sidebar's right edge – on a phone the drawer is narrower than the menu's usual reach
    el.style.left = `${Math.max(8, Math.min(menu.left, side.current.offsetWidth - el.offsetWidth - 8))}px`;
  }, [menu, side]);
  // The menu's ⋯ button – the focus returns to it when the menu closes from the keyboard
  const menuButton = (id: string) => side.current?.querySelector<HTMLElement>(`[data-chat-menu="${CSS.escape(id)}"]`);
  const menuId = menu?.id;
  useEffect(() => {
    if (menuId) focusMenu(panel.current?.querySelector<HTMLElement>('[role="menu"]') ?? null);
  }, [menuId]);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!panel.current?.contains(t) && !t.closest?.(`[data-chat-menu="${CSS.escape(menu.id)}"]`)) setMenu(null);
    };
    // First in line, so the drawer around it stays open
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (panel.current?.contains(document.activeElement)) menuButton(menu.id)?.focus({ preventScroll: true });
      setMenu(null);
    };
    const scroll = () => setMenu(null);
    const nav = side.current?.querySelector(".ui-as-side__nav");
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key, true);
    nav?.addEventListener("scroll", scroll);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key, true);
      nav?.removeEventListener("scroll", scroll);
    };
  }, [menu, side]);

  const itemsFor = (chat: ShellChat): MenuItem[] => [
    { label: "Rename", icon: PencilEdit02Icon, shortcut: "⌥⌘R", onSelect: () => setRenaming(chat.id) },
    { label: chat.pinned ? "Unpin" : "Pin", icon: chat.pinned ? PinOffIcon : PinIcon, shortcut: "⌥⌘P", onSelect: () => togglePin(chat) },
    { label: chat.unread ? "Mark as read" : "Mark as unread", icon: ViewIcon, shortcut: "⇧⌘U", onSelect: () => update(chat.id, { unread: !chat.unread }) },
    {
      label: "Project",
      icon: Folder01Icon,
      submenu: [
        ...folders.map(({ name }) => ({
          label: name,
          icon: FolderOpenIcon,
          checked: chat.folder === name,
          onSelect: () => {
            update(chat.id, { folder: name });
            if (!chat.pinned) toggleFolder(name, true);
          },
        })),
        { label: "No project", divider: true, checked: !chat.folder, onSelect: () => update(chat.id, { folder: undefined }) },
      ],
    },
    {
      label: "Section",
      icon: ListViewIcon,
      submenu: [
        { label: "Pinned", icon: PinIcon, checked: !!chat.pinned, onSelect: () => !chat.pinned && togglePin(chat) },
        { label: "Chats", icon: BubbleChatIcon, checked: !chat.pinned, onSelect: () => chat.pinned && togglePin(chat) },
      ],
    },
    { label: "Share", icon: Share08Icon, divider: true, onSelect: () => copy(`${location.origin}/chat/${chat.id}`, "Share link copied") },
    {
      label: "Copy",
      icon: Copy01Icon,
      submenu: [
        { label: "Copy link", icon: Link01Icon, onSelect: () => copy(`${location.origin}/chat/${chat.id}`, "Link copied") },
        { label: "Copy as Markdown", icon: File02Icon, onSelect: () => copy(`# ${chat.title}`, "Chat copied as Markdown") },
        { label: "Copy chat ID", icon: Copy01Icon, onSelect: () => copy(chat.id, "Chat ID copied") },
      ],
    },
    { label: "Open in new window", icon: SquareArrowUpRight02Icon, divider: true, onSelect: () => showToast("Opening in a new window") },
    { label: "Archive", icon: Archive02Icon, shortcut: "⇧⌘A", divider: true, onSelect: () => archive(chat) },
  ];

  // The menu's shortcuts work on the focused row
  const onKey = (chat: ShellChat) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!e.metaKey || renaming) return;
    const run = e.altKey
      ? { KeyR: () => setRenaming(chat.id), KeyP: () => togglePin(chat) }[e.code]
      : e.shiftKey
        ? { KeyU: () => update(chat.id, { unread: !chat.unread }), KeyA: () => archive(chat) }[e.code]
        : undefined;
    if (run) {
      e.preventDefault();
      run();
    }
  };

  const folderNames = folders.map((f) => f.name);
  const row = (chat: ShellChat, inFolder = false) => (
    <div
      key={chat.id}
      className="ui-as-chat-row"
      data-indent={inFolder || undefined}
      draggable={renaming !== chat.id}
      data-dragging={drag?.id === chat.id || undefined}
      data-drop={over?.id === chat.id && drag?.kind === "chat" && drag.id !== chat.id ? (over.after ? "after" : "before") : undefined}
      data-menu={menu?.id === chat.id || undefined}
      data-pinned={chat.pinned || undefined}
      onKeyDown={onKey(chat)}
      onDragStart={(e) => lift(e, chat.title, () => setDrag(chat.id))}
      onDragOver={(e) => {
        if (drag?.kind !== "chat") return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        if (over?.id !== chat.id || over.after !== after) setOver({ id: chat.id, after });
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (over) drop(over.id, over.after);
        endDrag();
      }}
      onDragEnd={endDrag}
    >
      {renaming === chat.id ? (
        <input
          className="ui-as-chat-row__rename"
          defaultValue={chat.title}
          aria-label="Chat name"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            const title = e.currentTarget.value.trim();
            if (title) update(chat.id, { title });
            setRenaming(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.currentTarget.value = chat.title;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="ui-as-side__item ui-as-chat-row__link"
          aria-current={active === chat.title ? "page" : undefined}
          onClick={() => {
            if (chat.unread) update(chat.id, { unread: false });
            onOpen(chat);
          }}
        >
          {chat.logo && (
            <span className="ui-as-chat-row__logo" aria-hidden="true">
              {chat.logo}
            </span>
          )}
          <span className="ui-as-side__text" title={chat.title} dir="auto">
            {chat.title}
          </span>
          {chat.unread && <span className="ui-as-chat-row__dot" aria-label="Unread" />}
        </button>
      )}
      <span className="ui-as-chat-row__tools">
        <button
          type="button"
          className="ui-as-chat-row__tool"
          aria-label={`Options for ${chat.title}`}
          aria-haspopup="menu"
          aria-expanded={menu?.id === chat.id}
          data-chat-menu={chat.id}
          onClick={(e) => openMenu(chat.id, e.currentTarget)}
        >
          <Icon icon={MoreHorizontalIcon} size={15} />
        </button>
        <button
          type="button"
          className="ui-as-chat-row__tool ui-as-chat-row__pin"
          aria-label={chat.pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
          aria-pressed={!!chat.pinned}
          // One stop per row for the keyboard: pinning is also in the ⋯ menu and on ⌥⌘P
          tabIndex={-1}
          onClick={() => togglePin(chat)}
        >
          <Icon icon={chat.pinned ? PinOffIcon : PinIcon} size={14} />
        </button>
      </span>
    </div>
  );

  // A folder: opens and closes on a click, takes chats dropped on it, can be pinned and dragged into another place
  const folderRow = ({ name, pinned }: { name: string; pinned: boolean }) => {
    const inside = list.filter((c) => !c.pinned && c.folder === name);
    const isOpen = openFolders.has(name);
    const overMe = over?.id === `folder:${name}` && drag?.kind === "folder" && drag.id !== name;
    return (
      <Fragment key={name}>
        <div
          className="ui-as-chat-folder-row"
          draggable={renamingFolder !== name}
          data-menu={menu?.id === `folder:${name}` || undefined}
          data-dragging={(drag?.kind === "folder" && drag.id === name) || undefined}
          data-drop={overMe ? (over.after ? "after" : "before") : undefined}
          onDragStart={(e) => lift(e, name, () => setDragState({ kind: "folder", id: name }))}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            if (drag.kind === "chat") {
              setDropFolder(name);
              setOver(null);
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            if (over?.id !== `folder:${name}` || over.after !== after) setOver({ id: `folder:${name}`, after });
          }}
          onDragLeave={() => setDropFolder((f) => (f === name ? null : f))}
          onDrop={(e) => {
            e.preventDefault();
            if (drag?.kind === "chat") dropInto(name);
            else if (drag?.kind === "folder" && over) moveFolder(drag.id, name, over.after);
            endDrag();
          }}
          onDragEnd={endDrag}
        >
          {renamingFolder === name ? (
            <input
              className="ui-as-chat-row__rename ui-as-chat-folder__rename"
              defaultValue={name}
              aria-label="Project name"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => renameFolder(name, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.currentTarget.value = name;
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="ui-as-side__item ui-as-chat-folder"
              aria-expanded={isOpen}
              title={rail ? name : undefined}
              data-drop={dropFolder === name || undefined}
              onClick={() => toggleFolder(name)}
            >
              {typeof folderIcon === "function" ? folderIcon(isOpen) : (folderIcon ?? <Icon icon={isOpen ? FolderOpenIcon : Folder01Icon} size={16} />)}
              <span className="ui-as-side__text" title={name}>
                {name}
              </span>
              {/* On hover a small arrow right after the name: right when closed, down when open */}
              <span className="ui-as-chat-folder__arrow" aria-hidden="true">
                <Icon icon={ArrowRight01Icon} size={13} />
              </span>
            </button>
          )}
          <span className="ui-as-chat-row__tools">
            <button
              type="button"
              className="ui-as-chat-row__tool"
              aria-label={`Options for ${name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.id === `folder:${name}`}
              data-chat-menu={`folder:${name}`}
              onClick={(e) => openMenu(`folder:${name}`, e.currentTarget)}
            >
              <Icon icon={MoreHorizontalIcon} size={15} />
            </button>
            <button
              type="button"
              className="ui-as-chat-row__tool ui-as-chat-row__pin"
              aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
              aria-pressed={pinned}
              tabIndex={-1}
              onClick={() => togglePinFolder(name)}
            >
              <Icon icon={pinned ? PinOffIcon : PinIcon} size={14} />
            </button>
          </span>
        </div>
        {isOpen && (
          <div className="ui-as-chat-folder__chats">
            {inside.length === 0 ? <span className="ui-as-side__empty ui-as-chat-folder__empty">No chats yet</span> : inside.map((c) => row(c, true))}
          </div>
        )}
      </Fragment>
    );
  };

  const pinnedChats = list.filter((c) => c.pinned);
  const pinnedFolders = folders.filter((f) => f.pinned);
  const otherFolders = folders.filter((f) => !f.pinned);
  const loose = list.filter((c) => !c.pinned && !(c.folder && folderNames.includes(c.folder)));
  const open = menu && list.find((c) => c.id === menu.id);
  const openFolder = menu?.id.startsWith("folder:") ? folders.find((f) => `folder:${f.name}` === menu.id) : undefined;
  return (
    <>
      {/* Pinned folders and chats on top, then the other folders with their chats indented inside, then the loose chats */}
      {(pinnedFolders.length > 0 || pinnedChats.length > 0) && (
        <div className="ui-as-side__group ui-as-chat-pinned" role="group" aria-label="Pinned">
          <span className="ui-as-side__label">Pinned</span>
          {pinnedFolders.map(folderRow)}
          {pinnedChats.map((c) => row(c))}
        </div>
      )}
      <div className="ui-as-side__group ui-as-chat-folders" role="group" aria-label="Projects">
        <span className="ui-as-side__label">Projects</span>
        {otherFolders.length === 0 && <span className="ui-as-side__empty">No projects yet</span>}
        {otherFolders.map(folderRow)}
      </div>
      <div className="ui-as-side__group ui-as-chats" role="group" aria-label="Chats">
        <span className="ui-as-side__label">Chats</span>
        {loose.length === 0 && <span className="ui-as-side__empty">No chats yet</span>}
        {loose.map((c) => row(c))}
      </div>
      {menu &&
        (open || openFolder) &&
        side.current &&
        createPortal(
          <div
            ref={panel}
            className="ui-as-menu ui-as-chat-menu"
            style={{ left: menu.left }}
            role="dialog"
            aria-label={`Options for ${open ? open.title : openFolder?.name}`}
            onKeyDown={(e) => {
              // Tab leaves the menu from its ⋯ button, so the focus goes on to the row's next control
              if (e.key !== "Tab") return;
              menuButton(menu.id)?.focus({ preventScroll: true });
              setMenu(null);
            }}
          >
            <MenuList
              items={open ? itemsFor(open) : openFolder ? folderItems(openFolder.name, openFolder.pinned) : []}
              onPick={() => {
                const button = menuButton(menu.id);
                setMenu(null);
                refocus(button);
              }}
            />
          </div>,
          side.current,
        )}
      {toast && app.current && createPortal(toast, app.current)}
    </>
  );
}

/* ---------- File cards ---------- */

export type FileType = "DOC" | "PDF" | "XLS";
export type FileItem = { name: string; type: FileType; edited?: string };

/** Badge color and label per file type */
const colors: Record<FileType, "blue" | "rose" | "emerald"> = { DOC: "blue", PDF: "rose", XLS: "emerald" };
export const fileKind: Record<FileType, string> = { DOC: "Document", PDF: "PDF", XLS: "Spreadsheet" };

/** A file as a card: preview on a gray stage, name and one line of details below */
export function FileCard({ file, meta, onOpen }: { file: FileItem; meta: ReactNode; /** Called when the card is clicked or pressed */ onOpen?: (file: FileItem) => void }) {
  return (
    <button type="button" className="ui-as-template" title={file.name} onClick={onOpen && (() => onOpen(file))}>
      <span className="ui-as-template__preview">
        <DocPreview type={file.type} color={colors[file.type]} />
      </span>
      <b className="ui-as-template__name">{file.name}</b>
      <span className="ui-as-meta">{meta}</span>
    </button>
  );
}

/** The lines on each kind of page: one row per array, widths in % */
const docRows: Record<FileType, number[][]> = {
  DOC: [[100], [31, 31, 31], [48, 48], [31, 31, 31], [24, 48, 24], [31, 31]],
  PDF: [[100], [48, 48], [31, 62]],
  XLS: [[31, 31, 31], [31, 31, 31], [31, 31, 31], [31, 31, 31], [31, 31, 31]],
};

/**
 * File illustration: a small white page with hairline rows of content, its top right corner cut off,
 * and a colored tag with the type overlapping its lower left corner. On hover the page lifts a little.
 */
function DocPreview({ type, color }: { type: FileType; color: "blue" | "rose" | "emerald" }) {
  return (
    <span className="ui-as-doc" data-color={color} aria-hidden="true">
      <span className="ui-as-doc__art">
        <span className="ui-as-doc__page" data-type={type}>
          {type === "PDF" && <span className="ui-as-doc__image" />}
          <span className="ui-as-doc__rows">
            {docRows[type].map((row, r) => (
              <span key={r} className="ui-as-doc__row">
                {row.map((w, k) => (
                  <i key={k} style={{ width: `${w}%` }} />
                ))}
              </span>
            ))}
          </span>
        </span>
        <span className="ui-as-doc__type">{type}</span>
      </span>
    </span>
  );
}

/* ---------- Styles ---------- */

/* ---------- Workspace: the work area's default content ---------- */

export type WorkspaceTool = { id: string; label: string; icon: Parameters<typeof Icon>[0]["icon"]; shortcut?: string };
export type WorkspaceSource = { id: string; title: string; source: string; mark?: ReactNode };

export const defaultTools: WorkspaceTool[] = [
  { id: "terminal", label: "Terminal", icon: CommandLineIcon, shortcut: "⌃`" },
  { id: "browser", label: "Browser", icon: Globe02Icon, shortcut: "⌘⇧B" },
  { id: "notes", label: "Notes", icon: NoteEditIcon, shortcut: "⌘⇧N" },
];

export const defaultSources: WorkspaceSource[] = [
  { id: "geo", title: "GEO: Generative Engine Optimization", source: "arxiv.org", mark: "A" },
  { id: "tokens", title: "Design tokens – naming guide", source: "notion.so", mark: "N" },
  { id: "q3", title: "Q3 launch checklist", source: "linear.app", mark: "L" },
];

export type WorkspacePanelProps = {
  tools?: WorkspaceTool[];
  sources?: WorkspaceSource[];
  /** A tool or a suggestion was opened */
  onOpen?: (id: string) => void;
};

/** The pane's content: an address field, the tools, and suggested sources – each row opens its item */
export function WorkspacePanel({ tools = defaultTools, sources = defaultSources, onOpen }: WorkspacePanelProps) {
  const [query, setQuery] = useState("");
  return (
    <div className="ui-asw">
      <style href="ui-app-shell-workspace" precedence="default">
        {workspaceCss}
      </style>
      <label className="ui-asw__address">
        <Icon icon={Search01Icon} size={14} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search or enter URL" aria-label="Search or enter URL" />
      </label>

      <section className="ui-asw__section" aria-label="Tools">
        <h3 className="ui-asw__label">Tools</h3>
        {tools.length === 0 && <p className="ui-asw__empty">No tools connected yet</p>}
        {tools.length > 0 && (
        <div className="ui-asw__list">
          {tools.map((tool) => (
            <div key={tool.id} className="ui-asw__row">
              <button type="button" className="ui-asw__open" onClick={() => onOpen?.(tool.id)}>
                <span className="ui-asw__tile">
                  <Icon icon={tool.icon} size={15} />
                </span>
                <span className="ui-asw__name" title={tool.label}>
                  {tool.label}
                </span>
                {tool.shortcut && <kbd className="ui-asw__kbd">{tool.shortcut}</kbd>}
              </button>
              <button type="button" className="ui-asw__more" aria-label={`More for ${tool.label}`}>
                <Icon icon={MoreHorizontalIcon} size={15} />
              </button>
            </div>
          ))}
        </div>
        )}
      </section>

      <section className="ui-asw__section" aria-label="Suggested">
        <h3 className="ui-asw__label">Suggested</h3>
        {sources.length === 0 && <p className="ui-asw__empty">Nothing suggested right now</p>}
        {sources.length > 0 && (
        <div className="ui-asw__list">
          {sources.map((item) => (
            <button key={item.id} type="button" className="ui-asw__row ui-asw__open ui-asw__source" onClick={() => onOpen?.(item.id)}>
              <span className="ui-asw__tile ui-asw__tile--mark">{item.mark ?? firstChar(item.title).toUpperCase()}</span>
              <span className="ui-asw__text">
                <span className="ui-asw__name" title={item.title}>
                  {item.title}
                </span>
                <span className="ui-asw__meta" title={item.source}>
                  {item.source}
                </span>
              </span>
              <span className="ui-asw__go">
                <Icon icon={ArrowUpRight01Icon} size={14} />
              </span>
            </button>
          ))}
        </div>
        )}
      </section>
    </div>
  );
}

const workspaceCss = /* css */ `
.ui-asw { display: flex; flex-direction: column; gap: 22px; padding: 0 2px; }

/* Address field: a white pill with a hairline, like the search fields in the screens */
.ui-asw__address {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border-radius: 10px;
  background: var(--card);
  box-shadow: inset 0 0 0 0.5px var(--line-strong), var(--shadow);
  color: var(--faint);
  cursor: text;
}
.ui-asw__address:focus-within { box-shadow: inset 0 0 0 1px var(--line-strong), 0 0 0 3px var(--accent-soft); }
.ui-asw__address input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: var(--ink);
}
.ui-asw__address input::placeholder { color: var(--placeholder); }

.ui-asw__section { display: flex; flex-direction: column; gap: 8px; }
.ui-asw__label { margin: 0; padding: 0 4px; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--muted); }

/* Rows sit on one white card, split by hairlines – the same card style as the screens */
.ui-asw__list {
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-radius: 12px;
  background: var(--card);
  box-shadow: inset 0 0 0 0.5px var(--line-strong), var(--shadow);
}
.ui-asw__row { position: relative; display: flex; align-items: center; border-radius: 8px; transition: background-color 140ms ease; }
.ui-asw__row + .ui-asw__row::before {
  content: "";
  position: absolute;
  top: -0.5px;
  left: 44px;
  right: 8px;
  height: 1px;
  background: var(--line-soft);
}
.ui-asw__open {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 8px;
  border-radius: 8px;
  text-align: left;
  transition: background-color 140ms ease;
}
/* The hover fills the whole row, the ⋯ button at its end included */
.ui-asw__row:hover { background: var(--hover); }
.ui-asw__source { height: 48px; flex: none; }

.ui-asw__tile {
  display: grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--chip);
  color: var(--text);
}
.ui-asw__tile--mark { font-size: 11.5px; font-weight: 500; color: var(--muted); }

.ui-asw__text { display: flex; flex: 1; min-width: 0; flex-direction: column; }
.ui-asw__name { overflow: hidden; font-size: 13px; line-height: 18px; font-weight: 450; color: var(--ink); white-space: nowrap; text-overflow: ellipsis; }
.ui-asw__open > .ui-asw__name { flex: 1; }
.ui-asw__meta { overflow: hidden; font-size: 12px; line-height: 16px; color: var(--muted); white-space: nowrap; text-overflow: ellipsis; }
.ui-asw__empty { margin: 0; padding: 0 4px; font-size: 13px; line-height: 18px; color: var(--faint); }

.ui-asw__kbd {
  flex: none;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--chip);
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  transition: opacity 140ms ease;
}
/* The shortcut sits flush right; on hover the ⋯ button takes its place */
.ui-asw__more {
  position: absolute;
  top: 50%;
  right: 6px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--faint);
  opacity: 0;
  translate: 0 -50%;
  transition: opacity 140ms ease, background-color 140ms ease;
}
.ui-asw__row:is(:hover, :focus-within) .ui-asw__more { opacity: 1; }
.ui-asw__row:is(:hover, :focus-within) .ui-asw__kbd { opacity: 0; }
.ui-asw__more:hover { background: var(--hover); color: var(--text); }
.ui-asw__go { flex: none; color: var(--faint); opacity: 0; translate: -2px 0; transition: opacity 140ms ease, translate 200ms var(--ease); }
.ui-asw__source:hover .ui-asw__go { opacity: 1; translate: 0 0; }
`;

export const css = /* css */ `
/* Design tokens – same values as the affectUI library components */
.ui-as {
  --tray: #f4f4f4;
  --card: #ffffff;
  /* Like the affectUI library: gray page, the main area is a rounded panel on it */
  --page: #f8f8f8;
  --panel: #ffffff;
  --radius-panel: 12px;
  --frame-gap: 8px;
  /* Clean: hairlines drawn with shadows, text in stepped opacities of black, Inter in 400 and 500 */
  --line: rgba(0, 0, 0, 0.06);
  --line-soft: rgba(0, 0, 0, 0.04);
  --strong: #000000;
  --ink: rgba(0, 0, 0, 0.88);
  --text: rgba(0, 0, 0, 0.61);
  --muted: rgba(0, 0, 0, 0.45);
  --faint: rgba(0, 0, 0, 0.27);
  --placeholder: rgba(0, 0, 0, 0.27);
  --chip: rgba(0, 0, 0, 0.04);
  --chip-hover: rgba(0, 0, 0, 0.06);
  --hover: rgba(0, 0, 0, 0.03);
  --accent: #0060e2;
  --button: rgba(0, 0, 0, 0.88);
  --button-hover: rgba(0, 0, 0, 0.78);
  --accent-soft: rgba(0, 96, 226, 0.08);
  --shadow: 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  /* A card: a 0.5px hairline and a soft drop; the frame around previews is a faint gray with the same hairline */
  --card-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 1px 1px -1px rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --card-shadow-hover: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 2px 6px -1px rgba(0, 0, 0, 0.08), 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --frame: rgba(0, 0, 0, 0.02);
  --line-strong: rgba(0, 0, 0, 0.1);
  /* An edge you can drag, while the pointer is on it */
  --edge-active: rgba(0, 0, 0, 0.14);
  --subtle: #fafafa;
  --disabled: #dcdcdc;
  --on-ink: #ffffff;
  --ink-hover: #3a3a3a;
  --select: rgba(0, 0, 0, 0.055);
  --toggle-off: #e2e2e2;
  --switch-on: rgba(0, 96, 226, 0.765);
  --logo-bg: #ffffff;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

/* Library components inside a screen are their clean versions – same scale and hairlines as the shell; approval
   actions stay at their natural width, at the end of the row */
.ui-as .ui-apc__foot .ui-apc__actions { flex: 0 0 auto; margin-left: auto; }

/* Dark mode: follows a .dark class or data-theme="dark" on any ancestor, e.g. <html>.
   Every screen draws from these tokens, and the library parts inside switch on their own. */
:where(.dark, [data-theme="dark"]) .ui-as {
  --tray: #1d1d20;
  --card: #1b1b1e;
  --page: #0e0e10;
  --panel: #141416;
  --line: rgba(255, 255, 255, 0.08);
  --line-soft: rgba(255, 255, 255, 0.05);
  --strong: #ffffff;
  --ink: rgba(255, 255, 255, 0.9);
  --text: rgba(255, 255, 255, 0.62);
  --muted: rgba(255, 255, 255, 0.45);
  --faint: rgba(255, 255, 255, 0.28);
  --placeholder: rgba(255, 255, 255, 0.28);
  --chip: rgba(255, 255, 255, 0.06);
  --chip-hover: rgba(255, 255, 255, 0.09);
  --hover: rgba(255, 255, 255, 0.05);
  --accent: #5b9aff;
  --button: #f4f4f5;
  --button-hover: #ffffff;
  --accent-soft: rgba(91, 154, 255, 0.16);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  --card-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.1), 0 1px 2px rgba(0, 0, 0, 0.4);
  --card-shadow-hover: 0 0 0 0.5px rgba(255, 255, 255, 0.16), 0 2px 6px rgba(0, 0, 0, 0.4);
  --frame: rgba(255, 255, 255, 0.03);
  --line-strong: rgba(255, 255, 255, 0.14);
  --edge-active: rgba(255, 255, 255, 0.18);
  --subtle: #18181b;
  --disabled: #3a3a3f;
  --on-ink: #111113;
  --ink-hover: #d4d4d8;
  --select: rgba(255, 255, 255, 0.08);
  --toggle-off: #3a3a3f;
  --switch-on: #4d8dff;
  --logo-bg: #2a2a2e;
  color-scheme: dark;
}

.ui-as, .ui-as *, .ui-as *::before, .ui-as *::after { box-sizing: border-box; }
.ui-as {
  font-family: var(--font);
  font-size: 13px;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
:where(.ui-as) button {
  appearance: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
:where(.ui-as) svg { display: block; flex: none; }
/* The shell's ring at the lowest weight that still beats a host page's bare :focus-visible – any screen rule
   (.ui-x:focus-visible) wins by design, not by the order of the style tags */
.ui-as :where(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.ui-as textarea:focus-visible, .ui-as input:focus-visible { outline: none; }

/* App frame shared by all screens: sidebar on the gray page, main area as a rounded white panel */

.ui-as-app {
  /* The layout answers to the app's own width (container queries), not the window – see the end of this file */
  container: ui-as / inline-size;
  position: relative;
  display: grid;
  /* Sidebar · main area · work area on the right (0 when there is none or it's closed); widths come from the drag handles */
  --side-col: var(--side-w, 272px);
  --panel-col: 0px;
  grid-template-columns: var(--side-col) minmax(0, 1fr) var(--panel-col);
  height: 100%;
  min-height: 560px;
  background: var(--page);
  transition: grid-template-columns 420ms var(--ease);
}
.ui-as-app[data-panel="open"] { --panel-col: var(--panel-w, 360px); }
/* Dragging an edge: the columns follow the pointer at once */
.ui-as-app[data-resizing] { transition: none; cursor: col-resize; user-select: none; }
.ui-as-app[data-resizing] :is(.ui-as-main, .ui-as-side, .ui-as-panel) { transition: none; }

/* ---------- Sidebar ---------- */

.ui-as-side {
  display: flex;
  flex-direction: column;
  width: var(--side-w, 272px);
  min-height: 0;
  padding: 10px 8px 8px 10px;
  transition: opacity 260ms ease, translate 420ms var(--ease), visibility 0s;
}
/* The rail: the sidebar keeps its layout and is only cut to the icons – every row stays where it was,
   at its height, with its own fill. Words go; each row names itself on hover */
.ui-as-app[data-collapsed] { --side-col: 48px; }
.ui-as-app[data-collapsed] > .ui-as-side { width: 100%; overflow: hidden; }
.ui-as-app[data-collapsed] > .ui-as-side > * { flex-shrink: 0; width: calc(var(--side-w, 272px) - 20px); }
.ui-as-app[data-collapsed] :is(.ui-as-side__name, .ui-as-side__workspace > svg, .ui-as-side__text, .ui-as-side__count, .ui-as-user__name, .ui-as-user > svg, .ui-as-side__search > span, .ui-as-side__search > kbd) { display: none; }
.ui-as-app[data-collapsed] :is(.ui-as-side__item, .ui-as-side__search, .ui-as-side__workspace, .ui-as-user-menu > .ui-as-user) { flex: none; width: fit-content; }
.ui-as-app[data-collapsed] .ui-as-side__search { padding-right: 8px; }
/* Group titles keep their room; a short hairline stands in for the words */
.ui-as-app[data-collapsed] .ui-as-side__label { color: transparent; white-space: nowrap; overflow: hidden; background: linear-gradient(var(--line-strong), var(--line-strong)) 0 50% / 28px 0.5px no-repeat; }
.ui-as-app[data-collapsed] .ui-as-side__empty { visibility: hidden; }
.ui-as-app[data-collapsed] .ui-as-side__foot > :not(.ui-as-user-menu) { display: none; }
/* The toggle lies over the workspace logo and takes its place while the pointer is on the sidebar; a settings sidebar drops its way back and shows the toggle */
.ui-as-app[data-collapsed] :is(.ui-as-side__head, .ui-as-bar--side) { position: relative; }
.ui-as-app[data-collapsed] .ui-as-side__tools,
.ui-as-app[data-collapsed] > .ui-as-bar--side > .ui-as-icon-btn { position: absolute; top: 0; left: 0; opacity: 0; transition: opacity 140ms ease; }
.ui-as-app[data-collapsed] > .ui-as-bar--side > .ui-as-icon-btn { top: 10px; left: 10px; margin: 0; }
.ui-as-app[data-collapsed] :is(.ui-as-side__tools, .ui-as-bar--side) .ui-as-icon-btn { width: 30px; }
.ui-as-app[data-collapsed]:has(> :is(.ui-as-side, .ui-as-bar--side):hover, :is(.ui-as-side__head, .ui-as-bar--side) :focus-visible) :is(.ui-as-side__tools, .ui-as-bar--side > .ui-as-icon-btn),
.ui-as-app[data-collapsed] :is(.ui-as-side__head, .ui-as-bar--side):has(> .ui-as-side__back) :is(.ui-as-side__tools, .ui-as-icon-btn) { opacity: 1; }
.ui-as-app[data-collapsed]:has(> :is(.ui-as-side, .ui-as-bar--side):hover, :is(.ui-as-side__head, .ui-as-bar--side) :focus-visible) .ui-as-side__logo { opacity: 0; }
.ui-as-app[data-collapsed] .ui-as-side__logo { transition: opacity 140ms ease; }
.ui-as-app[data-collapsed] .ui-as-side__back { visibility: hidden; }

/* The icon to bring the sidebar back, in the top left corner of the main area */
.ui-as-side-open {
  position: fixed;
  z-index: 20;
  top: calc(var(--frame-gap) + 9px);
  left: calc(var(--frame-gap) + 9px);
  visibility: hidden;
  opacity: 0;
  transition: opacity 200ms ease, visibility 0s 200ms;
}


.ui-as-side__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
}
/* The workspace's name takes what the tools leave and shortens with … – the full name on hover */
.ui-as-side__head { gap: 4px; }
.ui-as-side__head > .ui-as-anchor { display: flex; min-width: 0; }
.ui-as-side__workspace {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  text-align: left;
  height: 30px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}
.ui-as-side__workspace svg { color: var(--faint); }
.ui-as-side__name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-as-side__tools { flex: none; }
.ui-as-side__workspace:hover { background: var(--hover); }
/* Settings sidebar: "‹ Settings" in place of the workspace */
.ui-as-side__back { display: flex; align-items: center; gap: 6px; min-width: 0; height: 30px; padding: 0 8px 0 4px; border-radius: 8px; font-size: 14px; font-weight: 500; color: var(--strong); }
.ui-as-side__back svg { color: var(--muted); transition: translate 200ms var(--ease); }
.ui-as-side__back:hover { background: var(--hover); }
.ui-as-side__back:hover svg { translate: -2px 0; }
.ui-as-user-menu { display: flex; align-items: center; gap: 2px; }
.ui-as-user-action { flex: none; }
.ui-as-user-menu > .ui-as-user { flex: 1; min-width: 0; }
.ui-as-user-menu .ui-as-menu { width: 100%; }
.ui-as-user-menu .ui-as-user-pop { width: 100%; min-width: 260px; }
/* The account menu's head: picture, name and email */
.ui-as-account { display: flex; align-items: center; gap: 10px; padding: 8px 10px 10px; margin-bottom: 4px; border-bottom: 1px solid var(--line); }
.ui-as-account img, .ui-as-account .ui-as-user__initials { flex: none; width: 30px; height: 30px; border-radius: 50%; font-size: 11px; }
.ui-as-account__text { display: grid; min-width: 0; }
.ui-as-account__text b { overflow: hidden; font-size: 13px; font-weight: 500; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; color: var(--ink); }
.ui-as-account__text small { overflow: hidden; font-size: 12px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
/* The workspace menu runs as wide as the sidebar */
.ui-as-ws-menu .ui-as-menu { width: 240px; }
/* Workspace logo on a white tile with a small, tight shadow below */
.ui-as-side__logo {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin-right: 1px;
  border-radius: 5px;
  background: var(--logo-bg);
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 1px 1px rgba(0, 0, 0, 0.12);
}
.ui-as-side__logo svg { width: 11px; height: auto; }
.ui-as-side__tools { display: flex; gap: 2px; }

.ui-as-icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--muted);
  transition: background-color 140ms ease, color 140ms ease;
}
.ui-as-icon-btn:hover { background: var(--hover); color: var(--ink); }

.ui-as-side__nav {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  min-height: 0;
  margin-top: 12px;
  /* A long list scrolls under the head, the cards at the bottom stay */
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.ui-as-side__nav::-webkit-scrollbar { display: none; }
/* Rows keep their height – the list scrolls instead of squeezing them */
.ui-as-side__nav > *, .ui-as-side__nav .ui-as-side__group > * { flex-shrink: 0; }
.ui-as-side__foot { flex: none; }

/* Chats: no icon – loose ones start at the rows' left edge, the ones in a folder line up with its name;
   ⋯ and the pin show on hover */
.ui-as-side { position: relative; }
.ui-as-chats, .ui-as-chat-pinned { margin-top: 6px; }
.ui-as-chat-folder-row { position: relative; display: flex; flex: none; }
.ui-as-chat-folder-row:is(:hover, :has(:focus-visible), [data-menu]) > .ui-as-chat-folder { padding-right: 56px; background: var(--hover); color: var(--ink); }
.ui-as-chat-folder-row:is(:hover, :has(:focus-visible), [data-menu]) .ui-as-chat-row__tools { opacity: 1; }
.ui-as-chat-folder__rename { padding-left: 29px; }
.ui-as-chat-folder-row[draggable="true"] { cursor: grab; }
.ui-as-chat-folder > .ui-as-side__text { flex: 0 1 auto; }
.ui-as-chat-folder__arrow { display: grid; flex: none; place-items: center; margin-left: -4px; color: var(--faint); opacity: 0; transition: opacity 120ms ease, transform 200ms var(--ease); }
.ui-as-chat-folder[aria-expanded="true"] .ui-as-chat-folder__arrow { transform: rotate(90deg); }
.ui-as-chat-folder-row:is(:hover, :has(:focus-visible)) .ui-as-chat-folder__arrow { opacity: 1; }
.ui-as-chat-folder-row[data-dragging] { opacity: 0.4; }
.ui-as-chat-folder-row[data-drop]::after { content: ""; position: absolute; left: 6px; right: 6px; height: 2px; border-radius: 1px; background: var(--accent); pointer-events: none; }
.ui-as-chat-folder-row[data-drop="before"]::after { top: -1px; }
.ui-as-chat-folder-row[data-drop="after"]::after { bottom: -1px; }
.ui-as-chat-row { position: relative; display: flex; flex: none; }
.ui-as-chat-row > .ui-as-chat-row__link { padding-left: 6px; }
.ui-as-chat-row[data-indent] > .ui-as-chat-row__link { padding-left: 30px; }
.ui-as-chat-folder__chats { display: flex; flex-direction: column; }
.ui-as-chat-folder__empty { padding-left: 30px; }
/* A chat dragged over a folder: the folder lights up */
.ui-as-chat-folder[data-drop] { background: var(--hover); box-shadow: inset 0 0 0 1px var(--accent); color: var(--ink); }
.ui-as-chat-row__link .ui-as-side__text { flex: 1; }
.ui-as-chat-row:is(:hover, :has(:focus-visible), [data-menu]) .ui-as-chat-row__link { padding-right: 56px; background: var(--hover); color: var(--ink); }
/* The open chat: only the soft hover fill behind it, no heavier type */
.ui-as-chat-row > .ui-as-chat-row__link[aria-current="page"] { background: var(--hover); font-weight: 400; color: var(--ink); }
.ui-as-chat-row__dot { flex: none; width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: var(--accent); }
.ui-as-chat-row__tools { position: absolute; top: 3px; right: 4px; display: flex; gap: 2px; opacity: 0; transition: opacity 120ms ease; }
.ui-as-chat-row:is(:hover, :has(:focus-visible), [data-menu]) .ui-as-chat-row__tools { opacity: 1; }
.ui-as-chat-row__tool { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 6px; color: var(--muted); transition: background-color 120ms ease, color 120ms ease; }
.ui-as-chat-row__tool:hover, .ui-as-chat-row__tool[aria-expanded="true"] { background: var(--chip); color: var(--ink); }
.ui-as-chat-row__rename { width: 100%; height: 30px; padding: 0 8px 0 5px; border: 0; border-radius: 8px; outline: 0; background: var(--card); box-shadow: inset 0 0 0 1px var(--line-strong), 0 0 0 3px var(--chip); font: inherit; font-size: 13px; color: var(--ink); }
/* Dragging: the row fades, a line shows where it lands */
.ui-as-chat-row[data-indent] .ui-as-chat-row__rename { padding-left: 29px; }
.ui-as-chat-row[draggable="true"] { cursor: grab; }
.ui-as-chat-row[data-dragging] { opacity: 0.4; }
.ui-as-chat-row[data-drop]::after { content: ""; position: absolute; left: 6px; right: 6px; height: 2px; border-radius: 1px; background: var(--accent); pointer-events: none; }
.ui-as-chat-row[data-drop="before"]::after { top: -1px; }
.ui-as-chat-row[data-drop="after"]::after { bottom: -1px; }
.ui-as-chat-menu { position: absolute; z-index: 30; width: 232px; animation: ui-as-popover-up 160ms var(--ease) both; }
.ui-as-chat-menu .ui-as-menu__subpanel { min-width: 180px; }
/* The rail has no room for names */
.ui-as-app[data-collapsed] :is(.ui-as-chats, .ui-as-chat-folder__chats, .ui-as-chat-row, .ui-as-chat-row__tools) { display: none; }
.ui-as-app[data-collapsed] .ui-as-chat-pinned:not(:has(.ui-as-chat-folder)) { display: none; }
.ui-as-app[data-collapsed] .ui-as-chat-folder__arrow { display: none; }
/* Search opens the Command Menu over the app, near the top, on a soft scrim */
.ui-as-cmd {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: min(12vh, 96px) 16px 16px;
  background: rgba(0, 0, 0, 0.12);
  animation: ui-as-cmd-fade 200ms ease both;
}
.ui-as-cmd > * { width: 100%; max-width: 560px; animation: ui-as-cmd-in 260ms var(--ease) both; }
@keyframes ui-as-cmd-fade { from { opacity: 0; } }
@keyframes ui-as-cmd-in { from { opacity: 0; transform: translateY(-6px) scale(0.98); } }
:where(.dark, [data-theme="dark"]) .ui-as-cmd { background: rgba(0, 0, 0, 0.45); }

/* The search field under the workspace */
.ui-as-side__search {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  margin-top: 12px;
  padding: 0 6px 0 8px;
  border-radius: 8px;
  background: var(--card);
  box-shadow: var(--card-shadow);
  font-size: 13px;
  color: var(--muted);
  text-align: left;
  transition: box-shadow 140ms ease, color 140ms ease;
}
.ui-as-side__search svg { color: var(--faint); }
.ui-as-side__search:hover { box-shadow: var(--card-shadow-hover); color: var(--text); }
.ui-as-side__search kbd { margin-left: auto; padding: 0 5px; border-radius: 4px; box-shadow: inset 0 0 0 0.5px var(--line-strong); font: inherit; font-size: 11px; line-height: 18px; color: var(--faint); }
.ui-as-side__group { display: flex; flex-direction: column; }
.ui-as-side__group + .ui-as-side__group { margin-top: 10px; }
.ui-as-side__group + .ui-as-side__group > .ui-as-side__label:first-child { margin-top: 6px; }
.ui-as-side__count { flex: none; margin-left: auto; font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
.ui-as-side__empty { padding: 4px 6px; font-size: 13px; color: var(--faint); }
.ui-as-side__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  transition: background-color 140ms ease, color 140ms ease;
}
.ui-as-side__item svg { flex: none; color: var(--muted); }
/* One line per row – long names shorten with …, the full name on hover */
.ui-as-side__text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-as-side__item:hover { background: var(--hover); color: var(--ink); }
.ui-as-side__item[aria-current="page"] { background: var(--select); color: var(--ink); font-weight: 500; }
.ui-as-side__item[aria-current="page"] svg { color: var(--ink); }
a.ui-as-side__item { text-decoration: none; cursor: pointer; }
.ui-as-side__label {
  margin: 16px 0 4px;
  padding: 0 6px;
  font-size: 12.5px;
  line-height: 16px;
  color: var(--faint);
}

.ui-as-side__foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: auto;
}

/* "What's new" – two cards stacked, the second one peeks out above */
.ui-as-news { position: relative; padding-top: 30px; }
.ui-as-news__card {
  position: relative;
  z-index: 1;
  padding: 10px 10px 0;
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--card-shadow);
}
.ui-as-news__card--back {
  position: absolute;
  z-index: 0;
  top: 0;
  left: 10px;
  right: 10px;
  height: 48px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 9px 9px 0;
  background: var(--card);
  color: var(--faint);
}
.ui-as-news[data-count="1"] { padding-top: 0; }
.ui-as-news[data-count="1"] .ui-as-news__card--back { display: none; }
.ui-as-news__top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ui-as-news__kicker { min-width: 0; overflow: hidden; font-size: 11.5px; line-height: 15px; font-weight: 500; color: var(--accent); white-space: nowrap; text-overflow: ellipsis; }
.ui-as-news__card--back svg, .ui-as-news__close { flex: none; }
.ui-as-news__close {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  margin: -2px -2px 0 0;
  border-radius: 6px;
  color: var(--faint);
}
.ui-as-news__close:hover { background: var(--hover); color: var(--ink); }
.ui-as-news__title { display: block; margin-top: 4px; font-size: 13px; line-height: 18px; font-weight: 500; color: var(--ink); }
.ui-as-news__more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: calc(100% + 20px);
  height: 34px;
  margin: 10px -10px 0;
  padding: 0 10px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0 0 12px 12px;
  font-size: 12.5px;
  color: var(--muted);
}
.ui-as-news__more:hover { background: var(--subtle); color: var(--ink); }

/* Onboarding progress */
/* Getting started: one card that morphs between the short summary and the full Setup Guide */
.ui-as-guide-slot { position: relative; flex: none; }
.ui-as-guide {
  position: absolute;
  z-index: 6;
  right: 0;
  bottom: 0;
  left: 0;
  overflow: hidden;
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--card-shadow);
  transition: height 480ms var(--ease), border-radius 480ms var(--ease), box-shadow 200ms ease;
}
.ui-as-guide:not([data-open]):hover { box-shadow: 0 0 0 1px var(--line-strong), 0 2px 6px rgba(0, 0, 0, 0.05); }
.ui-as-guide[data-open] { border-radius: 12px; box-shadow: 0 0 0 0.5px var(--line-strong), 0 8px 24px -10px rgba(0, 0, 0, 0.14); }
.ui-as-guide__content { animation: ui-as-guide-in 360ms var(--ease) both; }
/* Closing: the guide fades out while the card shrinks back to the summary's height */
.ui-as-guide[data-state="closing"] .ui-as-guide__content { animation: ui-as-guide-out 260ms ease both; }
.ui-as-guide[data-state="closing"] { border-radius: 12px; box-shadow: var(--card-shadow); }
@keyframes ui-as-guide-out { to { opacity: 0; } }
@keyframes ui-as-guide-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.ui-as-steps {
  display: grid;
  gap: 3px;
  width: 100%;
  padding: 10px 10px 9px;
  text-align: left;
}
/* The library's Setup Guide inside the card: its own frame drops away, the card is the frame */
/* Opening and closing belong to the card, so the guide's own minimize button is left out */
.ui-as-guide .ui-sgc__icon-btn[aria-expanded] { display: none; }
.ui-as-guide .ui-sgc { zoom: 0.86; max-width: none; padding: 12px 4px 4px; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.ui-as-steps__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--ink);
}
.ui-as-steps__title svg { color: var(--faint); }
.ui-as-steps__sub { font-size: 12.5px; line-height: 17px; color: var(--muted); }
.ui-as-steps__cheer { color: var(--accent); }
.ui-as-steps__bar {
  height: 4px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--tray);
}
.ui-as-steps__bar i { display: block; min-width: 6px; height: 100%; border-radius: inherit; background: var(--accent); transition: width 600ms var(--ease); }

.ui-as-user {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.ui-as-user__name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* Name over a second line, such as the computer in use */
.ui-as-user:has(> .ui-as-user__text) { height: 40px; }
.ui-as-user__text { display: grid; min-width: 0; text-align: left; line-height: 16px; }
.ui-as-user__text small { overflow: hidden; font-size: 12px; font-weight: 400; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); }
/* macOS: the window's title bar. The traffic lights sit 20px from the window's left edge and the tools from 80px,
   level with the main area's 52px head; the sidebar's head only keeps their room */
.ui-as-side__head[data-chrome="mac"] { height: 50px; margin-bottom: 6px; }
.ui-as-corner { position: fixed; z-index: 21; top: 9px; left: 0; display: flex; align-items: center; gap: 8px; height: 52px; padding-left: 20px; pointer-events: none; }
.ui-as-corner > * { pointer-events: auto; }
.ui-as-corner__tools { display: flex; gap: 2px; }
.ui-as-corner .ui-as-icon-btn:disabled { opacity: .4; cursor: default; }
.ui-as-lights { display: flex; flex: none; gap: 8px; }
.ui-as-lights i { width: 12px; height: 12px; border-radius: 50%; background: #ff5f57; box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.12); }
.ui-as-lights i:nth-child(2) { background: #febc2e; }
.ui-as-lights i:nth-child(3) { background: #28c840; }
.ui-as-app[data-chrome="mac"] > .ui-as-side-open { display: none; }
/* With the sidebar hidden the controls stay over the main area's head, which starts its content after them */
.ui-as-app[data-chrome="mac"][data-collapsed] { --corner-space: 176px; }
.ui-as-side__ws { display: flex; min-width: 0; margin-bottom: 8px; }
.ui-as-user > :is(img, .ui-as-user__initials) { flex: none; }
.ui-as-user img { width: 21px; height: 21px; border-radius: 50%; object-fit: cover; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06); }
.ui-as-user svg { margin-left: auto; color: var(--faint); }
.ui-as-user:hover { background: var(--hover); }

/* ---------- Main ---------- */

/* Main area as a rounded panel, like the affectUI library */
.ui-as-main {
  /* Screens reflow their content by the width of this panel */
  container: ui-as-main / inline-size;
  position: relative;
  min-width: 0;
  margin: var(--frame-gap) var(--frame-gap) var(--frame-gap) 0;
  overflow-y: auto;
  /* No rubber-band bounce at the ends – sticky headers stay put */
  overscroll-behavior: none;
  transition: margin-left 420ms var(--ease);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--panel);
}


/* Shared page parts: headings, toolbars, tabs, search, empty states – affectUI tokens */

.ui-as-page {
  padding: 46px 32px 56px;
}
.ui-as-page-title {
  margin: 0;
  font-size: 24px;
  line-height: 32px;
  font-weight: 500;
  letter-spacing: -0.24px;
  color: var(--strong);
}
.ui-as-page-sub {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--text);
}
.ui-as-page-sub a { color: var(--text); text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.ui-as-page-sub a:hover { color: var(--ink); text-decoration-color: currentColor; }

.ui-as-section-head { margin-top: 36px; }
/* Without tabs the tools sit on the same line as the title */
.ui-as-section-head[data-inline] { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.ui-as-section-head[data-inline] .ui-as-toolbar { margin-top: 0; }
/* A section's title: a small uppercase label */
.ui-as-section-head__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--muted);
}
.ui-as-section-head__count { font-variant-numeric: tabular-nums; color: var(--faint); }
.ui-as-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 12px;
}
.ui-as-toolbar__left, .ui-as-toolbar__right { display: flex; align-items: center; gap: 6px; }

/* Tabs: small outlined buttons, the active one gets a soft gray fill */
.ui-as-tabs { position: relative; display: flex; gap: 8px; }
/* The gray pill glides under the active tab */
.ui-as-tabs__pill {
  position: absolute;
  top: 0;
  left: 0;
  height: 28px;
  border-radius: 6px;
  background: var(--select);
  transition: transform 340ms var(--ease), width 340ms var(--ease);
}
.ui-as-tabs__tab {
  position: relative;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text);
  box-shadow: inset 0 0 0 0.5px var(--line);
  transition: background-color 140ms ease, color 140ms ease;
}
.ui-as-tabs__tab:hover { color: var(--ink); }
.ui-as-tabs__tab[aria-selected="true"] { color: var(--ink); }

/* Small outlined tools */
.ui-as-tool {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--card);
  box-shadow: var(--card-shadow);
  color: var(--text);
  transition: box-shadow 140ms ease, color 140ms ease;
}
.ui-as-tool svg { color: var(--muted); }
.ui-as-tool:hover { box-shadow: var(--card-shadow-hover); color: var(--ink); }
.ui-as-tool--label { padding: 0 10px; font-size: 13px; }

.ui-as-view {
  position: relative;
  display: flex;
  gap: 2px;
  height: 28px;
  padding: 2px;
  border-radius: 6px;
  background: var(--chip);
}
.ui-as-view__btn {
  display: grid;
  place-items: center;
  width: 28px;
  border-radius: 4px;
  color: var(--faint);
}
.ui-as-view__btn:hover { color: var(--ink); }
.ui-as-view__btn { position: relative; transition: color 160ms ease; }
.ui-as-view__btn[aria-checked="true"] { color: var(--ink); }
/* White pill that slides between grid and list */
.ui-as-view__pill {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: 28px;
  border-radius: 4px;
  background: var(--card);
  box-shadow: var(--card-shadow);
  transition: transform 320ms var(--ease);
}
.ui-as-view[data-view="list"] .ui-as-view__pill { transform: translateX(30px); }

.ui-as-search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--card);
  box-shadow: var(--card-shadow);
  color: var(--faint);
  cursor: text;
  transition: box-shadow 140ms ease;
}
.ui-as-search:focus-within { box-shadow: var(--card-shadow-hover), 0 0 0 3px var(--chip); }
.ui-as-search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: var(--ink);
}
.ui-as-search input::placeholder { color: var(--placeholder); }
.ui-as-search__clear {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--chip);
  color: var(--muted);
  animation: ui-as-pop 220ms var(--ease);
}
.ui-as-search__clear:hover { color: var(--ink); }

/* Sort: the arrows turn half a circle for Z–A */
.ui-as-sort svg { transition: transform 360ms var(--ease); }
.ui-as-sort[data-dir="desc"] svg { transform: rotate(180deg); }
.ui-as-tool[data-active] { box-shadow: var(--card-shadow-hover); color: var(--ink); }
.ui-as-tool__count {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--ink);
  font-size: 11px;
  font-weight: 500;
  color: var(--on-ink);
  animation: ui-as-pop 220ms var(--ease);
}

/* Popovers: attached to their trigger, they fade and scale in from that side */
.ui-as-anchor { position: relative; display: inline-flex; }
.ui-as-popover {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  transform-origin: top left;
  animation: ui-as-popover 220ms var(--ease);
}
.ui-as-popover[data-align="end"] { right: 0; left: auto; transform-origin: top right; }
.ui-as-popover[data-side="top"] { top: auto; bottom: calc(100% + 6px); transform-origin: bottom left; animation-name: ui-as-popover-up; }
.ui-as-popover[data-side="top"][data-align="end"] { transform-origin: bottom right; }
.ui-as-popover[data-side="right"] { top: auto; bottom: 0; left: calc(100% + 12px); transform-origin: bottom left; }
@keyframes ui-as-popover-up { from { opacity: 0; transform: scale(0.96) translateY(4px); } to { opacity: 1; transform: none; } }
/* The Filter Menu at its own size – 13px rows like every other menu, no shrinking */
.ui-as-popover--filter .ui-fmc { width: 300px; }
.ui-as-popover--filter .ui-fmc__title { font-size: 13px; line-height: 20px; }

.ui-as-menu {
  min-width: 168px;
  padding: 4px;
  border-radius: 12px;
  background: var(--card);
  box-shadow: 0 0 0 0.5px var(--line-strong), 0 12px 32px -8px rgba(0, 0, 0, 0.16);
}
.ui-as-menu__title { display: block; padding: 6px 10px 4px; font-size: 12px; font-weight: 500; color: var(--faint); }
.ui-as-menu__list { display: grid; gap: 1px; }
.ui-as-menu__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
.ui-as-menu__item[data-rich] { min-height: 44px; padding: 6px 10px; }
.ui-as-menu__item > svg { flex: none; color: var(--muted); }
.ui-as-menu__logo { display: grid; flex: none; place-items: center; width: 16px; height: 16px; }
.ui-as-menu__logo > svg { width: 14px; height: 14px; }
/* A flag: a small rounded rectangle with a hairline, so white stripes don't melt into the menu */
.ui-as-flag, .ui-as-menu__logo > .ui-as-flag { flex: none; width: 16px; height: 11px; overflow: hidden; border-radius: 2.5px; box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.14); }
.ui-as-menu__item > svg:last-child:not(:first-child) { margin-left: auto; color: var(--ink); }
.ui-as-menu__label { display: grid; flex: 1; gap: 1px; min-width: 0; }
.ui-as-menu__label small { font-size: 12px; line-height: 16px; color: var(--faint); }
/* Long names in menus stay on one line – the full name on hover */
.ui-as-menu__text, .ui-as-menu__label small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-as-menu__item > svg { flex: none; }
.ui-as-menu__empty { display: block; padding: 6px 8px; font-size: 13px; color: var(--faint); }
/* A group's title: small and gray, lined up with the items' icons */
.ui-as-menu__heading { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 8px 10px 4px; font-size: 12px; line-height: 16px; color: var(--faint); }
.ui-as-menu__heading > svg { flex: none; color: var(--faint); }
.ui-as-menu__heading-note { flex: none; margin-left: auto; }
.ui-as-menu__item:hover { background: var(--hover); color: var(--ink); }
.ui-as-menu__item[aria-checked="true"] { color: var(--ink); font-weight: 500; }
.ui-as-menu__item[aria-checked="true"] small { font-weight: 400; }
.ui-as-menu__item[data-danger] { color: #dc2626; }
.ui-as-menu__item:disabled { opacity: 0.45; cursor: default; background: none; }
/* Shortcuts, dividers and menus that open to the side */
.ui-as-menu__kbd { flex: none; margin-left: auto; padding-left: 16px; font: inherit; font-size: 12px; letter-spacing: 0.04em; color: var(--faint); }
.ui-as-menu__item > .ui-as-menu__kbd + svg { margin-left: 8px; }
.ui-as-menu__sep { display: block; height: 1px; margin: 4px 6px; background: var(--line); }
.ui-as-menu__sub { position: relative; display: block; }
.ui-as-menu__item > svg:last-child:not(:first-child):is(.ui-as-menu__sub svg) { color: var(--faint); }
.ui-as-menu__subpanel {
  position: absolute;
  z-index: 1;
  top: -4px;
  left: calc(100% + 4px);
  visibility: hidden;
  opacity: 0;
  transition: opacity 120ms ease, visibility 0s 120ms;
}
/* A bridge over the gap, so moving the pointer across doesn't close it */
.ui-as-menu__subpanel::before { content: ""; position: absolute; top: 0; bottom: 0; left: -8px; width: 8px; }
.ui-as-menu__sub:is(:hover, :focus-within, [data-open]) > .ui-as-menu__subpanel { visibility: visible; opacity: 1; transition: opacity 120ms ease; }
.ui-as-menu__sub:is(:hover, :focus-within, [data-open]) > .ui-as-menu__item { background: var(--hover); color: var(--ink); }
.ui-as-menu__item[data-danger] > svg { color: #dc2626; }

.ui-as-toast {
  max-width: calc(100% - 32px);
  position: absolute;
  z-index: 40;
  left: 50%;
  bottom: 20px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 14px 0 12px;
  border-radius: 999px;
  background: var(--ink);
  font-size: 13px;
  color: var(--on-ink);
  box-shadow: 0 10px 24px -8px rgba(0, 0, 0, 0.35);
  translate: -50% 0;
  animation: ui-as-toast 2200ms var(--ease) both;
}

/* Shared motion: content that changes (tabs, filters, new messages) rises in; --i staggers a list */
.ui-as-rise { animation: ui-as-rise 420ms var(--ease) both; animation-delay: calc(var(--i, 0) * 35ms); }
/* The rise makes each row a layer of its own – a row with an open menu lifts above the rows after it */
.ui-as-rise:has(.ui-as-popover) { position: relative; z-index: 10; }
@keyframes ui-as-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes ui-as-pop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: none; } }
@keyframes ui-as-popover { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes ui-as-toast {
  0% { opacity: 0; transform: translateY(12px) scale(0.96); }
  12%, 85% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: translateY(6px); }
}
@media (prefers-reduced-motion: reduce) {
  /* One 1ms run – a looping pulse (a live dot, a listening mic) doesn't turn into a flicker */
  .ui-as *, .ui-as *::before, .ui-as *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; scroll-behavior: auto !important; }
}
/* Rows in scrolling lists and menus: the focus ring sits inside the row, so the list's edge doesn't cut it off */
.ui-as :is(.ui-as-side__nav, .ui-as-menu, .ui-as-panel__body) :is(button, [href], [tabindex]):focus-visible { outline-offset: -2px; }
/* Keyboard focus on a menu item shows like the pointer's hover */
.ui-as-menu__item:focus-visible { background: var(--hover); color: var(--ink); }

/* Touch screens: no hover – the row tools stay in view (just ⋯; pinning is in its menu), and targets grow to a finger's size */
@media (hover: none) {
  .ui-as-chat-row__tools, .ui-as-chat-folder-row .ui-as-chat-row__tools { opacity: 1; }
  .ui-as-chat-row__pin { display: none; }
  .ui-as-chat-row .ui-as-chat-row__link, .ui-as-chat-folder-row > .ui-as-chat-folder { padding-right: 34px; }
  .ui-as-chat-row:is(:hover, :has(:focus-visible), [data-menu]) .ui-as-chat-row__link,
  .ui-as-chat-folder-row:is(:hover, :has(:focus-visible), [data-menu]) > .ui-as-chat-folder { padding-right: 34px; }
  .ui-as-chat-row__tool { color: var(--faint); }
}
@media (pointer: coarse) {
  /* Rows grow to a finger's height; small icon buttons keep their look and get an invisible ring that takes the tap */
  .ui-as-side__item, .ui-as-side__search, .ui-as-side__workspace, .ui-as-side__back, .ui-as-chat-row__rename { height: 36px; }
  .ui-as-chat-row__tools { top: 6px; }
  .ui-as-user { height: 40px; }
  .ui-as-menu__item { min-height: 40px; }
  :is(.ui-as-chat-row__tool, .ui-as-news__close, .ui-as-search__clear, .ui-as-tool, .ui-asw__more, .ui-as-bar__pick) { position: relative; }
  .ui-as-icon-btn:not(.ui-as-side-open, .ui-as-panel-open) { position: relative; }
  :is(.ui-as-icon-btn, .ui-as-chat-row__tool, .ui-as-tool, .ui-as-view__btn, .ui-as-tabs__tab, .ui-asw__more)::after { content: ""; position: absolute; inset: -4px; }
  :is(.ui-as-news__close, .ui-as-search__clear)::after { content: ""; position: absolute; inset: -7px; }
}
.ui-as-search input::-webkit-search-cancel-button { display: none; }

/* Empty state in a dashed drop area */
.ui-as-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 16px;
  padding: 48px 24px 52px;
  border-radius: 12px;
  background: var(--frame);
  box-shadow: inset 0 0 0 0.5px var(--line);
  text-align: center;
}
.ui-as-empty[data-tall] { padding: 48px 24px 48px; }
.ui-as-empty__icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 11px;
  background: var(--chip);
  color: var(--muted);
}
.ui-as-empty__title { margin-top: 16px; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); }
.ui-as-empty__text { max-width: 430px; margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--muted); text-wrap: balance; }
.ui-as-empty > .ui-buttonc { margin-top: 18px; }

/* Glass Folder from the library at icon size; hovering the whole card or row opens it like hovering the folder itself */
.ui-as-folder-card__icon, .ui-as-folder-head__icon {
  position: relative;
  flex: none;
  width: 30px;
  height: 25px;
}
.ui-as-folder-card__icon .ui-fd, .ui-as-folder-head__icon .ui-fd {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 75px;
  translate: -50% -50%;
}
:is(.ui-as-folder-card, .ui-as-folder-head):hover .ui-fd-icon { transform: translate(-50%, -48%) scale(1.03); }
:is(.ui-as-folder-card, .ui-as-folder-head):hover .ui-fd-doc--left { transform: translate(32px, 70px) rotate(9deg); }
:is(.ui-as-folder-card, .ui-as-folder-head):hover .ui-fd-doc--right { transform: translate(286px, 76px) rotate(5deg); }
:is(.ui-as-folder-card, .ui-as-folder-head):hover .ui-fd-doc--middle { transform: translate(166px, 52px) rotate(-7deg); }
:is(.ui-as-folder-card, .ui-as-folder-head):hover .ui-fd-front {
  top: 24.8%;
  border-radius: 3cqw 3cqw 6.333cqw 6.333cqw;
  transform: translateZ(2.33cqw) rotateX(-9deg);
}

.ui-as-meta { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 16px; color: var(--muted); }
.ui-as-meta svg { color: var(--faint); }
.ui-as-toast > svg { flex: none; }
.ui-as-toast__text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }


/* File card – used for templates and for the files inside a folder */
.ui-as-template { display: grid; grid-template-columns: minmax(0, 1fr); width: 239px; text-align: left; }
.ui-as-template__preview {
  display: block;
  height: 152px;
  padding: 3px;
  border-radius: 12px;
  background: var(--frame);
  box-shadow: inset 0 0 0 0.5px var(--line);
  transition: box-shadow 160ms ease;
}
.ui-as-template__preview .ui-as-doc { box-shadow: var(--card-shadow); }
.ui-as-template:hover .ui-as-template__preview { box-shadow: inset 0 0 0 0.5px var(--line-strong); }
/* One line at every width – the full name on hover */
.ui-as-template__name { margin-top: 8px; overflow: hidden; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--strong); white-space: nowrap; text-overflow: ellipsis; }
.ui-as-template .ui-as-meta { margin-top: 0; }

/* File illustration: a small white page with hairline rows, a colored type tag over its lower left corner */
.ui-as-doc {
  --doc-tag: #3b82f6;
  --doc-tag-shade: 30, 64, 175;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  border-radius: 10px;
  background: var(--card);
}
.ui-as-doc[data-color="rose"] { --doc-tag: #f43f5e; --doc-tag-shade: 159, 18, 57; }
.ui-as-doc[data-color="emerald"] { --doc-tag: #10b981; --doc-tag-shade: 6, 95, 70; }
/* Moved right by what the tag adds on the left, so the drawing sits in the middle */
.ui-as-doc__art { position: relative; display: block; width: 52px; translate: 4px 0; }

/* The page: white with a hairline ring and a soft shadow; the top right corner is cut (rounded where cuts aren't supported) */
.ui-as-doc__page {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* The lower room the closing stroke had stays, so the page keeps its height */
  padding: 10px 10px 22px;
  border-radius: 5px 9px 5px 5px;
  corner-top-right-shape: bevel;
  background: var(--card);
  box-shadow: 0 0 0 1px var(--line-strong), 0 4px 8px -2px rgba(0, 0, 0, 0.065), 0 2px 3px -2px rgba(0, 0, 0, 0.065);
  transition: transform 420ms var(--ease);
}
.ui-as-doc__rows { display: flex; flex-direction: column; gap: 5px; }
.ui-as-doc__row { display: flex; gap: 3px; }
.ui-as-doc__row i { display: block; height: 2px; border-radius: 1px; background: color-mix(in srgb, var(--ink) 10%, transparent); }
/* A spreadsheet's first row is its header */
.ui-as-doc__page[data-type="XLS"] .ui-as-doc__row:first-child i { background: color-mix(in srgb, var(--ink) 22%, transparent); }
.ui-as-doc__image { display: block; height: 14px; border-radius: 2px; background: color-mix(in srgb, var(--ink) 6%, transparent); }
/* The type tag overlaps the page's lower left corner; the box is trimmed to the capitals, so they sit in its
   exact middle (a slightly deeper top padding stands in where trimming isn't supported) */
.ui-as-doc__type {
  position: absolute;
  left: -8px;
  bottom: 11px;
  z-index: 2;
  display: block;
  padding: 3.5px 4px 2.5px;
  border-radius: 3px;
  background: var(--doc-tag);
  box-shadow: 0 4px 8px -3px rgba(var(--doc-tag-shade), 0.3);
  font-size: 9px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: #fff;
  transition: transform 420ms var(--ease);
}
@supports (text-box: trim-both cap alphabetic) {
  .ui-as-doc__type { padding: 3.5px 4px; text-box: trim-both cap alphabetic; }
}
.ui-as-template:hover .ui-as-doc__page { transform: translateY(-2px); }
.ui-as-template:hover .ui-as-doc__type { transform: translate(-1px, -3px); }

/* Workspace initial and user initials */
.ui-as-side__logo { font-size: 10.5px; font-weight: 500; color: var(--ink); }
.ui-as-user__initials {
  display: grid;
  place-items: center;
  width: 21px;
  height: 21px;
  border-radius: 50%;
  background: var(--accent-soft);
  font-size: 9.5px;
  font-weight: 500;
  color: var(--accent);
}

/* Scrim behind the drawer – only used on narrow screens */
.ui-as-scrim { display: none; }

/* ---------- Resizing ---------- */

/* A 12px strip centred on the main area's edge; on hover a darker line runs along the page's edge, fading to nothing
   at both ends – so it meets the rounded corners of the inset panel softly */
.ui-as-resizer {
  position: absolute;
  z-index: 15;
  top: calc(var(--bar-h, 0px) + var(--frame-gap));
  bottom: var(--frame-gap);
  width: 12px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
.ui-as-resizer[data-edge="left"] { left: calc(var(--side-w, 272px) - 6px); }
/* Centred on the work area's left edge – inset it sits half a gap off the page, flat it touches it */
.ui-as-resizer[data-edge="right"] { right: calc(var(--panel-w, 360px) - var(--frame-gap) / 2 - 6px); }
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-resizer[data-edge="right"] { right: calc(var(--panel-w, 360px) - 6px); }
.ui-as-resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(to bottom, transparent, var(--edge-active) 22%, var(--edge-active) 78%, transparent);
  opacity: 0;
  transition: opacity 180ms ease;
}
/* Exactly on a border: the page's left edge on the left, the work area's left edge on the right */
.ui-as-resizer[data-edge="left"]::after { left: 6px; }
.ui-as-resizer[data-edge="right"]::after { left: 6px; }
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-resizer[data-edge="right"]::after { left: 5px; }
.ui-as-resizer:hover::after { opacity: 1; transition-delay: 100ms; }
.ui-as-resizer:focus-visible::after, .ui-as-resizer[data-dragging]::after { opacity: 1; transition-delay: 0ms; }

/* ---------- Work area on the right ---------- */

/* Sits on the gray page like the sidebar, mirrored; the main area gives up its right gap to it */
.ui-as-app[data-panel] > .ui-as-main { grid-column: 2; }
.ui-as-app[data-panel="open"] > .ui-as-main { margin-right: 0; }
/* Inset: the work area is a rounded white panel of its own, like the main area */
.ui-as-panel {
  grid-column: 3;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  /* Half the gap towards the main area, the full one to the window's edges */
  width: calc(var(--panel-w, 360px) - 1.5 * var(--frame-gap));
  min-height: 0;
  margin: var(--frame-gap) var(--frame-gap) var(--frame-gap) calc(var(--frame-gap) / 2);
  padding: 10px 10px 10px 12px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  background: var(--panel);
  transition: opacity 260ms ease, translate 420ms var(--ease), visibility 0s;
}
.ui-as-app[data-panel="closed"] > .ui-as-panel {
  visibility: hidden;
  opacity: 0;
  translate: 16px 0;
  transition: opacity 200ms ease, translate 420ms var(--ease), visibility 0s 420ms;
}
.ui-as-panel__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding-left: 6px;
}
.ui-as-panel__title { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; font-size: 13px; font-weight: 500; color: var(--ink); white-space: nowrap; text-overflow: ellipsis; }
/* A plain text heading needs a block box for its … */
.ui-as-panel__title:not(:has(> *)) { display: block; }
.ui-as-panel__body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; margin: 0 -2px; padding: 12px 2px 4px; }

/* Its icon waits in the top right corner of the main area while it's closed */
.ui-as-panel-open {
  position: fixed;
  z-index: 20;
  top: calc(var(--frame-gap) + 9px);
  right: calc(var(--frame-gap) + 9px);
  visibility: hidden;
  opacity: 0;
  transition: opacity 200ms ease, visibility 0s 200ms;
}
.ui-as-app[data-panel="closed"] > .ui-as-panel-open {
  visibility: visible;
  opacity: 1;
  transition: opacity 260ms ease 160ms, visibility 0s;
}

/* ---------- Header across the app ---------- */

/* One bar over everything: a row of its own on top, split into the sidebar's, the page's and the work area's part */
.ui-as-app[data-header] { --bar-h: 48px; grid-template-rows: var(--bar-h) minmax(0, 1fr); }
.ui-as-app[data-header] > .ui-as-bar--side { grid-area: 1 / 1; }
.ui-as-app[data-header] > .ui-as-bar--main { grid-area: 1 / 2; }
.ui-as-app[data-header] > .ui-as-bar--panel { grid-area: 1 / 3; }
.ui-as-app[data-header] > .ui-as-side { grid-area: 2 / 1; }
.ui-as-app[data-header] > .ui-as-main { grid-area: 2 / 2; margin-top: 0; }
.ui-as-app[data-header] > .ui-as-panel { grid-area: 2 / 3; }
.ui-as-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  height: var(--bar-h);
  overflow: hidden;
  transition: padding 420ms var(--ease), opacity 260ms ease;
}
.ui-as-bar--side { padding: 0 10px; }
.ui-as-bar--side > :last-child { margin-left: auto; }
.ui-as-bar--side > .ui-as-anchor { display: flex; min-width: 0; }
.ui-as-app[data-header] > .ui-as-side > .ui-as-side__search { margin-top: 0; }
.ui-as-bar--main { justify-content: space-between; gap: 12px; padding: 0 12px 0 18px; }
.ui-as-bar--panel { justify-content: space-between; padding: 0 10px 0 16px; }
.ui-as-bar__title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; font-weight: 500; color: var(--ink); white-space: nowrap; }
.ui-as-bar__title > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-as-bar__actions { display: flex; flex: none; align-items: center; gap: 2px; }
.ui-as-bar__pick { display: flex; align-items: center; gap: 6px; min-width: 0; height: 30px; margin-left: -8px; padding: 0 8px; border-radius: 8px; color: var(--ink); }
.ui-as-bar__pick > span { overflow: hidden; text-overflow: ellipsis; }
.ui-as-bar__pick svg { color: var(--faint); }
.ui-as-bar__pick:hover { background: var(--hover); }
/* The sidebar's head – workspace and collapse – moves into the bar; the search field leads the sidebar */
.ui-as-app[data-header] > .ui-as-side > .ui-as-side__head,
.ui-as-app[data-header] > .ui-as-panel > .ui-as-panel__head { display: none; }
.ui-as-app[data-header] > .ui-as-panel > .ui-as-panel__body { padding-top: 2px; }
/* Folded away: the work area's part of the bar goes with it */
.ui-as-app[data-header][data-panel="closed"] > .ui-as-bar--panel { opacity: 0; }
.ui-as-app[data-header][data-panel="closed"] > .ui-as-bar--main { padding-right: 50px; }
.ui-as-app[data-header] > :is(.ui-as-side-open, .ui-as-panel-open) { top: 10px; }

/* A page that is just one centred block, e.g. an empty state */
.ui-as-center { display: grid; place-items: center; min-height: 100%; padding: 48px 32px; }
.ui-as-empty[data-bare] { margin-top: 0; padding: 0; border: 0; background: none; box-shadow: none; }

/* ---------- Narrow: tablet and phone ---------- */
/* Container queries on the app itself, so a scaled 1440 px preview keeps the desktop layout */

@container ui-as (max-width: 900px) {
  /* The main panel takes the whole width; the sidebar slides in over it as a drawer */
  .ui-as-app > .ui-as-main { grid-row: 1; grid-column: 1 / -1; margin-left: var(--frame-gap); }
  .ui-as-app > .ui-as-side {
    position: absolute;
    z-index: 50;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(264px, calc(100% - 56px));
    padding: 10px 10px 10px 12px;
    border-radius: 0 18px 18px 0;
    background: var(--page);
    box-shadow: 0 0 0 0.5px var(--line-strong), 0 24px 48px -12px rgba(0, 0, 0, 0.28);
  }
  .ui-as-app:not([data-drawer]) > .ui-as-side {
    visibility: hidden;
    translate: calc(-100% - 24px) 0;
    transition: translate 380ms var(--ease), visibility 0s 380ms;
  }
  .ui-as-app[data-drawer] > .ui-as-side {
    visibility: visible;
    opacity: 1;
    translate: 0 0;
    transition: translate 420ms var(--ease), visibility 0s;
  }
  /* The work area on the right becomes a drawer too, sliding in from the right */
  .ui-as-app[data-panel] { --panel-col: 0px; }
  .ui-as-app[data-panel] > .ui-as-main { grid-column: 1 / -1; margin-right: var(--frame-gap); }
  .ui-as-app > .ui-as-panel {
    /* Out of the grid: absolutely placed against the whole app, not the zero-width column it sits in on wide screens */
    grid-area: auto;
    position: absolute;
    z-index: 50;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(360px, calc(100% - 56px));
    margin: 0;
    padding: 10px 12px 10px 12px;
    border: 0;
    border-radius: 18px 0 0 18px;
    background: var(--panel);
    box-shadow: 0 0 0 0.5px var(--line-strong), 0 24px 48px -12px rgba(0, 0, 0, 0.28);
  }
  .ui-as-app[data-panel="closed"] > .ui-as-panel {
    translate: calc(100% + 24px) 0;
    transition: translate 380ms var(--ease), visibility 0s 380ms;
  }
  .ui-as-app[data-panel="open"] > .ui-as-panel { visibility: visible; opacity: 1; translate: 0 0; transition: translate 420ms var(--ease), visibility 0s; }
  .ui-as-app[data-panel="open"] > .ui-as-scrim { visibility: visible; opacity: 1; transition: opacity 300ms ease, visibility 0s; }
  .ui-as-app > .ui-as-panel-open { right: calc(var(--frame-gap) + 9px); background: var(--panel); }
  .ui-as-app > .ui-as-panel-open:hover { background: var(--chip); }
  /* With the header: the page's part spans the bar; the sidebar's and work area's parts go into their drawers */
  .ui-as-app[data-header] > .ui-as-main { grid-area: 2 / 1 / 3 / -1; }
  .ui-as-app[data-header] > .ui-as-bar--main { grid-area: 1 / 1 / 2 / -1; padding-left: 50px; }
  .ui-as-app[data-header][data-panel] > .ui-as-bar--main { padding-right: 50px; }
  .ui-as-app[data-header] > :is(.ui-as-bar--side, .ui-as-bar--panel) { display: none; }
  /* The drawers cover the full height, over the bar too – not just their grid row */
  .ui-as-app[data-header] > :is(.ui-as-side, .ui-as-panel) { grid-area: auto; }
  .ui-as-app[data-header] > .ui-as-side > .ui-as-side__head { display: flex; }
  .ui-as-app[data-header] > .ui-as-side > .ui-as-side__search { margin-top: 12px; }
  .ui-as-app[data-header] > .ui-as-panel > .ui-as-panel__head { display: flex; }
  .ui-as-app[data-header] > .ui-as-panel > .ui-as-panel__body { padding-top: 12px; }
  .ui-as-app > .ui-as-scrim {
    display: block;
    position: absolute;
    z-index: 45;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    visibility: hidden;
    opacity: 0;
    transition: opacity 300ms ease, visibility 0s 300ms;
  }
  .ui-as-app[data-drawer] > .ui-as-scrim { visibility: visible; opacity: 1; transition: opacity 300ms ease, visibility 0s; }
  :where(.dark, [data-theme="dark"]) .ui-as-app > .ui-as-scrim { background: rgba(0, 0, 0, 0.55); }
  /* The icon to open it always waits in the top left corner of the panel */
  .ui-as-app:not([data-drawer]) > .ui-as-side-open {
    visibility: visible;
    opacity: 1;
    transition: opacity 260ms ease 160ms, visibility 0s;
  }
  /* It stays put while the panel scrolls, so it gets the panel's color behind it */
  .ui-as-app > .ui-as-side-open { left: calc(var(--frame-gap) + 9px); background: var(--panel); }
  .ui-as-app > .ui-as-side-open:hover { background: var(--chip); }

  /* Page parts: less padding, toolbars wrap */
  .ui-as-page { padding: 46px 24px 48px; }
  /* File cards fill the cells of the grids the screens switch to */
  .ui-as-main .ui-as-file-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .ui-as-main .ui-as-file-grid .ui-as-template { width: 100%; }
  .ui-as-main .ui-as-file-grid .ui-as-template__name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ui-as-main .ui-as-file-grid .ui-as-meta { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ui-as-main .ui-as-file-grid .ui-as-meta svg { display: inline-block; vertical-align: -2px; }
  .ui-as-toolbar { flex-wrap: wrap; row-gap: 10px; }
  .ui-as-toolbar__right { flex-wrap: wrap; }
  .ui-as-section-head[data-inline] { flex-wrap: wrap; row-gap: 12px; }
}

@container ui-as (max-width: 600px) {
  .ui-as-app > * { --frame-gap: 6px; }
  /* No room for a submenu beside its menu on a phone: it opens in place, under its item */
  .ui-as-menu__subpanel { position: static; display: none; min-width: 0 !important; margin: 2px 0 4px; padding: 0 0 0 14px; border-radius: 0; background: none; box-shadow: none; }
  .ui-as-menu__subpanel::before { display: none; }
  .ui-as-menu__sub:is(:focus-within, [data-open]) > .ui-as-menu__subpanel { display: block; }
  .ui-as-menu__sub:is(:focus-within, [data-open]) > .ui-as-menu__item > svg:last-child { transform: rotate(90deg); }
  /* A short screen keeps the sidebar for its lists: What's new waits for a wider one */
  .ui-as-news { display: none; }
  .ui-as-app > .ui-as-main { border-radius: 11px; }
  .ui-as-page { padding: 52px 16px 40px; }
  .ui-as-page-title { font-size: 20px; line-height: 26px; }
  .ui-as-section-head { margin-top: 32px; }
  /* Toolbars: tabs on their own line, the tools below; search takes what is left */
  .ui-as-toolbar__left, .ui-as-toolbar__right { width: 100%; }
  .ui-as-toolbar__right .ui-as-search { order: 9; flex: 1 1 100%; width: auto !important; }
  .ui-as-toolbar__right > .ui-buttonc:last-child { margin-left: auto; }
  .ui-as-tabs { max-width: 100%; overflow-x: auto; scrollbar-width: none; }
  .ui-as-tabs__tab { flex: none; }
  .ui-as-empty { padding: 36px 18px 40px; }
  .ui-as-popover--filter .ui-fmc { width: 300px; }
  .ui-as-main .ui-as-file-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 10px; }
  .ui-as-main .ui-as-file-grid .ui-as-template__preview { height: 128px; }
}

/* ----- Flat: no panel – the page runs edge to edge next to the sidebar, split by a hairline ----- */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) { --frame-gap: 0px; }
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > * { --frame-gap: 0px; }

/* Main area: no panel – it fills the rest of the app, a hairline on its left is the only edge */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-main {
  margin: 0;
  border: 0;
  border-left: 1px solid var(--line);
  border-radius: 0;
  background: var(--panel);
}
/* Sidebar collapsed: nothing is left to divide */


/* Work area on the right: flat too – a hairline on the main area's right is its edge */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-panel="open"] > .ui-as-main { border-right: 1px solid var(--line); }
/* …and the same white as the main area – no frame of its own */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-panel { width: var(--panel-w, 360px); margin: 0; padding: 10px 10px 10px 10px; border: 0; border-radius: 0; background: var(--panel); }
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-panel-open { top: 10px; right: 12px; }

/* Header across the app: the page's and the work area's parts are white like the page, the sidebar's stays gray; no line under it –
   only the page's side lines run on up through the bar */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-header] > .ui-as-bar--main { background: var(--panel); border-left: 1px solid var(--line); transition: padding 420ms var(--ease), border-color 260ms ease; }

.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-header][data-panel="open"] > .ui-as-bar--main { border-right: 1px solid var(--line); }
/* The work area's part of the bar is white like the page's – only the sidebar's part stays gray */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-header] > .ui-as-bar--panel { background: var(--panel); }
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-header] > .ui-as-side { padding-top: 2px; }
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-header] > .ui-as-panel { padding-top: 12px; }

/* The sidebar's rows line up with a page's 46px title on top */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-side { padding: 10px 10px 10px 10px; }

/* The icon that brings the sidebar back sits where the collapse icon was */
.ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-side-open { top: 10px; left: 12px; }

@container ui-as (max-width: 900px) {
  /* Narrow: the main area is the whole app; the drawer slides in flat with a hairline edge */
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-main { margin: 0; border-left: 0; }
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-side {
    border-radius: 0;
    box-shadow: 1px 0 0 var(--line), 0 24px 48px -12px rgba(0, 0, 0, 0.22);
  }
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-side-open { left: 12px; }
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-panel] > .ui-as-main { margin: 0; border-right: 0; }
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-panel {
    border-radius: 0;
    box-shadow: -1px 0 0 var(--line), 0 24px 48px -12px rgba(0, 0, 0, 0.22);
  }
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-panel-open { right: 12px; }
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"]))[data-header] > .ui-as-bar--main { border-left: 0; border-right: 0; }
}
@container ui-as (max-width: 600px) {
  .ui-as-app:is([data-layout="flat"], [data-shell="flat"] :not([data-layout="inset"])) > .ui-as-main { border-radius: 0; }
}
`;
