import { pathToFileURL } from 'node:url';
import { Cdp, eventually } from './browserSession.js';

/**
 * Put files on the OS clipboard the way a file manager's Copy does.
 *
 * Nautilus, Dolphin and Finder do not put file bytes on the clipboard: they
 * offer the files' URLs (`text/uri-list` on Linux, `public.file-url` on
 * macOS), and the app that pastes has to go and read the files itself.
 * Chromium's async clipboard API cannot write those formats, and an outside
 * tool like wl-copy is no use either: under Wayland only the focused client
 * can read another client's selection, and test windows are hidden. So the
 * write happens inside the Electron process under test, through its main
 * process's Node inspector (`--inspect=<port>`), using Electron's own
 * `clipboard.writeBuffer` -- the same pasteboard entry, written by a
 * different hand.
 *
 * Returns a function that clears the clipboard again.
 */
export async function copyFilesLikeFileManager(
  inspectorPort: number,
  paths: string[],
): Promise<() => Promise<void>> {
  const urls = paths.map((path) => pathToFileURL(path).href);
  let format: string;
  let payload: string;
  if (process.platform === 'linux') {
    format = 'text/uri-list';
    payload = `${urls.join('\r\n')}\r\n`;
  } else if (process.platform === 'darwin') {
    format = 'public.file-url';
    payload = urls[0];
  } else {
    throw new Error(`copyFilesLikeFileManager has no file-copy format for ${process.platform}`);
  }
  const target = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`);
    const [first] = await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
    return first?.webSocketDebuggerUrl ?? null;
  }, 'the Electron main-process inspector did not come up', (url) => Boolean(url));
  const main = await Cdp.connect(target!);
  const run = (expression: string) => main.call('Runtime.evaluate', {
    expression,
    // Node's command-line API is what provides `require` here.
    includeCommandLineAPI: true,
    returnByValue: true,
  });
  await run(`require('electron').clipboard.writeBuffer(
    ${JSON.stringify(format)}, Buffer.from(${JSON.stringify(payload)}, 'utf8'))`);
  return async () => {
    await run(`require('electron').clipboard.clear()`).catch(() => undefined);
    main.close();
  };
}
