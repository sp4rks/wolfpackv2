// Shared, dark text colours on the paper background. -1 is red, 0 green, +1 purple.
export function spectrum(position: number): string {
  const amount = Math.min(1, Math.abs(position));
  const base = [35, 100, 58], end = position < 0 ? [155, 38, 36] : [103, 43, 139];
  return `rgb(${base.map((value, i) => Math.round(value + (end[i]! - value) * amount)).join(", ")})`;
}
