# Good CSS implementation screenshots

These screenshots use the same synthetic `todo-api` session rendered through `renderPage`.
The browser viewport is 1728 × 1117 unless noted otherwise.

| File | Checkpoint |
| --- | --- |
| `00-baseline.png` | Original template before changes. The missing charset is visible as mojibake. |
| `01-foundations.png` | Complete document metadata and the targeted reset. |
| `02-reduced-motion.png` | Motion changed to opt-in; the default visual state is intentionally unchanged. |
| `03-interaction.png` | Focus, input sizing, hover guards, press feedback, and coarse-pointer targets. |
| `04-sidebar-scroll.png` | Stable scrollbar gutter, contained overscroll, and small-viewport height. |
| `05-container-responsive.png` | The page was constrained to 50rem while the browser stayed wide, verifying that the viewer responds to its container rather than the viewport. |
| `06-readable-text.png` | Prose constrained to 75ch with conservative long-word wrapping. |
| `07-theme-logical-cleanup.png` | Forced dark theme after consolidating tokens with `light-dark()`, plus logical-property and clipping cleanup. |
| `08-final-light.png` | Final accumulated result in the light theme. |
