/**
 * THE BANIYAN COMPANY — Persistent Cart Store
 * Manages shopping cart state, LocalStorage sync, calculations & UI badge updates
 */

const CART_STORAGE_KEY = 'tbc_cart_items_v1';

class CartStore {
  constructor() {
    this.cart = this.loadCart();
  }

  loadCart() {
    try {
      const stored = localStorage.getItem(CART_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      console.error('Failed to load cart from LocalStorage:', e);
      return [];
    }
  }

  saveCart() {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(this.cart));
      this.dispatchCartUpdateEvent();
      this.updateCartBadges();
    } catch (e) {
      console.error('Failed to save cart to LocalStorage:', e);
    }
  }

  getCart() {
    return [...this.cart];
  }

  addToCart(product) {
    const {
      id,
      productId = id,
      name,
      price,
      originalPrice = price,
      image,
      size = 'M',
      color = 'Optic White',
      category = 'General',
      variantKey = `${size}::${color}`,
      stock = Number.MAX_SAFE_INTEGER,
      quantity = 1
    } = product;

    const cartItemId = `${productId}_${variantKey.replace(/\s+/g, '_')}`;
    const requestedQuantity = Number(quantity);
    if (!Number.isFinite(requestedQuantity) || requestedQuantity < 1 || Number(stock) < 1) {
      throw new Error('This product variant is currently out of stock.');
    }

    const existingIndex = this.cart.findIndex(item => item.cartItemId === cartItemId);

    if (existingIndex > -1) {
      const nextQuantity = this.cart[existingIndex].quantity + requestedQuantity;
      if (nextQuantity > Number(stock)) throw new Error('Only the available stock can be added to your bag.');
      this.cart[existingIndex].quantity = nextQuantity;
    } else {
      this.cart.push({
        cartItemId,
        productId,
        name,
        price: Number(price),
        originalPrice: Number(originalPrice),
        image,
        size,
        color,
        category,
        variantKey,
        stock: Number(stock),
        quantity: requestedQuantity
      });
    }

    this.saveCart();
    return this.getCartTotals();
  }

  removeFromCart(cartItemId) {
    this.cart = this.cart.filter(item => item.cartItemId !== cartItemId);
    this.saveCart();
    return this.getCartTotals();
  }

  updateQuantity(cartItemId, newQuantity) {
    const qty = parseInt(newQuantity, 10);
    if (isNaN(qty) || qty <= 0) {
      return this.removeFromCart(cartItemId);
    }

    const item = this.cart.find(item => item.cartItemId === cartItemId);
    if (item) {
      if (qty > Number(item.stock ?? Number.MAX_SAFE_INTEGER)) {
        throw new Error('Requested quantity exceeds available stock.');
      }
      item.quantity = qty;
      this.saveCart();
    }
    return this.getCartTotals();
  }

  clearCart() {
    this.cart = [];
    this.saveCart();
  }

  getCartTotals() {
    const itemCount = this.cart.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = this.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    // Check company settings for GST activation
    let isGstEnabled = false;
    let gstPct = 0;
    try {
      const raw = localStorage.getItem('tbc_cache_company');
      if (raw) {
        const parsed = JSON.parse(raw);
        const comp = parsed.data || parsed;
        const exp = comp?.expenses || {};
        if (exp.cgstEnabled === true || comp?.cgstEnabled === true || comp?.isGstEnabled === true) {
          isGstEnabled = true;
          gstPct = Number(exp.cgstPercentage || comp?.cgstPercentage || comp?.gstPercentage || 5);
        }
      }
    } catch (e) {}

    const tax = isGstEnabled ? Math.round(subtotal * (gstPct / 100)) : 0;
    const shipping = 0; // FREE Express Shipping
    const grandTotal = subtotal + tax + shipping;

    return {
      itemCount,
      subtotal,
      tax,
      isGstEnabled,
      gstPct,
      shipping,
      grandTotal
    };
  }

  dispatchCartUpdateEvent() {
    const event = new CustomEvent('tbc_cart_updated', {
      detail: {
        cart: this.getCart(),
        totals: this.getCartTotals()
      }
    });
    window.dispatchEvent(event);
  }

  updateCartBadges() {
    const totals = this.getCartTotals();
    const badgeElements = document.querySelectorAll('.cart-badge-count, #cart-count-badge, [data-cart-badge]');
    badgeElements.forEach(badge => {
      badge.textContent = totals.itemCount;
      if (totals.itemCount > 0) {
        badge.classList.remove('hidden');
        badge.style.display = 'flex';
      } else {
        badge.classList.add('hidden');
        badge.style.display = 'none';
      }
    });
  }
}

// Global Singleton Instance
window.tbcCart = window.tbcCart || new CartStore();

// Auto update badges on DOM load
document.addEventListener('DOMContentLoaded', () => {
  window.tbcCart.updateCartBadges();
});

export default window.tbcCart;
