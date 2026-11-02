import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import {
  MOD,
  startListEditingSession,
  type ListEditingSession,
  type TextRun,
} from './support/listEditingSession.js';

/**
 * Inline formatting across a line break, and the two keyboard ways of making
 * a list — all real input, all checked against what the author sees.
 *
 * Reported:
 *  - underline on, type, underline off, Return: the new line is underlined
 *    again. The pending "off" run held nothing but its sentinel, and the caret
 *    it left behind was restored by flat offset — inside the underlined span,
 *    which Chromium then cloned into the new paragraph.
 *  - underline on in a "- " line, type, Return: the underline is lost on both
 *    lines. The typed-marker conversion rebuilt the item from `textContent`.
 *  - two items at different levels selected, Tab: both indent, and an empty
 *    first-level bullet appears between them. `execCommand('indent')` over a
 *    multi-item range is Chromium's, not ours.
 *
 * Requested: "- " or "* " followed by a space starts a bullet at once, not
 * only on Return at the end of the line.
 */
const SHIFT = 8;
const FORMATS = [
  { name: 'bold', key: 'b', code: 'KeyB', keyCode: 66 },
  { name: 'italic', key: 'i', code: 'KeyI', keyCode: 73 },
  { name: 'underline', key: 'u', code: 'KeyU', keyCode: 85 },
] as const;
type FormatName = typeof FORMATS[number]['name'];

let session: ListEditingSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startListEditingSession('formatting-across-breaks', 'Formatting Breaks');
  session = started.session;
  close = started.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  close = null;
});

async function toggle(format: FormatName): Promise<void> {
  const spec = FORMATS.find((candidate) => candidate.name === format)!;
  await session.cdp.chord(spec.key, spec.code, spec.keyCode, MOD);
  await wait(40);
}

/** The runs holding `text`, as `text[b][i][u]@block` for readable failures. */
function picture(runs: TextRun[]): string[] {
  return runs.map((run) => `${run.text}${run.bold ? '[b]' : ''}${run.italic ? '[i]' : ''}`
    + `${run.underline ? '[u]' : ''}@${run.blockTag}${run.block}`);
}

function runOf(runs: TextRun[], text: string): TextRun {
  const run = runs.find((candidate) => candidate.text.includes(text));
  expect(run, `no run holding ${JSON.stringify(text)} in ${picture(runs).join(' ')}`).toBeTruthy();
  return run!;
}

describe.skipIf(!electronBinary)('inline formatting across a line break', () => {
  for (const { name } of FORMATS) {
    it(`${name} turned off before Return stays off on the new line`, { timeout: 120_000 }, async () => {
      await session.reset('<p>alpha</p>');
      await session.edit();
      await session.caretIn('alpha', 'end');
      await session.cdp.typeKeys(' ');
      await toggle(name);
      await session.cdp.typeKeys('styled');
      await toggle(name);
      await session.cdp.key('Enter', 13);
      await session.cdp.typeKeys('plain');
      const runs = await session.runs();
      const shown = picture(runs).join(' ');
      expect(runOf(runs, 'styled')[name], `styled run lost ${name}: ${shown}`).toBe(true);
      expect(runOf(runs, 'styled').block, `styled run left its line: ${shown}`).toBe(0);
      const plain = runOf(runs, 'plain');
      expect(plain.block, `the new line is not a new block: ${shown}`).toBe(1);
      expect(plain[name], `${name} came back on the new line: ${shown}`).toBe(false);
      expect(await session.liveProblems()).toEqual([]);
    });

    it(`${name} still on at Return carries onto the new line`, { timeout: 120_000 }, async () => {
      await session.reset('<p>alpha</p>');
      await session.edit();
      await session.caretIn('alpha', 'end');
      await session.cdp.typeKeys(' ');
      await toggle(name);
      await session.cdp.typeKeys('styled');
      await session.cdp.key('Enter', 13);
      await session.cdp.typeKeys('more');
      const runs = await session.runs();
      const shown = picture(runs).join(' ');
      expect(runOf(runs, 'styled')[name], `styled run lost ${name}: ${shown}`).toBe(true);
      const more = runOf(runs, 'more');
      expect(more.block, `the new line is not a new block: ${shown}`).toBe(1);
      expect(more[name], `${name} was dropped by Return: ${shown}`).toBe(true);
      expect(runOf(runs, 'alpha')[name], `alpha caught ${name}: ${shown}`).toBe(false);
      expect(await session.liveProblems()).toEqual([]);
    });
  }

  // Found by the list fuzz once it read formatting: the run that replaces a
  // sealed pending run started bare, so switching underline off switched
  // bold off with it.
  it('switching one format off keeps the other on, before and after Return', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>alpha</p>');
    await session.edit();
    await session.caretIn('alpha', 'end');
    await session.cdp.typeKeys(' ');
    await toggle('bold');
    await toggle('underline');
    await session.cdp.typeKeys('both');
    await toggle('underline');
    await session.cdp.typeKeys('boldonly');
    await session.cdp.key('Enter', 13);
    await session.cdp.typeKeys('next');
    const runs = await session.runs();
    const shown = picture(runs).join(' ');
    expect(runOf(runs, 'both'), shown).toMatchObject({ bold: true, underline: true, block: 0 });
    expect(runOf(runs, 'boldonly'), shown).toMatchObject({ bold: true, underline: false, block: 0 });
    expect(runOf(runs, 'next'), shown).toMatchObject({ bold: true, underline: false, block: 1 });
    expect(await session.liveProblems()).toEqual([]);
  });

  it('underline in a typed "- " line survives the Return that makes it a bullet', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>Text</p>');
    await session.edit();
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    await session.cdp.typeKeys('- ');
    await toggle('underline');
    await session.cdp.typeKeys('under');
    await session.cdp.key('Enter', 13);
    expect(await session.outline()).toEqual(['ul', '- under', '- ']);
    let runs = await session.runs();
    expect(runOf(runs, 'under').underline, `underline lost: ${picture(runs).join(' ')}`).toBe(true);
    await session.cdp.typeKeys('more');
    runs = await session.runs();
    const shown = picture(runs).join(' ');
    expect(runOf(runs, 'under').underline, `first item lost underline: ${shown}`).toBe(true);
    expect(runOf(runs, 'more').block, `second item: ${shown}`).toBe(1);
    expect(runOf(runs, 'more').underline, `second item lost underline: ${shown}`).toBe(true);
    expect(await session.outline()).toEqual(['ul', '- under', '- more']);
    expect(await session.liveProblems()).toEqual([]);
  });

  // Found by the nightly list fuzz (seeds 20261031, 2026103101): on an empty
  // line the caret's formats were read from a neighbouring line's word, so
  // Return there opened a line in that word's bold and underline, and Cmd+B
  // there switched bold "off" and typed plain.
  const LOUD = '<p><span style="font-weight: 700; text-decoration-line: underline;">loud</span></p>';
  for (const { where, html, empty } of [
    { where: 'below', html: `<p><br></p>${LOUD}`, empty: 0 },
    { where: 'above', html: `${LOUD}<p><br></p><p>plain</p>`, empty: 1 },
  ]) {
    it(`Return on an empty line takes no format from the line ${where} it`, { timeout: 120_000 }, async () => {
      await session.reset(html);
      await session.edit();
      await session.caretInBlock(empty);
      await session.cdp.key('Enter', 13);
      await session.cdp.typeKeys('next');
      const runs = await session.runs();
      const shown = `${picture(runs).join(' ')} ${await session.markup()}`;
      expect(runOf(runs, 'next'), shown)
        .toMatchObject({ bold: false, italic: false, underline: false, block: empty + 1 });
      expect(runOf(runs, 'loud'), shown).toMatchObject({ bold: true, underline: true });
      expect(await session.liveProblems()).toEqual([]);
    });

    it(`Cmd+B on an empty line with a bold line ${where} it switches bold on`, { timeout: 120_000 }, async () => {
      await session.reset(html);
      await session.edit();
      await session.caretInBlock(empty);
      await toggle('bold');
      await session.cdp.typeKeys('now');
      const runs = await session.runs();
      const shown = `${picture(runs).join(' ')} ${await session.markup()}`;
      expect(runOf(runs, 'now'), shown).toMatchObject({ bold: true, underline: false, block: empty });
      expect(await session.liveProblems()).toEqual([]);
    });
  }
});

describe.skipIf(!electronBinary)('typing "- " or "* " starts a bullet at once', () => {
  for (const marker of ['-', '*']) {
    it(`"${marker} " on an empty line opens a bullet before any text is typed`, {
      timeout: 120_000,
    }, async () => {
      await session.reset('<p>Text</p>');
      await session.edit();
      await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      await session.cdp.typeKeys(`${marker} `);
      expect(await session.outline(), 'the space did not open a bullet').toEqual(['ul', '- ']);
      await session.cdp.typeKeys('hello');
      expect(await session.outline()).toEqual(['ul', '- hello']);
      await session.cdp.key('Enter', 13);
      await session.cdp.typeKeys('world');
      expect(await session.outline()).toEqual(['ul', '- hello', '- world']);
      await session.expectPersisted((lines) => lines.join('|') === 'ul|- hello|- world', 'stored');
      expect(await session.liveProblems()).toEqual([]);
    });
  }

  it('"- " at the start of a line that already has text bullets that text', { timeout: 120_000 }, async () => {
    await session.reset('<p>alpha</p><p>beta</p>');
    await session.edit();
    await session.caretIn('beta', 'start');
    await session.cdp.typeKeys('- ');
    expect(await session.outline()).toEqual(['p: alpha', 'ul', '- beta']);
    expect(await session.liveProblems()).toEqual([]);
  });

  it('a dash and a space in the middle of a line is just text', { timeout: 120_000 }, async () => {
    await session.reset('<p>alpha</p>');
    await session.edit();
    await session.caretIn('alpha', 'end');
    await session.cdp.typeKeys(' - beta');
    expect(await session.outline()).toEqual(['p: alpha - beta']);
  });

  it('a pending underline survives "- " and styles what is typed into the bullet', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p><br></p>');
    await session.edit();
    await toggle('underline');
    await session.cdp.typeKeys('- under');
    expect(await session.outline()).toEqual(['ul', '- under']);
    const runs = await session.runs();
    expect(runOf(runs, 'under').underline, `${picture(runs).join(' ')} ${await session.markup()}`)
      .toBe(true);
    expect(await session.liveProblems()).toEqual([]);
  });
});



describe.skipIf(!electronBinary)('Tab over a selection spanning two levels', () => {
  const EXPECTED = ['ul', '- alpha', '  ul', '  - beta', '    ul', '    - gamma'];

  async function selectBetaToGamma(): Promise<void> {
    await session.caretIn('beta', 'start');
    await session.cdp.chord('ArrowDown', 'ArrowDown', 40, SHIFT);
    await session.cdp.chord('End', 'End', 35, SHIFT);
  }

  it('indents both items from the saved nesting shape without inventing a bullet', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<ul><li>alpha</li><li>beta<ul><li>gamma</li></ul></li></ul>');
    await session.edit();
    await selectBetaToGamma();
    await session.cdp.key('Tab', 9);
    expect(await session.outline()).toEqual(EXPECTED);
    expect(await session.liveProblems()).toEqual([]);
    await session.expectPersisted((lines) => lines.join('|') === EXPECTED.join('|'), 'stored');
  });

  it('indents both items from the shape Tab itself writes without inventing a bullet', {
    timeout: 120_000,
  }, async () => {
    await session.reset('<p>alpha</p><p>beta</p><p>gamma</p>');
    await session.edit();
    await session.cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    expect(await session.chooseList('Bulleted')).toEqual(['Bulleted']);
    await session.caretIn('gamma', 'end');
    await session.cdp.key('Tab', 9);
    expect(await session.outline()).toEqual(['ul', '- alpha', '- beta', '  ul', '  - gamma']);
    await selectBetaToGamma();
    await session.cdp.key('Tab', 9);
    expect(await session.outline()).toEqual(EXPECTED);
    expect(await session.liveProblems()).toEqual([]);
    await session.expectPersisted((lines) => lines.join('|') === EXPECTED.join('|'), 'stored');
  });
});

describe.skipIf(electronBinary)('formatting across breaks (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
