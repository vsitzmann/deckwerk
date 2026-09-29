// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PresenceState } from '../src/shared/collab.js';
import { PresenceBar, initials } from '../src/renderer/collab/presenceBar.js';

const peer = (overrides: Partial<PresenceState>): PresenceState => ({
  clientId: 'c', name: 'Someone', color: '#e0463c', activeSlideId: null, selectedSlideIds: [],
  selectedElementIds: [], editingElementId: null, cursor: null, ...overrides,
});

describe('PresenceBar', () => {
  it('shows you first, then people by name, then agents, and follows a click to their slide', () => {
    const follow = vi.fn();
    const bar = new PresenceBar((slideId) => (slideId === 's2' ? 'slide 2' : null), follow);
    bar.setSelf({ name: 'Vincent Sitzmann', color: '#3b82f6' });
    bar.setPeers([
      peer({ clientId: 'a', name: 'Zoe Park · agent', agent: true, activeSlideId: 's2' }),
      peer({ clientId: 'b', name: 'David Charatan', activeSlideId: 's2' }),
      peer({ clientId: 'c', name: 'ada@example.com' }),
    ]);
    const chips = [...bar.element.querySelectorAll<HTMLElement>('.bar-person')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['VS', 'A', 'DC', '⚙']);
    expect(chips[0].classList.contains('me')).toBe(true);
    expect(chips[0].tagName).toBe('SPAN');
    expect(chips[2].getAttribute('aria-label')).toBe('David Charatan — slide 2');
    expect(chips[3].classList.contains('agent')).toBe(true);
    chips[2].click();
    expect(follow).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'b' }));
    chips[1].click();
    expect(follow).toHaveBeenCalledTimes(1);
  });

  it('turns names and addresses into initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('vincent.sitzmann@gmail.com')).toBe('VS');
    expect(initials('Claude · agent')).toBe('C');
    expect(initials('')).toBe('?');
  });
});
