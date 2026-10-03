const { app, BrowserWindow } = require('electron');

const url = process.argv[2];
const port = process.argv[3] || '9222';
const profileDir = process.argv[4];
if (!url) throw new Error('usage: electron eval-browser.cjs <url> <debug-port> [profile-dir]');
if (profileDir) app.setPath('userData', profileDir);
app.commandLine.appendSwitch('remote-debugging-port', port);
app.commandLine.appendSwitch('remote-allow-origins', '*');
// A presentation is video wall-to-wall, and these windows are hidden (show:
// false), which Chromium treats as background: muted, audio-less video gets
// suspended "to save power". Without this, no test could ever observe a clip
// actually playing.
app.commandLine.appendSwitch('disable-background-media-suspend');
// These windows are hidden, and Chromium throttles timers and backgrounds
// renderers it cannot see. Any timing a test measures would be quantised to
// the throttle interval rather than reflecting the code under test.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;
app.whenReady().then(async () => {
  // Hidden on a developer's machine, so tests never pop windows over their
  // work. On CI's bare Xvfb (CI_NO_WINDOW_MANAGER) the window is shown: an
  // unmapped X11 window gets no compositor frames at all, and every input
  // event dispatched over DevTools then waits out a fixed fallback before the
  // renderer handles it -- the nightly formatting matrix ran at 2.8 s/case in
  // this window against 145 ms/case in the app's shown window on the same
  // runner. Nobody is looking at that display, so showing it costs nothing.
  const showWindow = Boolean(process.env.CI_NO_WINDOW_MANAGER);
  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    autoplayPolicy: 'no-user-gesture-required',
    // The command-line switches above are not the whole story: Electron
    // also throttles per window, and treats a window that is never shown as
    // background -- so under CI's bare Xvfb (the window is never mapped at
    // all) the page reports itself hidden, requestAnimationFrame stops, and
    // timers align to one-second ticks. The nightly formatting matrix ran
    // at 2.8 s/case there against 145 ms/case in the shown Electron window.
    backgroundThrottling: false,
    // Hidden, the window is never mapped: no compositor frames, so every
    // DevTools input event waited out a ~1 s fallback (2.8 s per formatting
    // case on a developer's machine). Offscreen rendering keeps frames coming
    // with nothing on screen.
    offscreen: !showWindow,
  };
  // Tabs a page opens itself (a second editor, a presentation) get the same
  // window. Left to Electron's defaults they are ordinary visible windows,
  // and a tiling window manager squeezes them beside whatever else is open:
  // on a Hyprland desktop the peer editor came up 670 px wide, too narrow
  // for the layout the tests click through. CI's bare Xvfb never resized it.
  //
  // Nor may a page's Fullscreen API reach the window manager: presenting
  // calls requestFullscreen, Electron turns that into a real OS fullscreen
  // window, and on leaving it a tiling window manager keeps the window as
  // one of its own -- the editor came back 670 px wide and later clicks
  // landed on the wrong controls. Not fullscreenable, the element still goes
  // fullscreen inside the window, which is all a test observes.
  const windowOptions = { width: 1600, height: 1000, show: showWindow, fullscreenable: false, webPreferences };
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: windowOptions,
    }));
  });
  mainWindow = new BrowserWindow(windowOptions);

  // The evaluation model may navigate through CDP while this first load is in
  // flight. Keep the window alive and tolerate that intentional cancellation.
  await mainWindow.loadURL(url).catch((error) => {
    if (!String(error).includes('ERR_ABORTED') && !String(error).includes('ERR_FAILED')) throw error;
  });
});

app.on('window-all-closed', () => app.quit());
