# OverBench docs

Design documents for OverBench. Start with the architecture, then read the design for the part you are working on.

| Document                                                     | Covers                                                                                                                                                   | Status        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [Architecture](./architecture.md)                            | The big picture and the global core design: processes, ACP, data flow, the core designs, security, directory layout                                      | Draft         |
| [Agent host](./design/agent-host.md)                         | Startup and supervision, the agent catalog, environments, installing adapters, launching and stopping agents, sign-in, diagnostics, platform differences | Draft         |
| [Session model](./design/session-model.md)                   | The thread model, patches and snapshots, the ACP v1 mapping, prompts, permissions, cancellation, session lifecycle                                       | Draft         |
| [Host protocol](./design/host-protocol.md)                   | The preload API, requests, events and validation between the renderer and the agent host                                                                 | Draft         |
| [Git](./design/git.md)                                       | Repository status, pull requests through `gh`, and git events in the thread                                                                              | Draft         |
| [Terminal](./design/terminal.md)                             | The terminal host, shells, flow control, rendering, and how terminals relate to projects and sessions                                                    | Draft         |
| [Updates](./design/updates.md)                               | Checking, downloading and installing new versions, per platform, and what the user sees                                                                  | Draft         |
| [Persistence](./design/persistence.md)                       | What is stored on disk, how it is written, versioned and recovered                                                                                       | Draft         |
| [Usage statistics](./design/usage.md)                        | OverBench's own token record, importing the agents' local logs, the usage database and what the usage page shows                                         | Implemented   |
| [Artifacts](./design/artifacts.md)                           | The details of artifacts: the service's tools, storage and versions, presence, the isolated surface, the Artifacts page and the canvas viewer            | Accepted      |
| [Localization](./design/localization.md)                     | The interface languages, the Language setting, switching live in every process, catalogs and how to write messages                                       | Draft         |
| [Design process](./design/design-process.md)                 | The gate every design passes: the rules first, the reference, options to try, docs before code, verification and review                                  | Draft         |
| [Visual style](./design/visual-style.md)                     | How the interface looks: character, icons and their vocabulary, type roles, color, shape, layout, spacing and states                                     | Draft         |
| [UX guidelines](./design/ux-guidelines.md)                   | How the interface behaves: structure, focus, feedback, attention, errors, destructive actions, disclosure, keyboard, agents and copy                     | Draft         |
| [Design system](./design/design-system.md)                   | The design reference and its boundaries, surfaces, lines, elevation, density, typography and motion tokens                                               | Draft         |
| [Media](./design/media.md)                                   | Images, audio and video in the thread, the viewer and the Files pane; the media scheme, its grants and the CSP; sizes, persistence and states            | Accepted      |
| [Interface](./design/ui.md)                                  | Layout, screens, sidebar, thread entries, composer, states, motion per element and shortcuts                                                             | Draft         |
| [Testing](./design/testing.md)                               | Unit, integration and process tests, the fake agent, CI, and performance measurement                                                                     | Draft         |
| [Development workflow](./workflow.md)                        | How a change goes from an issue to a release: triage, design, build, review, merge, the gates, labels, branches and agents                               | Accepted      |
| [M0: ACP foundation](./milestones/m0.md)                     | Scope, work packages, acceptance criteria, budgets, dependencies and decisions for M0                                                                    | In acceptance |
| [M0 feedback](./milestones/m0-feedback.md)                   | Problems found while accepting M0 by hand, collected before they were planned; what is left is in GitHub issues                                          | Accepted      |
| [M0 feedback findings](./milestones/m0-feedback-findings.md) | Research and fixes for the feedback, for planning it                                                                                                     | Draft         |
| [M0 performance](./perf/m0.md)                               | Measured results against the M0 budgets, per platform                                                                                                    | Draft         |

## Keeping the docs current

- The docs describe the system as designed. When the code and a doc disagree, one of them is wrong: fix it in the same change.
- A design change updates its document before or together with the code, never after.
- Each document starts with a status line: **Draft** while under review, **Accepted** once agreed, **Implemented** when the code matches it.
- Facts about third parties, such as agent versions and capabilities, carry the date they were observed.
- One fact lives in one place. Other documents link to it instead of repeating it.
- [Architecture](./architecture.md#core-designs) is the global core design: every core logic of the system, its model, interfaces, rules and decisions, is written there first, and the documents in `design/` hold the details. A core decision is the maintainer's, made with its options laid out and recorded there with its date.
- The docs are written in English, like everything else in the repository.
