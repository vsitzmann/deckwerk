/**
 * Tests that still take at least ten seconds when run in isolation after the
 * August 2026 speed pass, plus explicitly opt-in resource stress tests.
 * Isolated time avoids quarantining useful coverage merely because several
 * CPU-heavy workers happened to overlap in a full run.
 */
export const LONG_TESTS = [
  {
    file: 'test/exportLooksLikeSlide.test.ts',
    observedSeconds: 17,
    scope: 'Rendered export fidelity across representative slides',
  },
  {
    file: 'test/selectionFocusFuzzBrowser.test.ts',
    observedSeconds: 89,
    scope: 'Every entry and exit of a text or table edit, plus a seeded random walk, checking the selection/focus invariants after each real input',
  },
  {
    file: 'test/offlinePresentScenariosBrowser.test.ts',
    observedSeconds: 970,
    scope: 'The browser editor losing its server every way (refused, black hole, WebSocket, process) at every moment (before the copy, before Present, mid-talk), then presenting, reloading and reconnecting',
  },
  {
    file: 'test/performanceStressBrowser.test.ts',
    observedSeconds: 13,
    scope: 'Opt-in 1,000-slide media-wall/unique-video and 500-slide history performance gates',
  },
] as const;

export const LONG_TEST_FILES = LONG_TESTS.map(({ file }) => file);
