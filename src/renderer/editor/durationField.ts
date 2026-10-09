/**
 * An animation's duration: a slider for feel, a number for precision.
 *
 * Dragging the slider updates the number as it goes and commits once, when
 * the drag ends, so a sweep across the track is one undo step rather than
 * dozens. Typing a number commits on change and moves the slider to match.
 * Values outside the slider's range are allowed in the number (the slider
 * simply pins at its end), since a slow reveal is a legitimate choice.
 */
export function durationField(
  value: number,
  onCommit: (ms: number) => void,
  opts: {
    /** Class on the number input, for tests and existing styling. */
    inputClass: string;
    label: string;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
  },
): HTMLElement {
  const min = opts.min ?? 100;
  const max = opts.max ?? 5000;
  const step = opts.step ?? 50;
  const wrap = document.createElement('span');
  wrap.className = 'duration-field';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'duration-slider';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(Math.min(max, Math.max(min, value)));
  slider.setAttribute('aria-label', `${opts.label} slider`);
  slider.disabled = Boolean(opts.disabled);

  const number = document.createElement('input');
  number.type = 'number';
  number.className = opts.inputClass;
  number.min = '0';
  number.step = String(step);
  number.value = String(value);
  number.title = `${opts.label}, in milliseconds`;
  number.setAttribute('aria-label', `${opts.label} in milliseconds`);
  number.disabled = Boolean(opts.disabled);

  const unit = document.createElement('span');
  unit.className = 'field-unit';
  unit.textContent = 'ms';
  unit.setAttribute('aria-hidden', 'true');
  const numberWrap = document.createElement('span');
  numberWrap.className = 'field-unit-wrap duration-number';
  numberWrap.append(number, unit);

  slider.addEventListener('input', () => { number.value = slider.value; });
  slider.addEventListener('change', () => onCommit(Number(slider.value)));
  number.addEventListener('change', () => {
    const ms = Math.max(0, Number(number.value) || 0);
    number.value = String(ms);
    slider.value = String(Math.min(max, Math.max(min, ms)));
    onCommit(ms);
  });

  wrap.append(slider, numberWrap);
  return wrap;
}
