import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { validateDeckIntegrity } from '../src/shared/agent.js';
import type { Deck, Slide } from '../src/shared/deck.js';
import { sameSlideContent } from '../src/shared/htmlSlides.js';
import { electronBinary } from './support/browserSession.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';
import {
  sectionIds,
  startWorkspace,
  until,
  type AgentWorkspace,
  type CommandResult,
  type HostedWorkspace,
  type WorkspaceKind,
} from './support/agentWorkspace.js';

/**
 * Agent collaboration fuzz: a seeded random walk of what agents do to decks,
 * through every door an agent has — the CLI beside a closed deck, the live
 * desktop editor, a hosted session's mirror — with a person editing the same
 * deck alongside.
 *
 * The agent's moves are the brief's: write a new page (headings, prose,
 * lists, maths with an escaped dollar, pictures, shapes, flex layouts, layout
 * slots, builds) and put it first, last or after a named slide; export slides
 * and edit them the way an agent with an HTML parser does — rewrite a phrase,
 * add, remove and restyle objects, toggle builds, reorder, delete and add
 * sections; re-save a page untouched; apply the same page twice; save
 * without applying and let the watcher sync it. The person's moves are what
 * people do in a session: notes, comments, skipping a slide, rewriting a
 * phrase, adding and deleting slides — on a hosted deck over the WebSocket,
 * sometimes while the agent's page is compiling; beside a local deck through
 * the same CLI transactions any second writer would use.
 *
 * A model of the deck — its slide order, the phrases each slide must and must
 * not hold, the notes, skips and comments people gave it — is checked after
 * every step, along with the deck's integrity, what each reply said it
 * changed, the ids stamped back into each page, maths staying TeX, and (when
 * hosted) the mirror and the person converging on the server's deck.
 *
 * `AGENT_FUZZ_SEEDS` (comma-separated), `AGENT_FUZZ_STEPS`,
 * `AGENT_FUZZ_BACKENDS` and `FUZZ_SEED` are the knobs; a failure names the
 * seed, the step and every step before it.
 */

const STEPS = Number.parseInt(process.env.AGENT_FUZZ_STEPS ?? '', 10) || 18;
const SEEDS = [
  ...(process.env.AGENT_FUZZ_SEEDS?.split(',').map((value) => Number.parseInt(value, 10)).filter(Number.isFinite)
    ?? [20261004]),
  ...extraFuzzSeeds(),
];
const BACKENDS = (process.env.AGENT_FUZZ_BACKENDS?.split(',') ?? ['offline', 'desktop', 'hosted']) as WorkspaceKind[];

/** A small, reproducible pseudo-random source. */
function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

interface ModelSlide {
  /** Phrases this slide must hold, somewhere in its text. */
  markers: Set<string>;
  notes: string;
  skipped: boolean;
  comments: number;
}

interface Changes { replaced: string[]; inserted: string[]; deleted: string[]; moved: number }

const WORDS = ['signal', 'world', 'model', 'scene', 'memory', 'policy', 'video', 'robot', 'planner', 'latent', 'render', 'agent'];

class Walk {
  readonly next: () => number;
  /** The deck as the model says it must be, in order. */
  readonly order: string[] = [];
  readonly slides = new Map<string, ModelSlide>();
  /** Phrases removed from the deck: none may come back. */
  readonly gone = new Set<string>();
  readonly trail: string[] = [];
  private tokens = 0;
  private pages = 0;
  /** A page the agent last synced, for re-applying it. */
  private lastPage: string | null = null;

  constructor(readonly ws: AgentWorkspace, readonly seed: number) {
    this.next = random(seed);
  }

  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  token(): string {
    this.tokens += 1;
    // Fixed width: no phrase may be a prefix of a later one, or "removed"
    // would find the later one and cry wolf.
    return `zq${(this.seed % 46656).toString(36)}x${this.tokens.toString(36).padStart(4, '0')}`;
  }

  phrase(token: string): string {
    return `${token} ${this.pick(WORDS)} ${this.pick(WORDS)}`;
  }

  /** Adopt the deck as it stands as the model's starting point. */
  async begin(): Promise<void> {
    const deck = await this.ws.deck();
    for (const slide of deck.slides) {
      this.order.push(slide.id);
      this.slides.set(slide.id, {
        markers: new Set(), notes: slide.notes, skipped: slide.skipped ?? false, comments: slide.comments?.length ?? 0,
      });
    }
  }

  /* --- the agent ------------------------------------------------------------ */

  /** One section of new content, with the phrases it puts in the deck. */
  section(): { html: string; markers: string[] } {
    const markers: string[] = [];
    const say = () => {
      const token = this.token();
      markers.push(token);
      return this.phrase(token);
    };
    const build = () => (this.chance(0.25) ? ` data-build="${this.pick(['click', 'afterPrev+200', 'withPrev'])}"` : '');
    const parts: string[] = [];
    const kind = this.pick(['title', 'prose', 'list', 'flex', 'layout', 'maths']);
    if (kind === 'layout') {
      const title = say();
      const body = this.chance(0.5)
        ? `<ul data-layout-slot="body"><li>${say()}</li><li>${say()}</li></ul>`
        : '';
      return {
        html: `<section class="slide" data-layout="${body ? 'standard' : 'title'}"><h1 data-layout-slot="title">${title}</h1>${body}</section>`,
        markers,
      };
    }
    parts.push(`<h1 class="role-title"${build()}>${say()}</h1>`);
    if (kind === 'prose') parts.push(`<p class="role-body"${build()}>${say()} with <b>${this.pick(WORDS)}</b> and <i>${this.pick(WORDS)}</i></p>`);
    if (kind === 'list') parts.push(`<ul class="role-body"${build()}><li>${say()}</li><li>${say()}</li><li>${say()}</li></ul>`);
    if (kind === 'maths') {
      // TeX the player renders, and a dollar sign meant literally.
      parts.push(`<p class="role-body"${build()}>${say()} costs \\$5 and $E = mc^2$ holds</p>`);
    }
    if (kind === 'flex') {
      parts.push(`<div style="display:flex; gap:40px; align-items:center">`
        + `<p class="role-body" style="flex:1"${build()}>${say()}</p>`
        + (this.chance(0.5)
          ? '<img src="assets/pic.png" style="width:300px; height:200px; object-fit:cover">'
          : '<div style="width:200px; height:120px; background:#cc5533; border-radius:12px"></div>')
        + '</div>');
    }
    const padding = this.pick([60, 90, 120]);
    return {
      html: `<section class="slide" style="padding:${padding}px; display:flex; flex-direction:column; gap:24px">${parts.join('')}</section>`,
      markers,
    };
  }

  /** `new`, filled in, put somewhere: last, first, or after a slide named by number or id. */
  async addPage(): Promise<void> {
    const count = this.pick([1, 1, 2]);
    const fresh = Array.from({ length: count }, () => this.section());
    const start = await this.ws.run('new', '.', '--count', String(count));
    this.expect(start.code === 0, `new failed: ${start.stderr}`);
    let page = start.stdout;
    for (const section of fresh) {
      page = page.replace(/<section class="slide" data-placeholder="true">\s*<h1 class="role-title">Title<\/h1>\s*<\/section>/, section.html);
    }
    const where = this.pick(['last', 'last', 'first', 'number', 'id']);
    const anchorIndex = Math.floor(this.next() * this.order.length);
    const after = where === 'first' ? '0'
      : where === 'number' ? String(anchorIndex + 1)
        : where === 'id' ? this.order[anchorIndex] : null;
    const file = `add-${++this.pages}.html`;
    const watched = after === null && this.ws.saveWatched && this.chance(0.4);
    this.log(`add ${count} slide${count === 1 ? '' : 's'} (${watched ? 'watched save' : `apply${after === null ? '' : ` --after ${after}`}`})`);
    let ids: string[];
    if (watched) {
      const saved = await this.ws.saveWatched!(file, page);
      this.expect(saved.outcome === 'saved', `the watched save did not land: ${saved.line}`);
      ids = await until(async () => {
        const stamped = sectionIds(await this.ws.read(file));
        return stamped.length === count && stamped.every(Boolean) ? stamped as string[] : null;
      }, 'the id stamp');
    } else {
      await this.ws.write(file, page);
      const changes = this.landed(await this.apply(file, after === null ? [] : ['--after', after]));
      this.expect(changes.inserted.length === count, `expected ${count} inserted, got ${JSON.stringify(changes)}`);
      this.expect(changes.deleted.length === 0 && changes.replaced.length === 0, `an add replaced or deleted: ${JSON.stringify(changes)}`);
      ids = changes.inserted;
    }
    const at = after === null ? this.order.length : after === '0' ? 0 : anchorIndex + 1;
    this.order.splice(at, 0, ...ids);
    ids.forEach((id, index) => this.slides.set(id, {
      markers: new Set(fresh[index].markers), notes: '', skipped: false, comments: 0,
    }));
    this.lastPage = file;
  }

  /** Export some slides, edit the page the way an agent with an HTML parser does, save it. */
  async editPage(): Promise<void> {
    const span = Math.min(this.order.length, this.pick([1, 1, 2, 3]));
    const from = Math.floor(this.next() * (this.order.length - span + 1));
    const scope = this.order.slice(from, from + span);
    const exported = await this.ws.run('inspect', '.', '--html', '--slide', scope.join(','));
    this.expect(exported.code === 0, `inspect failed: ${exported.stderr}`);
    const dom = new JSDOM(exported.stdout);
    const doc = dom.window.document;
    const sections = [...doc.querySelectorAll('body > section')];
    const edits: string[] = [];
    // Sometimes a person edits one of these slides after the export: the page
    // the agent goes on to edit is then stale, and the save must merge.
    const stale = this.chance(0.35) ? await this.personMeanwhile(scope) : null;
    if (stale) edits.push(stale.what);
    const removed = new Set<string>();
    // What each object's markup was, so "touched" means changed on balance:
    // a build toggled on and off again is no edit, and the merge agrees.
    // (Attribute order aside: a parser that removes and re-adds an attribute moves it.)
    const markupOf = (object: Element) => [...object.attributes].map((attr) => `${attr.name}=${attr.value}`)
      .sort().join(' ') + object.innerHTML;
    const exportedMarkup = new Map([...doc.querySelectorAll('[data-element-id]')]
      .map((object) => [object.getAttribute('data-element-id')!, markupOf(object)]));
    const added: Array<{ section: Element; markers: string[] }> = [];
    const markersOf = (id: string) => this.slides.get(id)!.markers;
    for (const section of sections) {
      const id = section.getAttribute('data-slide-id')!;
      const moves = 1 + Math.floor(this.next() * 2);
      for (let move = 0; move < moves; move++) {
        const objects = [...section.querySelectorAll(':scope > [data-element-id]')];
        const texts = [...section.querySelectorAll('[data-text-content]')];
        const op = this.pick(['retext', 'retext', 'add', 'remove', 'restyle', 'build']);
        const holding = texts.filter((text) => [...markersOf(id)].some((marker) => text.textContent?.includes(marker)));
        if (op === 'retext' && holding.length > 0) {
          const text = this.pick(holding);
          const old = [...markersOf(id)].find((marker) => text.innerHTML.includes(marker))!;
          const token = this.token();
          text.innerHTML = text.innerHTML.replace(old, token);
          markersOf(id).delete(old);
          this.gone.add(old);
          markersOf(id).add(token);
          edits.push(`retext ${id}`);
        } else if (op === 'remove' && objects.length > 1) {
          const object = this.pick(objects);
          for (const marker of [...markersOf(id)]) {
            if (object.textContent?.includes(marker)) {
              markersOf(id).delete(marker);
              this.gone.add(marker);
            }
          }
          object.remove();
          removed.add(object.getAttribute('data-element-id') ?? '');
          edits.push(`remove an object from ${id}`);
        } else if (op === 'restyle' && texts.length > 0) {
          const text = this.pick(texts).closest('[data-element-id]') as HTMLElement | null;
          if (text) {
            if (this.chance(0.5)) text.style.color = this.pick(['#cc5533', '#225588', '#333333']);
            else text.style.fontSize = `${this.pick([28, 36, 44, 56])}px`;
            edits.push(`restyle in ${id}`);
          }
        } else if (op === 'build' && objects.length > 0) {
          const object = this.pick(objects);
          if (object.hasAttribute('data-build')) object.removeAttribute('data-build');
          else object.setAttribute('data-build', this.pick(['click', 'afterPrev+300']));
          edits.push(`toggle a build in ${id}`);
        } else {
          const token = this.token();
          const paragraph = doc.createElement('p');
          paragraph.className = 'role-body';
          paragraph.setAttribute('style', `position:absolute; left:${120 + Math.floor(this.next() * 600)}px; `
            + `top:${600 + Math.floor(this.next() * 300)}px; width:900px;`);
          paragraph.textContent = this.phrase(token);
          section.appendChild(paragraph);
          markersOf(id).add(token);
          edits.push(`add a line to ${id}`);
        }
      }
    }
    // Structure: reorder, delete one (keeping the deck non-empty), add one.
    const body = doc.body;
    if (sections.length > 1 && this.chance(0.3)) {
      for (const section of [...sections].sort(() => this.next() - 0.5)) body.appendChild(section);
      edits.push('reorder');
    }
    if (sections.length > 1 && this.order.length > 2 && this.chance(0.2)) {
      const victim = this.pick(sections);
      victim.remove();
      edits.push(`delete ${victim.getAttribute('data-slide-id')}`);
    }
    if (this.chance(0.25)) {
      const fresh = this.section();
      const holder = doc.createElement('div');
      holder.innerHTML = fresh.html;
      const section = holder.firstElementChild!;
      const anchor = this.pick([...body.querySelectorAll(':scope > section'), null]);
      body.insertBefore(section, anchor);
      added.push({ section, markers: fresh.markers });
      edits.push('add a slide');
    }
    const touched = new Set([...doc.querySelectorAll('[data-element-id]')]
      .filter((object) => exportedMarkup.get(object.getAttribute('data-element-id')!) !== markupOf(object))
      .map((object) => object.getAttribute('data-element-id')!));
    const file = `work-${++this.pages}.html`;
    const page = dom.serialize();
    const kept = [...body.querySelectorAll(':scope > section')].map((section) => section.getAttribute('data-slide-id'));
    const deleted = scope.filter((id) => !kept.includes(id));
    const watched = this.ws.saveWatched && this.chance(0.3);
    this.log(`edit [${scope.join(', ')}]: ${edits.join('; ')}${watched ? ' (watched save)' : ''}`);

    let authored: string[];
    if (watched) {
      const saved = await this.ws.saveWatched!(file, page);
      this.expect(saved.outcome === 'saved' || saved.outcome === 'unchanged', `the watched save failed: ${saved.line}`);
      authored = await until(async () => {
        const stamped = sectionIds(await this.ws.read(file));
        return stamped.every(Boolean) ? stamped as string[] : null;
      }, 'the id stamp');
    } else {
      await this.ws.write(file, page);
      const reply = await this.apply(file);
      const changes = this.landed(reply);
      this.expect([...changes.deleted].sort().join() === [...deleted].sort().join(),
        `expected [${deleted}] deleted, the reply says ${JSON.stringify(changes)}`);
      this.expect(changes.inserted.length === added.length, `expected ${added.length} inserted, got ${JSON.stringify(changes)}`);
      this.expect(changes.replaced.every((id) => scope.includes(id)), `replaced a slide outside the page: ${JSON.stringify(changes)}`);
      authored = (reply.json.slides as Array<{ id: string }>).map((slide) => slide.id);
      if (process.env.AGENT_FUZZ_TRACE === '1') this.log(`  reply ${JSON.stringify(changes)} slides [${authored}] note ${reply.json.note ?? ''}`);
    }
    // The page's slides take the range's place, in the page's order.
    for (const id of deleted) {
      for (const marker of this.slides.get(id)!.markers) this.gone.add(marker);
      this.slides.delete(id);
    }
    const at = this.order.indexOf(scope[0]);
    const outside = this.order.filter((id) => !scope.includes(id));
    added.forEach(({ section, markers }) => {
      const index = [...body.querySelectorAll(':scope > section')].indexOf(section);
      this.slides.set(authored[index], { markers: new Set(markers), notes: '', skipped: false, comments: 0 });
    });
    outside.splice(at, 0, ...authored);
    this.order.splice(0, this.order.length, ...outside);
    this.lastPage = file;
    // The person's rewording stands where the agent left that object alone;
    // where the agent changed the object too, the agent's later save wins.
    if (stale?.rewrite && this.slides.has(stale.slideId)) {
      const { slideId, elementId, before, after } = stale.rewrite;
      this.log(`  (${before} -> ${after} in ${elementId}; agent touched [${[...touched]}], removed [${[...removed]}])`);
      const model = this.slides.get(slideId)!;
      if (removed.has(elementId)) {
        model.markers.delete(after);
        this.gone.add(after);
      } else if (touched.has(elementId)) {
        model.markers.delete(after);
        this.gone.add(after);
        model.markers.add(before);
        this.gone.delete(before);
      }
    }
    // Whatever landed, the page now names exactly the slides it governs.
    const stamped = sectionIds(await this.ws.read(file));
    this.expect(stamped.join() === authored.join(), `the page is stamped [${stamped}], the deck has [${authored}]`);
  }

  /** Export slides and save the page as it came: nothing may change. */
  async resaveUntouched(): Promise<void> {
    const span = Math.min(this.order.length, this.pick([1, 3, 6]));
    const from = Math.floor(this.next() * (this.order.length - span + 1));
    const scope = this.order.slice(from, from + span);
    this.log(`re-save [${scope.join(', ')}] untouched`);
    const before = await this.ws.deck();
    const exported = await this.ws.run('inspect', '.', '--html', '--slide', scope.join(','));
    const file = `same-${++this.pages}.html`;
    await this.ws.write(file, exported.stdout);
    const changes = this.landed(await this.apply(file));
    this.expect(changes.replaced.length + changes.inserted.length + changes.deleted.length + changes.moved === 0,
      `an untouched page changed the deck: ${JSON.stringify(changes)}`);
    const after = await this.ws.deck();
    for (const id of scope) {
      const was = before.slides.find((slide) => slide.id === id)!;
      const is = after.slides.find((slide) => slide.id === id)!;
      this.expect(JSON.stringify(is) === JSON.stringify(was), `untouched slide ${id} changed:\n${JSON.stringify(was)}\n${JSON.stringify(is)}`);
    }
  }

  /** The last page, applied again as it stands (stamped): the same slides, not new ones. */
  async reapply(): Promise<void> {
    if (!this.lastPage) return this.addPage();
    this.log(`apply ${this.lastPage} again`);
    const reply = await this.apply(this.lastPage);
    const changes = this.landed(reply);
    if (!reply.json.idempotent) {
      this.expect(changes.inserted.length === 0 && changes.deleted.length === 0,
        `applying a synced page again changed the deck: ${JSON.stringify(changes)}`);
    }
  }

  /* --- the person ----------------------------------------------------------- */

  /** A person's edit through the product: the WebSocket when hosted, a CLI transaction locally. */
  async human(concurrently = false): Promise<void> {
    const id = this.pick(this.order);
    const model = this.slides.get(id)!;
    const op = this.pick(['notes', 'skip', 'comment', 'retext', 'add', 'delete']);
    const hosted = this.ws.kind === 'hosted' ? (this.ws as HostedWorkspace).human : null;
    if (op === 'comment') {
      this.log(`a person comments on ${id}`);
      const result = await this.ws.run('comments', '--add', `Look at ${id}`, '--slide', id);
      this.expect(result.code === 0, `comment failed: ${result.stderr}`);
      model.comments += 1;
      return;
    }
    if (op === 'add' || (op === 'delete' && this.order.length <= 3)) {
      const token = this.token();
      const fresh = `person-${token}`;
      this.log(`a person adds slide ${fresh}`);
      const slide: Slide = {
        id: fresh, name: '', notes: '', background: { color: null, image: null }, timeline: [],
        elements: [{
          id: `${fresh}-text`, type: 'text', x: 120, y: 120, w: 1200, h: 120, rot: 0, z: 1, opacity: 1,
          class: ['role-title'], style: {}, html: this.phrase(token), align: 'left', valign: 'top',
        } as never],
      };
      if (hosted) await hosted.edit('Add a slide', (deck) => { deck.slides.push(slide); });
      else await this.transaction('Add a slide', [{ op: 'insertSlides', afterSlideId: this.order.at(-1)!, slides: [slide] }]);
      this.order.push(fresh);
      this.slides.set(fresh, { markers: new Set([token]), notes: '', skipped: false, comments: 0 });
      return;
    }
    if (op === 'delete') {
      if (concurrently) return this.human(true);
      this.log(`a person deletes ${id}`);
      if (hosted) await hosted.edit('Delete a slide', (deck) => { deck.slides = deck.slides.filter((slide) => slide.id !== id); });
      else await this.transaction('Delete a slide', [{ op: 'deleteSlide', slideId: id }]);
      for (const marker of model.markers) this.gone.add(marker);
      this.order.splice(this.order.indexOf(id), 1);
      this.slides.delete(id);
      return;
    }
    if (op === 'retext') {
      const deck = await this.ws.deck();
      const slide = deck.slides.find((candidate) => candidate.id === id)!;
      const marker = [...model.markers].find((candidate) => slide.elements.some((element) =>
        element.type === 'text' && element.html.includes(candidate)));
      if (!marker) return this.human(concurrently);
      const token = this.token();
      this.log(`a person rewrites a phrase on ${id}`);
      const rewrite = (target: Slide) => {
        for (const element of target.elements) {
          if (element.type === 'text' && element.html.includes(marker)) element.html = element.html.replace(marker, token);
        }
      };
      if (hosted) {
        await hosted.edit('Edit text', (live) => rewrite(live.slides.find((candidate) => candidate.id === id)!));
      } else {
        const next = structuredClone(slide);
        rewrite(next);
        await this.transaction('Edit text', [{ op: 'replaceSlide', slideId: id, slide: next }]);
      }
      model.markers.delete(marker);
      this.gone.add(marker);
      model.markers.add(token);
      return;
    }
    const notes = op === 'notes' ? `Notes ${this.token()}` : model.notes;
    const skipped = op === 'skip' ? !model.skipped : model.skipped;
    this.log(`a person ${op === 'notes' ? 'writes notes on' : skipped ? 'skips' : 'un-skips'} ${id}`);
    if (hosted) {
      await hosted.edit(op === 'notes' ? 'Edit notes' : 'Skip slide', (deck) => {
        const slide = deck.slides.find((candidate) => candidate.id === id)!;
        slide.notes = notes;
        slide.skipped = skipped;
      });
    } else {
      await this.transaction('Edit slide', [{ op: 'setSlideProperties', slideId: id, slide: { id, notes, skipped } }]);
    }
    model.notes = notes;
    model.skipped = skipped;
  }

  /**
   * A person edits one of the slides the agent just exported: rewords a phrase
   * (which object it was in is tracked, for the merge) or adds a line.
   */
  async personMeanwhile(scope: string[]): Promise<{
    what: string;
    slideId: string;
    rewrite?: { slideId: string; elementId: string; before: string; after: string };
  } | null> {
    const slideId = this.pick(scope);
    const model = this.slides.get(slideId)!;
    const deck = await this.ws.deck();
    const slide = deck.slides.find((candidate) => candidate.id === slideId)!;
    const holder = slide.elements.find((element) => element.type === 'text'
      && [...model.markers].some((marker) => element.html.includes(marker)));
    const change = async (mutate: (target: Slide) => void) => {
      const hosted = this.ws.kind === 'hosted' ? (this.ws as HostedWorkspace).human : null;
      if (hosted) {
        await hosted.edit('A person edits', (live) => mutate(live.slides.find((candidate) => candidate.id === slideId)!));
      } else {
        const next = structuredClone(slide);
        mutate(next);
        await this.transaction('A person edits', [{ op: 'replaceSlide', slideId, slide: next }]);
      }
    };
    if (holder && holder.type === 'text' && this.chance(0.6)) {
      const before = [...model.markers].find((marker) => holder.html.includes(marker))!;
      const after = this.token();
      await change((target) => {
        const element = target.elements.find((candidate) => candidate.id === holder.id);
        if (element?.type === 'text') element.html = element.html.replace(before, after);
      });
      model.markers.delete(before);
      model.markers.add(after);
      this.gone.add(before);
      return { what: `meanwhile a person rewords ${holder.id}`, slideId, rewrite: { slideId, elementId: holder.id, before, after } };
    }
    const token = this.token();
    await change((target) => {
      target.elements.push({
        id: `person-line-${token}`, type: 'text', x: 200, y: 900, w: 1000, h: 80, rot: 0, z: 50, opacity: 1,
        class: ['role-caption'], style: {}, html: this.phrase(token), align: 'left', valign: 'top',
      } as never);
    });
    model.markers.add(token);
    return { what: `meanwhile a person adds a line to ${slideId}`, slideId };
  }

  /** The agent edits a page while a person edits a slide outside it, the edit landing mid-compile. */
  async raceAPerson(): Promise<void> {
    const hosted = this.ws as HostedWorkspace;
    const page = await this.ws.run('new', '.', '--count', '1');
    const fresh = this.section();
    const file = `race-${++this.pages}.html`;
    await this.ws.write(file, page.stdout.replace(
      /<section class="slide" data-placeholder="true">\s*<h1 class="role-title">Title<\/h1>\s*<\/section>/, fresh.html));
    const log = (await hosted.bridgeLog()).length;
    this.log(`add a slide while a person edits (race)`);
    const applying = this.apply(file);
    await until(async () => (await hosted.bridgeLog()).slice(log).includes(`compiling edit/${file}`), 'the compile to start', 30_000);
    await this.human(true);
    const changes = this.landed(await applying);
    this.expect(changes.inserted.length === 1, `the racing add did not land once: ${JSON.stringify(changes)}`);
    // It went last as the deck stood when it landed — after anything the person added meanwhile.
    this.order.push(changes.inserted[0]);
    this.slides.set(changes.inserted[0], { markers: new Set(fresh.markers), notes: '', skipped: false, comments: 0 });
  }

  /* --- plumbing ------------------------------------------------------------- */

  apply(file: string, flags: string[] = []): Promise<CommandResult> {
    return this.ws.run('apply', '.', '--html', `edit/${file}`, ...flags);
  }

  landed(result: CommandResult): Changes {
    this.expect(result.code === 0 && result.json?.status === 'applied',
      `the apply failed (exit ${result.code}): ${result.stdout}\n${result.stderr}`);
    if (this.ws.kind === 'desktop') this.expect(result.json.live === true, 'the desktop editor did not compile it');
    return result.json.changes as Changes;
  }

  async transaction(label: string, operations: unknown[]): Promise<void> {
    const file = join(this.ws.dir, `txn-${++this.pages}.json`);
    await writeFile(file, JSON.stringify({ version: 1, label, operations }), 'utf8');
    const result = await this.ws.run('transaction', 'apply', '.', file);
    this.expect(result.code === 0, `the person's transaction failed (exit ${result.code}): ${result.stdout}\n${result.stderr}`);
  }

  log(step: string): void {
    this.trail.push(step);
  }

  expect(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  /** Every oracle, against the deck as it now stands. */
  async check(): Promise<void> {
    const deck = await this.ws.deck();
    const ids = deck.slides.map((slide) => slide.id);
    this.expect(ids.join() === this.order.join(), `slide order\n  model: [${this.order}]\n  deck:  [${ids}]`);
    const errors = validateDeckIntegrity(deck, (src) => existsSync(join(this.ws.deckDir, src)));
    this.expect(errors.length === 0, `deck integrity: ${errors.join('; ')}`);
    const everything = deck.slides.map(plainText).join('\n');
    for (const marker of this.gone) {
      this.expect(!everything.includes(marker), `"${marker}" was removed but is back in the deck`);
    }
    for (const slide of deck.slides) {
      const model = this.slides.get(slide.id)!;
      const text = plainText(slide);
      for (const marker of model.markers) {
        this.expect(text.includes(marker), `slide ${slide.id} lost "${marker}": ${text.slice(0, 300)}`);
      }
      this.expect(slide.notes === model.notes, `slide ${slide.id} notes: "${slide.notes}", expected "${model.notes}"`);
      this.expect((slide.skipped ?? false) === model.skipped, `slide ${slide.id} skipped: ${slide.skipped}, expected ${model.skipped}`);
      this.expect((slide.comments?.length ?? 0) === model.comments,
        `slide ${slide.id} has ${slide.comments?.length ?? 0} comments, expected ${model.comments}`);
      for (const element of slide.elements) {
        if (element.type !== 'text') continue;
        this.expect(!element.html.includes('class="katex'), `slide ${slide.id}: rendered KaTeX stored as text in ${element.id}`);
        this.expect(!/(^|[^\\])\$5/.test(element.html), `slide ${slide.id}: an escaped dollar lost its escape in ${element.id}`);
      }
    }
    if (this.ws.kind === 'hosted') {
      const hosted = this.ws as HostedWorkspace;
      await until(async () => sameDeck(await hosted.mirrorDeck(), deck), 'the mirror to converge on the server', 20_000)
        .catch(async () => { throw new Error(`the mirror never converged:\n${diffDecks(await hosted.mirrorDeck(), deck)}`); });
      await until(async () => sameDeck(hosted.human.deck, deck), 'the person to converge on the server', 20_000)
        .catch(() => { throw new Error(`the person's deck never converged:\n${diffDecks(hosted.human.deck, deck)}`); });
    }
  }
}

function plainText(slide: Slide): string {
  return slide.elements.map((element) => (element.type === 'text' || element.type === 'html' ? element.html : ''))
    .join(' ')
    .replace(/<[^>]*>/g, ' ');
}

function sameDeck(left: Deck, right: Deck): boolean {
  return left.slides.length === right.slides.length
    && left.slides.every((slide, index) => slide.id === right.slides[index].id && sameSlideContent(slide, right.slides[index]));
}

function diffDecks(left: Deck, right: Deck): string {
  if (left.slides.map((slide) => slide.id).join() !== right.slides.map((slide) => slide.id).join()) {
    return `order [${left.slides.map((slide) => slide.id)}] vs [${right.slides.map((slide) => slide.id)}]`;
  }
  const differing = left.slides.filter((slide, index) => !sameSlideContent(slide, right.slides[index]));
  return differing.map((slide) => slide.id).join(', ');
}

const MOVES: Record<WorkspaceKind, Array<[keyof Walk & string, number]>> = {
  offline: [['addPage', 4], ['editPage', 6], ['resaveUntouched', 2], ['reapply', 1], ['human', 3]],
  desktop: [['addPage', 4], ['editPage', 6], ['resaveUntouched', 2], ['reapply', 1], ['human', 3]],
  hosted: [['addPage', 4], ['editPage', 6], ['resaveUntouched', 2], ['reapply', 1], ['human', 3], ['raceAPerson', 2]],
};

let ws: AgentWorkspace | null = null;
afterEach(async () => {
  await ws?.close();
  ws = null;
});

for (const kind of BACKENDS) {
  describe.skipIf(!electronBinary)(`agent collaboration fuzz (${kind})`, () => {
    for (const seed of SEEDS) {
      it(`survives a ${STEPS}-step walk, seed ${seed}`, { timeout: 60_000 + STEPS * 20_000 }, async () => {
        ws = await startWorkspace(kind);
        const walk = new Walk(ws, seed);
        await walk.begin();
        const moves = MOVES[kind];
        const total = moves.reduce((sum, [, weight]) => sum + weight, 0);
        for (let step = 1; step <= STEPS; step++) {
          let roll = walk.next() * total;
          const [move] = moves.find(([, weight]) => (roll -= weight) < 0) ?? moves[0];
          try {
            await (walk[move] as () => Promise<void>).call(walk);
            await walk.check();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (process.env.AGENT_FUZZ_KEEP) {
              const { cp } = await import('node:fs/promises');
              await cp(ws.dir, process.env.AGENT_FUZZ_KEEP, { recursive: true }).catch(() => undefined);
            }
            throw new Error(`seed ${seed}, step ${step} (${walk.trail.at(-1)}): ${message}\n\nsteps:\n`
              + walk.trail.map((line, index) => `  ${index + 1}. ${line}`).join('\n')
              + `\n\nreplay: AGENT_FUZZ_SEEDS=${seed} AGENT_FUZZ_BACKENDS=${kind} AGENT_FUZZ_STEPS=${step}`
              + `\n${ws.logs().slice(-4000)}`);
          }
        }
        if (process.env.AGENT_FUZZ_TRACE === '1') console.log(`${kind} seed ${seed}:\n${walk.trail.join('\n')}`);
        expect(walk.trail.length).toBeGreaterThanOrEqual(STEPS);
      });
    }
  });
}
