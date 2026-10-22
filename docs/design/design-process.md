# Design process

> Status: Draft · The gate for every design · Rules: [visual style](./visual-style.md) and [UX guidelines](./ux-guidelines.md)

Every design passes through these steps: a new screen, a component, an interaction, a visual change or a polish pass, whoever makes it. The two guides are the gate. A design that breaks one of their rules does not ship; the rule changes first, with the maintainer's agreement, or the design does.

## 1. Start from the rules

- Read [visual style](./visual-style.md), [UX guidelines](./ux-guidelines.md), the [design system](./design-system.md) and the [Interface](./ui.md) section of the area.
- Note which rules apply and which cases they leave open. An open case is decided in step 3 and written into the guide that owns it, never settled in the component alone.

## 2. Study the best existing implementation

- Claude Desktop is the benchmark for measurements and behavior ([design reference](./design-system.md#design-reference)). For a feature it does not have, find the strongest projects that do and read their source, not only their screenshots ([AGENTS.md](../../AGENTS.md#core-philosophy-beauty-is-productivity-颜值也是生产力)).
- Measure instead of eyeballing: sample the reference's 2× screenshots for sizes, colors and spacing, write the numbers down, and label a reading of a single screenshot as one.
- Take the principle and the measurement, never brand assets or proprietary code.

## 3. Decide what is open, with something to try

- **Settled directions are polished, not reopened.** The skeleton of the window and the flat, hairline style are decided: a pass improves a component against the reference inside them, it does not propose other styles.
- **An open direction gets options to try.** When a look, a structure or a choice between libraries is genuinely open, offer two to four genuinely different options as a page the maintainer can use: rendered in the app's look, in both themes, with measured numbers beside them (bundle size, frame time, memory) and a recommendation. A comparison table alone is not enough to choose from.
- **A choice covers what it was made for.** A look chosen for one part is not carried into other parts unasked; each area gets its own choice.
- **Record the decision** with its date: in the problem it settles in [M0 feedback](../milestones/m0-feedback.md) and in the document it changes.

## 4. Write it down before building

- The design goes into [Interface](./ui.md) for screens and behavior and into the [design system](./design-system.md) for tokens and component looks, before the code or in the same change ([keeping the docs current](../README.md#keeping-the-docs-current)).
- A new rule goes into the guide that owns it. A new token is a row in the design system, in both themes, before a component uses it.

## 5. Build from the stack

- shadcn/ui components through their variants, the design tokens, Lucide icons from the [vocabulary](./visual-style.md#vocabulary), CSS or Motion as the [motion rules](./design-system.md#css-or-motion) say.
- New code follows the rules, not older code beside it that does not yet.
- No new dependency without the maintainer's approval.

## 6. Verify

- Run the app and look at the result in light and dark, at a narrow and a wide window, with reduce motion on, and with the keyboard alone.
- Take before and after screenshots of the screens it touches in both themes (`tools/screenshots/capture.mjs`, [screenshots](./testing.md#screenshots)), next to the reference where it has the same element.
- Measure what runs on a hot path, such as switching sessions, streaming, long lists or resizing, with the DevTools Performance panel or the performance script, before and after.
- Walk the [visual checklist](./visual-style.md#checklist) and the [UX checklist](./ux-guidelines.md#checklist).

## 7. Review

- Present what changed with the screenshots, the rules it follows, any rule it changes and why, and what is not done or not checked.
- The maintainer accepts the design. The reason for a rejection becomes a rule in the guides, so the same detail is not corrected twice.

## Changing the rules

- A rule changes only with the maintainer's agreement, recorded with its date and the problem it came from.
- A changed rule brings every screen that follows it along in the same change, or lists the screens left to align.
- Code written before a rule is brought in line one rule at a time, in a pass of its own, rather than left to drift.
