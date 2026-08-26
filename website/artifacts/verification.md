# Gidem website — headless verification evidence

## Design reference adopted

- Canonical direction: extracted `Gidem Landing A.dc.html`, Direction A — Flight Operations.
- Adopted from A: dark native-app surfaces, dense one-pixel pane structure, hero Proof Rail, full-width Workbench, small operational section headings, and the Gidem surface ↔ gdm engine map.
- Adopted selectively from B: task/evidence record ordering and compact information labels only. The light Evidence Ledger style was not mixed into the final visual direction.
- Existing Orbit G SVG and the native `design-tokens.css` are reused verbatim.
- The extracted `support.js` was inspected as text but not executed because it dynamically loads remote React/Babel code and uses dynamic function evaluation.

## First-render review and correction

The first reference-aligned render exposed one weak point: on mobile, the Workbench animation could finish while the `Tasks` tab remained selected, hiding the final proof state. It was corrected so the walkthrough follows `Tasks → Agents → Proof`; direct tab choices are respected, Replay resets the flow, and reduced-motion opens the final Proof state immediately. The 375px stage selector was also changed from seven cramped columns to a 4+3 layout so every button is at least 44px.

A later gdm-driven axe run caught a transient 4.37:1 contrast reading while the proof counter was fading in. Counter and glyph motion now uses position/scale/rotation only, never opacity, so signal colors retain AA contrast throughout state transitions.

## Deterministic checks

- `bun run lint && bun run build`: passed; Vite production output created.
- `bun run test:e2e`: 11/11 passed.
  - 375×812, 768×1024, and 1440×900 overflow/control-clipping/console checks.
  - Play, Pause, Replay, all seven direct stages, off-screen pause, first-autoplay-only behavior.
  - mobile menu and Tasks/Agents/Proof tabs.
  - copy success feedback, keyboard operation, reduced motion, and JavaScript-disabled fallback.
  - 375px visible buttons measured at 44px or larger.
- `bun run test:a11y`: passed; axe reported 0 detected violations, including color contrast.
- `bun run check:content`: passed; canonical token equality, no out-of-token hard-coded colors, no gradient/external font/CDN, required copy/link/Orbit asset present.
- Browser console errors: 0 across all three target widths.
- All rendering and interaction checks used headless Chromium; no GUI application or foreground browser was opened.

## Purposeful motion pass

The rigid first pass was softened without changing Direction A or animating readable content. Five product-explaining motions were added: Hero Proof Rail settlement, Gidem-to-gdm handoff, the six-step proof route, claim-to-blocker verdict, and the final blue-to-green Orbit docking. The existing Workbench walkthrough remains the primary 8–10 second product animation; its terminal cursor moves only while Play is active.

- Text, terminal transcript, command output, and evidence content remain stationary.
- Supporting motion starts only when its section enters the viewport, settles when off-screen, and never loops as background decoration.
- `prefers-reduced-motion: reduce` skips every transition and presents the proven final state immediately.
- Axe was also run while three supporting animations were mid-frame; 0 violations were detected.
- No new color or font was introduced; motion uses the canonical blue, green, amber, and red tokens.

Motion evidence:

- `artifacts/screenshots/motion-375-proof-loop.png` — SHA-256 `be1a7d7ef09841f7e39d5a7e8cff6683798b6ac6ee0d5d68e6cf893b1cd8c400`
- `artifacts/screenshots/motion-768-proof-loop.png` — SHA-256 `38d1c3e528117555d17fdf66c81662e979fb741eef1e96a38336d31103a881eb`
- `artifacts/screenshots/motion-1440-proof-loop.png` — SHA-256 `83ab94045dc052d66a2891be67d6c43043fb876bdf31b716daf0813e69372274`
- `artifacts/screenshots/motion-1440-claim-verdict.png` — SHA-256 `3d1986ab526ded69a6133c584f09f9b36ec9243174b5ce50b04eb9be6c87ef47`
- `artifacts/screenshots/motion-1440-final-proof-dock.png` — SHA-256 `fc42495bee88f5f65aba3a688fae65b8cb333171bd480903664a68dd4cc1875c`
- `artifacts/screenshots/motion-375-reduced.png` — SHA-256 `2c72e56868ae20f6ce6265b5391ed34965a0da4a50278962990ba89edec746b2`

## Visual inspection

The three full-page renders and enlarged Hero/Workbench/Safety views were inspected directly. No horizontal page scroll, text/button overlap, clipped controls, unreadably scaled terminal, or mobile desktop-window shrink was observed.

Exact viewport captures:

- `artifacts/screenshots/viewport-375x812.png` — SHA-256 `ed25753823e1e65b882cfa550419a6ac16b7cccfca39617b1dbe421a83adc23b`
- `artifacts/screenshots/viewport-768x1024.png` — SHA-256 `afb86e25ca7854fc06090b2ca58501366e1bc5fcea6347e84315552d25150070`
- `artifacts/screenshots/viewport-1440x900.png` — SHA-256 `83f79c542af8a44c1b91610fbc5677a380894f74e825e372ac7b9754aa64bcda`

Full-page final-state captures:

- `artifacts/screenshots/final-375x812.png` — SHA-256 `03d912df5d1f0f426152a888d8315098adb265a5a263e0606e71296760574950`
- `artifacts/screenshots/final-768x1024.png` — SHA-256 `e7de52a5282a4bbae69134f9eced3ac4eaff1af8043cf987c6a210c55fba9b9b`
- `artifacts/screenshots/final-1440x900.png` — SHA-256 `15a77045272a5a5741ad7b35b2b3e7b9a2d00dd04f29812c6c7c7b0452b22106`
- `artifacts/screenshots/workbench-running-1440.png` — SHA-256 `21e9faa4bf4529834c57c44a762a4c9875527924b0397217309abc98d4ef7612`

## Scope

Implementation and generated evidence are confined to `website/`. Existing repository changes outside that directory were left untouched. No commit, push, deployment, or Gidem/Chrome GUI launch was performed.

The original `gidem-website` gdm contract was created before a separate active `work-protocol-production-v2` task changed 16 files outside `website/`; its final scope gate correctly rejected those unrelated deltas. Those paths were not added to this task. Final validation is recorded under a fresh `gidem-website-flight-operations` contract whose baseline includes the already-existing external changes and whose allowed path remains only `website/`.
