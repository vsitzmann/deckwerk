import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type Slide } from '../src/shared/deck.js';
import {
  FEATURES_FILE,
  TUTORIAL_MARKER_FILE,
  TUTORIAL_TEMPLATE_FILE,
  askAgentPrompt,
  desktopTutorialLink,
  mergeTutorialUpdate,
  parseFeatures,
  parseTutorialLink,
} from '../src/shared/tutorial.js';
import { findShippedTutorial, installTutorial, shippedTutorialVersion } from '../src/main/tutorial.js';
import { loadDeck, saveDeck } from '../src/main/deckStore.js';
import { validateDeckFolder } from '../src/main/agentDeck.js';

const SHIPPED = resolve('resources/tutorial');

const scratch: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'deckwerk-tutorial-'));
  scratch.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function slide(id: string, elementIds: string[] = [`${id}-text`]): Slide {
  return {
    ...emptyDeck().slides[0]!,
    id,
    name: id,
    elements: elementIds.map((elementId) => ({
      id: elementId, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1, opacity: 1, class: [], style: {}, html: elementId,
    })) as unknown as Slide['elements'],
    timeline: [],
  };
}
function deckOf(...slides: Slide[]): Deck {
  return { ...emptyDeck(), slides };
}
const ids = (deck: Deck): string[] => deck.slides.map((item) => item.id);

describe('the shipped tutorial', () => {
  it('is a valid deck with every asset it references', async () => {
    expect(await validateDeckFolder(SHIPPED)).toEqual([]);
  });

  it('has a FEATURES.md that names only slides the deck has, and every slide it has', async () => {
    const deck = await loadDeck(SHIPPED);
    const features = parseFeatures(await readFile(join(SHIPPED, FEATURES_FILE), 'utf8'));
    expect(features.length).toBeGreaterThan(10);
    const featureIds = features.map((feature) => feature.id);
    expect(new Set(featureIds).size).toBe(featureIds.length);
    const slideIds = new Set(ids(deck));
    for (const feature of features) {
      for (const id of feature.slides) expect(slideIds, `${feature.id} names ${id}`).toContain(id);
      expect(feature.aliases.length, `${feature.id} has an Also called: line`).toBeGreaterThan(0);
    }
    const referenced = new Set(features.flatMap((feature) => feature.slides));
    expect(ids(deck).filter((id) => !referenced.has(id)), 'tutorial slides no FEATURES.md entry links').toEqual([]);
  });

  it('says on its first slide that an agent can answer questions about any feature', async () => {
    const deck = await loadDeck(SHIPPED);
    const text = deck.slides[0]!.elements.map((element) => ('html' in element ? element.html : '')).join(' ');
    expect(text).toContain('Your agent knows every feature');
    expect(text).toContain('Question? Ask your agent!');
  });

  it('is found from a checkout, and from a packaged app’s resources first', async () => {
    expect(findShippedTutorial({ searchFrom: [join(SHIPPED, '..', '..', 'src', 'main')] })).toBe(SHIPPED);
    const resources = await tempDir();
    await cp(SHIPPED, join(resources, 'tutorial'), { recursive: true });
    expect(findShippedTutorial({ resourcesPath: resources, searchFrom: [process.cwd()] })).toBe(join(resources, 'tutorial'));
    expect(findShippedTutorial({ resourcesPath: await tempDir(), searchFrom: [] })).toBeNull();
  });
});

describe('tutorial links', () => {
  it('round-trip a slide id, and open the tutorial without one', () => {
    expect(parseTutorialLink(desktopTutorialLink('slide-62'))).toEqual({ slideId: 'slide-62' });
    expect(parseTutorialLink(desktopTutorialLink('slide 58/1'))).toEqual({ slideId: 'slide 58/1' });
    expect(parseTutorialLink(desktopTutorialLink())).toEqual({ slideId: null });
    expect(parseTutorialLink('deckwerk:///tutorial/slide-62')).toEqual({ slideId: 'slide-62' });
    expect(parseTutorialLink('deckwerk://tutorial?slide=slide-62')).toEqual({ slideId: 'slide-62' });
  });

  it('refuse anything that is not a tutorial link', () => {
    expect(parseTutorialLink('https://tutorial/slide-62')).toBeNull();
    expect(parseTutorialLink('deckwerk://deck/slide-62')).toBeNull();
    expect(parseTutorialLink('deckwerk://tutorial/a/b')).toBeNull();
    expect(parseTutorialLink('not a url')).toBeNull();
  });
});

describe('the ask-your-agent prompt', () => {
  it('points a desktop agent at FEATURES.md in the person’s tutorial and says how to link', () => {
    const prompt = askAgentPrompt({ kind: 'desktop', tutorialDir: '/Users/me/Library/Application Support/DeckWerk/Tutorial/' });
    expect(prompt).toContain('/Users/me/Library/Application Support/DeckWerk/Tutorial/FEATURES.md');
    expect(prompt).toContain('deckwerk://tutorial/<slide-id>');
    expect(prompt.trimEnd().endsWith('My question:')).toBe(true);
  });

  it('points a server agent at the server’s FEATURES.md and tutorial', () => {
    const prompt = askAgentPrompt({
      kind: 'server',
      origin: 'https://lab.example:9443',
      featuresUrl: 'https://lab.example:9443/tutorial/FEATURES.md',
      tutorialUrl: 'https://lab.example:9443/?deck=tutorial',
    });
    expect(prompt).toContain('https://lab.example:9443/tutorial/FEATURES.md');
    expect(prompt).toContain('https://lab.example:9443/?deck=tutorial');
  });
});

describe('mergeTutorialUpdate', () => {
  it('replaces shipped slides and keeps added ones after the slide they followed', () => {
    const user = deckOf(slide('a'), slide('mine-1'), slide('b'), slide('gone'), slide('mine-2'));
    user.slides[0]!.name = 'edited by the person';
    const shipped = deckOf(slide('a'), slide('new'), slide('b'));
    const merged = mergeTutorialUpdate(shipped, ['a', 'b', 'gone'], user);
    expect(ids(merged)).toEqual(['a', 'mine-1', 'new', 'b', 'mine-2']);
    expect(merged.slides[0]!.name).toBe('a');
  });

  it('puts an added first slide first, and keeps added slides in their order', () => {
    const user = deckOf(slide('mine-1'), slide('mine-2'), slide('a'));
    expect(ids(mergeTutorialUpdate(deckOf(slide('a')), ['a'], user))).toEqual(['mine-1', 'mine-2', 'a']);
  });

  it('drops an added slide whose object ids the new release took, rather than produce a deck that will not open', () => {
    const user = deckOf(slide('a'), slide('mine', ['shared-id']));
    const shipped = deckOf(slide('a'), slide('new', ['shared-id']));
    expect(ids(mergeTutorialUpdate(shipped, ['a'], user))).toEqual(['a', 'new']);
  });
});

describe('installTutorial', () => {
  /** A copy of the shipped tutorial this test can change, as a new release would. */
  async function shippedCopy(): Promise<string> {
    const dir = await tempDir();
    await cp(SHIPPED, dir, { recursive: true });
    return dir;
  }

  it('installs a fresh copy with the reference, a slide template and a marker', async () => {
    const shipped = await shippedCopy();
    const target = join(await tempDir(), 'Tutorial');
    expect(await installTutorial(shipped, target)).toBe('created');
    expect(ids(await loadDeck(target))).toEqual(ids(await loadDeck(shipped)));
    expect(await readFile(join(target, 'theme.css'), 'utf8')).toBe(await readFile(join(shipped, 'theme.css'), 'utf8'));
    expect(await readFile(join(target, FEATURES_FILE), 'utf8')).toBe(await readFile(join(shipped, FEATURES_FILE), 'utf8'));
    expect((await readdir(join(target, 'assets'))).sort()).toEqual((await readdir(join(shipped, 'assets'))).sort());
    const marker = JSON.parse(await readFile(join(target, TUTORIAL_MARKER_FILE), 'utf8')) as { version: string };
    expect(marker.version).toBe((await shippedTutorialVersion(shipped)).version);
    expect(await validateDeckFolder(target)).toEqual([]);
  });

  it('writes a template that can only add slides, and resolves assets from where it sits', async () => {
    const target = join(await tempDir(), 'Tutorial');
    await installTutorial(await shippedCopy(), target);
    const template = await readFile(join(target, TUTORIAL_TEMPLATE_FILE), 'utf8');
    expect(template).not.toContain('<!-- slide-editor-scope:');
    expect(template).not.toMatch(/data-slide-id="/);
    expect(template).toContain('<base href="../">');
    // templates/ sits one level below the deck, like edit/.
    expect(TUTORIAL_TEMPLATE_FILE.split('/')).toHaveLength(2);
  });

  it('leaves the person’s edits alone while the release is the same', async () => {
    const shipped = await shippedCopy();
    const target = join(await tempDir(), 'Tutorial');
    await installTutorial(shipped, target);
    const edited = await loadDeck(target);
    edited.slides.push(slide('mine'));
    edited.slides[1]!.name = 'tried the steps';
    await saveDeck(target, edited);
    expect(await installTutorial(shipped, target)).toBe('current');
    const after = await loadDeck(target);
    expect(after.slides.at(-1)!.id).toBe('mine');
    expect(after.slides[1]!.name).toBe('tried the steps');
  });

  it('brings a copy up to a new release, keeping added slides and a theme the person changed', async () => {
    const shipped = await shippedCopy();
    const target = join(await tempDir(), 'Tutorial');
    await installTutorial(shipped, target);
    const mine = await loadDeck(target);
    const firstId = mine.slides[0]!.id;
    mine.slides.splice(1, 0, slide('mine'));
    mine.slides[0]!.name = 'tried the steps';
    await saveDeck(target, mine);
    await writeFile(join(target, 'theme.css'), '/* my own */\n', 'utf8');

    const release = await loadDeck(shipped);
    release.slides.push(slide('shipped-later'));
    await saveDeck(shipped, release);
    await writeFile(join(shipped, FEATURES_FILE), '# newer reference\n', 'utf8');

    expect(await installTutorial(shipped, target)).toBe('updated');
    const after = await loadDeck(target);
    expect(after.slides[0]!.id).toBe(firstId);
    expect(after.slides[0]!.name).toBe(release.slides[0]!.name);
    expect(after.slides[1]!.id).toBe('mine');
    expect(after.slides.at(-1)!.id).toBe('shipped-later');
    expect(await readFile(join(target, 'theme.css'), 'utf8')).toBe('/* my own */\n');
    expect(await readFile(join(target, FEATURES_FILE), 'utf8')).toBe('# newer reference\n');
  });

  it('replaces an unchanged theme with the new release’s', async () => {
    const shipped = await shippedCopy();
    const target = join(await tempDir(), 'Tutorial');
    await installTutorial(shipped, target);
    await writeFile(join(shipped, 'theme.css'), '/* new release */\n', 'utf8');
    expect(await installTutorial(shipped, target)).toBe('updated');
    expect(await readFile(join(target, 'theme.css'), 'utf8')).toBe('/* new release */\n');
  });

  it('in replace mode, writes the shipped deck over whatever is there', async () => {
    const shipped = await shippedCopy();
    const target = join(await tempDir(), 'Tutorial');
    await installTutorial(shipped, target, { mode: 'replace' });
    const changed = await loadDeck(target);
    changed.slides.push(slide('mine'));
    await saveDeck(target, changed);
    const release = await loadDeck(shipped);
    release.slides[0]!.name = 'new release';
    await saveDeck(shipped, release);
    expect(await installTutorial(shipped, target, { mode: 'replace' })).toBe('updated');
    expect(ids(await loadDeck(target))).toEqual(ids(release));
  });

  it('keeps the bytes of a copy that no longer loads, and installs a working one', async () => {
    const shipped = await shippedCopy();
    const target = join(await tempDir(), 'Tutorial');
    await installTutorial(shipped, target);
    await writeFile(join(target, 'deck.json'), '{ broken', 'utf8');
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = await loadDeck(shipped);
    release.slides[0]!.name = 'new release';
    await saveDeck(shipped, release);
    expect(await installTutorial(shipped, target)).toBe('updated');
    expect(ids(await loadDeck(target))).toEqual(ids(release));
    expect((await readdir(target)).some((name) => name.startsWith('deck.before-update.'))).toBe(true);
    expect(existsSync(join(target, FEATURES_FILE))).toBe(true);
    expect(reported).toHaveBeenCalledOnce();
    reported.mockRestore();
  });
});
