# Ten-Dollar Words

A writing app where every word costs $10. Write mode shows only your text. Edit mode shows what you've spent against a budget, a readability grade, highlighted fixes (spelling, hard sentences, wordy phrases, passive voice, adverbs, weakeners), and optional AI help from Google Gemini. Drafts can sync both ways with a Notion database.

It's a static website: plain HTML, CSS, and JavaScript. There's no build step and nothing to install.

## Run it locally

From the Claude folder, run `python3 -m http.server 8765 --directory apps/ten-dollar-words/app` in Terminal, then open http://127.0.0.1:8765/.

(The Run button in `.claude/launch.json` can fail with "Operation not permitted", because macOS blocks the app's python3 from reading iCloud Drive. Use the Terminal command instead.)

Run the tests with `node --test apps/ten-dollar-words/tests/`.

## Get a Gemini key

1. Go to https://aistudio.google.com/apikey and create a free key.
2. In the app, open Settings (the sliders icon), paste the key under "AI help (Gemini)", and press "Save and test". The app tries the newest Flash models and keeps the first one that answers. You can change it in the Model menu. New Gemini models are often overloaded on the free tier (Google answers 503) and some older ones get retired (404), so every AI call quietly falls back to backup models: the Flash alias, the next best Flash models, then a Lite model.

The key stays in this browser (localStorage) and is only sent to Google. On the free tier, Google may use what you send to improve its products, so keep private client work out or use a paid key.

## Sync with Notion

1. Go to https://www.notion.so/profile/integrations, create an internal integration, and copy its secret (it starts with `ntn_`).
2. In Notion, open your posts database, click ••• → Connections, and add the integration.
3. In the app, open Settings → Notion sync, paste the secret and the database link, and press Connect.

Every page in the database shows up as a draft, and every draft with text becomes a page. Text, deletions, and the Name, Stage, Pillar and Date properties sync both ways, about every 5 seconds while the app is open. Edit a page's properties under Details in Edit mode. Text maps to Notion blocks line by line: `# ` headings, `- ` bullets, `1. ` numbered items, `> ` quotes, `[ ] ` to-dos, `---` dividers. Blocks the app can't edit (images, callouts, tables…) show as a locked line like `⟦image⟧`; delete the whole line to delete the block. Bold, links and mentions you don't touch stay as they are.

If you edit the same paragraph here and in Notion at the same time, this app wins. Only one browser tab syncs at a time; the others say "Syncing in another tab". When a draft's Stage says "no backspace", Write mode blocks deleting (turn this off in Settings → Writing).

The secret stays in this browser and is only sent to api.notion.com. Without Notion, drafts live only in this browser's localStorage; clearing site data deletes them.

## Formats

The Format menu in the top bar only sets the line length, so line breaks land where they will when the post goes out: LinkedIn and Instagram 52 characters, X 43, Substack 70 (exact in the Typewriter skin; the other skins use the width of a "0"). Font, size and paper stay the same as Basic. Each format has its own default budget, and Settings → Writing → "New drafts use" picks the format for new drafts. The format is saved with the draft but isn't sent to Notion.

Edit mode adds a few quiet aids, only when they matter:

- **LinkedIn and Instagram:** a small tick where "see more" cuts in (character 140 on LinkedIn, 125 on Instagram, or after 3 or 2 lines), with the label in the right margin. Text past the limit (3,000 or 2,200 characters) gets a faint red tint.
- **X threads:** a line with just `---` starts the next post, and ⌘↩ (Ctrl+↩) adds one. Numbers like 2/3 sit in the left margin; click one to select that post, ready to copy. Anything past 280 in a post, counted the way X counts, is tinted. In Notion, `---` becomes a divider, so a thread keeps its shape.

Hover over the dollar amount for the word count, characters and reading time.

## Spelling

Edit mode underlines unknown words with a red wavy line. Click one for fixes, or "Add to dictionary" to stop flagging it; Settings → Writing lists the words you've added. Names in the middle of a sentence, acronyms, links, @handles and #hashtags are skipped. The word list is built from SCOWL (license in `app/dict/LICENSE-SCOWL.txt`); `tools/build-dict.mjs` rebuilds it.

## Files

```
apps/ten-dollar-words/
  PLAN.md, PLAN-v2.md      the build plans and design decisions
  README.md                this file
  tests/                   node tests (engine, Notion mapping, spelling), plus fake-notion.mjs,
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
    js/engine.js           readability engine (grade, sentences, highlights, spelling)
    js/spell.js            spellchecker and personal dictionary
    js/notion-map.js       Notion blocks to draft lines and back
    js/sound.js            typing sounds, synthesized in the browser
    js/store.js            drafts and settings in localStorage
    js/ai.js               Gemini client and prompts
    js/ai-mock.js          fake AI for tests (switched on from JS only)
    js/notion.js           Notion API client
    js/sync.js             two-way sync with Notion
    js/editor.js           text box plus the highlight layer behind it
    js/ui.js               shared helpers: elements, toasts, money, icons
    js/formats.js          post formats
    js/panel.js            Edit-mode panel: register, details, grade, fixes, AI results
    js/popover.js          tips on highlighted text
    js/dialogs.js          Drafts drawer and Settings
    js/app.js              state, events, startup (loads last)
```

## Ship an update

Bump `APP_VERSION` in `app/js/app.js`, `VERSION` in `app/sw.js`, and the `?v=` on every script and stylesheet in `index.html` together (for example `1.1.1`, `tdw-1.1.1`, `?v=1.1.1`). The new service worker then replaces the old cache, and installed copies pick up the change. Deploy the `app/` folder.

## Later

Not built yet, on purpose:

- Syncing drafts to a folder (Chrome's File System Access).
- Claude as an alternative AI provider.
- Rich text or Markdown rendering.
- Focus mode that dims other sentences.
- A receipt or print view.
- Custom budget presets.
- A grammar checker.
- More skins or more sound profiles.
