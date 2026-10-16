import { describe, expect, it } from 'vitest';
import { agentConnectPrompt, agentSessionUrl } from '../src/renderer/collab/agentPrompt.js';

describe('the Agent prompt', () => {
  const options = {
    origin: 'https://lab.example.ts.net:9443',
    deckId: 'Talks/ICCV keynote',
    title: 'ICCV keynote',
    participantId: 'participant-0123456789abcdef',
  };

  it('pairs the bridge with this browser through the session URL', () => {
    const url = new URL(agentSessionUrl(options));
    expect(url.origin).toBe(options.origin);
    expect(url.searchParams.get('deck')).toBe('Talks/ICCV keynote');
    expect(url.searchParams.get('agent')).toBe(options.participantId);
  });

  it('tells the agent to fetch and run the bridge itself, from this server', () => {
    const prompt = agentConnectPrompt(options);
    expect(prompt).toContain('“ICCV keynote”');
    expect(prompt).toContain('curl -fsSL https://lab.example.ts.net:9443/deckwerk-connect.mjs');
    expect(prompt).toContain(`node ~/.deckwerk/deckwerk-connect.mjs '${agentSessionUrl(options)}'`);
    expect(prompt).toMatch(/background/);
    expect(prompt).toContain('Deck mirrored at');
    expect(prompt).toContain('AGENTS.md');
  });

  it('keeps the session URL safe inside its single quotes', () => {
    const prompt = agentConnectPrompt({ ...options, deckId: "Vincent's talk" });
    const line = prompt.split('\n').find((text) => text.includes('node ~/.deckwerk'))!;
    const quoted = /'([^']*)'/.exec(line)![1];
    expect(new URL(quoted).searchParams.get('deck')).toBe("Vincent's talk");
  });

  it('falls back to the deck id before the deck has a title', () => {
    expect(agentConnectPrompt({ ...options, title: '' })).toContain('“Talks/ICCV keynote”');
  });
});
