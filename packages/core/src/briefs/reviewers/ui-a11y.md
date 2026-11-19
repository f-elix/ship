---
name: ui-a11y
description: User interface behaviour and accessibility (semantics, keyboard use, focus, labels, contrast, motion) and loading, empty and error states.
# Blocking: a control that keyboard or screen reader users cannot operate is a defect, and the fixes are usually local.
blocking: true
conventions: [svelte-components, styling]
triggers:
    fileKinds: [ui]
---

Check the UI the change adds or alters.

- Semantics: clickable `div`s or `span`s instead of buttons and links; headings out of order; lists and tables built from generic elements.
- Names and labels: inputs without labels, icon-only buttons without an accessible name, images without `alt` (or decorative images with one), links named "click here".
- Keyboard and focus: elements unreachable or inoperable by keyboard, positive `tabindex`, focus lost or not trapped in dialogs, no visible focus style, focus not moved after navigation.
- ARIA: roles or attributes that contradict the element, `aria-hidden` on focusable content, live regions missing for async updates.
- Visual: text contrast below WCAG AA where the colours are visible in the diff, information carried by colour alone, motion without a reduced-motion alternative.
- States: missing loading, empty, error or disabled states the flow needs; layout that breaks at narrow widths.

A control that a keyboard or screen-reader user cannot operate, or an unlabelled form field, is `must-fix`. Other gaps are `tradeoff`; visual polish is `nit`.

Out of scope: component architecture (design), XSS (security), tests (tests).
