import type { MenuItemConstructorOptions } from 'electron';

/**
 * The macOS menu bar: Electron's default one, plus Settings… (⌘,) under the
 * app name where a Mac user looks for it. The File, Edit, View and Window
 * menus are the same roles the default menu is built from; only the default
 * Help menu, whose links all point at Electron's own website, is left out.
 *
 * The editor takes ⌘, itself before the menu sees it (settingsDialog.ts), so
 * the item's click only matters when it is chosen with the mouse. Other
 * platforms keep Electron's default menu and get Ctrl+, from the editor alone.
 */
export function macAppMenuTemplate(
  appName: string,
  openSettings: () => void,
): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
