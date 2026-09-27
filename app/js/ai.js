/* Gemini client and prompts. The key only ever goes to Google, in the x-goog-api-key header. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};

  const BASE = 'https://generativelanguage.googleapis.com/v1beta/';
  const FALLBACK_MODEL = 'models/gemini-flash-latest'; // Google's alias for the current Flash model
  const FALLBACKS_KEY = 'tdw.geminiFallbacks';
  const MODELS_KEY = 'tdw.geminiModels';      // { at, models: [...] } from the last listing
  const RELIST_MS = 7 * 86400e3;
  // Models that can't write back text for us.
  const NOT_TEXT = /(tts|image|audio|live|embedding|vision|robotics|computer|transcribe|native|veo|imagen|aqa|learnlm|gemma|customtools|nano)/i;
  // Models go offline or get overloaded (503), and free-tier quotas (429) are per model,
  // so a failed call moves on to the next model instead of failing.
  const TRY_NEXT = new Set(['busy', 'rate_limited', 'bad_model']);
  let sticky = null; // the model that answered last, tried first for the rest of this visit
  const MODEL_RE = /^models\/[A-Za-z0-9._-]+$/;
  const MAX_TIGHTEN = 60000;

  const SYSTEM = "You are a sharp line editor. The writer pays $10 for every word, so shorter is better, but never at the cost of meaning. Their style: plain, direct, conversational American English; short sentences; concrete words; no clichés, corporate filler, hype, or em dashes. Keep the writer's facts and voice. Never invent claims. Reply only with JSON that matches the schema.";

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

  const MESSAGES = {
    no_key: 'Add your Gemini key in Settings first.',
    bad_key: 'Gemini rejected the key. Check it in Settings.',
    bad_model: "That model isn't available. Pick another in Settings.",
    rate_limited: "Gemini's free limit is used up for now. Try again in a minute.",
    busy: 'Gemini is overloaded. Try again shortly.',
    offline: "You're offline. AI help needs internet.",
    unreachable: "Couldn't reach Gemini. Check your internet and try again.",
    blocked: 'Gemini declined this text.',
    bad_json: 'Gemini sent a garbled answer. Try again.'
  };

  const OK_SCHEMA = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };

  // detail: Google's own words, shown when connecting fails.
  const fail = (code, message, detail) => ({ code, message: message || MESSAGES[code] || '', detail: detail || '' });
  const str = (v) => (typeof v === 'string' ? v : '');

  function networkError(e) {
    if (e && e.name === 'AbortError') return fail('cancelled');
    if (e instanceof TypeError) return fail(navigator.onLine === false ? 'offline' : 'unreachable');
    return fail('error', (e && e.message) || 'network error');
  }

  function httpError(status, body) {
    const msg = (body && body.error && body.error.message) || '';
    if (status === 400 && /api[ _-]?key/i.test(msg)) return fail('bad_key', '', msg);
    if (status === 401) return fail('bad_key', '', msg);
    // 403 also covers "API not enabled" and region blocks; show Google's reason for those.
    if (status === 403) return /api[ _-]?key|unregistered callers/i.test(msg) ? fail('bad_key', '', msg) : fail('error', msg || 'HTTP 403', msg);
    if (status === 404) return fail('bad_model', '', msg);
    if (status === 429) return fail('rate_limited', '', msg);
    if (status >= 500) return fail('busy', '', msg);
    return fail('error', msg || 'HTTP ' + status, msg);
  }

  async function request(path, init, key) {
    let res;
    try {
      res = await fetch(BASE + path, Object.assign({}, init, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }
      }));
    } catch (e) {
      throw networkError(e);
    }
    let body = null;
    try { body = await res.json(); } catch (e) {
      if (e && e.name === 'AbortError') throw fail('cancelled');
    }
    if (!res.ok) throw httpError(res.status, body);
    return body || {};
  }

  // Flash models, best first: stable before preview, then the highest version.
  function rankModels(names) {
    const flash = names.filter((n) => !/(lite|image|tts|audio|live|embedding|vision|8b|thinking|learnlm|gemma|aqa|nano|robotics|computer|native)/i.test(n) && n.includes('flash'));
    const version = (n) => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };
    const byVersion = (a, b) => version(b) - version(a) || a.length - b.length || a.localeCompare(b);
    const isPreview = (n) => /(preview|exp)/.test(n);
    return flash.filter((n) => !isPreview(n)).sort(byVersion).concat(flash.filter(isPreview).sort(byVersion));
  }

  const pickModel = (names) => rankModels(names)[0] || FALLBACK_MODEL;

  // Every model worth offering in Settings, best first.
  function usableModels(names) {
    const ok = names.filter((n) => /gemini/.test(n) && !NOT_TEXT.test(n));
    const version = (n) => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };
    const tier = (n) => (/flash-lite/.test(n) ? 2 : /flash/.test(n) ? 0 : /pro/.test(n) ? 1 : 3);
    const preview = (n) => (/(preview|exp)/.test(n) ? 1 : 0);
    return ok.sort((a, b) => preview(a) - preview(b) || tier(a) - tier(b) || version(b) - version(a) || a.localeCompare(b));
  }

  function readListing() {
    try {
      const v = JSON.parse(localStorage.getItem(MODELS_KEY) || 'null');
      return v && Array.isArray(v.models) ? v : null;
    } catch (_) { return null; }
  }
  function writeListing(models) {
    try { localStorage.setItem(MODELS_KEY, JSON.stringify({ at: Date.now(), models })); } catch (_) { /* storage blocked */ }
  }

  async function listModels(key, signal) {
    const body = await request('models?pageSize=200', { method: 'GET', signal }, key);
    return (Array.isArray(body.models) ? body.models : [])
      .filter((m) => m && typeof m.name === 'string' && m.name.includes('gemini') &&
        Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => m.name)
      .sort();
  }

  // Automatic mode: once a week, move to the newest Flash model Google offers.
  let relisting = false;
  function relistSoon(key) {
    if (relisting || TDW.Store.getModelMode() !== 'auto') return;
    const l = readListing();
    if (l && Date.now() - l.at < RELIST_MS) return;
    relisting = true;
    listModels(key).then((models) => {
      writeListing(models);
      const best = rankModels(models)[0];
      if (best && TDW.Store.getModelMode() === 'auto') TDW.Store.setModel(best);
    }).catch(() => {}).then(() => { relisting = false; });
  }

  function parseJSON(text) {
    const s = text.replace(/```(?:json)?/gi, '').trim();
    try { return JSON.parse(s); } catch (_) { /* try the braces below */ }
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { /* fall through */ }
    }
    throw fail('bad_json');
  }

  function readFallbacks() {
    try { const v = JSON.parse(localStorage.getItem(FALLBACKS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function writeFallbacks(list) {
    try { localStorage.setItem(FALLBACKS_KEY, JSON.stringify(list)); } catch (_) { /* storage blocked */ }
  }

  // Which models to try, in order: the one that just worked, the saved one, then the backups.
  function modelOrder() {
    const saved = TDW.Store.getModel();
    const list = [sticky, MODEL_RE.test(saved) ? saved : FALLBACK_MODEL, ...readFallbacks(), FALLBACK_MODEL];
    return [...new Set(list.filter((m) => typeof m === 'string' && MODEL_RE.test(m)))].slice(0, 6);
  }

  // use: { key, model } to test a key and model before saving them.
  async function generate(prompt, schema, temperature, signal, use) {
    const key = use ? use.key : TDW.Store.getKey();
    if (!key) throw fail('no_key');
    if (use) return generateWith(use.model, key, prompt, schema, temperature, signal);
    relistSoon(key);
    const saved = TDW.Store.getModel();
    let firstError = null, savedGone = false;
    for (const model of modelOrder()) {
      try {
        const out = await generateWith(model, key, prompt, schema, temperature, signal);
        sticky = model;
        if (savedGone && model !== saved && TDW.Store.getModelMode() === 'auto') TDW.Store.setModel(model); // the saved model was retired
        return out;
      } catch (e) {
        if (!TRY_NEXT.has(e.code)) throw e;
        if (e.code === 'bad_model' && model === saved) savedGone = true;
        if (!firstError) firstError = e;
      }
    }
    throw firstError;
  }

  async function generateWith(model, key, prompt, schema, temperature, signal) {
    const body = await request(model + ':generateContent', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema }
      })
    }, key);
    const cand = Array.isArray(body.candidates) ? body.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : null;
    if (!parts) throw fail('blocked');
    return parseJSON(parts.filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join(''));
  }

  /* ---------- Output validation ---------- */
  function checkOptions(raw, max) {
    const list = raw && Array.isArray(raw.options) ? raw.options : [];
    return {
      options: list.filter((o) => o && typeof o.text === 'string' && o.text.trim())
        .slice(0, max || 3).map((o) => ({ text: o.text.trim(), note: str(o.note) }))
    };
  }

  function checkEdits(raw) {
    const list = raw && Array.isArray(raw.edits) ? raw.edits : [];
    return {
      summary: str(raw && raw.summary),
      edits: list.filter((e) => e && typeof e.find === 'string' && e.find !== '')
        .slice(0, 12).map((e) => ({ find: e.find, replace: str(e.replace), why: str(e.why) }))
    };
  }

  function checkMessage(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    return {
      takeaway: str(r.takeaway), verdict: str(r.verdict), match: str(r.match), why: str(r.why),
      offMessage: (Array.isArray(r.offMessage) ? r.offMessage : [])
        .filter((o) => o && typeof o.quote === 'string' && o.quote.trim())
        .map((o) => ({ quote: o.quote, reason: str(o.reason) })),
      strongerOpening: str(r.strongerOpening), strongerEnding: str(r.strongerEnding)
    };
  }

  /* ---------- Prompts ---------- */
  const block = (label, text) => label + ':\n<<<\n' + text + '\n>>>';

  const FEATURES = {
    simplify: {
      schema: OPTIONS, temperature: 0.7, check: checkOptions,
      prompt: (i) => [
        "Rewrite the sentence below so it is easier to read. Aim for fewer than 20 words and a grade 6 to 8 reading level. You may split it into two sentences. Keep every fact and the writer's voice.",
        block('PARAGRAPH', i.paragraph),
        block('SENTENCE', i.sentence),
        'Give 3 options, shortest first. Each note says what changed in 3 to 6 words.'
      ].join('\n\n')
    },
    activeVoice: {
      schema: OPTIONS, temperature: 0.7, check: checkOptions,
      prompt: (i) => [
        'The sentence below uses passive voice ("' + i.phrase + "\"). Rewrite it in active voice so the doer comes first. If the doer isn't named, use the natural one from context or restructure the sentence. Keep the meaning and the writer's voice.",
        block('PARAGRAPH', i.paragraph),
        block('SENTENCE', i.sentence),
        'Give 2 options, shortest first. Each note says what changed in 3 to 6 words.'
      ].join('\n\n')
    },
    stronger: {
      schema: OPTIONS, temperature: 0.8, check: (raw) => checkOptions(raw, 4),
      prompt: (i) => [
        'The phrase "' + i.phrase + "\" in the sentence below is weak. Suggest replacements for the whole phrase: one strong word, two at most, that says it with more precision in the writer's voice. Each option must fit the sentence when swapped in.",
        block('SENTENCE', i.sentence),
        'Give 4 options, best first. Each note gives the nuance in 2 to 5 words.'
      ].join('\n\n')
    },
    tighten: {
      schema: TIGHTEN, temperature: 0.3, check: checkEdits,
      prompt: (i) => [
        "Every word in this text costs $10. Find cuts that save money without losing meaning, facts, or the writer's personality.",
        'Rules:\n' +
        '- Each edit replaces an exact quote from the text with something shorter, or deletes it (empty replace).\n' +
        '- "find" must be copied character for character from the text, 1 to 30 words long, and must appear only once.\n' +
        '- Go after filler, hedges, throat-clearing, repetition, and wordy phrases.\n' +
        '- Every edited sentence must stay grammatical and mean exactly the same. Never change tense or voice, and never drop an article just to save a word.\n' +
        '- Fewer, better edits beat more edits. Skip any cut that makes the writing worse.\n' +
        '- Leave quotes from other people unchanged.\n' +
        '- At most 12 edits, biggest savings first.',
        block('TEXT', i.text)
      ].join('\n\n')
    },
    messageCheck: {
      schema: MESSAGE, temperature: 0.4, check: checkMessage,
      prompt: (i) => [
        'Judge whether this draft gets its message across to a busy reader.\n' +
        (i.intent ? 'The writer says the message is:\n<<<\n' + i.intent + '\n>>>' : 'The writer did not say what the message is.'),
        block('DRAFT', i.text),
        'Fill every field:\n' +
        '- takeaway: the one thing a busy reader would remember, in one sentence of 25 words or fewer.\n' +
        '- verdict: "clear", "mixed", or "unclear".\n' +
        '- match: if the writer stated a message, "yes", "partly", or "no"; otherwise "none".\n' +
        '- why: one or two sentences explaining the verdict.\n' +
        '- offMessage: up to 3 sentences copied exactly from the draft that pull away from the message, each with a reason of 10 words or fewer.\n' +
        '- strongerOpening: a sharper first line in the writer\'s voice, or "" if the current one works.\n' +
        '- strongerEnding: a sharper last line in the writer\'s voice, or "" if the current one works.'
      ].join('\n\n')
    }
  };

  async function run(feature, input, signal) {
    const f = FEATURES[feature];
    const raw = TDW.mockAI
      ? await TDW.AIMock.respond(feature, input, signal)
      : await generate(f.prompt(input), f.schema, f.temperature, signal);
    return f.check(raw);
  }

  TDW.AI = {
    // An empty key re-tests the saved one. Each candidate model gets a tiny test request, so the
    // saved model is one that answers for this key.
    async connect(key, signal) {
      if (TDW.mockAI) return TDW.AIMock.respond('connect', {}, signal);
      const k = String(key || '').trim() || TDW.Store.getKey();
      if (!k) throw fail('no_key');
      const models = await listModels(k, signal);
      writeListing(models);
      const ranked = rankModels(models);
      const manual = TDW.Store.getModelMode() === 'manual' && models.includes(TDW.Store.getModel()) ? TDW.Store.getModel() : null;
      // Backups: the Flash alias, the next best Flash models, then a Lite model (usually less busy).
      const alias = models.includes(FALLBACK_MODEL) ? [FALLBACK_MODEL] : [];
      const lite = ['models/gemini-flash-lite-latest'].concat(models.filter((m) => /flash-lite$/.test(m)).reverse())
        .filter((m) => models.includes(m)).slice(0, 1);
      const tryList = [...new Set([manual, ...ranked.slice(0, 3), ...alias, ...lite].filter(Boolean))];
      let firstError = null;
      for (const model of tryList.length ? tryList : [FALLBACK_MODEL]) {
        try {
          await generate('Reply with {"ok": true}', OK_SCHEMA, 0, signal, { key: k, model });
          TDW.Store.setKey(k);
          TDW.Store.setModel(model);
          if (manual && model !== manual) TDW.Store.setModelMode('auto'); // the chosen model didn't answer
          writeFallbacks([...new Set([...alias, ...ranked.slice(0, 3), ...lite])].filter((m) => m !== model));
          sticky = null;
          return { model, models };
        } catch (e) {
          if (e.code === 'bad_key' || e.code === 'cancelled') throw e;
          if (!firstError) firstError = e;
        }
      }
      throw firstError;
    },
    simplify: (input, signal) => run('simplify', input, signal),
    stronger: (input, signal) => run('stronger', input, signal),
    activeVoice: (input, signal) => run('activeVoice', input, signal),
    async tighten(input, signal) {
      const text = String(input.text || '');
      const truncated = text.length > MAX_TIGHTEN;
      const out = await run('tighten', { text: truncated ? text.slice(0, MAX_TIGHTEN) : text }, signal);
      out.truncated = truncated;
      return out;
    },
    messageCheck: (input, signal) => run('messageCheck', input, signal),
    status() {
      if (TDW.mockAI) return 'mock';
      return TDW.Store.getKey() ? 'ready' : 'none';
    },
    errorMessage(err) {
      const code = err && err.code;
      if (code && code !== 'error' && MESSAGES[code]) return MESSAGES[code];
      return 'Something went wrong: ' + ((err && err.message) || 'unknown error');
    },
    disconnect() {
      TDW.Store.clearKey();
      TDW.Store.setModel('');
      TDW.Store.setModelMode('auto');
      writeFallbacks([]);
      try { localStorage.removeItem(MODELS_KEY); } catch (_) { /* storage blocked */ }
      sticky = null;
    },
    // Settings: which models to offer, and what Automatic would use.
    listing() { const l = readListing(); return l ? l.models : []; },
    bestModel(models) { return rankModels(models || [])[0] || ''; },
    useAuto() {
      TDW.Store.setModelMode('auto');
      const best = rankModels(this.listing())[0];
      if (best) TDW.Store.setModel(best);
      sticky = null;
    },
    useModel(m) {
      TDW.Store.setModelMode('manual');
      TDW.Store.setModel(m);
      sticky = null;
    },
    pickModel,
    rankModels,
    usableModels
  };
})();
