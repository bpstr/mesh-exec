/**
 * Convert a string to a URL-friendly ASCII slug.
 *
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  if (typeof value !== "string") {
    throw new TypeError("value must be a string");
  }

  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
