import type { PresenceState } from '@shared/collab.js';

/** Up to two initials: "Ada Lovelace" → "AL", "ada@example.com" → "A". */
export function initials(name: string): string {
  const words = name.replace(/@.*$/, '').replace(/ · agent$/, '').split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [words[0][0]] : [words[0][0], words[words.length - 1][0]];
  return letters.join('').toUpperCase();
}

export function isAgentPeer(state: Pick<PresenceState, 'name' | 'agent'>): boolean {
  return Boolean(state.agent) || / · agent$/.test(state.name);
}

/**
 * Who is in the deck right now, as chips in the toolbar — the same strip
 * TeXWerk shows: you first (outlined), then everyone else by name, agents as
 * round ⚙ chips. Clicking someone jumps to the slide they are on.
 */
export class PresenceBar {
  readonly element: HTMLElement;
  private self: { name: string; color: string } | null = null;
  private peers: PresenceState[] = [];

  constructor(
    private readonly slideLabel: (slideId: string) => string | null,
    private readonly follow: (peer: PresenceState) => void,
  ) {
    this.element = document.createElement('span');
    this.element.className = 'bar-presence';
    this.element.setAttribute('role', 'list');
    this.element.setAttribute('aria-label', 'People in this deck');
  }

  setSelf(self: { name: string; color: string }): void {
    this.self = self;
    this.render();
  }

  setPeers(peers: PresenceState[]): void {
    this.peers = peers;
    this.render();
  }

  /** Slide positions shift under edits; re-derive the tooltips. */
  refresh(): void {
    this.render();
  }

  private render(): void {
    const chips: HTMLElement[] = [];
    if (this.self) chips.push(this.chip(this.self.name, this.self.color, { me: true }));
    const others = [...this.peers].sort((a, b) =>
      Number(isAgentPeer(a)) - Number(isAgentPeer(b)) || a.name.localeCompare(b.name));
    for (const peer of others) {
      const where = peer.activeSlideId ? this.slideLabel(peer.activeSlideId) : null;
      const chip = this.chip(peer.name, peer.color, { agent: isAgentPeer(peer), where });
      if (peer.activeSlideId) {
        chip.addEventListener('click', () => this.follow(peer));
      }
      chips.push(chip);
    }
    this.element.replaceChildren(...chips);
  }

  private chip(name: string, color: string, options: { me?: boolean; agent?: boolean; where?: string | null }): HTMLElement {
    const chip = document.createElement(options.me ? 'span' : 'button');
    chip.className = `bar-person${options.me ? ' me' : ''}${options.agent ? ' agent' : ''}`;
    chip.setAttribute('role', 'listitem');
    chip.style.background = color;
    chip.textContent = options.agent ? '⚙' : initials(name);
    const title = `${name}${options.me ? ' (you)' : ''}${options.where ? ` — ${options.where}` : ''}`;
    chip.title = options.me || !options.where ? title : `${title}. Click to go there.`;
    chip.setAttribute('aria-label', title);
    if (chip instanceof HTMLButtonElement) chip.type = 'button';
    return chip;
  }
}
