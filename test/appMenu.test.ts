import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { macAppMenuTemplate } from '../src/main/appMenu.js';

describe('the macOS app menu', () => {
  it("is Electron's default menu with Settings… (⌘,) under the app name", () => {
    let opened = 0;
    const template = macAppMenuTemplate('DeckWerk', () => { opened += 1; });
    const [app, ...rest] = template;
    expect(app.label).toBe('DeckWerk');
    const items = app.submenu as MenuItemConstructorOptions[];
    expect(items.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'about', 'separator', 'Settings…', 'separator', 'services', 'separator',
      'hide', 'hideOthers', 'unhide', 'separator', 'quit',
    ]);
    const settings = items.find((item) => item.label === 'Settings…')!;
    expect(settings.accelerator).toBe('Command+,');
    (settings.click as () => void)();
    expect(opened).toBe(1);
    // The rest are the roles the default menu is made of, untouched.
    expect(rest.map((menu) => menu.role)).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'windowMenu']);
  });
});
