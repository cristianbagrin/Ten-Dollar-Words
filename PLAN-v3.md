# Ten-Dollar Words v1.2: formats, made light

A change plan on top of v1.1. `PLAN.md` and `PLAN-v2.md` still apply unless this file changes them. Every decision here is final.

## Why

The owner wants every format to look exactly like Basic: same font, same size, same paper, same card rules per mode. The only difference is the line length, set to match the platform, so line breaks land where they'll land when posted.

He doesn't want counters, profile mock-ups, dates, reading times, hashtag counts, or an Email format. Any editing aid must live in Edit mode only, hidden until it matters, and read as a natural part of the page (the model is the budget: you click "of $2,000 budget" to change it, with no extra buttons). X needs threads.

## 1. Remove

- The Email format. On load, any draft with `format: 'email'` becomes `'basic'`.
- `#frame-head`, `#frame-foot`, and the `#title` field inside the sheet, with all their code and CSS. That covers the avatar and name, "Just now", the Photo box, the byline and date, every counter, the hashtag count, and the X ring. Titles are edited only as **Name** in the Details panel.
- All per-format sheet overrides of font, size, leading, background, ink, and radius. `--sheet-bg`/`--sheet-ink` can go too if nothing else uses them.
- The Stats section (`#stats`, "{w} words · {m} min read"). Its numbers move into a tooltip (section 4).

## 2. Formats

```js
const FORMATS = {
  basic:     { label: 'Basic',     measure: null,   budget: null },   // skin default; budget = settings.defaultBudget
  linkedin:  { label: 'LinkedIn',  measure: '52ch', budget: 2000, limit: 3000, fold: { chars: 140, lines: 3, label: '…see more' } },
  x:         { label: 'X',         measure: '43ch', budget: 500,  limit: 280, weighted: true, thread: true },
  instagram: { label: 'Instagram', measure: '52ch', budget: 1500, limit: 2200, fold: { chars: 125, lines: 2, label: '… more' } },
  substack:  { label: 'Substack',  measure: '70ch', budget: 8000 }
};
```

- The only CSS a format adds is `html[data-format="linkedin"] .sheet { --measure: 52ch; }` (and so on). `ch` belongs to the writing font. In the Typewriter skin (monospace), 52ch is exactly 52 characters per line, which matches a phone.
- The measure applies in both Write and Edit mode. Keep the v1.1 rule for switching budgets: if the budget equals the old format's default, move it to the new format's default.
- The picker stays the quiet `<select>` in the chrome. Its options are Basic, LinkedIn, X, Instagram, and Substack.
- **Settings → Writing** gets "New drafts use" (a select over the same 5), stored as `settings.defaultFormat` (default `'basic'`). It applies to new local drafts and to new drafts created from Notion pages.

## 3. Edit-mode aids

These render only in Edit mode and are hidden in Write mode. They sit in `.surface` or in the sheet's side padding and never shift the text.

### 3.1 Fold (LinkedIn, Instagram)

- **Where the cut goes:** at character index `fold.chars` (0-based, raw text). It only shows when `text.length > fold.chars`, or the text runs past `fold.lines` visual lines.
- **Measuring:** pass a `fold-marker` marker at that index to `buildHTML`, render, then read the marker's `offsetTop` and `offsetLeft`. Take `lineH` from the textarea.
- **Placement:**
  - If `offsetTop < fold.lines × lineH`, the cut sits inside the allowed lines. Draw the **tick** at that point, and the label at that line.
  - Otherwise the line limit cuts first. Draw no tick; the label goes at line `fold.lines`, at `top = (fold.lines − 1) × lineH`.
- **Tick** (`.fold-tick`): absolute, `left: x; top: y; height: lineH; border-left: 1.5px solid var(--ink-3); opacity: .8; pointer-events: none`.
- **Label** (`.fold-label`):
  - Absolute in the sheet's right padding, vertically centered on that line.
  - Text `fold.label`, in `11px var(--font-ui)`, color `--ink-3`.
  - `title="Readers see everything before this point. The rest hides behind “see more”."` (Instagram: "“… more”".)
  - `pointer-events: auto`, because it's in the margin and never over text.
  - Hidden at 600px and narrower, where there's no margin; the tick stays.
- **Recompute** on every Edit-mode render (the same pass that places the caret marker).

### 3.2 Over the limit

- **LinkedIn and Instagram:** characters from `limit` to the end go on the outer `fx` layer as `{type: 'overflow'}`, using the existing faint red tint. No text, no counter.
- **X:** the same, per post, using `xLength` weighting (section 3.3).

### 3.3 X threads

- **Posts:** a line that is exactly `---` (spaces allowed around it) separates posts. A post is the text between separators, trimmed of blank lines at its ends. Empty posts don't count.
- **Numbers**, in Edit mode, when there are two or more posts (`.post-num`):
  - "1/3" in `11px var(--font-ui)`, `--ink-3`, `font-variant-numeric: tabular-nums`.
  - Absolute in the sheet's left padding, right-aligned 12px before the text edge, on the first line of each post. Use a marker per post start for the `offsetTop`.
  - `title="Post 2 of 3 · 251/280 · click to select"`.
  - Clicking calls `Editor.select(start, end)` on that post's trimmed range, so ⌘C copies it.
  - `pointer-events: auto`. Hidden at 600px and narrower.
- **Overflow:** inside each post, the first index where the running `xLength` weight passes 280, up to the post's end, becomes an `overflow` fx range.
- **⌘↩ / Ctrl+↩ in X format** (both modes) inserts a separator through `Editor.replaceRange`, so undo works:
  - At the start of an empty line, insert `---\n`.
  - Otherwise insert `\n---\n`.
- **First time the format is set to X:** show the toast "Threads: a line with just --- starts the next post. ⌘↩ adds one." Remember that it was shown in `localStorage['tdw.hintThread']`.
- **In Notion,** `---` already maps to a divider block, so a thread keeps its shape there.

## 4. Tooltip on the amount

`.reg-amount` gets a `title`: "{w} words · {c} characters · {m} min read", where `m = max(1, round(readingTimeSec / 60))` and `c = text.length`. Update it with the register. Show nothing when the draft is empty.

## 5. Engine

- The mask also blanks separator lines: add `/^[ \t]*---[ \t]*$/gm` → spaces of the same length (same rule as `OPAQUE_RE`).
- Add this test to `tests/engine.test.js`:
  ```js
  test('thread separators are not text', () => {
    assert.equal(E.countWords('a\n---\nb'), 2);
    const a = E.analyze('One.\n---\nTwo.');
    assert.equal(a.sentences, 2);
    assert.equal(a.paragraphs, 2);
    assert.equal(a.words, 2);
  });
  ```

## 6. Version and docs

- `1.2.0`: `APP_VERSION`, `VERSION = 'tdw-1.2.0'`, and every `?v=` query string.
- Update the README's formats section: formats set line length only; the Edit-mode aids; threads.

## 7. Checks

Use the Typewriter skin at 1280×800 in the pane, on `http://127.0.0.1:8765/`, with ≤ 6 screenshots. Verify with JS where possible.

1. Every format looks identical to Basic apart from the column width. Compare the computed `font-family`, `font-size`, `line-height`, and the sheet background across formats; they must be equal. The column holds 52, 43, 52, and 70 characters per line in Typewriter: type a long run of "x" and count the characters on the first line.
2. **LinkedIn fold:**
   - A draft with a 200-character first paragraph shows the tick at character 140, on line 3, with the label in the right margin.
   - A draft of four one-word lines shows no tick, and the label at line 3.
   - Neither shows in Write mode.
3. **Instagram fold** at 125 characters or 2 lines.
4. **Over the limit:** paste 3,100 characters in LinkedIn. The last 100 are tinted; nothing else changes.
5. **X:** three posts separated by `---`.
   - The numbers 1/3, 2/3, 3/3 sit on the right lines.
   - Clicking 2/3 selects exactly post 2.
   - A 300-character post tints its last 20 weighted characters.
   - ⌘↩ inserts a separator, and ⌘Z removes it.
   - The first-time toast shows once.
6. The `.reg-amount` tooltip text is right. `#stats` is gone.
7. Settings "New drafts use: LinkedIn" makes a new draft open in LinkedIn with a $2,000 budget.
8. With the fake Notion server (reuse the v1.1 setup), a thread pushes `---` as divider blocks and pulls back unchanged.
9. At phone width (375px), the margin aids hide, the tick still shows, and there's no horizontal scroll. No console errors.
10. `node --test apps/ten-dollar-words/tests/` passes.

Report in under 250 words: status, the test summary, ✓/✗ per check, deviations, and the files changed. Clean up afterwards: stop the fake server, reset the viewport, and remove `tdw.notionBase` and any fake-connected drafts from the pane's storage (`localStorage.clear()` on `127.0.0.1:8765` is fine; it holds only test data).
