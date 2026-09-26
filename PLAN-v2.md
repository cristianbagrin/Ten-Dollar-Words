# Ten-Dollar Words v1.1: build plan

For the builder. This is a change plan on top of the working v1.0 app. Read `PLAN.md` for the original design and rules; they all still apply unless this file changes them. Every decision here is final. If something is ambiguous, pick the simplest option that passes the checks, and list it under "Deviations" in your report.

Paths are relative to the working directory (the connected Claude folder). The app lives in `apps/ten-dollar-words/app/`. Never write an absolute path into a file.

## 0. What the owner asked for (short)

1. **Two-way, near-real-time sync** with his Notion database "✍️ Write posts": text, deletions, and properties (Name, Stage, Pillar, Date).
2. **"very tired" → "exhausted".** Suggest one strong word for weak intensifier + adjective pairs, and use AI for any other weak phrase ("really something").
3. **Flag misspelled words** and offer fixes.
4. **Real AI must work.** His screenshot showed the mock answers, because `?mock=1` was in the URL.
5. **A Chinese font** that matches the typewriter style.
6. **Post formats** that make the page look like the final post (Basic, LinkedIn, X, Substack, Instagram, Email), with each platform's limits. Keep it light.
7. **Remove:** Copy, Download, backup and restore, "Aim for grade 9 or lower", "Saved $X by cutting", and "$X left".
8. **Experiment freely** to keep the app light. The owner will judge.

## 1. Already written for you (don't rewrite)

These are done and tested. Use them as they are. Only fix one if a test proves it wrong, and report the fix.

| file | what | tests |
|---|---|---|
| `app/js/notion-map.js` | Notion blocks ↔ draft lines, rich-text splicing that keeps formatting, diff (`planOps`), apply (`applyOps(pageId, entries, lines, ops, api)`), property conversion | `tests/notion-map.test.js` (16 pass) |
| `app/js/spell.js` | `TDW.Spell`: `load(url)`, `init(text)`, `known(w)`, `suggest(w, max)`, `addWord`, `removeWord`, `setPersonal`, `isReady` | `tests/spell.test.js` (5 pass) |
| `app/dict/en-us.txt` | 121k-word US English list (SCOWL). `!`-prefixed lines are valid but never suggested. `LICENSE-SCOWL.txt` sits next to it and must ship with it. | |
| `tools/build-dict.mjs` | regenerates the word list | |
| `app/js/data.js` | now also has `INTENSIFIERS` and `STRONGER` | |
| `tests/engine.test.js` | updated. **5 tests now fail until you change `engine.js`** (section 3) | |

Run all tests with:

```bash
node --test apps/ten-dollar-words/tests/
```

## 2. Global changes

- `APP_VERSION = '1.1.0'` (app.js) and `VERSION = 'tdw-1.1.0'` (sw.js).
- **Cache-busting:** every local `<script src>` and the CSS `<link>` get `?v=1.1.0`.
  - The service worker precaches the URLs without the query.
  - Its offline fallback uses `caches.match(request, { ignoreSearch: true })`.
  - It precaches `dict/en-us.txt` too.
- **Mock AI is test-only.** Delete the `?mock` URL check. `TDW.mockAI` stays false unless a test sets it from JS. Remove `#mock-badge`.
- **Notion base URL:** `TDW.Notion.base` defaults to `https://api.notion.com/v1`. Tests point it at the fake server by setting `localStorage['tdw.notionBase']`, and that key is honored only when `location.hostname` is `127.0.0.1` or `localhost`.
- **CSP in `_headers`:** add `https://api.notion.com` to `connect-src`.
- **Native spellcheck is always off** (`spellcheck=false` in both modes). The app draws its own spelling marks.
- **One source of truth for drafts.** `Store` keeps every draft in an in-memory `Map`, loaded once at boot. `getDraft(id)` returns that same object every time; never a fresh `JSON.parse` copy. The app and sync both mutate it and call `Store.saveDraft(draft)`.
  - A `storage` event for a `tdw.draft.<id>` key reloads that one object in place (`Object.assign`), unless it's the open draft and it's `dirty`.
  - This rule prevents duplicate Notion pages and lost `notionId`s. It's mandatory.

### Removals

- **Chrome:** the Copy button.
- **Drafts drawer:** Copy and Download on rows; "Download backup", "Restore backup", "Last backup"; `#restore-input`; `Store.exportAll`, `Store.importAll`, and `tdw.lastBackup`.
- **Register:** `#reg-left`, `#reg-saved`, and the budget chips. Keep "Spent", the amount, the meter, "of $X budget" (still clickable to edit), and the stamp.
- **Readability:** the hint "Aim for grade 9 or lower."
- **Stats line:** trim it to "{w} words · {m} min read".
- **Budget:** the budget-bell check stays; it's sound, not text.

## 3. Engine (`app/js/engine.js`)

Make every test in `tests/engine.test.js` pass. The changes:

1. **`analyze(text, opts)`.** The new optional `opts.isKnown(lowerWord) → boolean` turns on spelling. Keep `countWords(text)` with one argument.
2. **Mask before analyzing.** Masking replaces characters with spaces of the same length, so offsets stay valid. Run every detection and count on `mask(text)`, but take each issue's `text` from the original.
   ```js
   const OPAQUE_RE = /^⟦[^\n]*⟧[ \t]*$/gm;                                   // Notion blocks shown as ⟦image⟧
   const MARKER_RE = /^[ \t]*(?:[-*•]|\d+[.)]|#{1,3}|>|\[[ xX]\])(?=[ \t])/gm; // list / heading / quote / to-do markers
   const mask = (t) => t.replace(OPAQUE_RE, (m) => ' '.repeat(m.length)).replace(MARKER_RE, (m) => ' '.repeat(m.length));
   ```
   `countWords` counts on `mask(text)`. `splitSentences` (the public function) stays unmasked, but `analyze` splits `mask(text)`.
3. **Intensifier + adjective.**
   - Condition: `WORD_RE` token `i` is in `D.INTENSIFIERS` (lowercase), token `i+1` is in `D.STRONGER` (lowercase), and only `[ \t ]+` sits between them.
   - Result: a candidate `{type: 'qualifier', start: tok[i].start, end: tok[i+1].end, suggestion: D.STRONGER[adj], cut: {start: tok[i].start, end: tok[i].end}}` at priority 5.
4. **Spelling** (only when `opts.isKnown` is given), for each `WORD_RE` token:
   - Skip it if its whitespace-delimited chunk contains `://`, `www.`, `@`, or `#`.
   - Skip it if its length is 1.
   - Skip it if `/[A-Z]/.test(token.slice(1))` (camelCase or ALLCAPS).
   - Skip it if it starts uppercase and isn't the first token of its sentence (a proper noun).
   - Otherwise take `w = lowercase with ’ → '`. It's fine if `isKnown(w)`, or `w` ends in `'s` and `isKnown(w.slice(0, -2))`, or `w` ends in `'` and `isKnown(w.slice(0, -1))`.
   - Anything else becomes `{type: 'spelling', start, end}` at priority 6.
5. **Priorities:** spelling 6, intensifier 5, complex 4, passive 3, qualifier 2, adverb 1. The claim-array overlap rule is unchanged.
6. **Output:** `counts` gains `spelling`, and issues keep `cut` when it's present.

## 4. Spelling in the app

- **Loading:** boot calls `TDW.Spell.load('dict/en-us.txt?v=1.1.0')` without blocking. Then it runs `Spell.setPersonal(settings.dictionary)`, and if the mode is Edit, re-analyzes. `analyze` is called with `{ isKnown: Spell.isReady() ? Spell.known : undefined }`.
- **Highlight:** `.hl-spelling { text-decoration: underline wavy var(--hl-spelling) 1.5px; text-underline-offset: 3px; text-decoration-skip-ink: none; }`.
  - `--hl-spelling`: typewriter `#d0342c`, ditto `#c2185b`, night `#ff6b6b`.
  - `.hide-spelling .hl-spelling { text-decoration: none; }`
- **Fix row:** it comes first in the list, and `settings.highlights.spelling` defaults to true. Copy: "{n} spelling mistakes." / "1 spelling mistake." / "No spelling mistakes." The swatch is a short red wavy underline.
- **Popover:** title "Spelling".
  - Message: "Did you mean:", followed by chips from `Spell.suggest(issue.text)`, each with its money effect (section 12.6 of PLAN.md).
  - A quiet "Add to dictionary" button adds the word to `settings.dictionary`, calls `Spell.addWord`, saves, re-analyzes, and hides the popover.
  - With no suggestions, show "No suggestions." plus "Add to dictionary".
- **Settings → Writing → "Your dictionary":** the added words as small chips, each with × to remove. If the list is empty, show "Words you add show up here."

## 5. Weak phrases

- **Qualifier issue *with* a `suggestion`** (an intensifier pair):
  - Title "Weakener". Message "Try one strong word:" followed by chips. Each chip replaces the whole phrase with `matchCase(issue.text, alt)` and shows its money effect (usually "saves $10").
  - Then "Cut ‘{intensifier}’ · saves $10", which runs `cutPlan` on `issue.cut`.
  - Then "More options (AI)".
- **Qualifier *without* a suggestion, whose text is one of `D.INTENSIFIERS`**, with a following word (`/^[ \t ]+([A-Za-z'’-]+)/` on the text after `issue.end`):
  - Message "Say it like you mean it."
  - "Cut it · saves $10".
  - "Stronger word (AI)", which works on the phrase = intensifier + next word.
- **Other qualifiers:** unchanged.
- **AI feature `stronger({ phrase, sentence })`:** OPTIONS schema, temperature 0.8. The prompt:
  ```
  The phrase "{phrase}" in the sentence below is weak. Suggest replacements for the whole phrase: one strong word, two at most, that says it with more precision in the writer's voice. Each option must fit the sentence when swapped in.

  SENTENCE:
  <<<
  {sentence}
  >>>

  Give 4 options, best first. Each note gives the nuance in 2 to 5 words.
  ```
  Show the options as chips (text plus money effect). Applying one replaces the phrase range if it still matches, otherwise the toast "That sentence changed. Run it again." The mock returns `{ options: [{ text: 'remarkable', note: 'Mock option' }, { text: 'striking', note: 'Mock option' }] }`.

## 6. Real AI (Gemini)

- **`AI.connect(key)`** lists the models as before, then orders the candidates: the chosen best first, then the other flash candidates.
  - For up to 3 of them, it runs a test generate: prompt `Reply with {"ok": true}` and schema `{type:'OBJECT', properties:{ok:{type:'BOOLEAN'}}, required:['ok']}`.
  - The first success saves the key and model and returns `{ model, models }`.
  - `bad_key` stops right away. If everything fails, it throws the first error.
- **Status copy:** "Connected. Using {name}." For errors, show Google's message when there is one ("Something went wrong: …").
- **Settings AI section:** when a key is saved, show "Key saved ••••{last4}" instead of an empty field.

## 7. Chinese text

- **Font links**, one each:
  - `family=Cactus+Classical+Serif`
  - `family=Noto+Serif+TC:wght@400;700`
  - `family=Noto+Sans+TC:wght@400;700`
- **Writing stacks.** Latin fonts come first, so Latin never falls back to a CJK face:
  - typewriter: `"Courier Prime", "Courier New", "Cactus Classical Serif", "Noto Serif TC", "PMingLiU", "Songti TC", monospace`
  - ditto: `"Newsreader", Georgia, "Cactus Classical Serif", "Noto Serif TC", "PMingLiU", "Songti TC", serif`
  - night: `"Atkinson Hyperlegible Mono", "IBM Plex Mono", Menlo, "Noto Sans TC", "PingFang TC", monospace`
- **Check:** type 「每個字值十美元。」 into the typewriter skin. The Ming-style Cactus face should render, and the highlight layer must still line up.

## 8. Post formats

**Data** (`app/js/formats.js`, `TDW.Formats`). One entry per format:

| key | label | budget | limit | fold | extra |
|---|---|---|---|---|---|
| basic | Basic | `settings.defaultBudget` | none | none | |
| linkedin | LinkedIn | 2000 | 3,000 characters | 210 chars or 3 lines, "…see more" | |
| x | X | 500 | 280, weighted | none | overflow highlight |
| instagram | Instagram | 1500 | 2,200 characters | 125 chars or 2 lines, "… more" | 30 hashtags |
| substack | Substack | 8000 | none | none | title field "Title" |
| email | Email | 3000 | none | 90 chars or 2 lines, "Inbox preview ends here" | title field "Subject", 60-character counter |

- **Where it's stored:** `draft.format` (default `'basic'`). It's local only; Notion has no matching property.
- **Picker:** `<select id="format-select" aria-label="Format">` in the chrome, left of Full screen, styled as a quiet pill.
- **Switching format:** if `draft.budget` equals the old format's budget, set it to the new format's budget. Then re-render.
- **Frame markup** (inside `#sheet`, built with `createElement`):
  ```html
  <div id="frame-head" class="frame-head" hidden></div>
  <input id="title" class="title-input" type="text" autocomplete="off" hidden>
  <div id="surface" class="surface">…</div>
  <div id="frame-foot" class="frame-foot" hidden></div>
  ```
- **Head, by format:**
  - linkedin: a 40px grey avatar circle, "You" (600), and "Just now" (12px grey).
  - x: a 40px avatar, "You" (700), and "@you" (grey).
  - instagram: a 32px avatar and "you" (600), then a 180px-tall `#efefef` box labeled "Photo".
  - substack: nothing above the title. Below the title, the byline "You · {Mon D}".
  - email: two grey 13px lines, "From: You" and "To: Your list", above the subject field.
- **Foot, by format:**
  - linkedin: "{n} / 3,000 characters".
  - x: a 20px SVG progress ring plus the remaining count, shown from 260. Colors: ring `#1d9bf0`, amber `#ffd400` from 260, red `#f4212e` past 280.
  - instagram: "{n} / 2,200 · {h} / 30 hashtags", with hashtags matched by `/#[\p{L}\p{N}_]+/gu`.
  - substack: "{m} min read".
  - email: the subject counter "{n} / 60" sits at the right end of the subject row.
  - Anything over its limit turns `--bad` red.
- **The card:** every format except basic shows the sheet as a card in both modes, since the look is the point.
  - `.sheet` background `var(--sheet-bg)` and color `var(--sheet-ink)`, where those default to `--paper` and `--ink` on `:root`.
  - Radius: 8px for linkedin, 16px for x, 12px otherwise.
  - Keep the skin's desk around the card.
- **Sheet tokens per format** (override on `html[data-format="…"] .sheet`):

| format | `--font-write` | size / leading | `--measure` | bg / ink |
|---|---|---|---|---|
| linkedin | `-apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang TC", "Noto Sans TC", sans-serif` | 14px / 1.4286 | 520px | `#fff` / `rgba(0,0,0,.9)` |
| x | same sans stack | 15px / 1.3334 | 516px | `#fff` / `#0f1419` |
| instagram | same sans stack | 14px / 1.2857 | 468px | `#fff` / `#000` |
| substack | `"Newsreader", Georgia, "Noto Serif TC", serif` | 20px / 1.6 | 680px | `#fff` / `#363737` |
| email | same sans stack | 15px / 1.5 | 600px | `#fff` / `#202124` |

- **Title field** (`#title`, bound to `draft.title`): shown for substack and email in both modes.
  - substack: `700 32px/1.2 "Newsreader", Georgia, serif`.
  - email: `600 16px/1.4` in the sans stack, placeholder "Subject".
  - For other formats, the title is edited as Name in the Details panel (section 9.6).
- **Folds.** Add a `fold` marker to the backdrop and draw `.fold`, an absolute element in `.surface`, at `min(lines × lineHeight, foldMarkerTop + lineHeight)`.
  - Styling: a 1px dashed `--ink-3` top border, with the label right-aligned in 11px `--ink-3`.
  - Only show it when the text actually goes past the fold.
- **X weighted length and overflow:**
  ```js
  function xLength(text) {                 // URLs count 23; CJK, emoji and most non-Latin count 2
    let len = 0, last = 0, m;
    const w = (s) => { for (const ch of s) { const c = ch.codePointAt(0);
      len += (c <= 0x10FF || (c >= 0x2000 && c <= 0x200D) || (c >= 0x2010 && c <= 0x201F) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2; } };
    const re = /https?:\/\/\S+|www\.\S+/gi;
    while ((m = re.exec(text))) { w(text.slice(last, m.index)); len += 23; last = m.index + m[0].length; }
    w(text.slice(last));
    return len;
  }
  ```
  The overflow starts at the first index where the running weighted length passes 280. That range goes on the new outer backdrop layer as `{type: 'overflow', start, end: text.length}`, styled `.fx-overflow { background: rgba(244, 33, 46, .18); }`.
- **`buildHTML` becomes three layers plus several markers.** Replace the v1 function with this:
  ```js
  // fx / sent / word: arrays of {start, end, type, id?}, each sorted and non-overlapping within itself.
  // markers: [{ index, cls }]
  function buildHTML(text, fx, sent, word, markers) {
    const cuts = new Set([0, text.length]);
    for (const arr of [fx, sent, word]) for (const m of arr) { cuts.add(m.start); cuts.add(m.end); }
    for (const mk of markers) cuts.add(mk.index);
    const pts = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);
    const skip = (arr, i, pos) => { while (i < arr.length && arr[i].end <= pos) i++; return i; };
    const cover = (arr, i, a) => (i < arr.length && arr[i].start <= a && a < arr[i].end ? arr[i] : null);
    let out = '', fi = 0, si = 0, wi = 0, openF = null, openS = null, openW = null;
    const closeW = () => { if (openW) { out += '</mark>'; openW = null; } };
    const closeS = () => { closeW(); if (openS) { out += '</span>'; openS = null; } };
    const closeF = () => { closeS(); if (openF) { out += '</span>'; openF = null; } };
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = k + 1 < pts.length ? pts[k + 1] : a;
      fi = skip(fx, fi, a); si = skip(sent, si, a); wi = skip(word, wi, a);
      const F = cover(fx, fi, a), S = cover(sent, si, a), W = cover(word, wi, a);
      if (F !== openF) { closeF(); openF = F; if (F) out += '<span class="fx fx-' + F.type + '">'; }
      if (S !== openS) { closeS(); openS = S; if (S) out += '<span class="hs hs-' + S.type + '" data-id="' + S.id + '">'; }
      if (W !== openW) { closeW(); openW = W; if (W) out += '<mark class="hl hl-' + W.type + '" data-id="' + W.id + '">'; }
      for (const mk of markers) if (mk.index === a) out += '<span class="' + mk.cls + '"></span>';
      if (b > a) out += escapeHTML(text.slice(a, b));
    }
    closeF();
    if (text === '' || text.endsWith('\n')) out += ' ';
    return out;
  }
  ```
  Keep all v1 rules: marks never get horizontal padding, margins, or borders.

## 9. Notion sync

Two files and some UI. Notion allows browser requests (CORS `*`), so the app calls `https://api.notion.com/v1` directly with the owner's internal-integration secret, stored in `localStorage['tdw.notionToken']`. The secret is only ever sent in the `Authorization` header to that host.

### 9.1 `app/js/notion.js` (`TDW.Notion`)

- **Headers:** `Authorization: Bearer <token>`, `Notion-Version: 2026-03-11`, and `Content-Type: application/json`.
- **One sequential queue.** At most one request in flight, with at least 340ms between request starts. Per request:
  - A 25s timeout (AbortController); a timeout counts as `offline`.
  - 429: wait `Retry-After` seconds (default 1), then retry, up to 5 times.
  - 409: retry once after 500ms.
  - 5xx: retry twice, after 1s and then 3s.
  - A network `TypeError` rejects with `offline`.
- **Errors** reject with `{code, status, message}`, where code is one of `unauthorized` (401), `forbidden` (403), `not_found` (404), `validation` (400), `conflict` (409), `rate_limited`, `server`, `offline`, or `unknown`. The message comes from the body's `message`.
- **Methods:**
  - `getDatabase(id)` is `GET /databases/{id}`, which returns `data_sources: [{id, name}]` and `title`.
  - `getDataSource(id)` is `GET /data_sources/{id}`, which returns `properties` (the schema).
  - `query(dsId, body)` is `POST /data_sources/{dsId}/query`. The body is `{sorts: [{timestamp: 'last_edited_time', direction: 'descending'}], page_size, start_cursor}`. `queryAll(dsId)` paginates through `has_more`/`next_cursor`.
  - `getPage(id)` is `GET /pages/{id}`.
  - `createPage(body)` is `POST /pages`, with `parent: {type: 'data_source_id', data_source_id}`.
  - `updatePage(id, body)` is `PATCH /pages/{id}`. `trashPage(id)` sends `{in_trash: true}` and `restorePage(id)` sends `{in_trash: false}`.
  - `listChildren(id)` is `GET /blocks/{id}/children?page_size=100`, paginated, and returns every top-level block.
  - `appendChildren(pageId, children, afterId)` is `PATCH /blocks/{pageId}/children` with `{children, position: afterId ? {type: 'after_block', after_block: {id: afterId}} : {type: 'start'}}`. It returns `results`.
  - `updateBlock(id, payload)` is `PATCH /blocks/{id}` with the body `{[payload.type]: payload[payload.type]}`.
  - `deleteBlock(id)` is `DELETE /blocks/{id}`.
- **The `api` object for `NotionMap.applyOps`:** `{update: updateBlock, remove: deleteBlock, append: appendChildren}`.

### 9.2 Storage additions (`store.js`)

- **Draft fields** (fill defaults for v1 drafts on load):
  - `title` (''), `format` ('basic').
  - `notionId` (null), `url` (null), `props` ({}).
  - `dirty` (false), `propsDirty` (false).
  - `contentFetchedAt` (0), `contentEditedAt` (null), `remoteTitle` (null), `localOnly` (false).
- **Settings additions:** `dictionary: []`, `noBackspace: true`, and `highlights.spelling: true`.
- **Keys:**
  - `tdw.notionToken`.
  - `tdw.notion`: `{databaseId, dataSourceId, dbTitle, titleProp, schema}`, where `schema` is `{[name]: {type, options?: string[], defaultStatus?}}`.
  - `tdw.notionTrash`: an array of page ids waiting to be trashed.
- **`displayTitle(draft)`** is `draft.title.trim()`, or else the v1 first-line title.

### 9.3 `app/js/sync.js` (`TDW.Sync`)

**API:** `init(hooks)`, `connect(token, link, { uploadLocal })`, `disconnect()`, `isConnected()`, `start()`, `stop()`, `noteEdit(draftId)`, `noteProp(draftId, name)`, `prepare(draft)`, `trash(draft)`, `restore(draft)`, `status()`.

The hooks are `onRemoteText(draft)`, `onRemoteDelete(draft)`, `onList()`, and `onStatus({state, message, at})`. The states are `off`, `syncing`, `synced`, `offline`, `error`, and `other-tab`.

- **Leader tab.** Only one tab syncs. `start()` runs `navigator.locks.request('tdw-sync', loop)`. Where Web Locks is missing, just run the loop. A tab waiting for the lock reports `other-tab`.
- **connect(token, link, { uploadLocal }):**
  1. The database id is the last 32-hex-character run in `link` (a UUID with dashes is fine too). If there isn't one, throw "That link has no database ID. Copy the database link from Notion."
  2. Save the token. `getDatabase(id)`:
     - 401: "Notion rejected the secret. Copy it again from notion.so/profile/integrations."
     - 404: "Notion can't see that database. In Notion, open it, click ••• → Connections, and add your integration."
  3. `getDataSource(data_sources[0].id)`. Build the schema: `options` from select, status, or multi_select options; `defaultStatus` is the first option in the status property's `to_do` group, or else its first option. Take `titleProp` as the property of type `title`.
  4. If a different `databaseId` was saved before, clear `notionId`, `url`, `props`, and `remoteTitle` on every draft.
  5. Save the config. Mark local-only drafts: if `uploadLocal` is false, drafts with content and no `notionId` get `localOnly = true`.
  6. `await fullSync()`, then `start()`. Return `{ title: dbTitle, pages: n }`.
- **fullSync():**
  - `pages = queryAll`. Upsert each page. Every draft whose `notionId` is missing from the remote set (and isn't `localOnly`) was removed in Notion: delete it locally and fire `onRemoteDelete`.
  - Drafts with no `notionId`, not `localOnly`, and some text or title get queued to push (which creates the page). Empty drafts are never uploaded.
- **upsert(page):**
  - Find the draft by `notionId`, or create a stub: new id, `notionId`, `text: ''`, `contentFetchedAt: 0`, `createdAt` and `updatedAt` from the page times, `format: 'basic'`, and the basic budget.
  - Unless `propsDirty`, set `title` from the title property and `props[name]` for the others via `NotionMap.propFromNotion`.
  - Set `remoteTitle`, `url`, and `updatedAt = max(updatedAt, Date.parse(page.last_edited_time))`. Save the draft and fire `onList`.
- **tick()** runs every 5s while the tab is visible and online. It skips if a tick is already running.
  1. Flush `tdw.notionTrash`.
  2. Query the first 25 pages by last edit and upsert each.
  3. If the open draft is linked, find its page in those results. If it's not there, `getPage` it (a 404 counts as trashed). A trashed (`in_trash`) or `is_archived` page is a remote delete. Otherwise, if the draft isn't `dirty` and isn't pushing, and `needsContent(draft, page)`, pull it.
  4. Every 12th tick, run `fullSync`.
  5. Report `synced`.
- **needsContent:**
  ```js
  !draft.contentFetchedAt || page.last_edited_time !== draft.contentEditedAt ||
  Date.parse(page.last_edited_time) >= Math.floor(draft.contentFetchedAt / 60000) * 60000
  ```
  Notion rounds `last_edited_time` down to the minute. The third clause catches edits made in the same minute as the last fetch.
- **pull(draft, page):**
  - Set `entries = NotionMap.blocksToEntries(await listChildren(notionId))`, cache them in memory, and set `text = NotionMap.entriesToText(entries)`.
  - Set `contentFetchedAt = now` and `contentEditedAt = page.last_edited_time`.
  - After the await, re-check `dirty`. If it's clean and `text !== draft.text`, set `draft.text = text`, save, and fire `onRemoteText(draft)`.
- **push(draft)** runs one at a time per draft. If edits land mid-push, it pushes again afterwards.
  - Snapshot `text` and `lines = text.split('\n')`.
  - **No `notionId`:** `createPage` with:
    - the properties: `titleProp` → `propToNotion('title', displayTitle)`; the status property → `defaultStatus` unless `draft.props` has a value; any other `draft.props`;
    - the first 100 non-marker lines as blocks (`blockPayload(lineToSpec(l), richFromText(spec.text))`).
    - Then append the rest in batches of 100 at the end, save `notionId` and `url`, and refetch the entries.
  - **Linked:** take the entries from cache, or `listChildren` if there are none. Run `entries = await NotionMap.applyOps(notionId, entries, lines, NotionMap.planOps(entries, lines), api)`.
    - On `not_found`, `validation`, or `conflict`, refetch the entries, plan again, and apply once more.
    - Then, if `displayTitle !== remoteTitle`, update the title property.
  - **Afterwards:** if `draft.text === text`, set `dirty = false`. Set `contentFetchedAt = now` and save.
  - **Errors:** `offline` keeps `dirty` and reports `offline`. Anything else reports `error` with the message.
- **noteEdit(id):** set `draft.dirty = true` and save. Push 1,200ms after the last call.
- **noteProp(id, name):** set `propsDirty` and push that property after 400ms with `updatePage(notionId, {properties: {[name]: propToNotion(type, value)}})`. A `null` body means skip.
- **prepare(draft):** for a linked draft whose content is missing or stale, set the editor read-only with the placeholder "Loading from Notion…", pull, then unlock. When offline, use the local text.
- **trash(draft) / restore(draft):** trash adds the id to `tdw.notionTrash` and flushes the queue. Restore removes the id if it's still queued, otherwise calls `restorePage`. The drafts drawer's Undo toast calls `restore`.
- **Visibility:** hidden pauses the timer; visible runs a tick at once. `online` runs a tick; `offline` reports `offline`.
- **disconnect:** stop, and clear the token and config. Keep the drafts and their `notionId`s, so reconnecting the same database relinks them.

### 9.4 Wiring in `app.js`

- **Editor input:** runs the v1 save path, then `Sync.noteEdit(draft.id)` if connected (and the draft isn't `localOnly`).
- **Title field and Name field input:** `draft.title = value`, save, `noteEdit`.
- **Opening a draft:** `await Sync.prepare(draft)` before `setText`.
- **`onRemoteText(draft)`:** if it's the open draft, replace the editor text and keep the caret.
  - Common prefix length `p`. If the old caret is ≤ p, keep it; otherwise shift it by `newLength - oldLength`, clamped.
  - Use `editor.value = …` (the one place besides load where that's allowed), then re-render.
- **`onRemoteDelete(draft)`:** if it was open, open the newest remaining draft (or a new one) and show the toast "“{title}” was deleted in Notion." Re-render the list.
- **Deleting in the drawer:** `Sync.trash(draft)` before the local delete. The Undo toast restores the local copy and calls `Sync.restore`.

### 9.5 Settings → "Notion sync" section

- **Connected:** "Synced with {dbTitle}", then "Last sync {relTime}", plus "Disconnect" (quiet, danger).
- **Not connected:**
  - The help line "Keep every draft in a Notion database, both ways." with the link `<a href="https://www.notion.so/profile/integrations" target="_blank" rel="noopener">Create an integration</a>`.
  - Then these steps, each ≤ 12 words:
    1. "Create an internal integration and copy its secret."
    2. "In Notion, open the database → ••• → Connections → add it."
    3. "Paste the secret and the database link here."
  - Fields: "Integration secret" (password, placeholder `ntn_…`) and "Database link".
  - The checkbox "Also add my {n} drafts from this device", shown only when n > 0 and checked by default.
  - A "Connect" button, and a status line for errors.

### 9.6 Edit panel → "Details" section (new, between the register and Readability)

- **Rows** (label 12px `--ink-2`, control on the right):
  - **Name:** a text input bound to `draft.title`, with the placeholder `displayTitle`. Always shown.
  - **Linked drafts:** one row per schema property except the title, in schema order.
    - select and status: `<select>` with an empty option, then the options.
    - date: `<input type="date">`.
    - checkbox, number, and text/url/email/phone: the matching input.
    - multi_select: toggle chips.
    - Anything read-only: plain text.
- **Link:** an "Open in Notion ↗" link to `draft.url`, `target="_blank"`.
- **Changes:** go through `Sync.noteProp`. Remote updates re-render the section unless one of its controls has focus.

### 9.7 Chrome sync status

- `<button id="sync-status" class="sync-status" type="button">`, shown only in Edit mode and when connected.
- Its text is "Synced", "Syncing…", "Offline", "Sync error", or "Syncing in another tab". It's a 12px quiet pill, with the text in `--bad` for errors.
- Clicking it shows a toast with the message and the time of the last sync.

### 9.8 Drafts drawer

- **Rows:** title, and the meta line "{relTime} · {words} words · ${spent}". If content hasn't been fetched yet, the words part reads "—".
- **Stage:** if the draft has a Stage or Status value, show it as a small pill.
- **Footer:**
  - Connected: "Synced with {dbTitle}".
  - Otherwise: "Drafts live in this browser only. Connect Notion in Settings to sync them."

### 9.9 Experiment: honor "no backspace" stages

- **When it applies:** `settings.noBackspace` is on, the mode is Write, and any select or status value on the open draft matches `/no backspace/i` (his Stage "Draft 1 (no backspace)").
- **What it does:** block deletion.
  - `beforeinput` with an `inputType` starting with `delete` → `preventDefault()`.
  - Backspace and Delete keydowns → `preventDefault()`.
  - Play `Sound.play('back', { pan: 0 })` at 60% gain as a soft bump.
- **First block of the session:** the toast "Draft 1 is no-backspace. Keep writing; Edit mode can delete."
- **Settings → Writing:** a checkbox "Block backspace when a draft's stage says “no backspace”".

## 10. The fake Notion server (`tests/fake-notion.mjs`) for stress tests

A Node `http` server on `127.0.0.1:8787` with in-memory state:

- **Every response:** `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization, Content-Type, Notion-Version`, and `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`. OPTIONS gets a 204.
- **Auth:** `Authorization: Bearer test-secret`, otherwise 401 `{object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.'}`.
- **Seed:** database `aaaaaaaabbbbccccddddeeeeeeeeeeee` with one data source `ds1`.
  - The schema matches "Write posts": Name (title), Date (date), Pillar (select: 40% Personal, 30% Craft, 20% Client's reality, 10% Proof, Other), and Stage (status with groups: to_do [Idea], in_progress [Draft 1 (no backspace), Draft 2, Ready, Scheduled], complete [Posted]).
  - 3 pages:
    - a paragraph with **bold** text plus a page mention;
    - a page with an image block between two paragraphs;
    - an empty page.
- **Implement** every endpoint from 9.1 with Notion's shapes. `last_edited_time` is rounded down to the minute, `in_trash` is honored, and a query leaves out trashed pages. `page.url` is `https://www.notion.so/fake/<id>`.
- **Admin routes** (no auth):
  - `POST /__admin/reset`
  - `GET /__admin/dump` (all pages with properties and blocks)
  - `GET /__admin/log` (request log: method, path, status)
  - `POST /__admin/edit-block {pageId, index, text}` (replaces the text, keeping the first segment's annotations)
  - `POST /__admin/add-block {pageId, index, text}`
  - `POST /__admin/trash {pageId}`
  - `POST /__admin/create-page {title, lines}`
  - `POST /__admin/set-prop {pageId, name, value}`
  - `POST /__admin/faults {every429: n, fail500Once: bool, latencyMs: n}`
- **Run it** in the background with `node apps/ten-dollar-words/tests/fake-notion.mjs`.

## 11. Build order

**M1. Engine**
- Update `engine.js`.
- Check: `node --test apps/ten-dollar-words/tests/` passes everything (engine, notion-map, spell).

**M2. Removals, version, and cache-busting**
- Section 2.
- Check: no Copy/Download/backup UI remains, and `grep -n "mock" app/js/app.js` shows no URL check.

**M3. Spelling and weak phrases**
- Sections 4 and 5.
- Check in the browser: "brokken" gets a wavy underline and "broken" fixes it. "very tired" offers "exhausted · saves $10". Add to dictionary works and survives a reload.

**M4. Chinese fonts and formats**
- Sections 7 and 8.
- Check: all 6 formats render, the LinkedIn fold shows at about 210 characters, X highlights the overflow past 280, and the highlights stay aligned in every format.

**M5. Notion client, sync, and UI**
- Sections 9.1–9.9, plus the fake server (10).

**M6. AI connect fix**
- Section 6. It can't be tested for real without a key; test it with the mock and read the code carefully.

**M7. Stress test**
- Everything in section 12.

**M8. Wrap-up**
- README update: Notion setup, formats, spelling, and a line that dictionary data is SCOWL (license in `app/dict/`).
- The subtraction pass.
- The report.

## 12. Stress tests (browser pane plus fake server)

**Setup:**
- Serve the app with `python3 -m http.server 8765 --bind 127.0.0.1 --directory apps/ten-dollar-words/app` (skip it if something already answers on 8765), and start the fake server.
- In the pane, open `http://127.0.0.1:8765/` and run `localStorage.setItem('tdw.notionBase', 'http://127.0.0.1:8787/v1')`, then reload.
- Connect with secret `test-secret` and link `https://www.notion.so/fake/aaaaaaaabbbbccccddddeeeeeeeeeeee`.
- Drive the page with `javascript_tool` and `computer`, and verify with `/__admin/dump` and `/__admin/log` (fetch them from the page or with curl).
- Use at most 10 screenshots in total.

Every item must pass:

1. After connecting, the 3 seed pages appear as drafts. Opening the bold/mention page shows its text.
2. Type a word in the middle of its paragraph and wait 3s. The log shows exactly one `PATCH /blocks/...` for that paragraph. The dump still shows the bold segment and the mention.
3. Press Enter and add a new paragraph between two paragraphs. It becomes one append with `after_block` = the previous block, and the dump order is right.
4. Delete a paragraph line. One DELETE.
5. On the image page, type into the `⟦image⟧` line. No request touches the image. Delete the whole line and the image block is deleted.
6. Remote edit: `/__admin/edit-block` on the open, clean draft. The editor text changes within 7s and the caret stays put.
7. Remote edit while the local draft is dirty (keep typing). Local wins: after pushing, the dump equals the editor text.
8. `/__admin/trash` on the open draft. Within 7s it disappears, the toast shows, and another draft opens.
9. Delete a draft in the drawer. The page gets `in_trash: true`. Undo restores both the draft and the page.
10. Create a new draft and type 3 paragraphs. One page is created with the right blocks and title, and its Stage is "Idea".
11. Change Stage and Pillar in Details. The dump updates. `/__admin/set-prop` shows up in the panel within 7s.
12. Faults `{every429: 3}`: type and edit for 20s. The sync completes, there are no duplicate pages, and the dump equals the editor.
13. Offline: stop the fake server. The status shows "Offline" and typing still works. Restart it (same state is fine; a new blank server is also acceptable if the code re-creates missing pages sensibly). Then sync recovers.
14. Reload while dirty (type, then reload at once). After boot the pending edit is pushed.
15. Paste 250 short paragraphs. Pushes go in batches of ≤ 100, and the dump has 250 blocks in order.
16. Two tabs: open a second tab. It shows "Syncing in another tab", and no duplicate pages appear while you edit in either tab.
17. Set Stage to "Draft 1 (no backspace)" and switch to Write mode. Backspace is blocked and shows the toast. In Edit mode, backspace works.
18. **AI (mock):** set `TDW.mockAI = true` from JS. Test Simplify, Rewrite, Cut the cost, Check the message, and "More options (AI)". Everything applies. Setting it back to false (and reloading) shows no mock leftovers.
19. **Visual:** Edit mode in each format (a screenshot of LinkedIn with a fold, X over the limit, and Email with a subject), Chinese text in the Typewriter skin, and the phone size (375px) with no horizontal scroll.
20. `node --test apps/ten-dollar-words/tests/` passes.

## 13. Report (under 350 words)

- Status.
- The test summary line.
- ✓/✗ for each stress test, 1–20.
- Deviations, with the reason for each.
- Known issues and risks.
- The files written or changed.

Leave the fake server stopped, reset the viewport, and remove `tdw.notionBase` from the pane's localStorage.
