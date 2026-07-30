---
name: Open Design
description: Visual and brand design direction — choose the right register from the brief, apply systematic colour and type, know when to use real photography.
when_to_use: Invoke when producing any designed artefact — brand identity, marketing pages, UI mockups, decks, or illustrations — before starting layout or visual work.
modes: [cowork]
---

## Match the register to the brief, not to a default

Every brief signals a register. Read it before reaching for tools. The failure mode is defaulting to a single house style — cream background, handcrafted serif, warm photography — regardless of what the work actually calls for.

**Register map:**

| Brief type | Register | Typography | Colour |
|---|---|---|---|
| Designer portfolio | Hard-edged white or near-black, structural negative space | Neutral grotesk (Inter, Neue Haas, Aktiv) — no serifs | Monochrome base + one structural accent |
| Market report / data document | Bloomberg/Economist register: high information density, tabular, tight leading | System-stack or neutral sans, mono for data | Near-black, white, one signal colour for callouts |
| Brand / fragrance / luxury | Clean-canvas minimal — Aesop/Byredo register | Refined serif (Canela, Portrait, Freight) + small-caps for labels | Off-white, bone, one restrained accent |
| SaaS product page | Conversion-optimised, legible at scroll speed | Grotesk for body, optional display weight for headlines | Brand primary + neutral surface + semantic status colours |
| Technical docs | Scannable, monospaced for code, no decoration | System UI stack + monospace | White or very light grey, syntax highlight palette |

If the brief contains words like "minimal", "editorial", "luxury" or "data-driven", they each imply a specific register. Do not override them with a different aesthetic preference.

## Category traps to avoid

**The cream-and-handcrafted-serif trap:** Applying a warm, artisan register to anything that asks for precision, authority, or technical credibility. A designer portfolio in this register reads as a lifestyle brand. A security audit in this register reads as unserious.

**The dark-mode-by-default trap:** Dark UI is not inherently premium. For document-heavy work, long-form reading, or data comparison, light surfaces outperform dark ones on legibility. Apply dark mode when the brief explicitly favours it or when the product category demands it (developer tools, creative software).

**The gradient-on-everything trap:** Gradients signal trend, not craft. One well-chosen gradient on a single focal element is fine. Gradients on backgrounds, cards, text, and buttons simultaneously signal the work was generated, not designed.

**The font-as-personality trap:** Choosing a display font because it "looks interesting" before establishing what the work needs to communicate. Type selection follows message hierarchy, not the other way around.

## Type pairing method

1. Decide hierarchy depth: how many distinct levels does this work need? (Typically: display headline / section head / body / label / caption / mono.)
2. Choose the body face first — it carries the most words. It must be readable at 16px/1rem on screen, or 10–11pt in print.
3. Add a display face only if the work has actual display-sized text (≥48px). If there is no such text, the display face adds weight to the font load for no benefit.
4. Ensure the pairing has contrast of category: grotesk + geometric, or serif + mono. Two grotesks or two serifs create visual noise at the join without enough contrast to look intentional.
5. Limit to two typefaces. A third is only justified if a monospace is required for code alongside a design-facing pair.

**Concrete pairs that work:**
- Inter + Canela Deck: editorial product work
- Neue Montreal + DM Serif Display: SaaS + warmth
- System UI stack + JetBrains Mono: documentation-first products
- PP Editorial New + Neue Haas Grotesk: luxury / fashion

**Pairs that do not work:**
- Playfair Display + Merriweather: two serifs, insufficient contrast, both feel old-web
- Helvetica Now + Aktiv Grotesk: two neutral grotesks, indistinguishable
- Any script font paired with another script font: illegible at body size

## Colour system method

Build from constraints, not from preference.

**Step 1 — Anchors:** Identify the brand primary (if one exists). If not, derive one from the visual brief.

**Step 2 — Neutral ramp:** 10-step greyscale from near-white (step 50) to near-black (step 950). Derive surface, border, muted-text, and body-text roles from this ramp, not from named CSS colours.

**Step 3 — Semantic states:** Assign colours to states before assigning them to components. Define:
- Destructive / danger (red-family)
- Warning (amber-family)
- Success / positive (green-family)
- Info / neutral signal (blue-family)

Each semantic token needs at minimum: a foreground, a background tint, a border.

**Step 4 — One accent:** The accent is the one colour that is not the neutral ramp and not a semantic state. It draws the eye to the single most important interactive or brand element per screen. If two things are equally important, the accent loses meaning.

**What a palette is not:** A palette is not a list of hex values. It is a set of roles. The hex values are implementation details that change across themes (light/dark, high-contrast). Document roles, not values.

## When to ground in real photography

Generate images when the subject does not exist yet (concept illustration, abstract composition) or when you need tight compositional control.

Use real photography when:
- The work depicts real places, people, or objects and accuracy matters.
- The brief is in a register where synthetic imagery reads as synthetic (luxury goods, medical, documentary).
- The subject has a known visual identity (a brand's product, a named location, a public figure).

Find real photographs first with `search_images`. Pass found images to `generate_image` with editing instructions to transform, composite, or adapt them. Do not invent a photograph of something that has a real reference.

When real photography is not available and generation is the only option, use the highest-quality model, describe lighting and lens characteristics explicitly (not just the subject), and specify aspect ratio to match the layout slot.

## Do / don't quick reference

| Do | Don't |
|---|---|
| Read the brief for register signals before opening any tool | Default to your preferred aesthetic |
| Choose body type first, display type only if needed | Pick a display font because it "looks interesting" |
| Build colour from roles (surface, border, text) not hex values | List hex values without semantic assignment |
| Use one accent colour per visual hierarchy | Apply gradients to every container |
| Find real photography for real subjects | Generate synthetic photos of branded products |
| Document what you assumed when facts are unknown | Present speculation as fact |
