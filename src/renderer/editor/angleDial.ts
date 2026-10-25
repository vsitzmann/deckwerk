import { ANGLE_SNAP_DEGREES, snapAngle } from '@shared/geometry.js';

/** Each dial's way of being turned from outside, see `setDialAngle`. */
const turners = new WeakMap<HTMLElement, (degrees: number | null) => void>();

/**
 * Point a dial made by `angleDial` at `degrees` (null: mixed) without
 * reporting it, as a readout follows a value changed elsewhere.
 */
export function setDialAngle(dial: HTMLElement, degrees: number | null): void {
  turners.get(dial)?.(degrees);
}

/**
 * A round dial for a direction, like Keynote's shadow angle knob.
 *
 * The angle is degrees counter-clockwise from the right (0 points right, 90
 * up, 270 down), the convention the shadow's Angle field uses, and the mark
 * on the dial points where the shadow falls. Drag anywhere on the dial to
 * point it there (Shift snaps to `ANGLE_SNAP_DEGREES`, the step the canvas's
 * rotate gesture snaps to); the arrow keys turn it a degree at a time (Shift:
 * the same step). A drag is one begin/end pair around any number of
 * inputs, so the caller can make it a single undo step.
 */
export function angleDial(
  value: number | null,
  handlers: {
    onBegin: () => void;
    onInput: (degrees: number) => void;
    onEnd: () => void;
  },
  label = 'Angle',
): HTMLElement {
  const dial = document.createElement('div');
  dial.className = 'angle-dial';
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', label);
  dial.setAttribute('aria-valuemin', '0');
  dial.setAttribute('aria-valuemax', '359');
  dial.title = `${label}: drag to turn, Shift to snap to ${ANGLE_SNAP_DEGREES}°`;
  const hand = document.createElement('span');
  hand.className = 'angle-dial-hand';
  dial.appendChild(hand);
  if (value === null) dial.classList.add('is-mixed');

  let current = value ?? 270;
  const show = (degrees: number): void => {
    current = ((Math.round(degrees) % 360) + 360) % 360;
    // CSS turns clockwise; the angle turns counter-clockwise.
    hand.style.transform = `rotate(${-current}deg)`;
    dial.setAttribute('aria-valuenow', String(current));
    dial.setAttribute('aria-valuetext', `${current}°`);
  };
  show(current);
  turners.set(dial, (degrees) => {
    dial.classList.toggle('is-mixed', degrees === null);
    if (degrees !== null) show(degrees);
  });

  const pointAt = (event: PointerEvent): number => {
    const box = dial.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    let degrees = (Math.atan2(-dy, dx) * 180) / Math.PI;
    if (event.shiftKey) degrees = snapAngle(degrees);
    return ((Math.round(degrees) % 360) + 360) % 360;
  };

  let dragging = false;
  dial.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dial.focus();
    dial.setPointerCapture?.(event.pointerId);
    dragging = true;
    dial.classList.remove('is-mixed');
    handlers.onBegin();
    show(pointAt(event));
    handlers.onInput(current);
  });
  dial.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const next = pointAt(event);
    if (next === current) return;
    show(next);
    handlers.onInput(current);
  });
  const finish = (): void => {
    if (!dragging) return;
    dragging = false;
    handlers.onEnd();
  };
  dial.addEventListener('pointerup', finish);
  dial.addEventListener('pointercancel', finish);
  dial.addEventListener('lostpointercapture', finish);

  dial.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? ANGLE_SNAP_DEGREES : 1;
    const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? step
      : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    dial.classList.remove('is-mixed');
    handlers.onBegin();
    show(current + delta);
    handlers.onInput(current);
    handlers.onEnd();
  });
  return dial;
}
