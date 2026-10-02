import { describe, expect, it } from 'vitest';
import { clipboardFilePaths, firstClipboardMediaPath } from '../src/shared/clipboardFiles.js';

describe('clipboardFilePaths', () => {
  it('reads a Nautilus text/uri-list, decoding escapes', () => {
    expect(clipboardFilePaths('file:///home/me/Downloads/task%20demo.mp4\r\n', 'linux'))
      .toEqual(['/home/me/Downloads/task demo.mp4']);
  });

  it('reads GNOME copied-files after its copy/cut verb', () => {
    expect(clipboardFilePaths('copy\nfile:///a/one.mp4\nfile:///a/two.png', 'linux'))
      .toEqual(['/a/one.mp4', '/a/two.png']);
  });

  it('skips comments, web links and remote hosts', () => {
    expect(clipboardFilePaths('# from Dolphin\nhttps://x.test/v.mp4\nfile://other/v.mp4\nfile://localhost/ok.mp4', 'linux'))
      .toEqual(['/ok.mp4']);
  });

  it('turns a Windows drive URL into a drive path', () => {
    expect(clipboardFilePaths('file:///C:/Users/me/clip.mp4', 'win32')).toEqual(['C:\\Users\\me\\clip.mp4']);
  });

  it('picks the first importable media file', () => {
    expect(firstClipboardMediaPath(['/a/notes.txt', '/a/clip.MP4', '/a/b.png'])).toBe('/a/clip.MP4');
    expect(firstClipboardMediaPath(['/a/notes.txt'])).toBeNull();
  });
});
