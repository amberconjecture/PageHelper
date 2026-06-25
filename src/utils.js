export function normalizeArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(Object(value), key);
}
