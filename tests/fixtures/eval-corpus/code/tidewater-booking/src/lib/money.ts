/** Converts a euro amount typed by staff ("249,50" or "249.50") to integer cents without float drift. */
export function toCents(input: string): number {
  const normalised = input.trim().replace(/\s/g, '').replace(',', '.')
  const [whole, frac = ''] = normalised.split('.')
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2))
}

export function formatEUR(cents: number, locale = 'sv-SE'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
