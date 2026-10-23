# Visual style

> Status: Draft · Part 1 of the design rules, with [UX guidelines](./ux-guidelines.md) · Gate: [design process](./design-process.md) · Values in the [design system](./design-system.md)

How OverBench looks, as rules a screen's author applies. The [design system](./design-system.md) records the values: every color, radius, size and timing token and the measurement behind it. This guide records the choices made with those values and gives one answer for each: which icon, which size, which color, which radius, how each state looks. Two people who build the same control from it should arrive at the same pixels, so new UI starts aligned instead of being aligned detail by detail in review. How OverBench behaves is the [UX guidelines](./ux-guidelines.md); every design passes both through the [design process](./design-process.md).

- A rule here holds on every screen. A screen that needs an exception says so in [Interface](./ui.md), with the reason.
- A case this guide does not cover is decided once and written here first, then built; never settled in one component alone.
- Values are not repeated here; each rule links to the token it uses.
- Most rules come from the maintainer's decisions in [M0 feedback](../milestones/m0-feedback.md); the problem number is given where the reason matters.

## Character

OverBench is a flat, technical workbench. Its look comes from hairlines, small steps in surface lightness and well-set type, never from decoration.

1. **Flat.** Nothing at rest has a shadow, a gradient or a raised card. Only what floats above the canvas casts a shadow ([elevation](#lines-and-elevation)).
2. **Linear.** Icons are thin outlines, borders are hairlines, separators are inset to the text they divide.
3. **Restrained, not grey.** The chrome is neutral. Color appears only where it carries meaning ([color](#color)), and there it is clear rather than timid ([problem 35](../milestones/m0-feedback.md#35-the-palette-is-black-and-grey-and-reads-as-cheap)).
4. **Content first.** The agent's work has the highest contrast on screen. Secondary chrome steps back: muted at rest, full contrast only under the pointer, pressed or chosen. The app's own navigation, the sidebar's rows and the top bar's buttons, is drawn in the text color, as in the reference ([#127](https://github.com/overbench/overbench/issues/127)).
5. **Less on screen.** Every element says something the user needs now. A word that repeats what a shape already says, a time on every row, or a hint the menu already gives is removed, not styled ([problems 8, 25, 28](../milestones/m0-feedback.md)).

Claude Desktop is the benchmark for measurements and behavior, never for brand ([design reference](./design-system.md#design-reference)). Where this guide leaves a detail open, measure the reference, then write the result here.

## Icons

### Source

- Every UI icon is a Lucide component from `lucide-react`. Never draw an icon, inline an SVG for one, or mix in another set ([problem 37](../milestones/m0-feedback.md#37-icons-look-heavy-use-thin-line-icons-from-a-library)).
- Three kinds of image are not UI icons and keep their own rules: the [agent marks](./design-system.md#agent-marks), the [file-type icons](./design-system.md#file-icons), and data graphics such as the branch lane and the usage pie.

### Shape

- Take the plainest shape that names the meaning: `Folder` over `FolderOpen`, `SunMoon` over `Palette`, `Trash` over `Trash2`. Perspective, extra strokes and filled parts read heavier than their neighbours.
- Outlines only. The one filled shape is the stop square of a running turn (`Square` with `fill-current`), the convention every media control shares. Status dots are shapes drawn with CSS, not icons.
- One meaning, one icon, across the app ([vocabulary](#vocabulary)); one icon never stands for two meanings. The exceptions are pairs on either side of a value, where they cannot read as their other meaning: `Plus`, which also increases a stepped value beside `Minus`, and `ChevronRight`, which also steps to the next page beside `ChevronLeft` around a counter such as "3 / 5".
- When no Lucide shape fits, use a word. A near-miss icon is worse than a label.

### Weight

One stroke width for every icon, set once by `LucideProvider` in `main.tsx`; its value is in [density and sizing](./design-system.md#density-and-sizing). No call site passes `strokeWidth` or `absoluteStrokeWidth`.

### Size

Four sizes, chosen by context:

| Size  | Utility    | Context                                                                                        |
| ----- | ---------- | ---------------------------------------------------------------------------------------------- |
| 20 px | `size-5`   | Chrome: the sidebar's nav rows, the top bar's buttons (`icon-compact`)                         |
| 16 px | `size-4`   | Inside a control: `compact` and `default` buttons, pane headers                                |
| 14 px | `size-3.5` | Inside a card or menu: `sm` buttons, selects, chevrons, tool call rows, sidebar row actions    |
| 12 px | `size-3`   | Beside 12 px text: chips, `xs` buttons, secondary lines, status icons in meta text, file chips |

- No other size: 11, 13, 15 and 18 px are off the scale. The 20 px step came with the reference's density on 2026-10-23 ([#127](https://github.com/overbench/overbench/issues/127)). A context that truly needs another size adds a row here first.
- A button sizes its icon through its own `size` variant; an icon inside a button takes no size class.
- An empty state's icon goes in the `Empty` component's media slot, at the size the slot gives it.

### Color and placement

- An icon takes the color of its text (`currentColor`): `--icon-default` (`text-icon`) at rest, `--text-primary` under the pointer, pressed or chosen. Chrome icons, the sidebar's nav rows and the top bar's buttons, are `--text-primary` at rest too, as in the reference, where they measure near black.
- Only a status icon takes a color: `--danger` for a failure and `--attention` for something waiting for your approval. A completed step, a passing check or an open pull request stays `--icon-default` ([repository states](./design-system.md#repository-state)). A neutral action never takes a color.
- In a button, an icon sits in the `data-icon="inline-start"` or `"inline-end"` slot, so the padding adjusts. Inline with text, it sits at `vertical-align: -0.125em`.
- A busy button swaps its icon for a `Spinner` of the same size and keeps its label and width.
- An icon-only button has an accessible name and a tooltip that gives the name and the shortcut.
- Menu items carry no icons ([menus](./design-system.md#menus-and-dialogs)); an agent mark is the one exception.

### Vocabulary

What each common meaning is drawn with. Tool call kinds and git states keep their own tables, in [tool calls](./ui.md#tool-calls) and [repository state](./design-system.md#repository-state). A new meaning adds its row here before it ships.

| Meaning                                                           | Icon                     | Not                               |
| ----------------------------------------------------------------- | ------------------------ | --------------------------------- |
| Close, dismiss, remove from a list                                | `X`                      |                                   |
| Add, new session, new terminal                                    | `Plus`                   | `SquarePen`, `CirclePlus`         |
| More actions                                                      | `Ellipsis`               | `EllipsisVertical`                |
| Folded group, submenu                                             | `ChevronRight`           |                                   |
| Open group, menu trigger, select                                  | `ChevronDown`            | `ChevronsUpDown`                  |
| Back                                                              | `ArrowLeft`              | `ChevronLeft`                     |
| Send                                                              | `ArrowUp`                | `Send`                            |
| Stop a turn                                                       | `Square`, filled         | `CircleStop`                      |
| Retry or restart what failed or stopped                           | `RotateCw`               |                                   |
| Read fresh data: reload the environment, fetch, check for updates | `RefreshCw`              |                                   |
| Reset to the default                                              | `RotateCcw`              |                                   |
| Copy, then copied                                                 | `Copy`, then `Check`     | `Clipboard`                       |
| The chosen item of a list                                         | `Check`                  | `CircleCheck`                     |
| Completed, passing                                                | `CircleCheck`            |                                   |
| Error, failed                                                     | `CircleAlert`            | `CircleX`, except a failing check |
| Warning, conflict                                                 | `TriangleAlert`          |                                   |
| Information                                                       | `Info`                   |                                   |
| Help, an unknown value                                            | `CircleHelp`             |                                   |
| Delete                                                            | `Trash`                  | `Trash2`                          |
| Rename, edit                                                      | `Pencil`                 | `SquarePen`                       |
| A web link, open outside the app                                  | `ExternalLink`           |                                   |
| A folder, show in the file manager, the Files pane                | `Folder`                 | `FolderOpen`                      |
| A file                                                            | `File`                   |                                   |
| Save a file; save a report to disk                                | `Save`; `FileDown`       |                                   |
| Terminal                                                          | `SquareTerminal`         | `Terminal`                        |
| Search, filter                                                    | `Search`                 | `Filter`                          |
| Settings                                                          | `Settings`               | `Cog`, `SlidersHorizontal`        |
| Appearance                                                        | `SunMoon`                | `Palette`                         |
| Sidebar                                                           | `PanelLeft`              |                                   |
| Maximize, restore; back from a focused page to its canvas         | `Maximize2`, `Minimize2` |                                   |
| Fork                                                              | `GitFork`                |                                   |
| Branch                                                            | `GitBranch`              |                                   |
| Pull, commits to pull                                             | `ArrowDown`              |                                   |
| Push, commits not pushed                                          | `ArrowUp`                |                                   |
| Publish a branch or repository                                    | `CloudUpload`            |                                   |
| Subagent; the agents, as in Settings › Agents                     | `Bot`                    |                                   |
| Notifications, send a test notification                           | `Bell`                   |                                   |
| Keyboard shortcuts                                                | `Keyboard`               |                                   |
| Advanced settings                                                 | `Wrench`                 |                                   |
| Sign in, sign out                                                 | `LogIn`, `LogOut`        |                                   |
| Install                                                           | `Download`               | `CloudDownload`                   |
| An update on offer, the app's or an agent's                       | `CircleArrowUp`          |                                   |
| Hide, show account details                                        | `EyeOff`, `Eye`          |                                   |
| Decrease, increase a stepped value, such as zoom                  | `Minus`, `Plus`          | `ZoomOut`, `ZoomIn`               |
| Toggle a preview and its source: Markdown files, SVG code blocks  | `BookOpen`, `Code`       |                                   |
| Usage, the usage page                                             | `ChartNoAxesColumn`      | `ChartBar`, `ChartColumn`         |
| A date or a range of dates                                        | `Calendar`               | `CalendarDays`, `CalendarRange`   |
| An artifact, the Artifacts page                                   | `Shapes`                 |                                   |
| Zoom to fit                                                       | `Scan`                   | `Fullscreen`, `Expand`            |
| Previous page, beside a counter                                   | `ChevronLeft`            | `ArrowLeft`                       |
| Next page, beside a counter                                       | `ChevronRight`           | `ArrowRight`                      |

## Typography

The typefaces, the type scale and the weights are in the [design system](./design-system.md#typography). This section says which step each piece of text takes and how text is set.

### Roles

Every piece of text takes one of these roles. A size, weight, line height or color that is not here is off the scale.

| Role                                                                    | Step           | Color                             |
| ----------------------------------------------------------------------- | -------------- | --------------------------------- |
| The New session heading                                                 | Greeting       | `--text-primary`                  |
| Page title: a Settings page                                             | Title          | `--text-primary`                  |
| Dialog title, the Settings column's title                               | Heading        | `--text-primary`                  |
| Thread prose                                                            | Prose          | `--text-primary`                  |
| Interface text: rows, menu items, buttons, setting names                | Interface      | `--text-primary`                  |
| A label that names a thing: a project, a selected row, a card title     | Interface, 500 | `--text-primary`                  |
| A sentence that explains a screen: an `Empty` state                     | Interface      | `--text-secondary`                |
| A dialog's description                                                  | Small          | `--text-secondary`                |
| Tool call rows and fold lines, their file names `--text-primary`        | Small          | `--text-tertiary`                 |
| Model names and reasoning levels                                        | Control        | `--text-secondary`                |
| Segments, `compact` buttons, select triggers                            | Control        | `--text-tertiary`, chosen in full |
| Secondary text: descriptions, hints, the top bar's information          | Caption        | `--text-secondary`                |
| Group labels in menus, lists and settings; an empty list's line, a path | Caption, 500   | `--text-tertiary`                 |
| Code, commands, branch names, diffs                                     | Code           | as their context                  |
| Meta: versions, times, counts, commit ids                               | Meta           | `--text-tertiary`                 |
| Placeholders                                                            | as the field   | `--text-placeholder`              |
| Unavailable items                                                       | as the item    | `--text-disabled`                 |

### Rules

- **Two typefaces, one stack.** Latin is Inter and Chinese the platform's face, mixed within a line by the font stack; nothing sets a font family of its own. Mono is the only other family, and only for the roles above that name it.
- **Mono is for what the user would type or copy**: code, commands, branch names, ids, versions, times and counts. Names, descriptions, labels and a project's path shown as its location are never mono ([problems 22, 34](../milestones/m0-feedback.md#34-the-slash-command-popover-looks-crude)).
- **Five text colors**, each with its role above: `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-placeholder` and `--text-disabled`. Opacity is never another level; a disabled control dims through its component's disabled state.
- **Weights** are 400, 500 and 600 only, set through the weight tokens so the dark theme can lighten them; never a raw `font-weight`.
- **Chinese is set as Chinese**: no letter spacing, no italic (emphasis is the medium weight), full-width punctuation, and a space between Chinese and Latin words or digits in the interface's own copy ([localization](./localization.md#chinese-copy)).
- **Numbers** that change in place use `tabular-nums`.
- **One line, then cut.** A name that does not fit truncates with an ellipsis and shows in full in its tooltip. A description is never cut mid-sentence: it wraps, or moves into a tooltip ([problem 34](../milestones/m0-feedback.md#34-the-slash-command-popover-looks-crude)).
- **No stacked identity.** A row shows a thing by its name alone, not its name over its full path; two that share a name add the fewest words that tell them apart ([problem 22](../milestones/m0-feedback.md#22-the-new-session-project-and-agent-menus-look-crude)).

## Color

The maintainer's rules for the [palette](./design-system.md#palette), set on 2026-10-23:

1. **No pure black or white text.** Body text is `--text-primary`, in both themes.
2. **Color only where it means something**: waiting for your approval (`--attention`), a failure or a deletion (`--danger`), a diff's added and deleted lines (`--success`, `--danger`), links (`--link`) and usage warnings (`--warning`, `--danger`). Everything else is neutral: surfaces, lines, text, icons, controls that are on, things on offer, states in progress.
3. **Success has no color.** A tool call that succeeded shows no green check, a finished turn is not green, and "Installed", "Signed in", "Copied", passing checks and open pull requests are neutral.
4. **Model names and reasoning levels**, such as "Xhigh", are `--text-secondary`, never orange or a gradient ([model names](./design-system.md#model-names-and-reasoning-levels)).
5. **Usage hints**, such as "7 days 57%", are `--text-tertiary`, `--warning` from 80% and `--danger` from 95% ([usage levels](./design-system.md#usage-levels)).
6. **Brand colors stay on the agent marks.** An agent's color never colors text, a border or a state.
7. **Icons** rest at `--icon-default` and turn `--text-primary` under the pointer; only a status icon can be `--attention` or `--danger`.
8. **One color per region.** One area of the screen shows at most one meaning color, apart from a diff's paired added and deleted counts.

- **Quiet unless it needs you.** A sidebar row's running and unread marks are neutral, a `--text-secondary` `Spinner` and a `--text-tertiary` dot. `--attention` is the loudest color in the app.
- **Never color alone.** A color comes with a shape, an icon or a word, except where [Interface](./ui.md#sidebar) names the exception.
- **Tokens only.** No raw `#hex`, `rgb()` or `oklch()` outside `tokens.css`, and no Tailwind palette utilities (`bg-white`, `text-red-500`); `pnpm lint` fails on either ([color checks](./testing.md#color-checks)). A new color is a token in `tokens.css` and a row in the design system first, in both themes, at 4.5:1 for text on every surface it sits on, and a pair in the contrast check.
- **Not settled yet**: the search match's yellow (`--mark`), the file-type icons' own colors, the terminal's ANSI colors, the usage charts' agent series and heatmap, and the syntax highlighting theme keep their earlier colors until the maintainer decides them.

## Shape

### Radius

Radius follows the element's role; the values are the [radius scale](./design-system.md#density-and-sizing).

| Role                                         | Utility        |
| -------------------------------------------- | -------------- |
| Segments and their thumb, chips, inline code | `rounded-md`   |
| Buttons, inputs, rows, menu items, tabs      | `rounded-lg`   |
| Cards, the user bubble, code blocks          | `rounded-xl`   |
| The composer, menus, popovers                | `rounded-2xl`  |
| Dialogs                                      | `rounded-3xl`  |
| The send button, dots, counts, status pills  | `rounded-full` |
| An artifact's pages on a canvas              | `rounded-none` |

- A shape nested inside another keeps its corner concentric: the inner radius is the outer one less the gap between them, as a menu item is inside its menu.
- No arbitrary radius (`rounded-[6px]`). A role that needs one adds a row here first.
- One exception: the update notice's dismiss button, a 16 px round outline button on the card's corner, which breaks the control heights and the radius table on purpose ([update notice](./ui.md#updates)).

### Lines and elevation

- **One line per surface** ([rule](./design-system.md#one-line-per-surface)): a container has at most one border, drawn as an inset ring of a hairline. Parts inside it are divided by a `Separator` or a surface step, never a second border.
- **Which line**: `--border-default` encloses a container, `--border-subtle` divides inside one and edges the top bar and the sidebar, `--border-strong` marks an outline button and a hovered or focused container ([palette](./design-system.md#palette)).
- **Separators are inset** to the text they divide, never edge to edge, except the hairline under a search field that spans its menu.
- **Shadows** only on what floats: the composer, queued cards, menus, popovers, dialogs and a hovered card, at the [elevation tiers](./design-system.md#elevation). Pages and lists are flat: Settings has no cards and no shadows ([problem 40](../milestones/m0-feedback.md#40-the-settings-pages-look-crude-and-their-colours-are-untuned)), and tool calls are rows, not cards ([problem 43](../milestones/m0-feedback.md#43-the-message-body-needs-a-typography-pass-to-a-given-spec)).
- **No decorative backgrounds.** Screens sit on their surface token; animated or patterned backgrounds were tried on the home screens and rejected.

## Layout

### Surfaces

- The window is three columns on the [surface steps](./design-system.md#palette): the sidebar and the side panel on surface 0 (`--bg-sidebar`), the thread between them on surface 1 (`--bg-app`), meeting at `--border-subtle` hairlines. Cards and everything that floats sit on `--bg-surface`.
- A full-window screen, such as Settings, keeps the same arrangement: a column on surface 0 beside its page on surface 1, or the page alone on surface 1.
- A new surface step, a fourth column or a tinted region is a design-system change, not a screen's choice.

### Rows

A row is the unit of every list: the sidebar, menus, Settings, the Files tree, tool calls.

- **Anatomy**: a leading slot (an icon or mark in one column for the whole list), the label (truncating first), then a trailing slot (a status, a count, a hover action). The trailing slot keeps its width on every row, so a status or an action appearing never moves the label ([problem 8](../milestones/m0-feedback.md#8-session-rows-show-their-time-badly)).
- **Height** is `--row-height`; a row with a second line grows by the line, never by extra padding.
- **Fill**: a row has no fill at rest; hover and selection fill the whole row at its radius, never the label alone.
- **A row that opens something and also offers an action**, such as an agent in Settings › Agents, puts the action in a [status pill](./design-system.md#status-pills) next to the label, never as a button in the trailing slot, which keeps the state and the chevron. The row opens through a button laid under its content, since buttons cannot nest, and the pill stays a button of its own.
- **Text inside a row** is one line. What does not fit truncates; a second line is a description at the secondary role, never a path or a raw command.

### Pages and columns

- A page's content sits in one centred column with a maximum width: 42em for prose, 560 px for Settings, 960 px for the usage dashboard and the Artifacts page. It never stretches to the window. An artifact's viewer is the exception: the page it shows fills the area, since its layout is the page's own.
- A page starts with its title at the page title role; groups inside it are introduced by group labels, not by cards or headings of their own. A dashboard of figures is the one exception: the [usage page](./usage.md#interface) sets each figure, chart and table on a card with its title inside, so panels side by side read as separate (decided while the maintainer was away; to be reviewed).
- Containers adapt to their own width with container queries ([layout behavior](./design-system.md#layout-behavior)); what gives way first in a crowded bar is written in [Interface](./ui.md) for that bar, the least important part first.

## Space and size

- **Heights snap to the tokens**: `--control-height` for buttons and selectors, `--control-height-sm` for small and icon buttons in bars, `--row-height` for rows and menu items, `--card-header` for card headers ([density and sizing](./design-system.md#density-and-sizing)).
- **Gaps between and around components** use the spacing steps (Tailwind `1`, `1.5`, `2`, `2.5`, `3`, `4`, `7`). A component's own insets, such as a menu's padding, come from its entry in the design system.
- **Related things sit closer than unrelated ones.** Inside a group the gap is smaller than between groups, and a heading sits closer to what follows it than to what precedes it.
- **Edges line up.** In a list, the icons share one column and the text starts at one inset; labels, group labels and separators in a menu share the items' inset.
- **Width fits content.** Menus and popovers are as wide as their widest item, at least 160 px, never a fixed width ([problem 22](../milestones/m0-feedback.md#22-the-new-session-project-and-agent-menus-look-crude)).
- **Nothing moves when state changes.** A control that appears on hover or focus holds its slot at rest, a status that appears takes a reserved slot, and a hovered or selected row changes its fill, never its size or its neighbours' places.

## States

How each state looks. When each one appears, and what it says, is in the [UX guidelines](./ux-guidelines.md#feedback). Every interactive element is drawn in each state that applies to it, in both themes:

| State               | Look                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Rest                | Chrome in `--text-tertiary`, icons `--icon-default`; content in `--text-primary`                         |
| Hover               | `--bg-hover` fill, text and icon to `--text-primary`, over `--duration-fast`                             |
| Focus               | The `focus-ring`: 2 px of `--focus`, 2 px outside; a field's border also turns `--border-strong`         |
| Pressed toggle      | The `quiet` button's `--pressed` fill and hairline ([toggle buttons](./design-system.md#toggle-buttons)) |
| Open (menu trigger) | `--accent` fill while its menu is open                                                                   |
| Selected, checked   | A `--bg-selected` row; a `Check` in a list; a `--text-primary` track on a switch                         |
| Disabled            | The component's own disabled state                                                                       |
| Busy                | A `Spinner` in place of the icon, the label kept                                                         |
| Loading             | `Skeleton` blocks at the real sizes of what will replace them                                            |
| Empty               | One centred `Empty` in the area it stands for                                                            |
| Error               | `--danger` on the icon and the words that name the error; a notice is the `Alert` `error` variant        |
| Waiting on the user | The [attention ring](./design-system.md#elevation) on the card that waits for your approval              |

## Motion

Micro-interactions are CSS, timed with the [motion tokens](./design-system.md#motion); Motion handles springs, layout, exits and gestures. Only `transform` and `opacity` animate, apart from the disclosures and the sidebar slide the design system names. Motion confirms a change the user made or explains where something went; it never decorates, never loops except to show that work is going on, and always has its reduce-motion form.

## Components first

- Build from the shadcn/ui component that fits, through its variants. Where OverBench looks different, the difference is a `cva` variant of that component, described in the design system ([density and sizing](./design-system.md#density-and-sizing)); `className` at a call site is for layout only.
- Use what the stack already provides before writing your own ([Contributing](../../CONTRIBUTING.md#ui-stack)).
- A look shared by two screens is one component or one variant, never two copies that drift apart.

## Checklist

Before a UI change goes up for review, with the [UX checklist](./ux-guidelines.md#checklist):

1. Every icon is in the [vocabulary](#vocabulary) or added to it, at 12, 14 or 16 px, with no stroke or fill of its own.
2. Every text has a [role](#roles); no size, weight or opacity outside them.
3. No raw color, Tailwind palette color, arbitrary radius or arbitrary size; every value is a token.
4. Color appears only by the [color rules](#color), at most one per region, and never alone.
5. One border per surface; separators inset; no shadow on anything that does not float.
6. Rows follow their [anatomy](#rows), and nothing shifts between states.
7. Every state in the [table](#states) that applies is drawn.
8. Checked in light and dark, at a narrow and a wide window, with reduce motion on, next to the reference where it has the same element.
