const KEY = 'tbc_wishlist_product_ids_v1';

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

function write(ids) {
  localStorage.setItem(KEY, JSON.stringify([...new Set(ids)]));
  window.dispatchEvent(new CustomEvent('tbc_wishlist_updated', { detail: [...new Set(ids)] }));
}

export function getWishlistIds() { return read(); }
export function hasWishlistItem(id) { return read().includes(id); }
export function toggleWishlistItem(id) {
  const ids = read();
  write(ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  return hasWishlistItem(id);
}
export function removeWishlistItem(id) { write(read().filter(item => item !== id)); }
