---
name: UI/UX Pro Max
description: Interface and interaction design — layout systems, type scales, full state coverage, accessibility requirements, motion guidance, and the specific traps of dark UI.
when_to_use: Invoke before implementing or designing any user interface — screens, components, forms, or interactive flows.
modes: [cowork]
---

## Layout systems and spacing scales

Use an 8px base grid. All spacing values should be multiples of 8 (8, 16, 24, 32, 40, 48, 64, 80, 96). Where 8 is too coarse, use 4px as a sub-unit for intra-component spacing (icon-to-label gap, input padding).

**Component layout pattern:**
- Padding inside a component: 12–16px horizontal, 8–12px vertical at standard density.
- Spacing between components: minimum 8px, section-level gaps 24–48px.
- Do not express spacing as `margin: 5px` or `padding: 7px`. Fractional grid values indicate the layout has no system.

**Grid columns:** 12-column grid at desktop (≥1024px), 4-column at mobile (≤767px), 8-column in between. Content regions should not exceed 1280px max-width without a deliberate reason.

## Type scale method

Build a modular scale from a base size and a ratio.

**Standard scale (ratio 1.25):**
- xs: 12px / 0.75rem
- sm: 14px / 0.875rem
- base: 16px / 1rem
- md: 18px / 1.125rem (body copy for long-form)
- lg: 20px / 1.25rem (sub-heading)
- xl: 24px / 1.5rem (section heading)
- 2xl: 32px / 2rem (page title)
- 3xl: 40px / 2.5rem (display)
- 4xl: 56px / 3.5rem (hero)

Line height: 1.6 for body text, 1.3 for headings. Never set `line-height: 1` on multi-line text.

Letter spacing: -0.02em on headings ≥32px to counteract optical spreading. Do not letter-space body text — it degrades readability.

## State coverage checklist

This is the most common defect class in interface implementation. Every interactive element needs every applicable state:

**For interactive controls (buttons, links, inputs, checkboxes, radios, selects, toggles):**
- [ ] Default
- [ ] Hover (pointer: fine media query — do not apply hover styles on touch-primary devices)
- [ ] Active / pressed
- [ ] Focus-visible (keyboard focus ring — distinct from hover, never removed)
- [ ] Disabled (reduced opacity + `cursor: not-allowed` + `aria-disabled` or `disabled` attr)
- [ ] Loading (spinner or skeleton, cursor feedback, prevent double-submit)
- [ ] Error (error border, error message, `aria-describedby` pointing to the message)

**For data surfaces (lists, tables, search results):**
- [ ] Loading skeleton (not a spinner alone — show the shape of what is coming)
- [ ] Empty state (with guidance, not just "No results")
- [ ] Error state (with retry affordance)
- [ ] Partial load / pagination

If any state is missing from a component, the component is not done.

## Empty-state and error-state writing

**Empty state:**
- Say specifically what is empty and why the user might be here.
- Provide a primary action to fill it.
- Do not say "Nothing here yet." Say "You haven't added any projects. [Create a project]."

**Error state:**
- Say what went wrong in plain language (not HTTP codes exposed raw).
- Say what the user can do about it.
- Provide a retry action if the operation is retryable.
- "An error occurred" with no further detail is not an error message — it is an absence of one.

## Keyboard and focus requirements

Every interactive element must be reachable and operable by keyboard alone. This is a baseline, not an enhancement.

- Focus order must follow logical reading order. Do not set `tabindex` values other than 0 and -1 on ordinary elements; positive `tabindex` values override natural order and usually create bugs.
- Focus ring: use `outline: 2px solid <focus-colour>; outline-offset: 2px` at minimum. Never `outline: none` without providing a custom focus indicator.
- Modals and drawers must trap focus inside when open and restore focus to the trigger element when closed.
- Custom dropdowns, comboboxes, and date pickers must implement the relevant ARIA pattern (combobox with `aria-expanded`, listbox with keyboard navigation: Arrow keys move selection, Enter confirms, Escape closes).

## Contrast minimums (WCAG 2.1 AA)

These are requirements, not suggestions:
- Normal text (< 18px regular or < 14px bold): **4.5:1** against background.
- Large text (≥ 18px regular or ≥ 14px bold): **3:1** against background.
- UI components and graphical objects (icons, chart lines, input borders): **3:1** against adjacent colour.
- Placeholder text counts as text — it must meet 4.5:1.
- Disabled controls are exempted from contrast requirements (they are intentionally non-interactive).

Check contrast with actual computed colours, not design-tool approximations. Light-theme and dark-theme both need independent checks.

## Motion: purpose and duration

Every animation must have a purpose. The purposes are:
1. **Communicate state change** (a toggle switching, a form submitting).
2. **Orient spatial relationships** (a panel sliding in from the edge it logically belongs to).
3. **Signal causality** (an element appearing from the button that triggered it).

Animation for decoration alone imposes cost (distraction, performance, vestibular discomfort) with no informational return.

**Duration ranges:**
- Micro-interactions (hover, checkbox check): 80–150ms
- Component transitions (panel open/close, modal appear): 200–300ms
- Page transitions: 300–450ms
- Anything over 500ms feels slow unless the delay is intentional (progress feedback)

**Easing:** Ease-out for things entering the screen. Ease-in for things leaving. Ease-in-out for things that stay on screen and change shape. Avoid linear for anything the user directly triggers — it reads as mechanical.

**Honour `prefers-reduced-motion`:**
```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```
Do not simply disable the animation — in some cases a reduced version is better than none (e.g., fade without translate for a modal).

## Dark UI — specific defects to avoid

These are real defects that appear repeatedly, including in this project:

**Native `<select>` ignores inherited colour:** On Windows, native `<option>` elements render with the OS colour scheme regardless of CSS. A dark-themed `<select>` with `background: #1a1a1a; color: white` will show white-on-white text in the dropdown on some Windows versions. Either style with a custom combobox, accept the OS default rendering, or constrain dark theme to environments where you control the rendering (WebViews with full CSS control).

**Borders vanish at low alpha:** `border: 1px solid rgba(255,255,255,0.08)` disappears on OLED screens and when subpixel rendering shifts. Use at least 0.12–0.15 alpha for hairline borders on dark surfaces, or use a solid colour from your neutral ramp.

**Muted text failing contrast:** `color: rgba(255,255,255,0.5)` on a `#121212` background is approximately 5:1, which passes for large text but fails for body text in some combinations. Measure. Dark themes require explicit contrast verification — do not assume that reducing opacity is safe.

**Surface layering:** Dark UI typically uses slightly lighter surfaces for elevated components (cards, modals, drawers) rather than shadows, because low-opacity shadows are invisible on dark backgrounds. Use a ramp: base surface (#0F0F0F), +1 level (#1A1A1A), +2 level (#242424), +3 level (#2E2E2E). Do not use `box-shadow` alone for elevation on dark backgrounds.
