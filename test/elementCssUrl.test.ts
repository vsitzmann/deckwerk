// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SlideElement } from '../src/shared/deck.js';
import { applyElementBoxStyles, renderElement } from '../src/renderer/player/render.js';

const filled: SlideElement = {
  id: 'title', type: 'text', x: 100, y: 350, w: 1720, h: 250, rot: 0, z: 1, opacity: 1,
  class: ['role-title'], html: 'Can agents reconstruct 4D scenes?', align: 'center', valign: 'top',
  style: {
    'background-image': 'url(assets/title-code.png)',
    'background-clip': 'text',
    color: 'transparent',
  },
} as SlideElement;

const resolveSrc = (src: string) => `deck://deck/${src}`;

describe('deck-relative url() in an element’s own CSS', () => {
  it('points a picture-filled title at the deck’s file, not the app’s page', () => {
    const node = renderElement(filled, { resolveSrc });
    expect(node.style.backgroundImage).toContain('deck://deck/assets/title-code.png');
  });

  it('does the same on the editor’s in-place patch path', () => {
    const node = document.createElement('div');
    applyElementBoxStyles(node, filled, undefined, resolveSrc);
    expect(node.style.backgroundImage).toContain('deck://deck/assets/title-code.png');
  });

  it('leaves absolute URLs and gradients alone', () => {
    const node = document.createElement('div');
    applyElementBoxStyles(node, {
      ...filled,
      style: { 'background-image': 'linear-gradient(90deg, #7b90e1, #ec6b14), url(data:image/png;base64,AAAA)' },
    } as SlideElement, undefined, resolveSrc);
    expect(node.style.backgroundImage).toContain('linear-gradient');
    expect(node.style.backgroundImage).toContain('data:image/png;base64,AAAA');
    expect(node.style.backgroundImage).not.toContain('deck://');
  });
});
