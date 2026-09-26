/* Maps Notion blocks to the plain-text lines of a draft and back, and plans the smallest set
   of block changes that turns what Notion has into what the draft says. No network code:
   the caller passes an `api` object to applyOps. Runs in Node for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./inline.js'));
  else { root.TDW = root.TDW || {}; root.TDW.NotionMap = factory(root.TDW.Inline); }
})(typeof self !== 'undefined' ? self : this, function (Inline) {
  'use strict';

  const TEXT_TYPES = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3',
    'bulleted_list_item', 'numbered_list_item', 'quote', 'to_do']);
  const PREFIX = { heading_1: '# ', heading_2: '## ', heading_3: '### ', bulleted_list_item: '- ', quote: '> ' };
  const OPAQUE_LABELS = {
    image: 'image', video: 'video', audio: 'audio', file: 'file', pdf: 'PDF', bookmark: 'link',
    embed: 'embed', link_preview: 'link', callout: 'callout', toggle: 'toggle', code: 'code',
    equation: 'equation', table: 'table', column_list: 'columns', child_page: 'page',
    child_database: 'database', synced_block: 'synced block', table_of_contents: 'contents',
    breadcrumb: 'breadcrumb', link_to_page: 'page link', meeting_notes: 'meeting notes'
  };
  const MAX_TEXT = 2000;

  /* A line that stands for a block the app can't edit (image, callout…) looks like ⟦image⟧. */
  const isOpaqueLine = (line) => /^⟦[^\n]*⟧$/.test(line);
  const looksOpaque = (line) => line.startsWith('⟦');

  function plainOf(r) {
    if (typeof r.plain_text === 'string') return r.plain_text;
    if (r.type === 'text' && r.text) return r.text.content || '';
    if (r.type === 'equation' && r.equation) return r.equation.expression || '';
    return '';
  }
  // Soft line breaks inside a block show as spaces; 1:1 so positions still line up.
  const display = (s) => s.replace(/\n/g, ' ');
  const richPlain = (rich) => display((rich || []).map(plainOf).join(''));

  // A text link (mentions keep their own link to the page they mention).
  const urlOf = (r) => (r && r.type === 'text' ? (r.text && r.text.link && r.text.link.url) || r.href || null : null);
  const styleRun = (r) => {
    const a = r.annotations || {};
    return { text: display(plainOf(r)), b: !!a.bold, i: !!a.italic, s: !!a.strikethrough, c: !!a.code, link: urlOf(r) };
  };
  // Rich text → the draft's markdown: **bold**, *italic*, ~~strike~~, `code`, [links](url).
  const richToMd = (rich) => Inline.serialize((rich || []).map(styleRun));

  // What a stretch of text means, style included, so equal meaning compares equal
  // however the markdown was written.
  function signature(runs) {
    let out = '', last = null;
    for (const r of runs) {
      const k = (r.b ? 'b' : '') + (r.i ? 'i' : '') + (r.s ? 's' : '') + (r.c ? 'c' : '') + '\u0001' + (r.link || '');
      for (const ch of r.text) {
        const kk = r.c || !/\s/.test(ch) ? k : last; // a styled space looks like any other space
        out += (kk === last ? '' : '\u0002' + kk + '\u0003') + ch;
        last = kk;
      }
    }
    return out;
  }
  function mdRuns(md) {
    const { flags, links } = Inline.parse(md, 0);
    const out = [];
    for (let k = 0; k < md.length; k++) {
      const f = flags[k];
      if (f & Inline.MD) continue;
      const lk = f & Inline.L ? links.find((l) => k >= l.start && k < l.end) : null;
      out.push({ text: md[k], b: !!(f & Inline.B), i: !!(f & Inline.I), s: !!(f & Inline.S), c: !!(f & Inline.C), link: lk ? lk.url : null });
    }
    return out;
  }
  const mdPlain = (md) => mdRuns(md).map((r) => r.text).join('');

  function opaqueLine(b) {
    const label = OPAQUE_LABELS[b.type] || 'block';
    const body = b[b.type] || {};
    let detail = '';
    if (Array.isArray(body.rich_text)) detail = richPlain(body.rich_text);
    else if (b.type === 'child_page' || b.type === 'child_database') detail = body.title || '';
    else if (typeof body.url === 'string') detail = body.url;
    detail = detail.replace(/[⟦⟧]/g, '').replace(/\s+/g, ' ').trim();
    if (detail.length > 60) detail = detail.slice(0, 57) + '…';
    return '⟦' + label + (detail ? ': ' + detail : '') + '⟧';
  }

  /* Top-level Notion blocks (page order) → entries aligned 1:1 with the draft's lines. */
  function blocksToEntries(blocks) {
    let n = 0;
    return (blocks || []).map((b) => {
      const type = b.type;
      n = type === 'numbered_list_item' ? n + 1 : 0;
      if (TEXT_TYPES.has(type)) {
        const body = b[type] || {};
        const rich = body.rich_text || [];
        let prefix = PREFIX[type] || '';
        if (type === 'numbered_list_item') prefix = n + '. ';
        if (type === 'to_do') prefix = body.checked ? '[x] ' : '[ ] ';
        const md = richToMd(rich);
        return { line: prefix + (prefix ? md : Inline.escapeLineStart(md)), id: b.id, type, rich, checked: !!body.checked, opaque: false };
      }
      if (type === 'divider') return { line: '---', id: b.id, type, rich: [], checked: false, opaque: false };
      return { line: opaqueLine(b), id: b.id, type, rich: [], checked: false, opaque: true };
    });
  }

  const entriesToText = (entries) => entries.map((e) => e.line).join('\n');

  /* A draft line → the block it should be. */
  function lineToSpec(line) {
    let m;
    if (line === '---') return { type: 'divider', text: '' };
    if ((m = /^### (.*)$/.exec(line))) return { type: 'heading_3', text: m[1] };
    if ((m = /^## (.*)$/.exec(line))) return { type: 'heading_2', text: m[1] };
    if ((m = /^# (.*)$/.exec(line))) return { type: 'heading_1', text: m[1] };
    if ((m = /^[-*•] (.*)$/.exec(line))) return { type: 'bulleted_list_item', text: m[1] };
    if ((m = /^\d+[.)] (.*)$/.exec(line))) return { type: 'numbered_list_item', text: m[1] };
    if ((m = /^> (.*)$/.exec(line))) return { type: 'quote', text: m[1] };
    if ((m = /^\[([ xX])\] (.*)$/.exec(line))) return { type: 'to_do', text: m[2], checked: m[1] !== ' ' };
    return { type: 'paragraph', text: line };
  }

  /* ---------- Rich text ---------- */

  function linkOf(r) {
    if (r && r.type === 'text' && r.text && r.text.link && r.text.link.url) return { url: r.text.link.url };
    if (r && r.href) return { url: r.href };
    return null;
  }
  const annotationsOf = (r) => (r && r.annotations ? Object.assign({}, r.annotations) : null);

  function textObj(content, annotations, link) {
    const o = { type: 'text', text: { content, link: link || null } };
    if (annotations) o.annotations = annotations;
    return o;
  }

  /* A rich text object as Notion returns it → the shape Notion accepts in a write. */
  function writable(r) {
    const ann = annotationsOf(r);
    if (r.type === 'mention' && r.mention) {
      const m = r.mention;
      const kind = ['page', 'database', 'user', 'date'].find((k) => m.type === k && m[k]);
      if (kind) {
        const o = { type: 'mention', mention: { type: kind, [kind]: kind === 'date' ? m.date : { id: m[kind].id } } };
        if (ann) o.annotations = ann;
        return o;
      }
      return textObj(plainOf(r), ann, linkOf(r));
    }
    if (r.type === 'equation' && r.equation) {
      const o = { type: 'equation', equation: { expression: r.equation.expression } };
      if (ann) o.annotations = ann;
      return o;
    }
    return textObj(plainOf(r), ann, linkOf(r));
  }

  function sameStyle(a, b) {
    return a.type === 'text' && b.type === 'text' &&
      JSON.stringify(a.annotations || null) === JSON.stringify(b.annotations || null) &&
      JSON.stringify(a.text.link || null) === JSON.stringify(b.text.link || null);
  }

  function mergeText(list) {
    const out = [];
    for (const o of list) {
      if (o.type === 'text' && o.text.content === '') continue;
      const last = out[out.length - 1];
      if (last && sameStyle(last, o)) last.text.content += o.text.content;
      else out.push(o.type === 'text' ? textObj(o.text.content, o.annotations || null, o.text.link) : o);
    }
    return out;
  }

  // Notion caps one text object at 2,000 characters. Never cut a surrogate pair in half.
  function chunk(list) {
    const out = [];
    for (const o of list) {
      if (o.type !== 'text' || o.text.content.length <= MAX_TEXT) { out.push(o); continue; }
      const s = o.text.content;
      let i = 0;
      while (i < s.length) {
        let j = Math.min(i + MAX_TEXT, s.length);
        if (j < s.length && /[\uDC00-\uDFFF]/.test(s[j])) j--;
        out.push(textObj(s.slice(i, j), o.annotations || null, o.text.link));
        i = j;
      }
    }
    return out;
  }

  const richFromText = (text) => (text ? chunk([textObj(text, null, null)]) : []);

  const DEFAULT_ANN = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
  function annotation(x) {
    const a = { bold: !!x.b, italic: !!x.i, strikethrough: !!x.s, underline: !!x.u, code: !!x.c, color: x.color || 'default' };
    return JSON.stringify(a) === JSON.stringify(DEFAULT_ANN) ? null : a;
  }

  /* Rich text for a markdown line, rebuilt from the old rich text: the markdown decides bold,
     italics, strikethrough, code and links; text the user did not touch keeps its color,
     underline, soft line breaks, and its mentions. Inserted text takes the color of the
     character before it. */
  function spliceRich(oldRich, md) {
    const chars = mdRuns(String(md || ''));
    const newText = chars.map((c) => c.text).join('');
    const segs = (oldRich || []).map((r) => ({ r, raw: plainOf(r) }));
    const owner = [];
    segs.forEach((seg, i) => { for (let k = 0; k < seg.raw.length; k++) owner.push(i); });
    const oldRaw = segs.map((x) => x.raw).join('');
    const oldText = display(oldRaw);
    let p = 0;
    const maxP = Math.min(oldText.length, newText.length);
    while (p < maxP && oldText[p] === newText[p]) p++;
    let q = 0;
    while (q < oldText.length - p && q < newText.length - p &&
      oldText[oldText.length - 1 - q] === newText[newText.length - 1 - q]) q++;

    let carry = { color: 'default', u: false };
    const cells = chars.map((c, k) => {
      let from = -1;
      if (k < p) from = k;
      else if (k >= newText.length - q) from = oldText.length - (newText.length - k);
      let cell;
      if (from >= 0) {
        const seg = segs[owner[from]];
        const a = seg.r.annotations || {};
        carry = { color: a.color || 'default', u: !!a.underline };
        const obj = seg.r.type === 'mention' || seg.r.type === 'equation' ? owner[from] : -1;
        cell = Object.assign({}, c, { text: oldRaw[from], color: carry.color, u: carry.u, obj, from });
      } else {
        cell = Object.assign({}, c, { color: carry.color, u: carry.u, obj: -1, from: -1 });
      }
      return cell;
    });

    const out = [];
    const key = (x) => [x.b, x.i, x.s, x.c, x.u, x.color, x.link, x.obj].join('|');
    for (let k = 0; k < cells.length;) {
      let j = k + 1;
      while (j < cells.length && key(cells[j]) === key(cells[k])) j++;
      const run = cells.slice(k, j);
      const first = run[0];
      const ann = annotation(first);
      const seg = first.obj >= 0 ? segs[first.obj] : null;
      const whole = seg && run.length === seg.raw.length && run.every((x, t) => x.from === run[0].from + t) &&
        owner[run[0].from] === first.obj && (run[0].from === 0 || owner[run[0].from - 1] !== first.obj);
      if (whole) {
        const w = writable(seg.r);
        if (ann) w.annotations = ann; else delete w.annotations;
        out.push(w);
      } else {
        out.push(textObj(run.map((x) => x.text).join(''), ann, first.link ? { url: first.link } : null));
      }
      k = j;
    }
    return chunk(mergeText(out));
  }

  const richFromMd = (md) => spliceRich([], md);

  function blockPayload(spec, rich) {
    if (spec.type === 'divider') return { object: 'block', type: 'divider', divider: {} };
    const body = { rich_text: rich };
    if (spec.type === 'to_do') body.checked = !!spec.checked;
    return { object: 'block', type: spec.type, [spec.type]: body };
  }

  /* ---------- Diff ---------- */

  // Compare lines by what they mean in Notion, so a renumbered list item isn't a change.
  function keyOfEntry(e) {
    if (e.opaque) return 'opaque\u0000' + e.line;
    if (e.type === 'divider') return 'divider';
    return e.type + '\u0000' + signature((e.rich || []).map(styleRun)) + (e.type === 'to_do' ? '\u0000' + e.checked : '');
  }
  function keyOfLine(line) {
    if (looksOpaque(line)) return 'opaque\u0000' + line;
    const s = lineToSpec(line);
    if (s.type === 'divider') return 'divider';
    return s.type + '\u0000' + signature(mdRuns(s.text)) + (s.type === 'to_do' ? '\u0000' + !!s.checked : '');
  }

  function bigrams(s) {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  }
  // Dice coefficient on character pairs: 1 = same text, 0 = nothing in common.
  function similarity(x, y) {
    if (x === y) return 1;
    x = x.toLowerCase(); y = y.toLowerCase();
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
    const bx = bigrams(x), by = bigrams(y);
    let inter = 0;
    for (const [g, c] of bx) if (by.has(g)) inter += Math.min(c, by.get(g));
    return (2 * inter) / (x.length + y.length - 2);
  }
  function simFor(entry, line) {
    if (entry.opaque) return looksOpaque(line) ? 1 : 0;
    if (looksOpaque(line)) return 0;
    return similarity(richPlain(entry.rich), mdPlain(lineToSpec(line).text));
  }

  // Inside a changed stretch, pair each old block with the new line it most resembles
  // (order-preserving), so an edited paragraph keeps its block and its formatting.
  function alignGap(dels, ins, entries, lines) {
    const D = dels.length, I = ins.length, MIN = 0.35;
    const sim = dels.map((x) => ins.map((y) => simFor(entries[x], lines[y])));
    const best = [];
    for (let i = 0; i <= D; i++) best.push(new Float64Array(I + 1));
    for (let i = D - 1; i >= 0; i--) {
      for (let j = I - 1; j >= 0; j--) {
        const s = sim[i][j];
        best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], s >= MIN ? s + best[i + 1][j + 1] : -1);
      }
    }
    const pairs = new Map();
    let i = 0, j = 0;
    while (i < D && j < I) {
      const s = sim[i][j];
      if (s >= MIN && best[i][j] === s + best[i + 1][j + 1]) { pairs.set(j, i); i++; j++; }
      else if (best[i][j] === best[i + 1][j]) i++;
      else j++;
    }
    return pairs;
  }

  function pairOp(entry, oldIdx, lineIdx, line) {
    if (entry.opaque) {
      // Opaque blocks can't be edited here. A line that still starts like a marker keeps
      // the block untouched; anything else means the marker was replaced by new text.
      if (looksOpaque(line)) return { op: 'keep', old: oldIdx, line: lineIdx, stale: true };
      return { op: 'replace', old: oldIdx, line: lineIdx };
    }
    if (lineToSpec(line).type === entry.type) return { op: 'update', old: oldIdx, line: lineIdx };
    return { op: 'replace', old: oldIdx, line: lineIdx };
  }

  /* entries: what Notion has (blocksToEntries); lines: the draft split on "\n".
     Returns ops in page order: keep | update | replace | insert | delete. */
  function planOps(entries, lines) {
    const a = entries.map(keyOfEntry);
    const b = lines.map(keyOfLine);
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
    const n = A.length, m = B.length;

    const matches = [];
    if (n && m && n * m <= 4e6) {
      const dp = [];
      for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { matches.push([i, j]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
      }
    }

    const ops = [];
    for (let k = 0; k < pre; k++) ops.push({ op: 'keep', old: k, line: k });
    let ci = 0, cj = 0;
    const gap = (i2, j2) => {
      const dels = [], ins = [];
      for (let x = ci; x < i2; x++) dels.push(pre + x);
      for (let y = cj; y < j2; y++) ins.push(pre + y);
      let pairs;
      if (dels.length === 1 && ins.length === 1) pairs = new Map([[0, 0]]);
      else if (dels.length && ins.length && dels.length * ins.length <= 40000) pairs = alignGap(dels, ins, entries, lines);
      else {
        pairs = new Map();
        for (let k = 0; k < Math.min(dels.length, ins.length); k++) pairs.set(k, k);
      }
      const used = new Set();
      ins.forEach((y, j) => {
        if (!pairs.has(j)) { ops.push({ op: 'insert', line: y }); return; }
        const x = dels[pairs.get(j)];
        used.add(x);
        ops.push(pairOp(entries[x], x, y, lines[y]));
      });
      for (const x of dels) if (!used.has(x)) ops.push({ op: 'delete', old: x });
    };
    for (const [mi, mj] of matches) {
      gap(mi, mj);
      ops.push({ op: 'keep', old: pre + mi, line: pre + mj });
      ci = mi + 1; cj = mj + 1;
    }
    gap(n, m);
    for (let k = 0; k < suf; k++) ops.push({ op: 'keep', old: a.length - suf + k, line: b.length - suf + k });
    return ops;
  }

  /* Run the ops against Notion through `api`:
       api.update(blockId, payload)            → Promise
       api.remove(blockId)                     → Promise
       api.append(pageId, children, afterId)   → Promise<createdBlocks[]>  (afterId null = start)
     Returns the new entries (what Notion has afterwards), aligned with the lines that exist
     in Notion. Lines that look like ⟦markers⟧ are never created as text. */
  async function applyOps(pageId, entries, lines, ops, api) {
    const next = [];
    let anchor = null;
    let batch = [];
    const flush = async () => {
      for (let k = 0; k < batch.length; k += 100) {
        const part = batch.slice(k, k + 100);
        const created = (await api.append(pageId, part.map((x) => blockPayload(x.spec, x.rich)), anchor)) || [];
        part.forEach((x, t) => {
          const id = created[t] && created[t].id;
          next.push({ line: lines[x.lineIdx], id, type: x.spec.type, rich: x.rich, checked: !!x.spec.checked, opaque: false });
          if (id) anchor = id;
        });
      }
      batch = [];
    };
    for (const o of ops) {
      if (o.op === 'delete') { await api.remove(entries[o.old].id); continue; }
      if (o.op === 'keep') {
        await flush();
        const e = entries[o.old];
        next.push(o.stale ? e : Object.assign({}, e, { line: lines[o.line] }));
        anchor = e.id;
        continue;
      }
      if (o.op === 'update') {
        await flush();
        const e = entries[o.old];
        const spec = lineToSpec(lines[o.line]);
        const rich = spliceRich(e.rich, spec.text);
        await api.update(e.id, blockPayload(spec, rich));
        next.push({ line: lines[o.line], id: e.id, type: e.type, rich, checked: !!spec.checked, opaque: false });
        anchor = e.id;
        continue;
      }
      const line = lines[o.line];
      if (o.op === 'replace') await api.remove(entries[o.old].id);
      if (looksOpaque(line)) continue;
      const spec = lineToSpec(line);
      const rich = o.op === 'replace' && !entries[o.old].opaque ? spliceRich(entries[o.old].rich, spec.text) : richFromMd(spec.text);
      batch.push({ lineIdx: o.line, spec, rich });
    }
    await flush();
    return next;
  }

  /* ---------- Properties ---------- */

  const EDITABLE = new Set(['title', 'rich_text', 'number', 'select', 'status', 'multi_select',
    'date', 'checkbox', 'url', 'email', 'phone_number']);

  /* A Notion property value → a plain value the app can show and edit. */
  function propFromNotion(p) {
    if (!p) return null;
    switch (p.type) {
      case 'title': return (p.title || []).map(plainOf).join('');
      case 'rich_text': return (p.rich_text || []).map(plainOf).join('');
      case 'number': return p.number;
      case 'select': return p.select ? p.select.name : null;
      case 'status': return p.status ? p.status.name : null;
      case 'multi_select': return (p.multi_select || []).map((o) => o.name);
      case 'date': return p.date ? p.date.start : null;
      case 'checkbox': return !!p.checkbox;
      case 'url': return p.url || null;
      case 'email': return p.email || null;
      case 'phone_number': return p.phone_number || null;
      case 'people': return (p.people || []).map((u) => u.name || 'Someone').join(', ');
      case 'formula': { const f = p.formula || {}; return f[f.type] == null ? null : String(f[f.type]); }
      case 'unique_id': return p.unique_id ? (p.unique_id.prefix ? p.unique_id.prefix + '-' : '') + p.unique_id.number : null;
      case 'created_time': return p.created_time || null;
      case 'last_edited_time': return p.last_edited_time || null;
      default: return null;
    }
  }

  /* A plain value → the body Notion expects for that property type (null if not editable). */
  function propToNotion(type, v) {
    switch (type) {
      case 'title': return { title: v ? richFromText(String(v)) : [] };
      case 'rich_text': return { rich_text: v ? richFromText(String(v)) : [] };
      case 'number': return { number: v === '' || v == null || isNaN(Number(v)) ? null : Number(v) };
      case 'select': return { select: v ? { name: String(v) } : null };
      case 'status': return v ? { status: { name: String(v) } } : null;
      case 'multi_select': return { multi_select: (Array.isArray(v) ? v : []).map((name) => ({ name: String(name) })) };
      case 'date': return { date: v ? { start: String(v) } : null };
      case 'checkbox': return { checkbox: !!v };
      case 'url': return { url: v ? String(v) : null };
      case 'email': return { email: v ? String(v) : null };
      case 'phone_number': return { phone_number: v ? String(v) : null };
      default: return null;
    }
  }

  return {
    isOpaqueLine, looksOpaque, blocksToEntries, entriesToText, lineToSpec, richPlain, richToMd, spliceRich,
    richFromText, richFromMd, blockPayload, planOps, applyOps, propFromNotion, propToNotion, EDITABLE
  };
});
