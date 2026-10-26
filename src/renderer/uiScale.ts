/**
 * The interface size: how large the editor's chrome is drawn, from the
 * DeckWerk menu. It is the window's zoom factor, so the canvas's pointer
 * maths stay exact; slides keep fitting the canvas as before.
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

/** Apply the stored size to this window; call once at startup. */
export function applyUiScale(): void {
  scaleApi()?.setUiScale?.(storedUiScale());
}

function setUiScale(factor: number): void {
  try {
    window.localStorage.setItem(SCALE_KEY, String(factor));
  } catch {
    // Private mode: the size lasts for this window only.
  }
  scaleApi()?.setUiScale?.(factor);
}

/** The DeckWerk menu's Interface size section, or null where a window cannot zoom itself. */
export function interfaceSizeMenuSection(): {
  label: string;
  options: { label: string; action: () => void; checked: () => boolean }[];
} | null {
  if (!scaleApi()?.setUiScale) return null;
  return {
    label: 'Interface size',
    options: SIZES.map(({ label, factor }) => ({
      label: `${label} · ${Math.round(factor * 100)}%`,
      action: () => setUiScale(factor),
      checked: () => storedUiScale() === factor,
    })),
  };
}
