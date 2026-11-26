import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import { PARA, startCrossSession, type CrossSession } from './support/crossContextSession.js';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;
beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession('save-shortcut', 'Save shortcut');
  session = started.session;
  close = started.close;
}, 180_000);
afterAll(async () => { await close?.(); });

describe.skipIf(!electronBinary)('the editor owns Cmd/Ctrl+S', () => {
  it('cancels browser saving on the canvas, inside text, in fields and in dialogs', async () => {
    await session.cdp.evaluate(`(() => {
      window.saveKeyResults = [];
      window.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          window.saveKeyResults.push(e);
        }
      }, true);
      return true;
    })()`);
    for (const context of ['canvas', 'text', 'field', 'dialog']) {
      if (context === 'canvas') await session.clickEmpty();
      else if (context === 'text') await session.doubleClick(PARA);
      else {
        await session.key('Escape', 27);
        // Fixture focus surfaces; the shortcut itself is always real keyboard input.
        await session.cdp.evaluate(`(() => {
          document.getElementById('save-shortcut-fixture')?.remove();
          const host = document.createElement('div');
          host.id = 'save-shortcut-fixture';
          host.style.cssText = 'position:fixed;left:300px;top:100px;z-index:99999';
          if (${JSON.stringify(context)} === 'dialog') host.setAttribute('aria-modal', 'true');
          const input = document.createElement('input');
          host.append(input); document.body.append(host); input.focus();
          return true;
        })()`);
      }
      for (const modifier of [4, 2]) {
        await session.chord('s', 'KeyS', 83, modifier);
        // BUG: text/field/modal focus used to bypass the editor's Save handler.
        const results = await session.cdp.evaluate<boolean[]>('window.saveKeyResults.map(e => e.defaultPrevented)');
        expect(results.at(-1), `${context}, modifier ${modifier}: browser Save was allowed`).toBe(true);
      }
    }
  }, 60_000);
});
