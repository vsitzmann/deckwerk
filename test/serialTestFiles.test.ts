import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_TEST_FILES, SERIAL_TEST_FILES } from './testTiers.js';

describe('serialized integration manifest', () => {
  it('contains only unique, existing test files', () => {
    expect(new Set(SERIAL_TEST_FILES).size).toBe(SERIAL_TEST_FILES.length);
    for (const file of SERIAL_TEST_FILES) {
      expect(existsSync(resolve(process.cwd(), file)), file).toBe(true);
    }
  });

  it('runs the process-heavy local agent bridge away from the parallel unit tier', () => {
    expect(SERIAL_TEST_FILES).toContain('test/localAgentBridge.test.ts');
  });

  it('serializes real media and importer processes outside the required tier', () => {
    expect(SERIAL_TEST_FILES).toEqual(expect.arrayContaining([
      'test/exportDeckCompression.test.ts',
      'test/ffmpeg.test.ts',
      'test/keynoteImport.test.ts',
      'test/mediaImportFormats.test.ts',
      'test/mp4FastStart.test.ts',
      'test/posterCache.test.ts',
      'test/pptxImport.test.ts',
      'test/webImageImport.test.ts',
    ]));
  });

  it('keeps indirect Electron compilers out of the required unit tier', () => {
    expect(BROWSER_TEST_FILES).toEqual(expect.arrayContaining([
      'test/agentCli.test.ts',
      'test/collabServer.test.ts',
      'test/htmlAuthoring.test.ts',
      'test/pdfLooksLikePlayer.test.ts',
      'test/scratchpadRenderingBrowser.test.ts',
    ]));
  });
});
