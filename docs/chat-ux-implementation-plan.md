# Chat UX Implementation Plan (Reader-Friendly v1.1+)

Last updated: 2026-02-26
Status: In progress

## Scope

Refactor chat output so raw assistant text is lightweight and action bubbles are the primary operational surface.

## Product Decisions (Locked)

1. Assistant raw text may end with a question.
2. Action bubbles are the canonical actionable output.
3. Raw text should not duplicate detailed action content shown in bubbles.
4. DOE is not mentioned in user-facing copy for standard weekend days.
5. DOE is mentioned only for weekday school anomalies (holiday/recess/no-school).
6. Improve spacing and scanability in both narrative text and bubble rendering.

## P1: Conversation Output Refactor

### Ticket P1.1 - Compact Narrative Contract

Status: Complete

Implement a compact narrative response format:

1. Headline (1 line)
2. Key drivers (max 2 bullets)
3. Optional short snapshot (single paragraph)
4. Optional follow-up question

Acceptance criteria:

1. Raw assistant text does not include repeated full action lines when bubbles are present.
2. Raw text remains under 6 visible lines in common cases.
3. Follow-up question can be final line.

### Ticket P1.2 - Bubble as Action Source of Truth

Status: Complete

Ensure at least one actionable bubble is always shown (including fallback paths).

Acceptance criteria:

1. Every assistant turn with recommendations renders at least one bubble.
2. Fallback paths render a conservative action bubble.
3. Bubble fields remain schema-compliant (`action`, `timeWindow`, `confidence`, `source`).

## P2: Bubble Readability and Progressive Disclosure

### Ticket P2.1 - Collapse Secondary Detail by Default

Status: Pending

Move `Why` and `Trigger` into collapsible sections.

Acceptance criteria:

1. Default bubble view shows action/time/confidence/source only.
2. Expanding detail reveals `Why` and `Trigger`.
3. Expand/collapse state is stable per bubble.

### Ticket P2.2 - Spacing and Visual Rhythm

Status: Pending

Improve spacing between narrative block and bubble block; tighten bubble card density without harming readability.

Acceptance criteria:

1. Clear visual separation between narrative text and action bubbles.
2. No horizontal overflow on mobile.
3. Readability pass on 390px and desktop widths.

## P3: DOE Language and Demand Framing

### Ticket P3.1 - Weekend Language Simplification

Status: Pending

For standard Saturday/Sunday patterns, use weekend demand framing only; no DOE mention in user text.

Acceptance criteria:

1. Weekend recommendations never include "DOE" in user-facing narrative by default.
2. Explanation references weekend traffic pattern only.

### Ticket P3.2 - Weekday DOE Anomaly Wording

Status: Pending

For weekday non-school anomalies, explicitly mention DOE calendar signal.

Acceptance criteria:

1. Weekday holiday/recess/no-school recommendations may include DOE mention.
2. Wording is concise and operational ("no school on Tue may shift lunch demand").

## P4: Gate and Documentation Updates

### Ticket P4.1 - Gate Rule Update

Status: Pending

Replace raw-text terminal-action assertion with bubble-presence assertion.

Acceptance criteria:

1. Gate checks verify `action bubble present` per turn.
2. Raw-text terminal action line no longer required.

### Ticket P4.2 - Spec/ADR Synchronization

Status: Pending

Update v1.1 docs and ADR notes to match implemented UX policy.

Acceptance criteria:

1. `docs/restaurant-intelligence-v1.1.md` reflects bubble-first action policy.
2. ADR records include rationale/tradeoffs for question-ending narrative style.

## QA Matrix (Required)

1. Single-location happy path: compact text + action bubble present.
2. Multi-location + ambiguous baseline: one clarification only.
3. Weekend scenario: no DOE mention in narrative.
4. Weekday DOE anomaly: explicit DOE mention allowed.
5. Source degradation: fallback bubble still present and actionable.
6. Mobile pass: no overflow, readable spacing.

## Rollout

1. Ship P1 first (largest UX relief).
2. Ship P2 + P3 together.
3. Ship P4 alongside final gate automation updates.
