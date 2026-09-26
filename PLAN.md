# Ten-Dollar Words: build plan

For the builder. Every product and design decision below is final. Implement it faithfully, test it the way section 16 says, and report back. If something is ambiguous, choose the simplest option that passes the acceptance checks and list it under "Deviations" in your report. Do not run the design-seed-randomizer or artifact-design skills; the design is already decided here.

All paths are relative to the working directory (the connected Claude folder). The project lives in `apps/ten-dollar-words/`. Never write an absolute path into any file.

---

## 0. Who it's for

Chris is a ghostwriter (LinkedIn posts, email courses, newsletters) with no coding background. Use American English everywhere. He likes plain, direct copy and hates corporate fluff and AI-sounding text, so UI copy must be short and plain (section 14 has every string). He reads light pages more easily than dark ones.

Inspiration is the Hemingway Editor. We copy its features and logic, never its name, logo, wording, or look.

## 1. What we're building

A static web app with plain HTML, CSS, and vanilla JS. No build step, no frameworks, no npm packages. It gets deployed to Netlify later, but not by you.

- **Two modes.** WRITE shows only the text on the page, with nothing else on screen while typing. EDIT shows highlights, the budget register, the readability grade, fixes, and AI help. You can type in both modes.
- **Every word costs $10.** Each draft has a budget (default $2,000). The budget appears in Edit mode only.
- **Readability engine (Hemingway-style).** It gives a grade (Automated Readability Index) and flags hard and very hard sentences, adverbs, passive voice, wordy phrases, and weakeners.
- **AI help through Google Gemini**, using the user's own API key stored in their browser. It covers four features: simplify a sentence, rewrite passive voice, Cut the cost (tighten), and Check the message.
- **Typing sounds.** They are synthesized with Web Audio, quiet, and instant. There are two profiles plus Off.
- **Three skins:** Typewriter (default), Ditto, and Night desk.
- **Drafts** are saved in localStorage, with backup and restore through a JSON file.
- **Installable as an app (a PWA)**, and writing works offline.

## 2. Ground rules

**Do**
- Use classic `<script>` tags, never ES modules. There is one global namespace, `window.TDW`, and each file attaches one object to it (`TDW.Engine`, `TDW.Sound`, ...).
- Keep comments sparse, only where the logic isn't obvious.
- Use `hidden` or classes to show and hide things, and put all colors in CSS custom properties (section 4).
- Build for current Chrome, Safari, and Firefox.

**Don't**
- Don't use frameworks, libraries, build tools, or npm installs.
- Don't edit `app/js/data.js` or `tests/engine.test.js`. They're provided. If you're sure one has a typo, fix it and report it.
- Don't touch anything outside `apps/ten-dollar-words/`, except for creating `.claude/launch.json` (M0).
- Don't deploy, publish, create git repos, or send anything anywhere.
- Don't build anything listed in section 17.
- Don't write meta text into the app, such as "built by", "per plan", "v2 changes", or placeholder lorem ipsum.

**Security.** The user's API key lives in the browser, so:
- Never use `innerHTML` with user text or AI text. The only exception is `Editor.buildHTML`, which escapes `&`, `<`, and `>`. Build everything else with `createElement` and `textContent`. Static icon SVG constants are fine.
- Use no inline `<script>` blocks, no inline `on*=` handlers, no `eval`, and no `new Function`. The CSP in section 13 forbids them.
- The key lives only in localStorage under `tdw.geminiKey`. It is only sent to `generativelanguage.googleapis.com`, in the `x-goog-api-key` header. Never log it, and never put it in a URL.

**Undo.** Never assign `editor.value` except when loading a draft (`Editor.setText`). Every programmatic change goes through `Editor.replaceRange`, which keeps native Cmd/Ctrl+Z working.

## 3. Files

```
apps/ten-dollar-words/
  PLAN.md                  this file
  README.md                you write it last (section 16)
  tests/engine.test.js     PROVIDED: acceptance tests for the engine
  app/                     the website (this folder gets deployed)
    index.html
    manifest.webmanifest
    sw.js
    _headers
    css/app.css
    js/data.js             PROVIDED: word lists
    js/engine.js           readability engine (UMD: browser + Node)
    js/sound.js            typing sounds
    js/store.js            drafts, settings, backup
    js/ai.js               Gemini client + prompts
    js/ai-mock.js          fake AI for local testing (?mock=1)
    js/editor.js           textarea + highlight layer
    js/ui.js               shared helpers: el(), toast, money, time, icons
    js/panel.js            Edit-mode panel: register, grade, fixes, stats, AI results
    js/popover.js          tips on highlighted text
    js/dialogs.js          Drafts drawer + Settings
    js/app.js              state, events, boot (loaded last)
    icons/icon.svg, icon-maskable.svg, icon-192.png, icon-512.png, icon-maskable-512.png, icon-180.png
```

Scripts load in exactly this order at the end of `<body>`: data, engine, sound, store, ai, ai-mock, editor, ui, panel, popover, dialogs, app.

---

## 4. Design system

### 4.1 Concept

The default skin is a portable typewriter seen from above. In Write mode the whole window is a sheet of paper with typed text and a ribbon-red caret, and nothing else. Switching to Edit mode feels like stepping back from the machine: the putty-colored body appears around the sheet, and a "tariff card" panel slides in on the right.

The one bold element is the **register**, the money readout. It uses big price-tag numerals with a small raised `$`, and an "OVER BUDGET" rubber stamp when you overspend. Keep everything else quiet.

### 4.2 Fonts

Use one `<link>` per family, so one bad family can't break the others. Verify each with `curl -s -o /dev/null -w "%{http_code}" "<url>"`, which must return 200.

```
https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&display=swap
https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400;1,700&display=swap
https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&display=swap
https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:ital,wght@0,200..800;1,200..800&display=swap
```

If the Atkinson URL fails, try `family=Atkinson+Hyperlegible+Mono:wght@200..800`. If that fails too, use `family=IBM+Plex+Mono:ital,wght@0,400;0,700;1,400` and make IBM Plex Mono first in the Night stack.

- **Archivo** is the UI face. Its width axis gives the character: `font-variation-settings: "wdth" 75` for small uppercase labels and `"wdth" var(--display-wdth)` for the register numerals and the wordmark.
- **The writing face changes per skin:** Courier Prime (Typewriter), Newsreader (Ditto), Atkinson Hyperlegible Mono (Night).

### 4.3 Tokens (paste into `css/app.css`)

```css
:root {
  --font-ui: "Archivo", "Helvetica Neue", Arial, sans-serif;
  --text-offset: 0px;           /* user text-size setting, -2px..+4px */
  --phone-offset: 0px;
  --chrome-h: 52px;
  --panel-w: 340px;
  --radius: 6px;
  --t-xs: 11px; --t-sm: 13px; --t-md: 15px; --t-lg: 20px; --t-xl: 28px; --t-2xl: 46px;
}
@media (max-width: 600px) { :root { --phone-offset: -2px; } }

:root, [data-skin="typewriter"] {
  color-scheme: light;
  --paper: #fffdf6;  --desk: #d6d2b8;  --desk-ink: #4b4838;  --card: #f4f1e2;  --line: #c3bea0;
  --ink: #1e1c17;  --ink-2: #585443;  --ink-3: #8a8570;
  --accent: #00788e;  --on-accent: #ffffff;
  --money: #c81f14;  --saved: #4f6b00;
  --good: #4f6b00;  --ok: #9a5a00;  --bad: #c81f14;
  --hl-hard: #f6e3a1;  --hl-veryhard: #f6c2bd;  --hl-complex: #e5d2f7;
  --hl-adverb: #cde3f6;  --hl-passive: #dde9b5;  --hl-qualifier: #2479b8;
  --caret: #c81f14;  --selection: rgba(0, 149, 176, .22);
  --shadow: 0 1px 2px rgba(60, 50, 20, .08), 0 12px 32px -18px rgba(60, 50, 20, .35);
  --font-write: "Courier Prime", "Courier New", Courier, "PingFang TC", "Noto Sans TC", monospace;
  --write-size: 19px;  --write-leading: 1.75;  --measure: 64ch;
  --display-wdth: 125;  --ink-bleed: none;
}

[data-skin="ditto"] {
  color-scheme: light;
  --paper: #fdfafe;  --desk: #e7dcea;  --desk-ink: #3f335e;  --card: #f6f0f8;  --line: #cdbfd6;
  --ink: #2b1f5c;  --ink-2: #5b4f86;  --ink-3: #9488b3;
  --accent: #0f7466;  --on-accent: #ffffff;
  --money: #a84c14;  --saved: #0f7466;
  --good: #0f7466;  --ok: #a84c14;  --bad: #b0233e;
  --hl-hard: #fbe3bf;  --hl-veryhard: #f8cbd4;  --hl-complex: #e3d4f7;
  --hl-adverb: #d2e6f8;  --hl-passive: #cdeee7;  --hl-qualifier: #2b6fb6;
  --caret: #663bbe;  --selection: rgba(102, 59, 190, .18);
  --shadow: 0 1px 2px rgba(43, 31, 92, .08), 0 12px 32px -18px rgba(43, 31, 92, .35);
  --font-write: "Newsreader", Georgia, "Times New Roman", "PingFang TC", "Noto Serif TC", serif;
  --write-size: 21px;  --write-leading: 1.6;  --measure: 36em;
  --display-wdth: 100;  --ink-bleed: 0 0 0.6px rgba(102, 59, 190, .55);
}

[data-skin="night"] {
  color-scheme: dark;
  --paper: #0a1a33;  --desk: #061429;  --desk-ink: #bccc9d;  --card: #0d2140;  --line: #24395c;
  --ink: #ede6d3;  --ink-2: #bccc9d;  --ink-3: #7f8ea6;
  --accent: #e0bc5b;  --on-accent: #061429;
  --money: #ff8a5c;  --saved: #8fd694;
  --good: #8fd694;  --ok: #e0bc5b;  --bad: #ff8a5c;
  --hl-hard: rgba(224, 188, 91, .30);  --hl-veryhard: rgba(203, 45, 137, .42);
  --hl-complex: rgba(181, 136, 196, .38);  --hl-adverb: rgba(10, 186, 230, .30);
  --hl-passive: rgba(25, 203, 99, .28);  --hl-qualifier: #5fd0f0;
  --caret: #e0bc5b;  --selection: rgba(224, 188, 91, .25);
  --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 16px 40px -20px rgba(0, 0, 0, .8);
  --font-write: "Atkinson Hyperlegible Mono", "IBM Plex Mono", ui-monospace, Menlo, "PingFang TC", monospace;
  --write-size: 18px;  --write-leading: 1.8;  --measure: 64ch;
  --display-wdth: 85;  --ink-bleed: none;
}
```

`data-skin` and `data-mode` live on `<html>`. The skin preview cards in Settings carry their own `data-skin` attribute, so each card shows its own colors.

### 4.4 Type and components

- **Labels** (`.label`): `600 var(--t-xs)/1 var(--font-ui)`, `"wdth" 75`, uppercase, `letter-spacing: .12em`, color `--ink-2`.
- **UI body:** `400 var(--t-sm)/1.4 var(--font-ui)`, color `--ink`. Secondary text uses `--ink-2`.
- **Buttons are pills:**
  - `.btn`: 32px tall, `padding: 0 14px`, radius 999px, `600 var(--t-sm) var(--font-ui)`, background `--accent`, color `--on-accent`.
  - `.btn-outline`: 1px `--line` border, transparent background, `--ink` text.
  - `.btn-quiet`: transparent, `--ink-2` text, and on hover a `color-mix(in srgb, var(--ink) 7%, transparent)` background.
  - `.btn-icon`: a 32×32 quiet button holding a 16px SVG.
  - `.danger` sets its text color to `--bad`.
  - `:focus-visible` gets `outline: 2px solid var(--accent); outline-offset: 2px`.
- **Mode switch:** a segmented pill with a 1px `--line` border, radius 999px, and 2px padding. Buttons are 28px tall. The pressed button gets background `--ink` and color `--paper`.
- **Wordmark:** the text "Ten-Dollar Words", `800 12px var(--font-ui)`, `"wdth" var(--display-wdth)`, uppercase, `letter-spacing: .14em`, color `--desk-ink`. No logo mark.
- **Grade pill** (`.pill`): 11px uppercase with `.1em` tracking, `padding: 3px 8px`, radius 999px. Its color is `--good`/`--ok`/`--bad`, on a background of that color mixed 14% into transparent.
- **Popover** (`.popover`): `position: fixed`, width `min(320px, calc(100vw - 32px))`, background `--card`, 1px `--line` border, radius 8px, `--shadow`, `padding: 14px 16px 16px`.
- **Dialogs** (`<dialog>`): background `--card`, color `--ink`, 1px `--line` border, radius 10px. `::backdrop` is `rgba(0,0,0,.28)`.
  - **Settings** is a centered modal, `width: min(560px, calc(100vw - 32px))`, `max-height: 85dvh`, scrolling inside.
  - **Drafts** is a left drawer: `margin: 0; height: 100dvh; max-height: 100dvh; width: min(360px, 100vw); border-radius: 0 10px 10px 0`.
- **Toast:** fixed at bottom center, above the safe area. Background `--ink`, color `--paper`, radius 999px, `padding: 8px 14px`, 13px text. It may hold one action button. It disappears after 3.5s, or 6s when it has an action.
- **Motion:**
  - The body background transitions over 240ms.
  - Entering Edit mode slides the panel in: `transform: translateX(24px)` to 0 and opacity 0 to 1, over 200ms.
  - The chrome fades over 180ms and the popover over 120ms.
  - The register number tweens over 250ms.
  - Under `prefers-reduced-motion: reduce`, turn all of these off.

### 4.5 Layout

**Write mode** (`html[data-mode="write"]`)
- Body background `--paper`. No panel, and no budget anywhere.
- `.page` has side padding of 16px. Top padding is 45vh when typewriter scrolling is on, otherwise 14vh. Bottom padding is 55vh.
- `.sheet` has no card styling: `max-width: var(--measure); margin: 0 auto`.
- The chrome (top bar) is `position: fixed` and invisible (`opacity: 0; pointer-events: none`).
  - A mouse move of more than 4px shows it for 1.6s, and hovering keeps it visible.
  - Any keydown in the editor hides it at once and adds `html.is-typing`, which sets `cursor: none`. A mouse move removes it.
  - On touch devices (`@media (hover: none)`), keep the chrome visible at `opacity: .55`, showing only the mode switch.
- Hide the page scrollbar: `html[data-mode="write"] { scrollbar-width: none }` plus the `::-webkit-scrollbar { display: none }` equivalent.
- Spellcheck is off.

**Edit mode, desktop** (901px and wider)
- Body background `--desk`.
- The chrome is always visible: fixed, height `--chrome-h` plus the top safe area, background `--desk`, and a 1px `--line` bottom border.
- `.page` padding is `calc(var(--chrome-h) + 28px) calc(var(--panel-w) + 24px) 40vh 24px`.
- `.sheet` becomes the paper card: background `--paper`, `--shadow`, radius 3px, `padding: 56px 64px`, `max-width: calc(var(--measure) + 128px)`, `margin: 0 auto`.
- `.panel` is fixed at `top: var(--chrome-h)`, `right: 0`, `bottom: 0`, `width: var(--panel-w)`, with `overflow-y: auto`, background `--card`, a 1px `--line` left border, and `padding: 22px 24px 48px`. It is a flex column with `gap: 18px`. Each section after the first gets `border-top: 1px solid var(--line); padding-top: 18px`.
- `#panel-handle` is `display: none` above 900px.

**Edit mode, phone and tablet** (900px and narrower)
- `.page` padding is `calc(var(--chrome-h) + 12px) 12px calc(72px + 30vh) 12px`. `.sheet` padding is `28px 20px`.
- `.panel` becomes a bottom sheet: fixed at `left: 0; right: 0; bottom: 0; max-height: 75dvh; overflow-y: auto`, with a 1px `--line` top border and `border-radius: 14px 14px 0 0`.
  - Collapsed, it shows only `#panel-handle`, a 56px row with the summary text "$2,340 of $3,000 · Grade 7 · 12 fixes" and a chevron.
  - Tapping the handle toggles `.is-open`, which expands the sheet with a transform transition.
  - Add the bottom safe-area inset to its padding.
- The chrome shows only Drafts, the mode switch, and Settings. Hide the wordmark, Copy, and Full screen.

**Never allow horizontal scrolling**, at any width down to 360px.

---

## 5. Markup (`index.html`)

It's a full document, since this is a normal website:

```html
<!doctype html>
<html lang="en" data-skin="typewriter" data-mode="write">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Ten-Dollar Words</title>
  <meta name="description" content="A writing app where every word costs $10.">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#fffdf6">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="icons/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="icons/icon-180.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <!-- the four font <link>s from 4.2 -->
  <link rel="stylesheet" href="css/app.css">
</head>
<body>
  <header id="chrome" class="chrome">
    <div class="chrome-left">
      <button id="btn-drafts" class="btn-quiet" type="button">Drafts</button>
      <span class="wordmark">Ten-Dollar Words</span>
      <span id="mock-badge" class="pill" hidden>Mock AI</span>
    </div>
    <div class="chrome-right">
      <span id="save-status" class="save-status" aria-live="polite"></span>
      <button id="btn-copy" class="btn-quiet" type="button">Copy</button>
      <button id="btn-fullscreen" class="btn-quiet" type="button">Full screen</button>
      <div class="mode-switch" role="group" aria-label="Mode">
        <button id="mode-write" type="button" aria-pressed="true">Write</button>
        <button id="mode-edit" type="button" aria-pressed="false">Edit</button>
      </div>
      <button id="btn-settings" class="btn-icon" type="button" aria-label="Settings"><!-- sliders icon --></button>
    </div>
  </header>

  <main id="page" class="page">
    <div id="sheet" class="sheet">
      <div id="surface" class="surface">
        <div id="backdrop" class="backdrop type-surface" aria-hidden="true"></div>
        <textarea id="editor" class="editor type-surface" spellcheck="false" autocapitalize="sentences"
          autocomplete="off" aria-label="Your draft" placeholder="Start typing. Every word costs $10."></textarea>
      </div>
    </div>
  </main>

  <aside id="panel" class="panel" aria-label="Editing tools">
    <button id="panel-handle" class="panel-handle" type="button" aria-expanded="false">
      <span id="panel-summary"></span><span class="chev" aria-hidden="true"></span>
    </button>

    <section id="register" class="register" aria-label="Budget">
      <div class="label">Spent</div>
      <div class="reg-amount"><span class="cur">$</span><span id="reg-spent">0</span></div>
      <div class="reg-meter" aria-hidden="true"><div id="reg-fill" class="reg-fill"></div></div>
      <div class="reg-row">
        <span>of <button id="reg-budget" class="link" type="button">$2,000</button> budget</span>
        <span id="reg-left"></span>
      </div>
      <div id="reg-saved" class="reg-saved" hidden></div>
      <div id="reg-stamp" class="stamp" hidden>Over budget</div>
      <form id="budget-form" class="budget-form" hidden>
        <label for="budget-input">Budget for this draft</label>
        <div class="money-input"><span>$</span><input id="budget-input" type="number" min="10" step="10" inputmode="numeric"></div>
        <div class="chips">
          <button type="button" class="chip" data-budget="2000">Post $2,000</button>
          <button type="button" class="chip" data-budget="3000">Email $3,000</button>
          <button type="button" class="chip" data-budget="8000">Essay $8,000</button>
        </div>
        <div class="row-end">
          <button type="button" id="budget-cancel" class="btn-quiet">Cancel</button>
          <button type="submit" class="btn">Set budget</button>
        </div>
      </form>
    </section>

    <section id="readability" aria-label="Readability">
      <div class="label">Readability</div>
      <div class="grade-row"><span id="grade-num" class="grade">Grade —</span><span id="grade-pill" class="pill" hidden></span></div>
      <p class="hint">Aim for grade 9 or lower.</p>
    </section>

    <section id="issues" aria-label="Fixes">
      <div class="label">Fixes</div>
      <ul id="issue-list" class="issue-list"></ul>
      <div id="issues-empty" class="empty" hidden>
        <p>Nothing to check yet.</p>
        <button id="btn-sample" type="button" class="btn-outline">Try sample text</button>
      </div>
    </section>

    <section id="ai-desk" aria-label="AI help">
      <div class="label">AI help</div>
      <div class="ai-actions">
        <button id="ai-tighten" type="button" class="btn">Cut the cost</button>
        <button id="ai-message" type="button" class="btn-outline">Check the message</button>
      </div>
      <p id="ai-note" class="hint"></p>
    </section>

    <section id="ai-results" class="ai-results" hidden aria-live="polite">
      <button id="ai-back" type="button" class="btn-quiet">← Back</button>
      <div id="ai-body"></div>
    </section>

    <section id="stats" aria-label="Stats"><p id="stats-line" class="stats"></p></section>
  </aside>

  <div id="popover" class="popover" role="dialog" aria-label="Tip" hidden></div>
  <dialog id="drafts-dialog" class="drawer" aria-labelledby="drafts-title"></dialog>
  <dialog id="settings-dialog" class="modal" aria-labelledby="settings-title"></dialog>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <input id="restore-input" type="file" accept="application/json,.json" hidden>

  <!-- 12 scripts in the order from section 3 -->
</body>
</html>
```

`dialogs.js` fills the two `<dialog>` elements (sections 12.6 and 12.7).

Icons are static SVG strings in `ui.js` (`TDW.icons`). Each is 16px with `stroke="currentColor"` and `fill="none"` unless noted:
- `close`: `<path d="M4 4l8 8M12 4l-8 8" stroke-width="1.6" stroke-linecap="round"/>`
- `sliders`: `<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" stroke-width="1.5" stroke-linecap="round"/><circle cx="10.5" cy="4.5" r="1.6" stroke-width="1.5"/><circle cx="5.5" cy="11.5" r="1.6" stroke-width="1.5"/>`
- `eye`: `<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>`
- `eyeOff`: the eye paths plus `<path d="M2.5 13.5l11-11" stroke-width="1.4" stroke-linecap="round"/>`
- `chevUp`: `<path d="M4 10l4-4 4 4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`

---

## 6. Readability engine (`js/engine.js`)

It must pass `node --test apps/ten-dollar-words/tests/engine.test.js`. The tests are the contract. Use the UMD wrapper so it works in Node and the browser:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./data.js'));
  else { root.TDW = root.TDW || {}; root.TDW.Engine = factory(root.TDW.Data); }
})(typeof self !== 'undefined' ? self : this, function (D) {
  // ... build sets/regexes once here ...
  return { countWords, splitSentences, classifySentence, gradeLabel, analyze };
});
```

**Constants**
- `CJK_G = /[㐀-鿿豈-﫿]/g`
- `HAS_WORDCHAR = /[A-Za-z0-9À-ɏ]/`
- `LETTERS_G = /[A-Za-z0-9À-ɏ]/g`
- `WORD_RE = /[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*/g` (word tokens with offsets)
- `normApos(s)` replaces `’` with `'`.

**countWords(text).** Split on `/\s+/`. For each non-empty chunk, add the number of CJK characters in it. Then add 1 more if what's left after removing the CJK characters contains `HAS_WORDCHAR`.

**splitSentences(text)** returns `[{start, end}]`. It goes line by line; `\n` always ends a sentence.
- For each line `[ls, le)`, run `TERM = /[.!?…]+["'”’)\]]*(?=\s|$)/g` on the line string.
- For each match: if `isBoundary`, push the range from the current start to the match end, and continue from the match end. At the end of the line, push the remainder.
- `push(a, b)` trims whitespace off both ends and keeps the range if it isn't empty.
- `isBoundary(line, m)`:
  - Let `next` be the first non-space character after the match on the line. If `next` is a lowercase a-z letter, return false. This covers "e.g. this", "etc. and", and "... well".
  - If the match starts with `.`, let `tok` be the run `[A-Za-z0-9.]+` that sits right before the match, and let `lower = tok.toLowerCase()`:
    - if `D.ABBREVIATIONS` includes `lower`, return false;
    - if `tok` is a single uppercase letter (an initial), return false;
    - if `tok` is all digits and only whitespace sits before it on the line (list numbering like "1. "), return false.
  - Otherwise return true.

**classifySentence(words, letters)**
- If `words < 14`, return `'normal'`.
- Otherwise `level = Math.round(4.71 * letters / words + 0.5 * words - 21.43)`.
- `level >= 14` gives `'veryHard'`, `level >= 10` gives `'hard'`, and anything else is `'normal'`.

**gradeLabel(g):** `g <= 9` is `'Good'`, `g <= 12` is `'OK'`, and anything higher is `'Hard'`.

**analyze(text)** returns:
```
{ words, letters, sentences, paragraphs, grade, readingTimeSec,
  sentenceList: [{start, end, words, letters, level, kind}],
  issues: [{id, type, start, end, text, suggestion?}],
  counts: {hard, veryHard, adverb, passive, complex, qualifier},
  targets: {adverb, passive} }
```
1. Sentences come from `splitSentences`. For each one, `words = countWords(slice)` and `letters` is the number of `LETTERS_G` matches in the slice. `level` uses the same formula as `classifySentence` but without the 14-word gate. `kind = classifySentence(words, letters)`.
2. `words = countWords(text)`, `letters` is the sum over sentences, `paragraphs` is the number of lines containing a non-space character, and `sentences = sentenceList.length`.
3. `grade` is 0 when there are no sentences or no words. Otherwise it's `Math.max(0, Math.round(4.71 * letters / words + 0.5 * words / sentences - 21.43))`.
4. `readingTimeSec = Math.round(words / 238 * 60)`. The targets are `{ adverb: Math.round(words / 100), passive: Math.round(sentences / 5) }`.
5. **Sentence issues:** each hard or very hard sentence becomes `{type: kind, start, end, text}`.
6. **Word-level candidates:**
   - **complex:** one regex, built once. Collect every `|` variant from `D.COMPLEX` into a `Map(norm(variant) → suggestion)`. Sort the variants by length, longest first, turn each into a pattern, and build `new RegExp('\\b(?:' + patterns.join('|') + ')\\b', 'gi')`. To turn a phrase into a pattern, escape regex metacharacters, replace `'` with `['’]`, and join the words with `[ \t ]+`. `norm(s)` means lowercase, `’`→`'`, whitespace collapsed to single spaces, trimmed. Each match gets `suggestion = map.get(norm(match))`.
   - **qualifier:** built the same way from `D.QUALIFIERS`, with `suggestion: ''`.
   - **passive:** checked per sentence, with tokens from `WORD_RE` and offsets relative to the text. For token `i`:
     - If `normApos(lower)` is in `D.BE_FORMS`, advance `j` past up to 2 tokens that are in `D.PASSIVE_SKIP` or that are 4+ letters ending in `ly`.
     - If the token at `j` is a participle, add `{type: 'passive', start: tok[i].start, end: tok[j].end}` and set `i = j`.
     - `isParticiple(p)` (lowercase) returns false if `p` is in `D.ADJECTIVAL_PARTICIPLES`, true if it's in `D.IRREGULAR_PARTICIPLES`, and otherwise `p.length >= 4 && p.endsWith('ed') && !D.ED_NOT_PARTICIPLE.includes(p)`.
   - **adverb:** a `WORD_RE` token whose lowercase form is 4+ characters long, ends in `ly`, and isn't in `D.ADVERB_EXCEPTIONS`.
7. **Resolve overlaps by priority:** complex 4, passive 3, qualifier 2, adverb 1. Sort candidates by priority descending, then start ascending, then length descending. Keep a `Uint8Array(text.length)` of claimed characters. Keep a candidate only if none of its characters are claimed yet, then claim them.
8. `issues` is the sentence issues plus the kept word issues, sorted by start ascending and then by span length descending. Each issue's `text` is `text.slice(start, end)` and its `id` is `` `${type}:${start}:${end}` ``. `counts` tallies the final issues.

Use `Set`s for the word lists. If the test with about 5,700 words takes more than 150ms, stop using one giant complex regex. Instead, index the phrases by their first word and check word tokens against that index.

---

## 7. Editor (`js/editor.js`)

The editor is a native `<textarea>` stacked on top of an identical `<div>` (the backdrop) that draws the highlights. This keeps the caret native, IME input and undo working, and avoids any contenteditable bugs.

### 7.1 CSS (exact; the two layers must wrap text identically)

```css
.surface { position: relative; }
.type-surface {
  display: block; box-sizing: border-box; width: 100%; margin: 0; padding: 0; border: 0;
  font-family: var(--font-write);
  font-size: calc(var(--write-size) + var(--text-offset) + var(--phone-offset));
  line-height: var(--write-leading); font-weight: 400; letter-spacing: 0;
  font-kerning: normal; font-variant-ligatures: none; font-feature-settings: normal;
  white-space: pre-wrap; overflow-wrap: break-word; word-wrap: break-word; word-break: normal;
  hyphens: none; tab-size: 4; text-align: left; text-indent: 0; text-transform: none;
}
.backdrop { position: absolute; top: 0; left: 0; right: 0; color: transparent; pointer-events: none; user-select: none; }
.editor {
  position: relative; z-index: 1; background: transparent; color: var(--ink); caret-color: var(--caret);
  resize: none; overflow: hidden; outline: none; border-radius: 0; -webkit-appearance: none; appearance: none;
  min-height: calc(3 * var(--write-leading) * 1em); text-shadow: var(--ink-bleed);
}
.editor::placeholder { color: var(--ink-3); opacity: 1; }
.editor::selection { background: var(--selection); }
.backdrop mark, .backdrop .hs { color: transparent; background: none; border-radius: 2px;
  -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.hs-hard { background: var(--hl-hard) !important; }
.hs-veryHard { background: var(--hl-veryhard) !important; }
.hl-complex { background: var(--hl-complex) !important; }
.hl-adverb { background: var(--hl-adverb) !important; }
.hl-passive { background: var(--hl-passive) !important; }
.hl-qualifier { text-decoration: underline dotted var(--hl-qualifier) 2px; text-underline-offset: 4px; }
.backdrop.hide-hard .hs-hard, .backdrop.hide-veryHard .hs-veryHard,
.backdrop.hide-complex .hl-complex, .backdrop.hide-adverb .hl-adverb,
.backdrop.hide-passive .hl-passive { background: none !important; }
.backdrop.hide-qualifier .hl-qualifier { text-decoration: none; }
.backdrop .is-active { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 35%, transparent); }
```

Never give marks horizontal padding, margins, or borders. They would shift the text out of line with the textarea. `box-shadow` and `outline` are safe.

### 7.2 buildHTML (use as written)

```js
function escapeHTML(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// sent / word: arrays of {start, end, type, id}, each sorted by start, non-overlapping within itself.
function buildHTML(text, sent, word, markerIndex) {
  const cuts = new Set([0, text.length]);
  for (const m of sent) { cuts.add(m.start); cuts.add(m.end); }
  for (const m of word) { cuts.add(m.start); cuts.add(m.end); }
  if (markerIndex != null) cuts.add(markerIndex);
  const pts = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
  const skip = (arr, i, pos) => { while (i < arr.length && arr[i].end <= pos) i++; return i; };
  let out = '', si = 0, wi = 0, openS = null, openW = null;
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = k + 1 < pts.length ? pts[k + 1] : a;
    si = skip(sent, si, a); wi = skip(word, wi, a);
    const S = si < sent.length && sent[si].start <= a && a < sent[si].end ? sent[si] : null;
    const W = wi < word.length && word[wi].start <= a && a < word[wi].end ? word[wi] : null;
    if (S !== openS) {
      if (openW) { out += '</mark>'; openW = null; }
      if (openS) out += '</span>';
      openS = S;
      if (S) out += '<span class="hs hs-' + S.type + '" data-id="' + S.id + '">';
    }
    if (W !== openW) {
      if (openW) out += '</mark>';
      openW = W;
      if (W) out += '<mark class="hl hl-' + W.type + '" data-id="' + W.id + '">';
    }
    if (a === markerIndex) out += '<span class="caret-marker"></span>';
    if (b > a) out += escapeHTML(text.slice(a, b));
  }
  if (openW) out += '</mark>';
  if (openS) out += '</span>';
  if (text === '' || text.endsWith('\n')) out += ' ';
  return out;
}
```

### 7.3 API

```
TDW.Editor = {
  init({ textarea, backdrop, surface }),
  setText(text),                // load a draft only: sets value, caret to end, render()
  getText(),
  setMarks(sent, word),         // cache the highlight arrays; [] and [] in Write mode
  setHidden(typesArray),        // toggles hide-<type> classes on the backdrop
  render(markerIndex?),         // backdrop.innerHTML = buildHTML(value, marks..., markerIndex ?? selectionEnd); then autosize
  caretTop(index),              // render(index); return .caret-marker offsetTop (px from surface top)
  scrollToIndex(index, frac),   // window.scrollTo so that line sits at frac of the viewport height
  typewriterScroll(),           // scrollToIndex(selectionEnd, 0.45)
  replaceRange(start, end, text),
  select(start, end),           // focus({preventScroll:true}), setSelectionRange, scrollToIndex(start, 0.35)
  caretIndex(),                 // selectionEnd
  markRect(id)                  // first getClientRects() rect of [data-id="id"] in the backdrop, or null
}
```

- **Autosize:** after each render, set `textarea.style.height = Math.max(backdrop.offsetHeight + 2, minPx) + 'px'`. The backdrop's natural height is the text height, so nothing jumps.
- **Never scroll the textarea:** `textarea.addEventListener('scroll', () => { textarea.scrollTop = 0; })`.
- **scrollToIndex:**
  ```js
  const top = caretTop(i);
  const lineH = parseFloat(getComputedStyle(textarea).lineHeight) || 30;
  const y = surface.getBoundingClientRect().top + window.scrollY + top + lineH / 2;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  window.scrollTo(0, Math.max(0, y - vh * frac));
  ```
- **replaceRange:**
  ```js
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, end);
  const before = textarea.value;
  let ok = false;
  try { ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text); } catch (_) {}
  const expect = before.slice(0, start) + text + before.slice(end);
  if (!ok || textarea.value !== expect) {
    textarea.value = expect;                       // fallback loses native undo; acceptable
    textarea.setSelectionRange(start + text.length, start + text.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  ```
  `execCommand` fires the `input` event by itself, so don't dispatch a second one.
- **Re-render** on `window` resize (in rAF), after `document.fonts.ready`, and on `document.fonts` `loadingdone`.

### 7.4 Text helpers (also in `editor.js`, on `TDW.Editor`)

- **`cutPlan(text, start, end, sentenceStart)`** returns `{start, end, replacement}` for deleting a word or phrase cleanly:
  1. `s = start; e = end`. If `text[e] === ','`, then `e++`.
  2. If `text[e] === ' '`, then `e++`. Otherwise, if `text[s-1] === ' '`, then `s--`.
  3. If `start === sentenceStart` and `text[e]` is a lowercase letter, return `{start: s, end: e + 1, replacement: text[e].toUpperCase()}`. Otherwise return `{start: s, end: e, replacement: ''}`.
- **`matchCase(original, replacement)`:**
  - If `original` is longer than 1 character and entirely uppercase, return `replacement.toUpperCase()`.
  - If the first letter of `original` is uppercase, capitalize the first letter of `replacement`.
  - Otherwise return `replacement` unchanged.

---

## 8. Budget and the register

- `PRICE = 10`. `spent = words * 10`. The budget lives on each draft (default comes from settings, 2000).
- `peakWords = max(peakWords, words)` is updated on every input and saved with the draft. `saved = (peakWords - words) * 10`.
- Register rendering (Edit mode):
  - `#reg-spent` tweens from the old value to the new one over 250ms (instant with reduced motion). It shows digits with commas; the `$` is the separate `.cur` span.
  - `#reg-fill` width is `min(spent / budget, 1) * 100%`.
  - Over budget, add `.is-over` to the register. That turns the amount and the fill `--money`, shows `#reg-stamp`, and sets `#reg-left` to "Over by $340" in `--money`. Otherwise `#reg-left` reads "$660 left".
  - `#reg-saved` shows "Saved $120 by cutting" only when `saved > 0`, in `--saved`.
- **Register CSS**
  - `.reg-amount`: `800 var(--t-2xl)/1 var(--font-ui)`, `font-variation-settings: "wdth" var(--display-wdth)`, `font-variant-numeric: tabular-nums`, color `--ink`.
  - `.cur`: `font-size: .45em; font-weight: 700; vertical-align: top; position: relative; top: .2em; margin-right: .05em`.
  - `.reg-meter`: 8px tall, radius 999px, background `color-mix(in srgb, var(--line) 60%, transparent)`.
  - `.reg-fill`: background `--ink`, with transitions on width and color.
  - `.stamp`: absolute, `top: 2px; right: 0`, `800 var(--t-xs)/1 var(--font-ui)`, `"wdth" 75`, uppercase, `letter-spacing: .18em`, color `--money`, `border: 2px solid var(--money)`, radius 3px, `padding: 4px 7px 3px`, `transform: rotate(-5deg)`.
  - `.register` needs `position: relative`.
- **Refund chip.** In Edit mode, when the word count drops, show a floating "+$N" chip at the register. Add up drops that happen within 700ms of each other into one chip. The chip is `700 var(--t-sm) var(--font-ui)` in `--saved`, rises 22px, and fades out over 900ms. Skip the motion under reduced motion. Never show it in Write mode.
- **Budget editor.** Clicking `#reg-budget` shows `#budget-form` with the current value. The chips fill the input. Set saves a new value of 10 or more (rounded to the nearest 10) to the draft, and Cancel hides the form.
- **Bell.** In Edit mode only, when typing pushes the word count over 90% of the budget, and again when it goes over 100%, play `Sound.play('bell')` once per crossing, only when going upward.

---

## 9. Sound (`js/sound.js`)

Everything is synthesized into AudioBuffers once. There are no audio files.

```
TDW.Sound = { init(settings), setProfile(p), setVolume(v), unlock(), kindForKey(e), panForKey(e), play(kind, opts) }
```

- **unlock()** runs on the first `pointerdown` or `keydown` anywhere (use `{ once: false }` and bail out if the context is already running). It creates `new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' })` if needed and calls `ctx.resume()`. It then builds the buffers for the current profile, plus `bell` and `coin`. Master gain is `volume * 0.6`, and the default volume is 0.35.
- **kindForKey(e)**
  - Return null if `e.isComposing`, `e.keyCode === 229`, `e.metaKey`, `e.ctrlKey`, or `e.altKey`.
  - `Enter` is `'enter'`. `Backspace` and `Delete` are `'back'`. `' '` is `'space'`. `Tab` or any single-character `e.key` is `'key'`. Anything else is null.
- **panForKey(e)**
  - The rows are `` '`1234567890-=' ``, `'qwertyuiop[]\\'`, `"asdfghjkl;'"`, `'zxcvbnm,./'`. Find the row `r` and index `i` of `e.key.toLowerCase()`. Pan is `(i / (row.length - 1) - 0.5) * 0.7`.
  - Space pans 0, and Enter and Backspace pan 0.35. Anything else pans 0.
- **play(kind, {pan, repeat})**
  - Return immediately if the profile is `off` or there's no context.
  - If `repeat` is set and the last sound was under 50ms ago, skip it.
  - Otherwise pick a random buffer variant for the kind. Create an `AudioBufferSourceNode` with `playbackRate` 1 ± 0.04 (random), then a gain of `0.8..1.0` (times 0.6 if `repeat`), then a `StereoPannerNode` if it exists, then the master gain. Start it at `ctx.currentTime`.
- **Wiring for zero lag**
  - The editor's `keydown` listener's first statement is `const k = Sound.kindForKey(e); if (k) Sound.play(k, { pan: Sound.panForKey(e), repeat: e.repeat });`. Nothing runs before it.
  - Phone fallback: on `beforeinput` with an `inputType` starting with `insert`, if no key sound played in the last 60ms, play `'key'`.

**Synthesis helpers.** Write samples into a Float32Array at `ctx.sampleRate`, then scale so the peak equals `norm`.
- `click(d, sr, t0, tau, amp, a)`: white noise through a one-pole lowpass `y += a * (x - y)` (higher `a` is brighter), times `amp * exp(-t / tau)`, for `t >= 0` from `t0`, stopping once the envelope drops below 0.001.
- `thump(d, sr, t0, f0, f1, tau, amp)`: a sine whose frequency glides as `f = f1 + (f0 - f1) * exp(-t / 0.012)`, using phase accumulation. Multiply by `amp * exp(-t / tau)`.
- `tone(d, sr, t0, f, tau, amp)`: a sine with a 2ms linear attack, multiplied by `exp(-t / tau)`.

**Typewriter profile** (`k` = variant index, 0..5)

| kind | parts | length | norm |
|---|---|---|---|
| key (6 variants) | click(0, .0010, .9, .85) + thump(0, 190+10k, 120, .018, .45) + click(.007+.0015k, .0035, .7, .5) | .08s | .9 |
| space (2 variants, jitter the second click ±.002) | click(0, .0012, .5, .6) + thump(0, 130, 80, .035, .7) + click(.014, .006, .5, .25) | .12s | .9 |
| enter | 7 clicks at t = .02·i ± .003, amp .35→.15, tau .0012, a .9; then at .17s: thump(.17, 150, 90, .03, .8) + click(.17, .004, .8, .5) | .30s | .9 |
| back (2 variants) | click(0, .0008, .45, .9) + thump(0, 300, 220, .008, .2) | .05s | .7 |

**Soft profile**

| kind | parts | length | norm |
|---|---|---|---|
| key (6 variants) | click(0, .004, .8, .18) + thump(0, 240+12k, 170, .012, .55) | .06s | .8 |
| space | click(0, .006, .7, .12) + thump(0, 170, 110, .02, .7) | .09s | .8 |
| enter | click(0, .006, 1, .12) + thump(0, 150, 100, .028, .9) | .10s | .85 |
| back | click(0, .003, .6, .25) + thump(0, 300, 240, .008, .3) | .05s | .6 |

**Shared sounds**

| kind | parts | length | norm |
|---|---|---|---|
| bell | tone(0, 1850, .6, 1) + tone(0, 4410, .25, .35) + tone(0, 5920, .12, .15) + click(0, .001, .3, .9) | 1.3s | .5 |
| coin | tone(0, 1568, .08, .6) + tone(.045, 2093, .12, .6) | .30s | .45 |

The **coin** sound plays when a Cut, a suggestion, or an AI edit saves money in Edit mode. It never plays for plain backspacing.

The **Test** button in Settings plays key, key, space, key, enter, 90ms apart.

Nobody can hear the result in your test environment. Just make sure there are no console errors and that `TDW.Sound.ctx.state === 'running'` after a keypress.

---

## 10. Storage (`js/store.js`)

Wrap every localStorage call in try/catch. If storage isn't available, keep everything in an in-memory Map and show a toast once (section 14).

| key | value |
|---|---|
| `tdw.index` | JSON array of `{id, title, words, budget, updatedAt}` |
| `tdw.draft.<id>` | JSON `{id, text, budget, peakWords, createdAt, updatedAt, intent}` |
| `tdw.settings` | JSON settings (merge with defaults on read: `{...DEFAULTS, ...saved}`, and `highlights` merged the same way) |
| `tdw.geminiKey` | string |
| `tdw.geminiModel` | string such as `models/gemini-2.5-flash` |
| `tdw.last` | id of the last opened draft |
| `tdw.lastBackup` | ms timestamp |
| `tdw.hintShown` | `'1'` |

The settings defaults are `{ skin: 'typewriter', sound: 'typewriter', volume: 0.35, typewriterScroll: true, textSize: 0, defaultBudget: 2000, highlights: { veryHard: true, hard: true, complex: true, passive: true, adverb: true, qualifier: true } }`.

**API**
```
TDW.Store = {
  listDrafts(), getDraft(id), saveDraft(draft) -> boolean, deleteDraft(id), newDraft({ text = '', budget }) -> draft (saved),
  getSettings(), saveSettings(s), getKey(), setKey(k), clearKey(), getModel(), setModel(m),
  getLast(), setLast(id), exportAll(), importAll(obj) -> number, getLastBackup(), setLastBackup(ts)
}
```

- **Draft ids:** `'d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`.
- **Draft titles:** take the first non-empty line, strip any leading `#` characters, and trim. If it's over 60 characters, cut it to 57 and add `…`. If it's empty, use "Untitled draft".
- **saveDraft** writes the draft key and updates its index entry (title, words, budget, updatedAt). It returns false on `QuotaExceededError`.
- **exportAll** returns `{ app: 'ten-dollar-words', schema: 1, exportedAt, drafts: [...] }`.
- **importAll** checks `app === 'ten-dollar-words'` and merges by id: a draft is added when missing, and replaces the existing one when the incoming `updatedAt` is newer. It returns how many drafts it added or updated.
- After the first successful save, call `navigator.storage?.persist?.()` once and ignore the result.

---

## 11. AI (`js/ai.js`, `js/ai-mock.js`)

### 11.1 The Gemini client

- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/`.
- **Headers:** `{'Content-Type': 'application/json', 'x-goog-api-key': key}`.
- **Connect / test** (`AI.connect(key)`)
  - `GET v1beta/models?pageSize=200`. Keep models whose `supportedGenerationMethods` includes `generateContent` and whose `name` contains `gemini`.
  - `pickModel(names)` excludes names matching `/(lite|image|tts|audio|live|embedding|vision|8b|thinking|learnlm|gemma|aqa|nano|robotics|computer|native)/i`, then keeps names containing `flash`. From those, prefer stable names (no `preview` or `exp`) and take the highest version, parsed from `/gemini-(\d+(?:\.\d+)?)/`. If there are no stable names, use the highest preview. If there's nothing at all, fall back to `models/gemini-2.5-flash`.
  - On success, save the key and model and return `{ model, models }`. The models list fills the Settings dropdown, sorted by name.
- **Generate:** `POST v1beta/${model}:generateContent`, where `model` already includes the `models/` prefix. The body is:
  ```json
  { "systemInstruction": { "parts": [{ "text": SYSTEM }] },
    "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
    "generationConfig": { "temperature": T, "responseMimeType": "application/json", "responseSchema": SCHEMA } }
  ```
  Join `candidates[0].content.parts[].text`, skipping parts with `thought: true`. Strip any ```` ``` ```` fences, then `JSON.parse`. If that fails, parse from the first `{` to the last `}`. If that fails too, reject with `bad_json`.
- **Errors** reject with `{ code, message }`. Use `fetch` with the caller's `AbortSignal` and add no timeout of your own.
  - A network `TypeError` gives `offline`.
  - An `AbortError` gives `cancelled`.
  - A 400 whose message mentions the API key gives `bad_key`, and so do 401 and 403.
  - 404 gives `bad_model`, 429 gives `rate_limited`, and 500 or above gives `busy`.
  - Having no candidates gives `blocked`. Any other 400 gives `error`, carrying `body.error.message`.
- **Validate the output:**
  - Options: keep only entries with non-empty text, at most 3.
  - Edits: keep only non-empty `find` values, at most 12.
  - Message: coerce missing strings to `''` and a missing array to `[]`.

**SYSTEM**
```
You are a sharp line editor. The writer pays $10 for every word, so shorter is better, but never at the cost of meaning. Their style: plain, direct, conversational American English; short sentences; concrete words; no clichés, corporate filler, hype, or em dashes. Keep the writer's facts and voice. Never invent claims. Reply only with JSON that matches the schema.
```

**Schemas** (Gemini uses uppercase type names)
```js
const OPTIONS = { type: 'OBJECT', properties: { options: { type: 'ARRAY', items: { type: 'OBJECT',
  properties: { text: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['text', 'note'] } } }, required: ['options'] };
const TIGHTEN = { type: 'OBJECT', properties: { summary: { type: 'STRING' }, edits: { type: 'ARRAY', items: { type: 'OBJECT',
  properties: { find: { type: 'STRING' }, replace: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['find', 'replace', 'why'] } } },
  required: ['summary', 'edits'] };
const MESSAGE = { type: 'OBJECT', properties: {
  takeaway: { type: 'STRING' }, verdict: { type: 'STRING', enum: ['clear', 'mixed', 'unclear'] },
  match: { type: 'STRING', enum: ['yes', 'partly', 'no', 'none'] }, why: { type: 'STRING' },
  offMessage: { type: 'ARRAY', items: { type: 'OBJECT', properties: { quote: { type: 'STRING' }, reason: { type: 'STRING' } }, required: ['quote', 'reason'] } },
  strongerOpening: { type: 'STRING' }, strongerEnding: { type: 'STRING' } },
  required: ['takeaway', 'verdict', 'match', 'why', 'offMessage', 'strongerOpening', 'strongerEnding'] };
```

**Features.** Each takes `(input, signal)` and returns validated JSON. Every one goes through `run(feature, input, signal)`, which calls `TDW.AIMock.respond(feature, input, signal)` when `TDW.mockAI` is true.

1. `simplify({ sentence, paragraph })` uses temperature .7 and the OPTIONS schema:
   ```
   Rewrite the sentence below so it is easier to read. Aim for fewer than 20 words and a grade 6 to 8 reading level. You may split it into two sentences. Keep every fact and the writer's voice.

   PARAGRAPH:
   <<<
   {paragraph}
   >>>

   SENTENCE:
   <<<
   {sentence}
   >>>

   Give 3 options, shortest first. Each note says what changed in 3 to 6 words.
   ```
2. `activeVoice({ sentence, paragraph, phrase })` uses temperature .7 and OPTIONS:
   ```
   The sentence below uses passive voice ("{phrase}"). Rewrite it in active voice so the doer comes first. If the doer isn't named, use the natural one from context or restructure the sentence. Keep the meaning and the writer's voice.

   PARAGRAPH:
   <<<
   {paragraph}
   >>>

   SENTENCE:
   <<<
   {sentence}
   >>>

   Give 2 options, shortest first. Each note says what changed in 3 to 6 words.
   ```
3. `tighten({ text })` uses temperature .3 and TIGHTEN. `text` is at most 60,000 characters; truncate it, and if you do, tell the user through the results note.
   ```
   Every word in this text costs $10. Find cuts that save money without losing meaning, facts, or the writer's personality.

   Rules:
   - Each edit replaces an exact quote from the text with something shorter, or deletes it (empty replace).
   - "find" must be copied character for character from the text, 1 to 30 words long, and must appear only once.
   - Go after filler, hedges, throat-clearing, repetition, and wordy phrases.
   - Leave quotes from other people unchanged.
   - At most 12 edits, biggest savings first.

   TEXT:
   <<<
   {text}
   >>>
   ```
4. `messageCheck({ text, intent })` uses temperature .4 and MESSAGE:
   ```
   Judge whether this draft gets its message across to a busy reader.
   {intent ? 'The writer says the message is:\n<<<\n' + intent + '\n>>>' : 'The writer did not say what the message is.'}

   DRAFT:
   <<<
   {text}
   >>>

   Fill every field:
   - takeaway: the one thing a busy reader would remember, in one sentence of 25 words or fewer.
   - verdict: "clear", "mixed", or "unclear".
   - match: if the writer stated a message, "yes", "partly", or "no"; otherwise "none".
   - why: one or two sentences explaining the verdict.
   - offMessage: up to 3 sentences copied exactly from the draft that pull away from the message, each with a reason of 10 words or fewer.
   - strongerOpening: a sharper first line in the writer's voice, or "" if the current one works.
   - strongerEnding: a sharper last line in the writer's voice, or "" if the current one works.
   ```

Also export:
- `AI.status()`: `'mock'` if `TDW.mockAI`, `'ready'` if a key is saved, otherwise `'none'`.
- `AI.errorMessage(err)`: the error copy from section 14.
- `AI.disconnect()`: clears the key and model.

### 11.2 The mock (`ai-mock.js`)

`TDW.AIMock.respond(feature, input, signal)` waits 700ms and rejects `{ code: 'cancelled' }` if the signal aborts.

| feature | response |
|---|---|
| `simplify` | `{ options: [{ text: first 10 words of input.sentence + '.', note: 'Cut the second half' }, { text: 'A shorter take on the same point.', note: 'Rewritten from scratch' }] }` |
| `activeVoice` | `{ options: [{ text: 'The team wrote it.', note: 'Doer comes first' }] }` |
| `tighten` | For each of `' really'`, `' very'`, `' just'`, `'in order to'`, `'I think '` found in input.text (at most 4), add an edit: find it; replace it with `'to'` for `'in order to'`, otherwise `''`; why is `'Filler'`. Summary: `'Mock edits: filler words.'` |
| `messageCheck` | `{ takeaway: 'Cut words and your writing gets clearer.', verdict: 'mixed', match: input.intent ? 'partly' : 'none', why: 'Mock answer for testing.', offMessage: [{ quote: <first sentence of input.text>, reason: 'Mock reason' }], strongerOpening: 'Every word costs you.', strongerEnding: 'Cut one more word.' }` |
| connect | `{ model: 'models/mock-flash', models: ['models/mock-flash'] }`, with no network call |

`app.js` sets `TDW.mockAI = new URLSearchParams(location.search).has('mock')` and shows `#mock-badge` when it's true.

---

## 12. Behavior and wiring

### 12.1 State (in `app.js`)

`{ mode, draft, analysis, words, dirty, settings, aiBusy, cycle: { type, index } }`, plus `APP_VERSION = '1.0.0'`.

### 12.2 Boot

1. Load settings and apply them. Set `html[data-skin]`. Set `--text-offset` to `textSize + 'px'`. Set the theme-color meta to `--paper` in Write mode or `--desk` in Edit mode, read with getComputedStyle. Start Sound with the settings.
2. Pick a draft: the one with id `Store.getLast()`, otherwise the newest in the index, otherwise `Store.newDraft({ budget: settings.defaultBudget })`. Load it with `Editor.setText`. `state.words = Engine.countWords(text)`.
3. Set the mode to `write` and focus the editor.
4. Wire all the events (12.3).
5. If `tdw.hintShown` isn't set, show the first-run toast and set the flag.
6. If the protocol is `https:`, register the service worker `sw.js`.
7. `document.fonts.ready.then(() => Editor.render())`.

### 12.3 Events

- **`editor keydown`:** play the sound first (section 9). Then, in Write mode, hide the chrome and add `html.is-typing`.
- **`editor input`:**
  - `text = editor.value`; compute `words` and the change since last time; `peakWords = max(...)`.
  - Mark the draft dirty, clear any pending save timer, and schedule a save in 600ms.
  - Hide the popover.
  - In Edit mode: if `text.length < 15000`, run `analyze` and render at once, otherwise debounce it by 150ms. Then update the panel, show the refund chip when words dropped, and check the budget bell.
  - In Write mode: in one requestAnimationFrame, run `Editor.render()`, and if `settings.typewriterScroll` is on, `Editor.typewriterScroll()`.
- **`editor click`, and `keyup` of arrow, Home, End, PageUp, PageDown:** in Edit mode, with a collapsed selection, call `Popover.showAt(caretIndex)`. In Write mode with typewriter scrolling on, run `typewriterScroll()` in rAF.
- **`beforeinput`:** the phone sound fallback (section 9).
- **`document keydown`:**
  - Cmd/Ctrl+E: `preventDefault` and toggle the mode.
  - Cmd/Ctrl+S: `preventDefault`, save now, and show the toast "Saved".
  - Escape: close the popover, the budget form, or the panel sheet (whichever is topmost). Dialogs close natively.
- **`document mousemove`:** remove `is-typing`. In Write mode, show the chrome.
- **`visibilitychange`** (becoming hidden) and **`pagehide`:** save now.
- **`storage` event** on `tdw.index`: re-render the drafts list if it's open.
- **Buttons:**
  - The mode buttons call `setMode`.
  - Copy uses `navigator.clipboard.writeText(text)`, then the toast "Copied". If that fails, select all text in the editor and show the toast "Press ⌘C to copy".
  - Full screen uses `document.documentElement.requestFullscreen()` or `exitFullscreen()`. The label toggles between "Full screen" and "Exit full screen", and the button is hidden if `!document.fullscreenEnabled`.
  - Drafts and Settings open their dialogs.
  - `#btn-sample`: if the draft is empty, insert `SAMPLE_TEXT` with `replaceRange(0, 0, SAMPLE_TEXT)`. Otherwise create a new draft containing it.

### 12.4 setMode(m)

- Set `html.dataset.mode`. Set `editor.spellcheck = (m === 'edit')`. Set `aria-pressed` on the mode buttons. Set the theme-color meta.
- **Edit:** `analysis = Engine.analyze(text)`, then `Editor.setMarks(sentenceIssues, wordIssues)`, `Editor.setHidden(the hidden types)`, `Editor.render()`, and `Panel.render()`.
- **Write:** `Editor.setMarks([], [])`, `Editor.render()`, hide the popover, close the mobile sheet and the AI results view.
- Then, in rAF, `Editor.scrollToIndex(caret, m === 'write' ? 0.45 : 0.35)` and `editor.focus({ preventScroll: true })`.

### 12.5 Panel (`panel.js`)

- **`Panel.render(analysis, draft, words)`** updates the register (section 8), the grade, the fix rows, the stats, the AI note, and the mobile summary.
  - **Grade:** with no words, show "Grade —" and hide the pill. Otherwise show "Grade N" and a pill with `gradeLabel`, using the class for good, ok, or bad.
  - **Fix rows**, in this order: veryHard, hard, complex, passive, adverb, qualifier. Each row is:
    ```html
    <li class="issue-row" data-type="…">
      <button class="issue-jump" type="button"><span class="swatch sw-TYPE"></span><span class="issue-text">…</span></button>
      <button class="issue-eye" type="button" aria-pressed="true|false" aria-label="Hide …|Show …">eye icon</button>
    </li>
    ```
    - The swatch is 12×12 with radius 3, a background of the highlight color, and `box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 12%, transparent)`. The qualifier swatch is instead a dotted 2px bottom border in `--hl-qualifier`.
    - Rows with a count of 0 show the zero copy at `opacity: .55`, and clicking their jump button does nothing.
    - Build the row text with elements, putting the count in `<b>`.
  - **Empty draft:** hide `#issue-list` and show `#issues-empty`.
  - **Jump:** go to the next issue of that type whose start is after the caret, wrapping around to the first. Then `Editor.select(start, end)` and `Popover.show(issue)`.
  - **Eye:** toggles `settings.highlights[type]`, saves the settings, and calls `Editor.setHidden`.
  - **Stats line:** "{w} words · {c} characters · {s} sentences · {p} paragraphs · {m} min read", where `c = text.length` and `m = max(1, round(sec / 60))`. Leave it empty when there are no words.
  - **AI note:** in `none` status it reads "Connect Gemini in Settings to use AI help." and both AI buttons open Settings, scrolled to the AI section. Otherwise the note is empty, and the buttons are disabled while a request is running or when the text is empty.
  - **Mobile summary:** "{$spent} of {$budget} · Grade {g} · {n} fixes", where n is the number of word-level issues plus hard and very hard sentences.
- **AI results view.** Hide `#issues`, `#ai-desk`, and `#stats`, and show `#ai-results`. Back reverses that and aborts any request still running.
  - **Loading** shows "Thinking…" and a Stop button (`btn-quiet`) wired to an AbortController.
  - **Errors** show the error copy and a "Try again" button.
  - **Cut the cost:**
    - If the selection is longer than 20 characters, send the selection only. Otherwise send the whole text.
    - Show the summary. Then an "Apply all · saves $X" button, where X is the sum of the valid edits.
    - Then one row per edit: the original in the writing font with a line through it, the replacement (or "cut"), the `why`, a savings badge "−$N" in `--saved`, and an Apply button.
    - **Apply:** find `idx = text.indexOf(find)`. If it's -1, the row reads "Text changed. Skipped." and is disabled.
    - If `replace` is empty, use `cutPlan`, with `sentenceStart` taken from the sentence containing `idx` in a fresh `analyze`. Otherwise use `replaceRange(idx, idx + find.length, replace)`.
    - Savings per edit are `(countWords(find) - countWords(replace)) * 10`. Drop edits that save 0 or less before rendering.
    - After applying, mark the row "Applied" and play the coin sound.
    - If no edits are left, show "Nothing to cut. It's tight already."
  - **Check the message:**
    - First show a small form: a label "What should readers take away? (optional)", a textarea (3 rows, prefilled from `draft.intent`), and a Check button. Save the intent to the draft on submit.
    - Then show the result:
      - "Readers will take away" with the takeaway in the writing font at 17px.
      - A verdict pill: Clear uses `--good`, Mixed uses `--ok`, Unclear uses `--bad`.
      - If `match !== 'none'`, the line "Matches what you meant: Yes / Partly / No".
      - The `why` text.
      - An "Off message" list, where clicking a quote selects it in the editor if found (`indexOf`).
      - "Sharper opening" and "Sharper ending", each with its text and a button, "Use as opening" or "Use as ending". These replace the first or last sentence range from a fresh `analyze`, then play the coin sound if words went down.

### 12.6 Popover (`popover.js`)

- **`Popover.showAt(index)`** finds the smallest word-level issue with `start <= index <= end`. If there isn't one, it finds a hard or very hard sentence containing the index. Then it calls `show(issue)`, or hides the popover.
- **`Popover.show(issue)`** fills the popover, adds `.is-active` to `[data-id]` in the backdrop, and positions it under `Editor.markRect(issue.id)`:
  - `top = rect.bottom + 8`, `left = clamp(rect.left, 16, innerWidth - width - 16)`.
  - If it would overflow the bottom, place it at `rect.top - height - 8` instead.
  - Reposition it on scroll and resize while it's open.
- **It hides** on input, on Escape, on a click outside both the popover and the editor, and on a mode change.
- **Content:** a title row with the swatch, the title, and a close button; the message; then the actions (copy in section 14).
  - **adverb:** a "Cut it · saves $10" button that applies `cutPlan` through `replaceRange` and plays the coin sound.
  - **qualifier:** the same, with "Cut it · saves $N", where N comes from `countWords(issue.text) * 10`.
  - **complex:**
    - Split the suggestion on `", "` into chips. Each chip's text is `matchCase(issue.text, alt)` and it applies `replaceRange` with that.
    - Each chip shows its money effect: "saves $N", "same cost", or "costs $N more", based on the word-count difference.
    - An empty suggestion gives a single "Cut it · saves $N" button instead.
  - **hard / veryHard:** a "Simplify with AI" button. **passive:** a "Rewrite with AI" button. Both disabled with the note "Connect Gemini in Settings" when there's no key and no mock.
    - Clicking shows "Thinking…" and a Stop button. The request sends the sentence text (for passive, the sentence containing the phrase) and its paragraph, meaning the line that contains it.
    - The results are a list of options. Each is shown on a `--paper` background in the writing font at 15px, with a meta line ("{n} words · saves $X", "same cost", or "costs $X more") and a "Use this" button.
    - Use this: if the current text at the sentence's saved range still equals the original sentence, replace that range. Otherwise try `indexOf(original)`. If that fails too, show the toast "That sentence changed. Run it again." Play the coin sound if words went down.

### 12.7 Dialogs (`dialogs.js`)

- **Drafts drawer.** It has a head with "Drafts" and a close button, a "New draft" button, a list, and a footer with the backup note, "Last backup: {date or never}", and the "Download backup" and "Restore backup" buttons.
  - Each row has an open button containing the title and a meta line "{relative time} · {words} words · ${spent}", plus quiet actions: Copy, Download, Delete. Mark the current draft's row with `.is-current`.
  - **Delete** swaps in an inline confirm: "Delete this draft?" with a Delete button (`danger`) and a Keep button.
    - After deleting, show the toast "Draft deleted" with an Undo button that saves the stored copy back.
    - If the deleted draft was open, open the newest remaining draft, or create a new one.
  - **Open:** save the current draft first, then `setText`, `Store.setLast`, and close the drawer.
  - **New:** save the current draft, create a new one with the default budget, open it, and switch to Write mode.
  - **Download** (a row action, or a backup) builds a Blob, an object URL, and an `<a download>` link, clicks it, and revokes the URL. A draft downloads as `{slug}.md`. A backup downloads as `ten-dollar-words-backup-YYYY-MM-DD.json`, then calls `setLastBackup(now)`.
  - **Restore:** `#restore-input` reads the file and runs `importAll`, then shows the toast "Restored {n} drafts". A bad file gives "That file isn't a Ten-Dollar Words backup."
- **Settings** (every change applies live and saves at once):
  - **Look:** 3 skin cards in a radiogroup. Each card has its own `data-skin`, a sample "Aa" in its writing font on its `--paper`, a 10px `--accent` dot, the name, and a one-line description.
  - **Sound:** a segmented Typewriter / Soft keys / Off control, a volume slider, and a Test button.
  - **Writing:**
    - A typewriter-scrolling checkbox labeled "Keep the line you're typing in the middle (Write mode)".
    - A text-size slider from -2 to 4 that updates `--text-offset` and re-renders the editor.
    - The line "Shortcuts: ⌘E or Ctrl+E switches Write and Edit. Esc closes panels."
  - **Budget:** "Default budget for new drafts", a $ number input with a minimum of 10.
  - **AI help (Gemini):**
    - Help text with a link, `<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get a free key at Google AI Studio</a>`.
    - A password input, a "Save and test" button, a status line, a model `<select>` that saves on change, and a "Remove key" button (`danger`).
    - The privacy note.
  - **Footer:** "Ten-Dollar Words · version {APP_VERSION}".

`relTime(ts)`:
- Under a minute: "just now".
- Under an hour: "{m} min ago".
- Under a day: "{h} h ago".
- Under two days: "yesterday".
- Otherwise the date, as `toLocaleDateString('en-US', {month: 'short', day: 'numeric'})`, plus the year when it isn't the current year.

`money(n) = '$' + Math.round(n).toLocaleString('en-US')`.

---

## 13. PWA and deploy prep

- **`manifest.webmanifest`**
  - `name` "Ten-Dollar Words", `short_name` "$10 Words", and `description` "A writing app where every word costs $10."
  - `start_url` "./", `scope` "./", `display` "standalone", `background_color` "#fffdf6", `theme_color` "#fffdf6".
  - `icons`: 192 and 512 PNG, a 512 maskable PNG (`"purpose": "maskable"`), and the SVG with `"sizes": "any"`.
- **`icons/icon.svg`**
  ```svg
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="112" fill="#d6d2b8"/>
    <circle cx="256" cy="256" r="172" fill="#1e1c17"/>
    <circle cx="256" cy="256" r="150" fill="#fffdf6"/>
    <text x="256" y="298" text-anchor="middle" font-family="'Courier New', Courier, monospace" font-weight="700" font-size="124" fill="#c81f14">$10</text>
  </svg>
  ```
  `icon-maskable.svg` is the same image without `rx`.
- **PNGs.** Try `qlmanage -t -s 512 -o <scratch dir> icons/icon-maskable.svg` first. If it doesn't work, try `sips -s format png icons/icon-maskable.svg --out ...`. Then use `sips -Z 192` and `sips -Z 180` for the smaller sizes. The PNGs are full-bleed squares with no transparency, made from the maskable SVG.
  - Look at the 512 PNG with the Read tool. It must show the keycap with "$10" centered, and no white border.
  - If neither tool can render the SVG, ship SVG icons only, remove the PNG entries and the apple-touch-icon link, and report it.
- **`sw.js`**
  - `const VERSION = 'tdw-1.0.0'` (it must match `APP_VERSION`).
  - Precache `./`, `index.html`, `manifest.webmanifest`, `css/app.css`, every `js/*.js` file, and every icon.
  - The fetch handler covers:
    - Only GET requests; ignore everything else.
    - Never touch `generativelanguage.googleapis.com`.
    - Google Fonts hosts are cache-first, in a cache named `tdw-fonts`.
    - Same-origin requests are network-first: update the cache on success, and on failure fall back to the cache, then to the `./` entry.
  - `install` precaches and calls `skipWaiting`. `activate` deletes old caches (every cache except `VERSION` and `tdw-fonts`) and calls `clients.claim()`.
- **`_headers`** (Netlify)
  ```
  /*
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://generativelanguage.googleapis.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: blob:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  /sw.js
    Cache-Control: no-cache
  ```

---

## 14. UI copy (use exactly)

**Chrome, editor, and toasts**
- Placeholder: "Start typing. Every word costs $10."
- First-run toast: "Press ⌘E (Ctrl+E on Windows) or click Edit to see your spend and fixes."
- Save status (Edit mode only):
  - "Saving…" while a save is pending.
  - "Saved" for 2 seconds after a save, then empty.
  - "Not saved: storage is full" on quota errors, which also triggers the toast "Storage is full. Download a backup and delete old drafts."
- When storage is unavailable, toast: "This browser won't let the app save. Copy your text before you close it."
- Other toasts: "Copied", "Press ⌘C to copy", "Saved", "Restored {n} drafts", "That file isn't a Ten-Dollar Words backup.", "Draft deleted" with "Undo", "That sentence changed. Run it again."

**Register**
- "Spent", "of $X budget", "$X left", "Over by $X", "Saved $X by cutting", "Over budget".

**Fix rows** (with singular forms where noted)

| type | n > 0 | n = 1 | n = 0 |
|---|---|---|---|
| veryHard | "{n} of {total} sentences are very hard to read." | "1 of {total} sentences is very hard to read." | "No very hard sentences." |
| hard | "{n} of {total} sentences are hard to read." | "1 of {total} sentences is hard to read." | "No hard sentences." |
| complex | "{n} phrases have simpler options." | "1 phrase has a simpler option." | "No wordy phrases." |
| passive | "{n} uses of passive voice. Aim for {t} or fewer." | "1 use of passive voice. Aim for {t} or fewer." | "No passive voice." |
| adverb | "{n} adverbs. Aim for {t} or fewer." | "1 adverb. Aim for {t} or fewer." | "No adverbs." |
| qualifier | "{n} weakeners. Cut them to sound sure." | "1 weakener. Cut it to sound sure." | "No weakeners." |

**Popover titles and messages**

| type | title | message |
|---|---|---|
| veryHard | Very hard to read | "Readers will lose the thread. Split it or cut it." |
| hard | Hard to read | "Shorten it or split it in two." |
| complex | Wordy | "Try:" (or "Cut it." when the suggestion is empty) |
| passive | Passive voice | "Say who did what." |
| adverb | Adverb | "Cut it, or pick a stronger verb." |
| qualifier | Weakener | "Say it like you mean it." |

- Popover buttons: "Cut it · saves $N", "Simplify with AI", "Rewrite with AI", "Use this", "Stop".
- AI state copy: "Thinking…", "Connect Gemini in Settings".

**AI help panel**
- Buttons: "Cut the cost" and "Check the message".
- Note: "Connect Gemini in Settings to use AI help."
- Results controls: "← Back", "Apply all · saves $X", "Apply", "Applied", "Text changed. Skipped.", "Nothing to cut. It's tight already.", "Try again".
- Message-check copy: "What should readers take away? (optional)", "Check", "Readers will take away", "Clear", "Mixed", "Unclear", "Matches what you meant:", "Yes", "Partly", "No", "Off message", "Sharper opening", "Sharper ending", "Use as opening", "Use as ending".

**AI errors**

| code | message |
|---|---|
| no_key | "Add your Gemini key in Settings first." |
| bad_key | "Gemini rejected the key. Check it in Settings." |
| bad_model | "That model isn't available. Pick another in Settings." |
| rate_limited | "Gemini's free limit is used up for now. Try again in a minute." |
| busy | "Gemini is overloaded. Try again shortly." |
| offline | "You're offline. AI help needs internet." |
| blocked | "Gemini declined this text." |
| bad_json | "Gemini sent a garbled answer. Try again." |
| error | "Something went wrong: {message}" |

**Drafts drawer**
- "Drafts", "New draft", "Untitled draft", "Copy", "Download", "Delete", "Delete this draft?", "Keep".
- Footer: "Drafts live in this browser only. Back up now and then.", "Last backup: {date}" or "Last backup: never", "Download backup", "Restore backup".

**Settings**
- Title "Settings". Sections: "Look", "Sound", "Writing", "Budget", "AI help (Gemini)".
- Skins:
  - "Typewriter": "Putty and ribbon ink."
  - "Ditto": "Purple ink on lilac, like old school handouts."
  - "Night desk": "Dark navy with mustard light."
- Sound: "Typing sound" with "Typewriter", "Soft keys", "Off"; then "Volume" and "Test".
- Writing: "Keep the line you're typing in the middle (Write mode)", "Text size".
- Budget: "Default budget for new drafts".
- AI:
  - Labels: "API key", "Save and test", "Model", "Remove key".
  - Status: "Connected. Using {model name without models/}." or the error message.
  - Help: "Paste a Gemini API key. It stays in this browser and is only sent to Google." followed by the link.
  - Privacy: "On Google's free tier, Google may use what you send to improve its products. Keep private client work out, or use a paid key."

**Sample text** (constant `SAMPLE_TEXT` in `app.js`)
```
Every word you type costs ten dollars. That sounds harsh, but it is really the fastest way to learn to cut.
Most people write long sentences because they are afraid that short ones will make them look simple to readers.
This sentence is here to show you what happens when a writer keeps adding clauses and qualifications that the reader has to hold in their head while they wait for the point, which arrives much too late.
The report was written by a committee in order to utilize every possible word.
I think you already know what to do. Delete what doesn't earn its keep and watch the register quietly drop.
```

---

## 15. Build order

Do the milestones in order. Each one ends with its check; fix before moving on.

**M0. Setup**
- Create `.claude/launch.json` in the working directory, or merge into it if it already exists:
  ```json
  { "version": "0.0.1", "configurations": [ { "name": "ten-dollar-words", "runtimeExecutable": "python3",
    "runtimeArgs": ["-m", "http.server", "8765", "--bind", "127.0.0.1", "--directory", "apps/ten-dollar-words/app"], "port": 8765 } ] }
  ```
- Verify the four font URLs (4.2).
- Check: every font URL returns 200, or its fallback is chosen.

**M1. Engine**
- Write `engine.js`.
- Check: `node --test apps/ten-dollar-words/tests/engine.test.js` passes every test.

**M2. Shell, layout, and editor**
- Write `index.html`, `app.css` (all tokens, both modes, desktop and phone), `editor.js`, and a minimal `app.js` with mode switching, chrome auto-hide, and typewriter scroll. Also `ui.js` basics (el, toast, money).
- Check in the browser:
  - Typing works.
  - Write mode shows only text.
  - Cmd/Ctrl+E toggles the mode.
  - Typewriter scroll keeps the caret line at 45% ± 5% of the viewport after about 40 lines.
  - No console errors.

**M3. Storage and drafts**
- Write `store.js`, the Drafts drawer, autosave, backup/restore, Copy, and Download.
- Check: a reload restores the text and the draft. New and switch work. Delete with Undo works.

**M4. Edit mode**
- Write `panel.js` (register, grade, fixes, stats) and `popover.js` without AI. Wire the highlights and the hide toggles.
- Check:
  - The sample text shows all 6 highlight types, and the counts match.
  - Highlights line up with the words, including wrapped lines.
  - Cut, chips, jump, and budget all work.
  - Cmd/Ctrl+Z undoes a Cut.

**M5. Sound**
- Write `sound.js` and the sound settings.
- Check: no errors, and `TDW.Sound.ctx.state === 'running'` after typing.

**M6. AI**
- Write `ai.js`, `ai-mock.js`, the Settings AI section, the popover AI actions, and the AI results views.
- Check: at `?mock=1`, all four features work end to end, including Stop, Apply, Apply all, and the Use buttons.

**M7. PWA**
- Write the manifest, icons, `sw.js`, and `_headers`.
- Check: the manifest parses (`JSON.parse`), the icons exist, and `sw.js` has no syntax errors (`node --check app/sw.js`).

**M8. Polish**
- **Subtraction pass:** remove anything decorative that isn't in this plan, any duplicate labels, and any leftover `console.log` calls.
- **Accessibility pass:** focus rings on everything, labels on inputs, dialogs that close with Esc, and reduced motion respected.
- Write `README.md` (section 16).

## 16. Final check and report

**Smoke test.** Run it in the built-in browser.
- Start the server with `preview_start` using the name `ten-dollar-words`, then open `http://127.0.0.1:8765/?mock=1`.
- Drive the page with `computer` (type, key, click), and verify with `javascript_tool` or `read_page`.
- Take no more than 8 screenshots in total.
- Reset the viewport with `resize_window` preset `desktop` when you're done.

1. The page loads with no console errors, and `document.fonts.check('19px "Courier Prime"')` is true.
2. In Write mode, type a few sentences. Only the text is visible, and there's no budget anywhere.
3. Switch to Edit. The register shows words × $10, and the grade and stats are correct.
4. Load the sample into a new draft. All 6 highlight types appear. **Screenshot** this; the highlights must sit exactly behind their words.
5. Click inside "utilize". The popover shows the chip "use · same cost". Click it, and the text changes. Cmd/Ctrl+Z brings back "utilize".
6. Cut an adverb. The register drops $10, and a refund chip appears.
7. Run "Simplify with AI" on the very hard sentence, then Use this. The sentence is replaced.
8. Run "Cut the cost" and "Apply all". The text changes, and the savings add up.
9. Run "Check the message", then "Use as opening". The first sentence is replaced.
10. Set the budget to $100 and type past it. The stamp shows and the register turns red.
11. Switch to each of the 3 skins in Edit mode. Take one screenshot each at scale 0.5.
12. At the phone size (`resize_window` preset `mobile`), Edit mode shows the bottom sheet and it expands. `document.documentElement.scrollWidth <= innerWidth`. **Screenshot**.
13. Reload. The last draft and its text come back.
14. Run `node --test` once more.

**`README.md`** is short and plain, written for Chris and for future Claude sessions:
- what the app is,
- how to run it locally (the Run button on the launch config, or `python3 -m http.server 8765 --directory apps/ten-dollar-words/app`),
- how to get a Gemini key,
- where drafts live and how to back them up,
- the file map,
- how to ship an update: bump `APP_VERSION` and `VERSION` in `sw.js` together,
- the "Later" list from section 17.

**Report back** in under 300 words:
- Status.
- The test summary line.
- A ✓/✗ per smoke-test item.
- Deviations from the plan, with the reason for each.
- Known issues and risks.
- The list of files written.

## 17. Not now

Don't build any of these. List them in the README under "Later":
- Syncing drafts to a folder (Chrome's File System Access).
- Claude as an alternative AI provider.
- Rich text or Markdown rendering.
- Focus mode that dims other sentences.
- A receipt or print view.
- Custom budget presets.
- Sending drafts to Notion.
- Syncing drafts across devices.
- A grammar checker beyond the browser's spellcheck.
- More skins or more sound profiles.
