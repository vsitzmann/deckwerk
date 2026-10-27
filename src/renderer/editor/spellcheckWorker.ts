/**
 * Harper, entirely off the page's thread (spellcheck.ts starts this worker).
 *
 * harper.js's own WorkerLinter lints in a worker too, but rebuilds every
 * result as a WebAssembly object on the page, so the page still fetched,
 * compiled and instantiated the whole 15 MB binary: opening the first text
 * box of a session cost Safari a run of 100-370 ms frames
 * (editingLatencyBrowser.test.ts). Here the binary lives only in this worker,
 * and what crosses back is plain data.
 */
import { Dialect, LocalLinter } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';
import type { PlainLint, SpellcheckReply, SpellcheckRequest } from './spellcheck.js';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SpellcheckRequest>) => void) | null;
  postMessage(reply: SpellcheckReply): void;
};

let linter: Promise<LocalLinter> | null = null;

function ready(): Promise<LocalLinter> {
  linter ??= (async () => {
    const local = new LocalLinter({ binary: binaryInlined, dialect: Dialect.American });
    await local.setup();
    return local;
  })();
  return linter;
}

scope.onmessage = async ({ data: request }) => {
  try {
    const local = await ready();
    if (request.op === 'importWords') {
      await local.importWords(request.words);
      scope.postMessage({ id: request.id });
      return;
    }
    const raw = await local.lint(request.text, { language: 'plaintext' });
    const lints: PlainLint[] = raw.map((lint) => {
      const span = lint.span();
      return {
        kind: lint.lint_kind(),
        message: lint.message(),
        start: span.start,
        end: span.end,
        suggestions: lint.suggestions().slice(0, 5).map((suggestion) => suggestion.get_replacement_text()),
      };
    });
    scope.postMessage({ id: request.id, lints });
  } catch (error) {
    scope.postMessage({ id: request.id, error: String(error) });
  }
};
