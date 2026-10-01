import type { Deck } from '@shared/deck.js';
import type { PresentationCommand, PresentationState } from '@shared/ipc.js';

/**
 * The link between a browser presentation's two surfaces.
 *
 * The desktop app owns both of its presentation windows in the main process
 * and routes commands and state between them over IPC. A browser has no such
 * broker: the audience view and Speaker View are two ordinary same-origin
 * pages. `BroadcastChannel` is that broker — it reaches every tab and window
 * of this origin in this browser profile, which is exactly the pair of
 * surfaces one presenter drives, and it needs nothing from the server.
 *
 * Deliberately *not* the collaboration WebSocket: presenter commands are
 * private to the presenter. Routing "next slide" through the server would put
 * them in front of every collaborator and would break the moment the network
 * hiccups mid-talk, which is the one moment presenting must keep working.
 */

export type PresentationRole = 'audience' | 'speaker';

export type PresentationBusMessage =
  /** A surface announcing itself, so the other one answers with what it knows. */
  | { kind: 'hello'; role: PresentationRole }
  /** Audience → speaker: paint immediately instead of waiting on a socket. */
  | { kind: 'seed'; deck: Deck; themeCss: string; mediaVariants?: Record<string, string> }
  /** Audience → speaker: where the presentation is and how long it has run. */
  | { kind: 'state'; state: PresentationState }
  /** Speaker → audience: a presenter control. */
  | { kind: 'command'; command: PresentationCommand }
  /**
   * Audience → speaker: exchange roles, handing over the whole show — where
   * it is and how long it has been running. The clocks travel with the role
   * because the role is what owns them; without them a swap would restart the
   * presentation timer from the moment that window happened to be opened.
   */
  | {
      kind: 'swap';
      cursor: { slide: number; step: number };
      startedAt: number;
      slideStartedAt: number;
    }
  /** The presentation ended; the other surface should close itself. */
  | { kind: 'bye' };

export interface PresentationBus {
  post(message: PresentationBusMessage): void;
  subscribe(listener: (message: PresentationBusMessage) => void): () => void;
  close(): void;
}

export function presentationChannelName(deckId: string): string {
  return `deckwerk-present:${deckId}`;
}

export function createPresentationBus(deckId: string): PresentationBus {
  const name = presentationChannelName(deckId);
  const listeners = new Set<(message: PresentationBusMessage) => void>();
  const deliver = (message: PresentationBusMessage): void => {
    for (const listener of [...listeners]) listener(message);
  };

  if (typeof BroadcastChannel === 'function') {
    const channel = new BroadcastChannel(name);
    channel.onmessage = (event) => deliver(event.data as PresentationBusMessage);
    return {
      post: (message) => channel.postMessage(message),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        listeners.clear();
        channel.close();
      },
    };
  }

  // Older WebKit has no BroadcastChannel. `storage` fires in every *other*
  // same-origin page, which is the same reach; the counter makes repeats of an
  // identical message (two `next`s in a row) distinct writes so they still
  // fire. A `seed` carries a whole deck, so it is skipped here rather than
  // risking the storage quota — the speaker's own socket delivers it instead.
  let sequence = 0;
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== name || !event.newValue) return;
    try {
      deliver(JSON.parse(event.newValue).message as PresentationBusMessage);
    } catch {
      // A truncated or foreign write is not a presenter command.
    }
  };
  window.addEventListener('storage', onStorage);
  return {
    post(message) {
      if (message.kind === 'seed') return;
      try {
        localStorage.setItem(name, JSON.stringify({ n: sequence++, message }));
      } catch {
        // Private-mode storage refusal: the surfaces simply stay independent.
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      window.removeEventListener('storage', onStorage);
      try {
        localStorage.removeItem(name);
      } catch {
        // Nothing to clean up if the write never landed.
      }
    },
  };
}
