/** PostgreSQL numeric comes back as string; keep 8 dp for virtual currency. */
export function dec(n: string | number): number {
  const x = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e8) / 1e8;
}

export function fmt(n: number): string {
  return (Math.round(n * 1e8) / 1e8).toFixed(8);
}
