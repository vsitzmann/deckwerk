import { loadDeck } from '../src/main/deckStore.js';
import { exportDeck } from '../src/main/exportDeck.js';
import { writeExportThumbnail } from '../src/main/exportThumbnail.js';
import type { WebExportQuality } from '../src/shared/ipc.js';

/**
 * Headless export for scripts and agents:
 *   npm run export -- <deck-dir> <out-dir> [--quality original|balanced|compact] [--no-thumbnail] [--speaker-view]
 * Produces the same standalone bundle as "Export web…" in the app: only the
 * media the slides show, re-encoded to the chosen quality, plus thumbnail.jpg
 * of the first slide for pages that list decks.
 */
const args = process.argv.slice(2);
const positional: string[] = [];
let quality: WebExportQuality = 'balanced';
let thumbnail = true;
let speakerView = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--quality') {
    const value = args[++i];
    if (value !== 'original' && value !== 'balanced' && value !== 'compact') {
      console.error(`--quality must be original, balanced or compact (got ${value ?? 'nothing'})`);
      process.exit(2);
    }
    quality = value;
  } else if (arg === '--no-thumbnail') thumbnail = false;
  else if (arg === '--speaker-view') speakerView = true;
  else positional.push(arg);
}
const [dir, out] = positional;
if (!dir || !out) {
  console.error('usage: npm run export -- <deck-dir> <out-dir> [--quality original|balanced|compact] [--no-thumbnail] [--speaker-view]');
  process.exit(2);
}
const deck = await loadDeck(dir);
let lastLine = '';
const result = await exportDeck(dir, deck, out, (message, ratio) => {
  const line = ratio === null ? message : `${Math.round(ratio * 100).toString().padStart(3)}% ${message}`;
  if (line !== lastLine && process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${line}`);
  lastLine = line;
}, { quality, dropSkipped: true, speakerView });
if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
if (thumbnail) await writeExportThumbnail(dir, deck, out, (message) => console.error(message));
const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;
console.log(
  `exported ${deck.slides.length} slides -> ${out} (${result.quality}: ${result.assets} assets, `
  + `${mb(result.sourceBytes)} -> ${mb(result.exportedBytes)})`,
);
