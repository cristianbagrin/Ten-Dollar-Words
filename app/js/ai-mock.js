/* Fake AI for tests. Active only when a test sets TDW.mockAI = true from JS; never touches the network. */
(function () {
  'use strict';
  const TDW = window.TDW = window.TDW || {};

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject({ code: 'cancelled' }); return; }
      const timer = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject({ code: 'cancelled' }); }, { once: true });
    });
  }

  const firstWords = (s, n) => String(s || '').trim().split(/\s+/).slice(0, n).join(' ').replace(/[\s.,;:!?]+$/, '');

  function firstSentence(text) {
    const r = TDW.Engine.splitSentences(text)[0];
    return r ? text.slice(r.start, r.end) : '';
  }

  function answer(feature, input) {
    switch (feature) {
      case 'simplify':
        return { options: [
          { text: firstWords(input.sentence, 10) + '.', note: 'Cut the second half' },
          { text: 'A shorter take on the same point.', note: 'Rewritten from scratch' }
        ] };
      case 'stronger':
        return { options: [{ text: 'remarkable', note: 'Mock option' }, { text: 'striking', note: 'Mock option' }] };
      case 'activeVoice':
        return { options: [{ text: 'The team wrote it.', note: 'Doer comes first' }] };
      case 'tighten': {
        const edits = [];
        for (const find of [' really', ' very', ' just', 'in order to', 'I think ']) {
          if (edits.length >= 4) break;
          if (input.text.includes(find)) edits.push({ find, replace: find === 'in order to' ? 'to' : '', why: 'Filler' });
        }
        return { summary: 'Mock edits: filler words.', edits };
      }
      case 'messageCheck':
        return {
          takeaway: 'Cut words and your writing gets clearer.',
          verdict: 'mixed',
          match: input.intent ? 'partly' : 'none',
          why: 'Mock answer for testing.',
          offMessage: [{ quote: firstSentence(input.text), reason: 'Mock reason' }],
          strongerOpening: 'Every word costs you.',
          strongerEnding: 'Cut one more word.'
        };
      case 'connect':
        return { model: 'models/mock-flash', models: ['models/mock-flash'] };
      default:
        throw { code: 'error', message: 'unknown feature' };
    }
  }

  TDW.AIMock = {
    respond(feature, input, signal) {
      return wait(700, signal).then(() => answer(feature, input || {}));
    }
  };
})();
