# Performance stress tests

The ordinary Vitest suite checks correctness and keeps quick feedback quick.
The opt-in performance suite launches hidden Electron, builds deterministic
large media with ffmpeg, binds a local collaboration server, and forces GC for
before/after resource measurements:

```bash
npm run test:performance
```

The suite covers three deliberately expensive scenarios:

- A 1,000-slide deck where every slide contains a 6000×4000 JPEG and a
  3840×2160 H.264 video. Sixty real ArrowDown events traverse distinct video
  presentation keys and measure key-to-second-paint latency, globally bounded
  decoder reuse, long tasks, thumbnail virtualization, DOM growth, and JS heap
  growth. The first target is a six-image 144 MP wall, which verifies that
  lookahead decoding stays sequential and within its retained-pixel budget.
  The same browser hydrates and opens the maximum 200-row History UI.
- A 500-slide deck receives 205 complex revisions touching eight distributed
  slides each. The test measures commit latency, verifies the 200-entry cap,
  writes and reloads the real gzip sidecar, hydrates it into a fresh store, and
  restores a middle revision.
- A presenting pair on a 60-slide media deck: the browser audience window plus
  a Speaker View in a second window, driven over the presentation bus. Forty
  advances are timed inside Speaker View, from the click that sends the command
  to the render that answers it — the whole loop the presenter feels, including
  the audience's own work. Presenting renders three full stages per step rather
  than one, and Speaker View rebuilds both of its previews each time, so the
  gate also checks that neither the discarded DOM nor the frozen video stills
  accumulate.

Each run prints compact JSON reports prefixed with
`[performance:large-deck]`, `[performance:history]`, and
`[performance:presentation]`. The assertions use
generous regression budgets rather than pretending to be a microbenchmark;
they are intended to catch order-of-magnitude regressions across CI machines.

## Budget overrides

All values are positive numbers. Time budgets are milliseconds.

| Variable | Default | Measurement |
| --- | ---: | --- |
| `PERF_DECK_LOAD_BUDGET_MS` | 60000 | Open the 1,000-slide deck |
| `PERF_FIRST_NAV_BUDGET_MS` | 350 | First warmed ArrowDown paint |
| `PERF_NAV_P95_BUDGET_MS` | 250 | Steady ArrowDown p95 |
| `PERF_NAV_MAX_BUDGET_MS` | 750 | Slowest steady ArrowDown |
| `PERF_LONG_TASK_MAX_BUDGET_MS` | 750 | Longest renderer long task |
| `PERF_HEAP_GROWTH_BUDGET_MB` | 128 | Post-GC JS heap growth |
| `PERF_DOM_GROWTH_BUDGET` | 20000 | Post-GC DOM growth, including Chromium internals for ≤24 live unique-video surfaces |
| `PERF_HISTORY_UI_HYDRATE_BUDGET_MS` | 5000 | Hydrate 200 rows in-browser |
| `PERF_HISTORY_UI_OPEN_BUDGET_MS` | 750 | Open and paint the History popover (beside the deck name) |
| `PERF_HISTORY_BUILD_BUDGET_MS` | 120000 | Produce 205 complex revisions |
| `PERF_HISTORY_COMMIT_P95_BUDGET_MS` | 1000 | Complex commit p95 |
| `PERF_HISTORY_SAVE_BUDGET_MS` | 30000 | Gzip and atomically save history |
| `PERF_HISTORY_LOAD_BUDGET_MS` | 30000 | Read, unzip, and validate history |
| `PERF_HISTORY_HYDRATE_BUDGET_MS` | 30000 | Hydrate a fresh store |
| `PERF_HISTORY_RESTORE_BUDGET_MS` | 30000 | Replay to a middle revision |
| `PERF_SPEAKER_FOLLOW_P95_BUDGET_MS` | 600 | Speaker View click-to-render p95 |
| `PERF_SPEAKER_FOLLOW_MAX_BUDGET_MS` | 2000 | Slowest Speaker View follow |
| `PERF_SPEAKER_DOM_GROWTH_BUDGET` | 3500 | Post-GC DOM growth over 40 advances |
| `PERF_SPEAKER_HEAP_GROWTH_BUDGET_MB` | 128 | Post-GC Speaker View heap growth |

For example:

```bash
PERF_NAV_P95_BUDGET_MS=180 npm run test:performance
```

The suite needs Electron and the bundled ffmpeg binary. The repository test
preflight also requires permission to bind localhost and launch Chromium, so
run it outside restricted sandboxes.
