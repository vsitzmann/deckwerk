/** Display progress counts visible slides; navigation still uses deck indices. */
export function slideProgress(slides: readonly { skipped?: boolean }[], index: number): { number: number | null; total: number } {
  let total = 0;
  let number: number | null = null;
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].skipped) continue;
    total++;
    if (i === index) number = total;
  }
  return { number, total };
}

export function slideProgressLabel(slides: readonly { skipped?: boolean }[], index: number): string {
  const { number, total } = slideProgress(slides, index);
  return `${number ?? '—'}/${total}`;
}

/** Hidden slides have no presentation number. */
export function slideNumberLabel(slides: readonly { skipped?: boolean }[], index: number): string {
  return String(slideProgress(slides, index).number ?? '—');
}
