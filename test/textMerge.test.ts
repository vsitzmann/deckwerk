import { describe, expect, it } from 'vitest';
import {
  diffSequences, htmlTokens, mapTextOffset, mergeSequences, mergeTextHtml, tagsBalanced, textSeam,
} from '../src/shared/textMerge.js';

const chars = (text: string) => text.split('');
const merge = (base: string, current: string, incoming: string) =>
  mergeSequences(chars(base), chars(current), chars(incoming)).join('');

describe('diffSequences', () => {
  it('trims the common ends to one exact hunk for a typed run', () => {
    expect(diffSequences(chars('Base alp'), chars('Base alpha'))).toEqual([
      { start: 8, end: 8, insert: ['h', 'a'] },
    ]);
    expect(diffSequences(chars('Base alpha'), chars('Bse alpha'))).toEqual([
      { start: 1, end: 2, insert: [] },
    ]);
    expect(diffSequences(chars('same'), chars('same'))).toEqual([]);
  });

  it('finds separate hunks for separate edits', () => {
    const hunks = diffSequences(chars('one two three'), chars('one TWO three!'));
    let rebuilt = '';
    let at = 0;
    const base = 'one two three';
    for (const hunk of hunks) {
      rebuilt += base.slice(at, hunk.start) + hunk.insert.join('');
      at = hunk.end;
    }
    rebuilt += base.slice(at);
    expect(rebuilt).toBe('one TWO three!');
    expect(hunks.length).toBeGreaterThan(1);
  });
});

describe('mergeSequences', () => {
  it('applies edits made in different places on both sides', () => {
    expect(merge('Base and more', 'Base alpha and more', 'Base and more bravo'))
      .toBe('Base alpha and more bravo');
  });

  it('keeps both runs typed at one point, incoming first', () => {
    expect(merge('Base', 'Base alpha', 'Base bravo')).toBe('Base bravo alpha');
  });

  it('keeps a word continued across two syncs in one piece', () => {
    // Bob had synced "Base bra"; Alice's " alp" was merged in behind it at the
    // server; Bob meanwhile typed "vo". His "vo" continues his own word.
    expect(merge('Base bra', 'Base bra alp', 'Base bravo')).toBe('Base bravo alp');
    // The same from Alice's side: her "ha" continues "alp".
    expect(merge('Base alp', 'Base bra alp', 'Base alpha')).toBe('Base bra alpha');
  });

  it('resolves only the contested region to incoming', () => {
    expect(merge('a cat sat. end', 'a dog sat. end!', 'a cow sat. end'))
      .toBe('a cow sat. end!');
  });

  it('applies a deletion on one side and an insertion elsewhere on the other', () => {
    expect(merge('keep drop keep', 'keep keep', 'keep drop keep more'))
      .toBe('keep keep more');
  });
});

describe('mergeTextHtml', () => {
  it('never splits a tag or a character reference', () => {
    expect(htmlTokens('<p class="a">x&amp;y</p>')).toEqual([
      '<p class="a">', 'x', '&amp;', 'y', '</p>',
    ]);
  });

  it('merges concurrent typing into one paragraph', () => {
    expect(mergeTextHtml('<p>Base</p>', '<p>Base alpha</p>', '<p>Base bravo</p>'))
      .toBe('<p>Base bravo alpha</p>');
  });

  it('merges typing in different paragraphs and around formatting', () => {
    expect(mergeTextHtml(
      '<p>One</p><p>Two <b>bold</b></p>',
      '<p>One more</p><p>Two <b>bold</b></p>',
      '<p>One</p><p>Two <b>bolder</b> end</p>',
    )).toBe('<p>One more</p><p>Two <b>bolder</b> end</p>');
  });

  it('falls back to incoming when the merged tags would not nest', () => {
    expect(tagsBalanced(htmlTokens('<p><b>x</p></b>'))).toBe(false);
    expect(tagsBalanced(htmlTokens('<p>a<br>b<img src="x"></p>'))).toBe(true);
    // One side wraps "ab" in bold, the other wraps "bc" in italics.
    const incoming = '<p>a<i>bc</i></p>';
    const merged = mergeTextHtml('<p>abc</p>', '<p><b>ab</b>c</p>', incoming);
    expect(tagsBalanced(htmlTokens(merged))).toBe(true);
  });

  it('is plain replacement when nothing happened concurrently', () => {
    expect(mergeTextHtml('<p>a</p>', '<p>a</p>', '<p>b</p>')).toBe('<p>b</p>');
    expect(mergeTextHtml('<p>a</p>', '<p>c</p>', '<p>a</p>')).toBe('<p>c</p>');
  });
});

describe('identical concurrent typing', () => {
  it('keeps a space each person typed at the same point', () => {
    expect(mergeTextHtml('<p>Base</p>', '<p>Base&nbsp;</p>', '<p>Base&nbsp;</p>'))
      .toBe('<p>Base&nbsp;&nbsp;</p>');
  });

  it('keeps the words apart when both continue after their own space', () => {
    // Each editor turns its trailing nbsp into a space as its author types on.
    const afterAlice = mergeTextHtml('<p>Base&nbsp;</p>', '<p>Base&nbsp;&nbsp;</p>', '<p>Base alpha</p>');
    expect(afterAlice).toBe('<p>Base alpha&nbsp;</p>');
    expect(mergeTextHtml('<p>Base&nbsp;</p>', afterAlice, '<p>Base bravo</p>'))
      .toBe('<p>Base alpha bravo</p>');
  });
});

describe('mapTextOffset', () => {
  it('moves a caret past text inserted before it', () => {
    expect(mapTextOffset('Base bravo', 'Base alpha bravo', 10)).toBe(16);
  });

  it('keeps a caret in front of text inserted exactly at it', () => {
    expect(mapTextOffset('Base bra', 'Base bra alp', 8)).toBe(8);
    expect(mapTextOffset('Base', 'Base alpha', 4)).toBe(4);
  });

  it('leaves a caret before an edit alone and clamps to the text', () => {
    expect(mapTextOffset('Base alpha', 'Base alpha!', 2)).toBe(2);
    expect(mapTextOffset('Base alpha', 'Base', 10)).toBe(4);
  });

  it('puts a caret inside replaced text after the replacement', () => {
    expect(mapTextOffset('a cat sat', 'a dog sat', 4)).toBe(5);
  });
});

describe('edits placed at word seams', () => {
  it('moves an insertion that shares letters with its neighbours out of the word', () => {
    // "bro " typed after "aprico " — suffix trimming alone calls it "o br"
    // typed between "apric" and "o ".
    expect(diffSequences(chars('x aprico '), chars('y aprico bro ')).at(-1))
      .toEqual({ start: 7, end: 7, insert: chars('o br') });
    expect(diffSequences(chars('x aprico '), chars('y aprico bro '), textSeam).at(-1))
      .toEqual({ start: 9, end: 9, insert: chars('bro ') });
  });

  it('moves a deletion out of the word it would cut', () => {
    expect(diffSequences(chars('x one bone '), chars('y one ')).at(-1))
      .toEqual({ start: 2, end: 7, insert: [] });
    expect(diffSequences(chars('x one bone '), chars('y one '), textSeam).at(-1))
      .toEqual({ start: 6, end: 11, insert: [] });
  });

  it("keeps the other person's run out of a word being finished", () => {
    // Alice is finishing "aprico|t"; Bob's " bro" landed after it at the
    // server meanwhile. Aligned inside "aprico", Bob's run took the "o" and
    // Alice's "t" followed it: "aprico brot".
    expect(mergeTextHtml(
      '<p>Base apple aprico </p>',
      '<p>Base blue apple aprico bro </p>',
      '<p>Base apple apricot </p>',
    )).toBe('<p>Base blue apple apricot bro </p>');
  });

  it('keeps a caret out of a run inserted next to it', () => {
    expect(mapTextOffset('x aprico ', 'y aprico bro ', 8)).toBe(8);
  });
});

/**
 * Two people typing at one caret position, run through the rules live text
 * sync follows, without a browser. Each editor streams its box (a push 250 ms
 * after the first keystroke, and at once after a space); the server merges a
 * push made from a stale base (collabApply); every replica replays its
 * unconfirmed pushes over the server's state (CollabBridge); and the editor
 * adopts that into its live text three ways with what it has not sent yet,
 * carrying its caret along (canvas.ts adoptRemoteEditedHtml). A loaded
 * renderer stalls now and then and runs everything that came due meanwhile
 * in one burst. Seeded: a failure names the seed that reproduces it.
 *
 * The same guarantees as midEditRaceBugs' "same point" test: nothing typed is
 * lost, nobody's word is split by the other's letters, everyone converges.
 * Which leading space ends up between the two runs stays undecidable.
 */
describe('two people typing at one point (simulated live sync)', () => {
  const html = (body: string) => `<p>${body}</p>`;
  const text = (markup: string) => markup.replace(/<[^>]*>/g, '');

  function rng(seed: number) {
    let state = seed >>> 0 || 1;
    return () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state / 0x1_0000_0000;
    };
  }

  interface Push { id: number; base: string; html: string }
  interface Editor {
    shadow: string;
    pending: Push[];
    store: string;
    dom: string;
    caret: number;
    storeBase: string;
    domBase: string;
    liveTimer: boolean;
  }

  function simulate(seed: number, runs: [string, string]): { server: string; editors: string[] } {
    const pace = rng(seed * 7919);
    const keyMs = 20 + pace() * 100;
    const latency = [pace() * 20, 20 + pace() * 300];
    const stall = pace() * 0.4;
    const random = rng(seed);
    const start = html('Base');
    let server = start;
    const editors: Editor[] = [0, 1].map(() => ({
      shadow: start, pending: [], store: start, dom: start, caret: 'Base'.length,
      storeBase: start, domBase: start, liveTimer: false,
    }));
    // `who` is the editor whose renderer runs the event; null is the server.
    const queue: Array<{ at: number; order: number; who: number | null; run: () => void }> = [];
    let order = 0;
    let clock = 0;
    const at = (time: number, who: number | null, run: () => void) => {
      queue.push({ at: time, order: order++, who, run });
    };
    const linkClock = new Map<string, number>();
    const send = (link: string, who: number | null, run: () => void) => {
      const time = Math.max(
        clock + latency[0] + random() * (latency[1] - latency[0]),
        linkClock.get(link) ?? 0, // a socket delivers in order
      );
      linkClock.set(link, time);
      at(time, who, run);
    };
    const apply = (state: string, message: Push) => (
      state === message.base ? message.html : mergeTextHtml(message.base, state, message.html)
    );
    let nextId = 1;

    const adopt = (editor: Editor) => {
      if (editor.store === editor.storeBase) return;
      const local = editor.dom;
      const remote = local === editor.domBase ? null : editor.store;
      const next = remote === null ? editor.store : mergeTextHtml(editor.domBase, remote, local);
      if (next !== local) {
        editor.caret = mapTextOffset(text(local), text(next), editor.caret);
        editor.dom = next;
      }
      editor.storeBase = editor.store;
      editor.domBase = remote === null ? editor.dom : remote;
    };
    const receive = (editor: Editor, message: Push) => {
      editor.shadow = apply(editor.shadow, message);
      editor.pending = editor.pending.filter((mine) => mine.id !== message.id);
      editor.store = editor.pending.reduce(apply, editor.shadow);
      adopt(editor);
    };
    const push = (who: number) => {
      const editor = editors[who];
      editor.liveTimer = false;
      adopt(editor);
      const current = editor.dom;
      if (editor.store === current) return;
      if (editor.store !== editor.storeBase && current === editor.domBase) return;
      const message: Push = { id: nextId++, base: editor.store, html: current };
      editor.pending.push(message);
      editor.store = current;
      editor.storeBase = current;
      editor.domBase = current;
      send(`up${who}`, null, () => {
        server = apply(server, message);
        for (const peer of [0, 1]) send(`down${peer}`, peer, () => receive(editors[peer], message));
      });
    };

    for (const who of [0, 1]) {
      let time = 0;
      for (const char of runs[who]) {
        time += keyMs * (0.8 + 0.4 * random());
        at(time, who, () => {
          const editor = editors[who];
          const body = text(editor.dom);
          editor.dom = html(body.slice(0, editor.caret) + char + body.slice(editor.caret));
          editor.caret += 1;
          if (char === ' ') push(who);
          else if (!editor.liveTimer) {
            editor.liveTimer = true;
            at(clock + 250, who, () => {
              if (editors[who].liveTimer) push(who);
            });
          }
        });
      }
      at(time + 800, who, () => push(who));
    }

    const busyUntil = [0, 0];
    while (queue.length > 0) {
      queue.sort((x, y) => x.at - y.at || x.order - y.order);
      const next = queue.shift()!;
      if (next.who !== null) {
        if (next.at >= busyUntil[next.who] && random() < stall) {
          busyUntil[next.who] = next.at + 50 + random() * 300;
        }
        if (next.at < busyUntil[next.who]) {
          next.at = busyUntil[next.who];
          queue.push(next);
          continue;
        }
      }
      clock = next.at;
      next.run();
    }
    return { server, editors: editors.map((editor) => editor.dom) };
  }

  const ALICE = ['alpha', 'apple', 'avocado', 'apricot'];
  const BOB = ['bravo', 'banana', 'blueberry', 'brownie'];
  const RUNS: [string, string] = [
    ALICE.map((word) => ` ${word}`).join(''),
    BOB.map((word) => ` ${word}`).join(''),
  ];
  const letters = (value: string) => value.replace(/\s/g, '').split('').sort().join('');

  it('loses nothing, splits no word and converges', () => {
    const failures: string[] = [];
    // Before words were aligned to seams, seeds 443, 1069 and 1138 split a
    // word ("bluebepricotrry", "brownieapri" … "cot").
    for (let seed = 1; seed <= 1500; seed += 1) {
      const { server, editors } = simulate(seed, RUNS);
      const body = text(server);
      const whole = [ALICE, BOB].every((words) => {
        let from = 0;
        return words.every((word) => {
          const found = body.indexOf(word, from);
          from = found + word.length;
          return found >= 0;
        });
      });
      if (
        !whole
        || letters(body) !== letters(['Base', ...ALICE, ...BOB].join(''))
        || editors.some((dom) => dom !== server)
      ) failures.push(`seed ${seed}: ${server}`);
    }
    expect(failures).toEqual([]);
  });
});
