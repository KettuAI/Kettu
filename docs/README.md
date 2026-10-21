# OverBench docs

Design documents for OverBench. Start with the architecture, then read the design for the part you are working on.

| Document                                                     | Covers                                                                                                                              | Status        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [Architecture](./architecture.md)                            | The big picture: processes, ACP, data flow, security, directory layout                                                              | Draft         |
| [Agent host](./design/agent-host.md)                         | Startup and supervision, the agent catalog, environments, launching and stopping agents, sign-in, diagnostics, platform differences | Draft         |
| [Session model](./design/session-model.md)                   | The thread model, patches and snapshots, the ACP v1 mapping, prompts, permissions, cancellation, session lifecycle                  | Draft         |
| [Host protocol](./design/host-protocol.md)                   | The preload API, requests, events and validation between the renderer and the agent host                                            | Draft         |
| [Git](./design/git.md)                                       | Repository status, pull requests through `gh`, and git events in the thread                                                         | Draft         |
| [Terminal](./design/terminal.md)                             | The terminal host, shells, flow control, rendering, and how terminals relate to projects and sessions                               | Draft         |
| [Updates](./design/updates.md)                               | Checking, downloading and installing new versions, per platform, and what the user sees                                             | Draft         |
| [Persistence](./design/persistence.md)                       | What is stored on disk, how it is written, versioned and recovered                                                                  | Draft         |
| [Design system](./design/design-system.md)                   | The design reference and its boundaries, surfaces, lines, elevation, density, typography and motion tokens                          | Draft         |
| [Interface](./design/ui.md)                                  | Layout, screens, sidebar, thread entries, composer, states, motion per element and shortcuts                                        | Draft         |
| [Testing](./design/testing.md)                               | Unit, integration and process tests, the fake agent, CI, and performance measurement                                                | Draft         |
| [M0: ACP foundation](./milestones/m0.md)                     | Scope, work packages, acceptance criteria, budgets, dependencies and decisions for M0                                               | In acceptance |
| [M0 feedback](./milestones/m0-feedback.md)                   | Problems found while accepting M0 by hand, collected before they are planned                                                        | Collecting    |
| [M0 feedback findings](./milestones/m0-feedback-findings.md) | Research and prepared fixes for the feedback, for planning it                                                                       | Draft         |
| [M0 performance](./perf/m0.md)                               | Measured results against the M0 budgets, per platform                                                                               | Draft         |

## Keeping the docs current

- The docs describe the system as designed. When the code and a doc disagree, one of them is wrong: fix it in the same change.
- A design change updates its document before or together with the code, never after.
- Each document starts with a status line: **Draft** while under review, **Accepted** once agreed, **Implemented** when the code matches it.
- Facts about third parties, such as agent versions and capabilities, carry the date they were observed.
- One fact lives in one place. Other documents link to it instead of repeating it.
- The docs are written in English, like everything else in the repository.
