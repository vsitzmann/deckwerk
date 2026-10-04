import { JSDOM } from 'jsdom';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import {
  WEB_BRIDGE_MARKER, hasWebBridgeRuntime, injectWebBridgeRuntime, isEmbeddableWebSrc, isWebBridgeAction,
} from '../src/shared/webBridge.js';
import { referencedAssets } from '../src/main/exportDeck.js';
import { EXIT_ERROR, EXIT_OK, runAgentCli } from '../src/cli/agentCli.js';
import { createDeck, loadDeck } from '../src/main/deckStore.js';
import { validateDeckIntegrity } from '../src/shared/agent.js';

/**
 * A `web` element is a sandboxed page shown live inside a slide. These tests
 * pin the parts that are not the browser's job: the schema, the authoring
 * round trip, the export knowing the page is an asset, the bridge runtime,
 * and the CLI verb that turns a complete HTML document into a slide.
 */

function node(over: Partial<MeasuredNode> = {}): MeasuredNode {
  return {
    tag: 'div', elementId: null, classes: [], dataset: {},
    rect: { x: 100, y: 200, w: 800, h: 450 }, rotation: 0, opacity: 1,
    style: {}, html: '', attrs: {}, ...over,
  };
}

describe('web element', () => {
  it('parses with defaults and refuses a missing src', () => {
    const deck = parseDeck({ version: 1, slides: [{ id: 's', elements: [{
      id: 'w', type: 'web', x: 0, y: 0, w: 1920, h: 1080, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: 'assets/web/page.html',
    }] }] });
    const element = deck.slides[0].elements[0];
    expect(element.type).toBe('web');
    if (element.type !== 'web') return;
    expect(element.poster).toBeNull();
    expect(element.interactive).toBe(true);
    expect(element.title).toBe('');
    expect(() => parseDeck({ version: 1, slides: [{ id: 's', elements: [{
      id: 'w', type: 'web', x: 0, y: 0, w: 10, h: 10, rot: 0, z: 1, opacity: 1, class: [], style: {},
    }] }] })).toThrow();
  });

  it('round-trips through the authoring HTML', () => {
    const element = elementFromNode(node({
      elementId: 'w1',
      dataset: {
        element: 'web', src: 'assets/web/chart.html', poster: 'assets/web/chart.png',
        interactive: 'false', title: 'Papers per year',
      },
    }), 'w1', 3);
    expect(element).toMatchObject({
      type: 'web', src: 'assets/web/chart.html', poster: 'assets/web/chart.png',
      interactive: false, title: 'Papers per year', x: 100, y: 200, w: 800, h: 450,
    });

    const deck = emptyDeck();
    deck.slides[0].elements.push(element!);
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('data-element="web"');
    expect(html).toContain('data-src="assets/web/chart.html"');
    expect(html).toContain('data-poster="assets/web/chart.png"');
    expect(html).toContain('object-fit:contain');
    expect(html).toContain('data-interactive="false"');
    // The stand-in inside is paint, not an object of its own.
    expect(html).toContain('<img data-element="none"');
    expect(html).not.toContain('<iframe');
  });

  it('is an asset the web export copies, poster included', () => {
    const deck = emptyDeck();
    deck.slides[0].elements.push({
      id: 'w', type: 'web', x: 0, y: 0, w: 1920, h: 1080, rot: 0, z: 1, opacity: 1, class: [], style: {},
      src: 'assets/web/page.html', poster: 'assets/web/page.png', interactive: true, title: '',
    });
    expect([...referencedAssets(deck)]).toEqual(['assets/web/page.html', 'assets/web/page.png']);
  });

  it('validates the page and poster as assets', () => {
    const deck = emptyDeck();
    deck.slides[0].elements.push({
      id: 'w', type: 'web', x: 0, y: 0, w: 1920, h: 1080, rot: 0, z: 1, opacity: 1, class: [], style: {},
      src: 'assets/web/missing.html', poster: 'assets/web/missing.png', interactive: true, title: '',
    });
    expect(validateDeckIntegrity(deck, () => false)).toEqual([
      'Missing asset for w: assets/web/missing.html',
      'Missing poster for w: assets/web/missing.png',
    ]);
  });
});

describe('web bridge', () => {
  it('only embeds deck-relative HTML documents', () => {
    expect(isEmbeddableWebSrc('assets/web/page.html')).toBe(true);
    expect(isEmbeddableWebSrc('assets/web/page.htm?x=1#top')).toBe(true);
    expect(isEmbeddableWebSrc('https://example.com/page.html')).toBe(false);
    expect(isEmbeddableWebSrc('javascript:alert(1)')).toBe(false);
    expect(isEmbeddableWebSrc('/etc/passwd.html')).toBe(false);
    expect(isEmbeddableWebSrc('assets/../deck.json')).toBe(false);
    expect(isEmbeddableWebSrc('assets/figure.png')).toBe(false);
    expect(isEmbeddableWebSrc('')).toBe(false);
  });

  it('injects the runtime into <head> once, ahead of the page scripts', () => {
    const page = '<!doctype html><html><head><title>x</title><script>window.ran=1</script></head><body></body></html>';
    const once = injectWebBridgeRuntime(page);
    expect(hasWebBridgeRuntime(once)).toBe(true);
    expect(once.indexOf(WEB_BRIDGE_MARKER)).toBeLessThan(once.indexOf('window.ran'));
    expect(injectWebBridgeRuntime(once)).toBe(once);
    // A bare fragment still gets it, at the top.
    expect(injectWebBridgeRuntime('<div>hi</div>').startsWith('<script ')).toBe(true);
  });

  it('keeps the doctype first on a page that leaves out <html> and <head>', () => {
    // Both tags are optional in HTML; the doctype is not, and anything before
    // it puts the page in quirks mode. `web check` then reported "no
    // <!doctype html>" for a page that had one, and `web add` staged it so.
    const page = '<!-- chart -->\n<!DOCTYPE html><meta charset="utf-8"><button>Go</button>';
    const injected = injectWebBridgeRuntime(page);
    expect(injected.startsWith('<!-- chart -->\n<!DOCTYPE html>')).toBe(true);
    expect(injected.indexOf(WEB_BRIDGE_MARKER)).toBeGreaterThan(injected.indexOf('<!DOCTYPE html>'));
    expect(injected.indexOf(WEB_BRIDGE_MARKER)).toBeLessThan(injected.indexOf('<button>'));
    expect(new JSDOM(injected).window.document.compatMode).toBe('CSS1Compat');
    expect(new JSDOM(`<script></script>${page}`).window.document.compatMode).toBe('BackCompat');
  });

  it('recognises only well-formed actions from a page', () => {
    expect(isWebBridgeAction({ source: 'deckwerk', action: 'next' })).toBe(true);
    expect(isWebBridgeAction({ source: 'deckwerk', action: 'key', key: 'ArrowRight' })).toBe(true);
    expect(isWebBridgeAction({ source: 'deckwerk', action: 'key' })).toBe(false);
    expect(isWebBridgeAction({ source: 'other', action: 'next' })).toBe(false);
    expect(isWebBridgeAction({ action: 'next' })).toBe(false);
    expect(isWebBridgeAction('next')).toBe(false);
  });
});

describe('slide-agent web import', { timeout: 30_000 }, () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function cli(cwd: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAgentCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t), cwd });
    return { code, stdout: out.join(''), stderr: err.join('') };
  }

  it('adds one full-canvas web slide from a complete HTML document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-import-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    await createDeck(dir, 'Deck');
    const page = join(root, 'chart.html');
    await writeFile(page, '<!doctype html><html><head><title>Papers per year</title></head><body><script>document.body.textContent="hi"</script></body></html>');

    const result = await cli(root, 'web', 'import', dir, 'chart.html');
    expect(result.code, result.stderr).toBe(EXIT_OK);
    const reply = JSON.parse(result.stdout);
    expect(reply.status).toBe('applied');
    expect(reply.src).toMatch(/^assets\/web\/chart\.[0-9a-f]{8}\.html$/);
    expect(reply.title).toBe('Papers per year');

    const deck: Deck = await loadDeck(dir);
    const slide = deck.slides.at(-1)!;
    expect(slide.id).toBe(reply.slideId);
    expect(slide.name).toBe('Papers per year');
    expect(slide.elements).toHaveLength(1);
    expect(slide.elements[0]).toMatchObject({
      type: 'web', src: reply.src, x: 0, y: 0, w: deck.canvas.w, h: deck.canvas.h, interactive: true,
    });
    // The stored copy carries the bridge runtime and the page's own script.
    const stored = await readFile(join(dir, reply.src), 'utf8');
    expect(hasWebBridgeRuntime(stored)).toBe(true);
    expect(stored).toContain('document.body.textContent');

    // Importing the same document again is a second slide over the same asset.
    const again = JSON.parse((await cli(root, 'web', 'import', dir, 'chart.html', '--after', reply.slideId, '--no-interaction')).stdout);
    expect(again.src).toBe(reply.src);
    const twice = await loadDeck(dir);
    expect(twice.slides.map((s) => s.id)).toContain(again.slideId);
    expect(twice.slides.at(-1)!.elements[0]).toMatchObject({ interactive: false });
  });

  it('stages a page as an asset at the box size without adding a slide', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-add-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    await createDeck(dir, 'Deck');
    await writeFile(join(root, 'chart.html'), '<!doctype html><html><head><title>Chart</title></head><body style="margin:0"><div id="c" style="width:100%;height:100vh;background:#def"></div><script>document.getElementById("c").textContent = "ok";</script></body></html>');

    const checked = await cli(root, 'web', 'check', 'chart.html', '--size', '1200x600');
    expect(checked.code, checked.stderr).toBe(EXIT_OK);
    const result = await cli(root, 'web', 'add', dir, 'chart.html', '--size', '1200x600');
    expect(result.code, result.stderr).toBe(EXIT_OK);
    const reply = JSON.parse(result.stdout);
    expect(reply.src).toMatch(/^assets\/web\/chart\.[0-9a-f]{8}\.html$/);
    expect(reply.markup).toContain(`data-src="${reply.src}"`);
    expect(reply.markup).toContain('style="width:1200px;height:600px"');
    expect(reply.cacheHit).toBe(true);
    expect(reply.durationMs).toBeTypeOf('number');
    // Poster capture is best-effort: a source checkout may not have a built
    // export player or a browser available. When capture succeeds, both the
    // reply and authoring markup point at the staged image.
    if (reply.poster) {
      expect(reply.poster).toMatch(/\.poster\.png$/);
      expect(existsSync(join(dir, reply.poster))).toBe(true);
      expect(reply.markup).toContain(`data-poster="${reply.poster}"`);
    }
    // An asset, not a slide: the deck is as it was.
    expect((await loadDeck(dir)).slides).toHaveLength(1);
  });

  it('replaces the page behind an existing web slide and drops the old files', { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-replace-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    await createDeck(dir, 'Deck');
    await writeFile(join(root, 'v1.html'), '<!doctype html><html><head><title>V1</title></head><body><script>document.body.textContent="one"</script></body></html>');
    await writeFile(join(root, 'v2.html'), '<!doctype html><html><head><title>V2</title></head><body><script>document.body.textContent="two"</script></body></html>');
    const first = JSON.parse((await cli(root, 'web', 'import', dir, 'v1.html', '--no-poster')).stdout);
    const before = await loadDeck(dir);
    const target = before.slides.find((slide) => slide.id === first.slideId)!.elements[0];
    target.w = 1200;
    target.h = 600;
    await writeFile(join(dir, 'deck.json'), `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    const inspected = await cli(root, 'web', 'inspect', dir, first.slideId);
    expect(inspected.code, inspected.stderr).toBe(EXIT_OK);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      slideId: first.slideId,
      elementId: target.id,
      src: first.src,
      size: [1200, 600],
      missingAssets: [],
    });

    const checked = await cli(root, 'web', 'check', 'v2.html', '--replace', first.slideId, '--deck', dir);
    expect(checked.code, checked.stderr).toBe(EXIT_OK);
    expect(JSON.parse(checked.stdout)).toMatchObject({
      size: { w: 1200, h: 600 },
      replaceTarget: { slideId: first.slideId, elementId: target.id },
    });

    const result = await cli(root, 'web', 'replace', dir, first.slideId, 'v2.html');
    expect(result.code, result.stderr).toBe(EXIT_OK);
    const reply = JSON.parse(result.stdout);
    expect(reply.slideId).toBe(first.slideId);
    expect(reply.src).not.toBe(first.src);
    expect(reply.title).toBe('V2');

    const after = await loadDeck(dir);
    expect(after.slides).toHaveLength(before.slides.length);
    const element = after.slides.find((s) => s.id === first.slideId)!.elements[0];
    expect(element).toMatchObject({ type: 'web', src: reply.src, title: 'V2' });
    expect(existsSync(join(dir, reply.src))).toBe(true);
    expect(existsSync(join(dir, first.src))).toBe(false);
    if (reply.poster) expect(existsSync(join(dir, reply.poster))).toBe(true);
  });

  it('refuses a file that is not HTML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-import-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    await createDeck(dir, 'Deck');
    await writeFile(join(root, 'notes.txt'), 'plain');
    const result = await cli(root, 'web', 'import', dir, 'notes.txt');
    expect(result.code).toBe(EXIT_ERROR);
  });

  it('reports visible labels clipped by an overflow-hidden page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-check-clipped-'));
    cleanup.push(root);
    await writeFile(join(root, 'clipped.html'), '<!doctype html><html><body style="margin:0;overflow:hidden"><span style="position:absolute;left:-30px;top:20px">Clipped label</span><script>window.ready=true</script></body></html>');
    const result = await cli(root, 'web', 'check', 'clipped.html', '--size', '400x200');
    expect(result.code).toBe(EXIT_ERROR);
    expect(JSON.parse(result.stdout).problems).toEqual([
      expect.stringMatching(/visible text\/control box.*may be clipped/),
    ]);
  });
});
