# Ten Dollar Words

A writing app where every word costs $10. Write mode shows only your text; the top bar slides in when you move the pointer to the top of the window. Edit mode shows what you've spent against a budget, a readability grade, highlighted fixes (spelling, hard sentences, wordy phrases, passive voice, adverbs, weakeners), and optional AI help from Google Gemini. Drafts can sync both ways with a Notion database. Switching between Write and Edit (⌘E) keeps the line you were on where it was on screen.

It's a static website: plain HTML, CSS, and JavaScript. There's no build step and nothing to install.

## Run it locally

From this folder, run `python3 -m http.server 8765 --directory app` in Terminal, then open http://127.0.0.1:8765/.

(The Run button in `.claude/launch.json` can fail with "Operation not permitted", because macOS blocks the app's python3 from reading iCloud Drive. Use the Terminal command instead.)

Run the tests with `node --test tests/` from this folder.

## Get a Gemini key

1. Go to https://aistudio.google.com/apikey and create a free key.
2. In the app, open Settings (the sliders icon), paste the key under "AI help (Gemini)", and press "Save and test". The app tries the newest Flash models and keeps the first one that answers.
3. Leave Model on **Automatic**. It uses the newest Flash model, checks once a week for a newer one, and falls back to backups when Google is busy (503) or retires a model (404): the Flash alias, the next best Flash models, then a Lite model. Pick a model from the list only if you want to pin one. The list hides models that can't write text (speech, image, robotics…).

The key stays in this browser (localStorage) and is only sent to Google. You enter it once per browser and web address: it survives restarts and updates, and goes away only if you clear this site's data, remove the key in Settings, or (in Safari) leave the site unused for weeks. The same is true of the Notion secret. On the free tier, Google may use what you send to improve its products, so keep private client work out or use a paid key.

## Sync with Notion

1. Go to https://www.notion.so/profile/integrations, create an internal integration, and copy its secret (it starts with `ntn_`).
2. In Notion, open your posts database, click ••• → Connections, and add the integration.
3. In the app, open Settings → Notion sync, paste the secret and the database link, and press Connect.

Every page in the database shows up as a draft, and every draft with text becomes a page. Text, formatting, deletions, the title and the other properties sync both ways, about every 5 seconds while the app is open. Set Stage, Pillar, Date and the rest from the chips under each draft in the Drafts drawer. Options added in Notion show up within a minute. Text maps to Notion blocks line by line (see Formatting below). Blocks the app can't edit (images, callouts, tables…) show as a locked line like `⟦image⟧`; delete the whole line to delete the block. Mentions, colors and underlines you don't touch stay as they are.

A draft's title is its first sentence; that's what Notion's Name gets and what the Drafts drawer shows. A page that has only a title in Notion keeps it until it gets some text. In the Drafts drawer, click a draft's title to open its page in Notion, or anywhere else on the row to open it here.

If you edit the same paragraph here and in Notion at the same time, this app wins. Only one browser tab syncs at a time; the others say "Syncing in another tab".

## Budget

Click the budget under the amount to change it. The presets are words × $10 for common lengths: $500 (an X post), $1,000 (a short LinkedIn post), $2,000 (a typical LinkedIn post), $3,000 (a long post or a thread), $8,000 (a newsletter), $15,000 (a long essay).

## No backspace

The **No backspace** switch in the top bar blocks backspace, delete and cut in Write mode for the open draft ("Backspace is off"); Edit mode can always delete. When a draft's Stage says "no backspace", the switch turns on by itself (turn that off in Settings → Writing), and a new Stage decides again.

## Formatting

Formatting works like Notion: you see bold words and headings, never the markup behind them.

- **As you type:** `# `, `## `, `### ` make headings; `- ` a bullet; `1. ` a numbered list; `[]` a checkbox (click the box to tick it); `> ` a quote; `---` a divider. `**bold**`, `*italic*`, `~strike~` and `` `code` `` turn into formatting when you close them. ⌘Z right after undoes the conversion.
- **Shortcuts:** ⌘B bold, ⌘I italic, ⌘⇧S strikethrough, ⌘⌥1, ⌘⌥2, ⌘⌥3 headings (again to undo), ⌘⌥0 plain text, ⌘⇧7 numbered list, ⌘⇧8 bullets, ⌘⇧9 checkbox, ⌘K link (works on a whole paragraph too).
- Enter continues a list; Enter on an empty item ends it. Backspace at the start of a heading or list item turns it back into text.
- Pasting from Notion, Google Docs or the web keeps headings, lists, bold, italics and links. Copying from Basic or Substack gives clean text plus rich text; from LinkedIn and X, see Formats.
- In Notion all of these are real formatting, both ways. Behind the scenes a draft is saved as markdown.

Each line is a paragraph, with space after it; a blank line makes a bigger gap.

## Formats

The Format switch in the top bar (Basic, LinkedIn, X, Substack) only sets the line length, so line breaks land close to where they will when the post goes out: LinkedIn 52 characters, X 43, Substack 70 (exact in the Typewriter skin). Each format has its own default budget, and Settings → Writing → "New drafts use" picks the format for new drafts. The format is saved with the draft but isn't sent to Notion.

**Copying** gives you what the platform will show. From LinkedIn and X, markdown disappears and bold and italics become Unicode bold and italic letters (𝗯𝗼𝗹𝗱, 𝘪𝘵𝘢𝘭𝘪𝘤), since those sites have no formatting of their own; headings become bold lines. From Basic and Substack, the copy carries rich text too, so Substack keeps headings, bold and links.

- **LinkedIn (Edit mode):** ticks in the text show where "…see more" cuts in: a solid tick for a phone (about 140 characters or 3 lines) and a dashed one for a computer (about 210 characters or 3 lines), whichever comes first. The app lays the post out the way LinkedIn does, in the system font at the feed's width, so blank lines and line wraps count the way they will there. Text past 3,000 characters gets a faint red tint.
- **X threads:** every post sits in its own window, in both modes, with its word count and X's own character count (links count 23, emoji 2, Unicode bold 2 per letter). ⌘↩ (Ctrl+↩) starts a new post at the caret. Backspace at the top of a post joins it to the one above, and an empty post just disappears. Click a post's number to select it, ready to copy. Anything past 280 is tinted in Edit mode. In Notion, posts are separated by divider blocks.

Hover over the dollar amount for the word count, characters and reading time.

## Spelling

Edit mode underlines unknown words with a red wavy line. Click one for fixes, or "Add to dictionary" to stop flagging it; Settings → Writing lists the words you've added. Names in the middle of a sentence, acronyms, links, @handles and #hashtags are skipped. The word list is built from SCOWL (license in `app/dict/LICENSE-SCOWL.txt`); `tools/build-dict.mjs` rebuilds it.

## Files

```
./
  PLAN.md, PLAN-v2.md, PLAN-v3.md   the build plans and design decisions
  README.md                this file
  tests/                   node tests (engine, formatting, formats, Notion mapping, spelling), plus fake-notion.mjs,
                           a local stand-in for the Notion API used for sync stress tests
  tools/build-dict.mjs     rebuilds app/dict/en-us.txt
  app/                     the website (this is what gets deployed)
    index.html             page markup
    manifest.webmanifest   install-as-app settings
    sw.js                  service worker (offline use)
    _headers               Netlify security headers
    css/app.css            all styles, the three skins, and the post formats
    dict/                  the spelling word list and its license
    icons/                 app icons (SVG and PNG)
    js/data.js             word lists
    js/inline.js           markdown-lite: block markers and bold, italic, strike, code, links
    js/engine.js           readability engine (grade, sentences, highlights, spelling)
    js/spell.js            spellchecker and personal dictionary
    js/notion-map.js       Notion blocks to draft lines and back
    js/sound.js            typing sounds, synthesized in the browser
    js/store.js            drafts and settings in localStorage
    js/ai.js               Gemini client and prompts
    js/ai-mock.js          fake AI for tests (switched on from JS only)
    js/notion.js           Notion API client
    js/sync.js             two-way sync with Notion
    js/editor.js           the editor: one line per paragraph, its own undo, X post windows, the fold
    js/ui.js               shared helpers: elements, toasts, money, icons, toggles, menus
    js/formats.js          post formats: what each platform shows, X counting, the LinkedIn fold
    js/panel.js            Edit-mode panel: register, grade, fixes, AI results
    js/popover.js          tips on highlighted text
    js/dialogs.js          Drafts drawer (with Notion properties) and Settings
    js/app.js              state, events, startup (loads last)
```

## Ship an update

Bump `APP_VERSION` in `app/js/app.js`, `VERSION` in `app/sw.js`, and the `?v=` on every script and stylesheet in `index.html` together (for example `1.3.1`, `tdw-1.3.1`, `?v=1.3.1`). A new script also goes in the `PRECACHE` list in `sw.js`. The new service worker then replaces the old cache, and installed copies pick up the change. Deploy the `app/` folder.

## Later

Not built yet, on purpose:

- Syncing drafts to a folder (Chrome's File System Access).
- Claude as an alternative AI provider.
- Focus mode that dims other sentences.
- A receipt or print view.
- Custom budget presets.
- A grammar checker.
- More skins or more sound profiles.
