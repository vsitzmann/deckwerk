/**
 * The interface size: how large the editor's chrome is drawn, from the
 * DeckWerk menu. In the desktop app it is the window's zoom factor; a browser
 * tab cannot set its own, so the browser editor zooms its chrome — toolbar,
 * rail, side panel, menus and the controls over the canvas — leaving the
 * slide canvas itself unzoomed. Either way slides keep fitting the canvas.
 */
const SCALE_KEY = 'deckwerk.ui.scale';

const SIZES = [
  { label: 'Small', factor: 0.9 },
  { label: 'Default', factor: 1 },
  { label: 'Large', factor: 1.15 },
  { label: 'Larger', factor: 1.3 },
] as const;

interface ScaleApi { setUiScale?: (factor: number) => void }

function scaleApi(): ScaleApi | undefined {
  return (window as unknown as { api?: ScaleApi }).api;
}

export function storedUiScale(): number {
  try {
    const value = Number(window.localStorage.getItem(SCALE_KEY));
    return SIZES.some((size) => size.factor === value) ? value : 1;
  } catch {
    return 1;
  }
}

function applyFactor(factor: number): void {
  const api = scaleApi();
  if (api?.setUiScale) api.setUiScale(factor);
  else {
    // CSS zoom on the canvas would throw off its pointer maths, so the
    // browser editor zooms its chrome around the slide instead (editor.css).
    const root = document.documentElement;
    if (factor === 1) {
      delete root.dataset.uiZoom;
      root.style.removeProperty('--ui-zoom');
    } else {
      root.dataset.uiZoom = '';
      root.style.setProperty('--ui-zoom', String(factor));
    }
  }
}

/** Apply the stored size to this window; call once at startup. */
export function applyUiScale(): void {
  applyFactor(storedUiScale());
}

function setUiScale(factor: number): void {
  try {
    window.localStorage.setItem(SCALE_KEY, String(factor));
  } catch {
    // Private mode: the size lasts for this window only.
  }
  applyFactor(factor);
}

/** The DeckWerk menu's Interface size section. */
export function interfaceSizeMenuSection(): {
  label: string;
  options: { label: string; action: () => void; checked: () => boolean }[];
} {
  return {
    label: 'Interface size',
    options: SIZES.map(({ label, factor }) => ({
      label: `${label} · ${Math.round(factor * 100)}%`,
      action: () => setUiScale(factor),
      checked: () => storedUiScale() === factor,
    })),
  };
}
