/**
 * The contract between a deck and the web pages it embeds (`web` elements).
 *
 * A web element runs in an `<iframe sandbox="allow-scripts">`: the page has
 * scripts but an opaque origin, so `postMessage` is the only way in or out.
 * The deck tells the page when its slide is shown and which build step is
 * current; the page may ask the deck to move on. Every message carries
 * `source: 'deckwerk'` so unrelated messages are ignored on both sides.
 */

export const WEB_BRIDGE_SOURCE = 'deckwerk';

/** Deck → page. */
export type WebBridgeEvent =
  | { source: typeof WEB_BRIDGE_SOURCE; event: 'active'; step: number; steps: number }
  | { source: typeof WEB_BRIDGE_SOURCE; event: 'inactive' }
  | { source: typeof WEB_BRIDGE_SOURCE; event: 'step'; step: number; steps: number };

/** Page → deck. */
export type WebBridgeAction =
  | { source: typeof WEB_BRIDGE_SOURCE; action: 'next' }
  | { source: typeof WEB_BRIDGE_SOURCE; action: 'prev' }
  /** A presenting key the page did not use itself, forwarded so the deck still navigates. */
  | { source: typeof WEB_BRIDGE_SOURCE; action: 'key'; key: string };

/**
 * Page → deck: readiness, apart from the navigation actions above.
 *
 * A live frame stays hidden (under its poster, when it has one) until the
 * page has loaded and painted. A page that lays itself out from script after
 * that — once `document.fonts.ready` resolves, say — sends `hold-ready` while
 * its scripts first run and `ready` when it is laid out; the deck keeps the
 * page hidden in between (never longer than its reveal timeout).
 */
export type WebReadinessAction = 'hold-ready' | 'ready';

export function webReadinessAction(data: unknown): WebReadinessAction | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as { source?: unknown; action?: unknown };
  if (message.source !== WEB_BRIDGE_SOURCE) return null;
  return message.action === 'hold-ready' || message.action === 'ready' ? message.action : null;
}

export function isWebBridgeAction(data: unknown): data is WebBridgeAction {
  if (!data || typeof data !== 'object') return false;
  const message = data as { source?: unknown; action?: unknown; key?: unknown };
  if (message.source !== WEB_BRIDGE_SOURCE) return false;
  if (message.action === 'next' || message.action === 'prev') return true;
  return message.action === 'key' && typeof message.key === 'string';
}

/**
 * Keys the page hands back to the deck when it did not handle them itself. A
 * page that wants a key (a slider on the arrows, say) calls `preventDefault`
 * and the runtime leaves it alone.
 */
export const WEB_BRIDGE_FORWARDED_KEYS = [
  'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp',
  ' ', 'Enter', 'Backspace', 'Home', 'Escape', 'b', 'B', 'o', 'O',
];

export const WEB_BRIDGE_MARKER = 'data-deckwerk-bridge';

/**
 * The runtime `slide-agent web import` writes into an imported page, and the
 * snippet a hand-written page can paste. It exposes `window.deckwerk`:
 *
 *   deckwerk.onActive(fn)   fn({ step, steps }) when the slide is shown
 *   deckwerk.onInactive(fn) when the deck leaves the slide
 *   deckwerk.onStep(fn)     fn({ step, steps }) on each build step
 *   deckwerk.next() / deckwerk.prev()
 *   deckwerk.ready(promise) keep the page hidden until `promise` settles;
 *                           call it while the page's scripts first run
 *
 * and forwards navigation keys the page leaves unhandled, so a focused page
 * never traps the presenter on one slide.
 */
export const WEB_BRIDGE_RUNTIME = `(function(){
if(window.deckwerk)return;
var SRC=${JSON.stringify(WEB_BRIDGE_SOURCE)};
var KEYS=${JSON.stringify(WEB_BRIDGE_FORWARDED_KEYS)};
var handlers={active:[],inactive:[],step:[]};
function post(m){m.source=SRC;if(window.parent&&window.parent!==window)window.parent.postMessage(m,'*');}
window.deckwerk={
  onActive:function(f){handlers.active.push(f);},
  onInactive:function(f){handlers.inactive.push(f);},
  onStep:function(f){handlers.step.push(f);},
  next:function(){post({action:'next'});},
  prev:function(){post({action:'prev'});},
  ready:function(p){
    if(!p||typeof p.then!=='function'){post({action:'ready'});return;}
    post({action:'hold-ready'});
    var done=function(){post({action:'ready'});};
    p.then(done,done);
  }
};
window.addEventListener('message',function(e){
  var d=e.data;if(!d||d.source!==SRC||!d.event)return;
  (handlers[d.event]||[]).forEach(function(f){try{f({step:d.step,steps:d.steps});}catch(err){console.error(err);}});
});
window.addEventListener('keydown',function(e){
  if(e.defaultPrevented||KEYS.indexOf(e.key)<0)return;
  var t=e.target;if(t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;
  e.preventDefault();post({action:'key',key:e.key});
});
})();`;

/** Whether a document already carries the runtime, so importing twice stays idempotent. */
export function hasWebBridgeRuntime(html: string): boolean {
  return html.includes(WEB_BRIDGE_MARKER);
}

/**
 * Add the runtime to a complete HTML document, ahead of the page's own scripts
 * so `window.deckwerk` exists by the time they run. Documents without a
 * `<head>` get it prepended to whatever is there.
 */
export function injectWebBridgeRuntime(html: string): string {
  if (hasWebBridgeRuntime(html)) return html;
  const tag = `<script ${WEB_BRIDGE_MARKER}>${WEB_BRIDGE_RUNTIME}</script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}\n${tag}${html.slice(at)}`;
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}\n<head>${tag}</head>${html.slice(at)}`;
  }
  // `<html>` and `<head>` are optional, the doctype is not: anything ahead of
  // it puts the page in quirks mode, so a bare `<!doctype html><button>` page
  // was staged — and checked — laid out by the wrong rules.
  const doctype = /^(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return `${html.slice(0, at)}\n${tag}${html.slice(at)}`;
  }
  return `${tag}\n${html}`;
}

/** Deck-relative, inside the deck, and an HTML document: the only pages a web element shows. */
export function isEmbeddableWebSrc(src: string): boolean {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('\\')) return false;
  if (src.split(/[\\/]/).some((segment) => segment === '..')) return false;
  return /\.x?html?$/i.test(src.split(/[?#]/)[0]);
}
