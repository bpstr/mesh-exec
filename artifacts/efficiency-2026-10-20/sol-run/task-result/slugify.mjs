export function slugify(value) {
  if (typeof value !== 'string') {
    throw new TypeError('slugify requires a string');
  }

  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
