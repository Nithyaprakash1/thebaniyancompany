/**
 * ============================================================
 *  THE BANIYAN COMPANY — Firebase v10 Modular Data Service
 *  Lead Architect: Industrial-Grade Firestore Integration
 * ============================================================
 *
 * COLLECTIONS COVERED:
 *   /categories         — product category catalog
 *   /products           — product catalog with variants & stock
 *   /invoices           — orders / checkout documents
 *   /companies/{id}     — company profile, banner, settings
 *
 * PATTERNS:
 *   - Firebase v10 Modular SDK (tree-shakeable)
 *   - Async/await with structured try/catch/finally
 *   - runTransaction for atomic stock decrements
 *   - onSnapshot for real-time order feeds
 *   - Order Status State Machine
 * ============================================================
 */

import {
  db,
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  onSnapshot,
} from './firebase-config.js';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

export const COMPANY_ID = 'thebaniyancompany';
export const BRANCH_ID  = 'online';           // Default branch for web orders

/** Ordered status lifecycle for online orders */
export const ORDER_STATUS_FLOW = [
  'Awaiting Acceptance',
  'Processing',
  'Packed',
  'Shipped',
  'Out for Delivery',
  'Delivered',
];

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

/**
 * Format a number as Indian Rupee string.
 * @param {number} value
 * @returns {string}  e.g. "₹1,499"
 */
export function formatMoney(value) {
  return `₹${Number(value || 0).toLocaleString('en-IN')}`;
}

/**
 * Safely extract a stock count from a variant's stock map.
 * Supports both { stock: number } and { stock: { [branchId]: number } } shapes.
 * @param {object} variant
 * @param {string} [branchId]
 * @returns {number}
 */
export function getVariantStock(variant, branchId = BRANCH_ID) {
  if (!variant?.stock) return 0;
  if (typeof variant.stock === 'number') return Math.max(0, variant.stock);
  if (typeof variant.stock === 'object') {
    // Prefer branch-specific count, fallback to 'main'
    return Math.max(0, Number(variant.stock[branchId] ?? variant.stock.main ?? 0));
  }
  return 0;
}

/**
 * Normalise a raw variants array from Firestore into a consistent shape.
 * @param {any[]} variants
 * @param {string} [branchId]
 * @returns {object[]}
 */
export function normalizeVariants(variants, branchId = BRANCH_ID) {
  if (!Array.isArray(variants)) return [];
  return variants.map((v, i) => ({
    ...v,
    key:   v.id || `${v.size || ''}::${v.color || ''}::${i}`,
    price: Number(v.price ?? 0),
    cost:  Number(v.cost  ?? 0),
    size:  String(v.size  ?? 'Standard'),
    color: String(v.color ?? 'Default'),
    stock: {
      [branchId]: getVariantStock(v, branchId),
      main:       getVariantStock(v, 'main'),
    },
  }));
}

/**
 * Derive the minimum available price across all in-stock variants.
 * Falls back to any variant if none are in-stock.
 * @param {object} product  Normalised product
 * @returns {number}
 */
export function productPrice(product) {
  const variants  = product.variants || [];
  const inStock   = variants.filter(v => getVariantStock(v) > 0);
  const pool      = inStock.length ? inStock : variants;
  const prices    = pool.map(v => v.price).filter(Number.isFinite);
  return prices.length ? Math.min(...prices) : 0;
}

/**
 * Normalise a raw Firestore product document into a consistent UI shape.
 * @param {string} id   Firestore document ID
 * @param {object} data Raw document data
 * @returns {object}
 */
export function normalizeProduct(id, data = {}) {
  const variants = normalizeVariants(data.variants);

  // Resolve image array from multiple possible field shapes
  let imageUrls = [];
  if (Array.isArray(data.imageUrls) && data.imageUrls.length)      imageUrls = data.imageUrls.filter(Boolean);
  else if (Array.isArray(data.images) && data.images.length)        imageUrls = data.images.filter(Boolean);
  else if (typeof data.imageUrl === 'string' && data.imageUrl)      imageUrls = [data.imageUrl];
  else if (typeof data.image   === 'string' && data.image)          imageUrls = [data.image];

  const name          = data.name || data.title || 'Unnamed Product';
  const price         = Number.isFinite(Number(data.price)) && data.price != null
    ? Number(data.price)
    : productPrice({ variants });

  const originalPrice = data.originalPrice != null ? Number(data.originalPrice)
    : data.mrp         != null ? Number(data.mrp)
    : null;

  const category = typeof data.category === 'string'
    ? data.category
    : data.category?.name ?? '';

  const tag = typeof data.tag === 'string'
    ? data.tag
    : Array.isArray(data.tags) ? (data.tags[0] ?? '') : '';

  const calcPct = (originalPrice && originalPrice > price)
    ? Math.round(((originalPrice - price) / originalPrice) * 100)
    : (typeof data.discount === 'number' ? data.discount : (parseInt(data.discount) || 0));

  const discountPct = (typeof calcPct === 'number' && calcPct > 0) ? calcPct : 0;

  return {
    ...data,
    id,
    productId:      data.productId || id,
    companyId:      data.companyId || COMPANY_ID,
    name,
    description:    data.description || data.details || '',
    gender:         data.gender   || 'Unisex',
    material:       data.material || '',
    tag,
    category,
    imageUrls,
    thumbnail:      imageUrls[0] || '',         // ← first image, ready for UI
    variants,
    price,
    originalPrice,
    discountPct,
    discount:       discountPct > 0 ? `${discountPct}% OFFER` : '',
    availableStock: variants.reduce((sum, v) => sum + getVariantStock(v), 0),
    showInEcom:     data.showInEcom !== false, // Strict E-commerce visibility flag (defaults to true unless explicitly false)
  };
}

/**
 * Normalise a raw Firestore category document.
 * @param {string} id
 * @param {object} data
 * @returns {object}
 */
export function normalizeCategory(id, data = {}) {
  return {
    id,
    name:      data.name      || data.categoryName || data.title || id,
    companyId: data.companyId || COMPANY_ID,
    parentId:  data.parentId  ?? null,
    icon:      data.icon      || '',
    imageUrl:  data.imageUrl  || data.image || data.iconUrl || '',
  };
}


// ═══════════════════════════════════════════════════════════════
// 1.  CATEGORIES & PRODUCTS — LIVE REAL-TIME DATA LAYER
//     Real-time Firestore listeners with instant memory state.
// ═══════════════════════════════════════════════════════════════

// Clean up any legacy persistent product caches to prevent old stock traps
try {
  localStorage.removeItem('tbc_cache_products');
  localStorage.removeItem('tbc_cache_categories');
} catch (e) {}

let _cachedProducts = null;
let _cachedCategories = null;

// Exported live accessors
export function getCachedProducts() {
  return _cachedProducts;
}

export function setCachedProducts(products) {
  _cachedProducts = products;
}

export function getCachedCategories() {
  return _cachedCategories;
}

export function setCachedCategories(categories) {
  _cachedCategories = categories;
}

export function getCachedCompany() {
  try {
    const raw = localStorage.getItem('tbc_cache_company');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data || parsed;
  } catch (e) {
    return null;
  }
}

export function setCachedCompany(company) {
  try {
    localStorage.setItem('tbc_cache_company', JSON.stringify({ time: Date.now(), data: company }));
  } catch (e) {}
}

export function clearTbcCache() {
  try {
    localStorage.removeItem('tbc_cache_products');
    localStorage.removeItem('tbc_cache_categories');
    localStorage.removeItem('tbc_cache_company');
  } catch (e) {}
  _cachedProducts = null;
  _cachedCategories = null;
}

export async function deleteProduct(id) {
  if (!id) return false;
  try {
    await deleteDoc(doc(db, 'products', id));
    if (Array.isArray(_cachedProducts)) {
      _cachedProducts = _cachedProducts.filter(p => p.id !== id && p.productId !== id);
    }
    clearTbcCache();
    return true;
  } catch (err) {
    console.error('[TBC] deleteProduct error:', err);
    throw err;
  }
}

export async function purgeMockProducts() {
  try {
    const snap = await getDocs(collection(db, 'products'));
    let deletedCount = 0;
    for (const d of snap.docs) {
      const data = d.data();
      const name = String(data.name || '').toLowerCase();
      if (
        name.includes('test') ||
        name.includes('mock') ||
        name.includes('ethereal white co-ord') ||
        data.isMock === true ||
        data.showInEcom === false
      ) {
        await deleteDoc(doc(db, 'products', d.id));
        deletedCount++;
      }
    }
    clearTbcCache();
    return deletedCount;
  } catch (e) {
    console.error('[TBC] purgeMockProducts error:', e);
    throw e;
  }
}

if (typeof window !== 'undefined') {
  window.clearTbcCache = clearTbcCache;
  window.deleteProduct = deleteProduct;
  window.purgeMockProducts = purgeMockProducts;
}

/**
 * Real-time live listener for categories.
 * @param {Function} onUpdate
 * @param {Function} [onError]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToCategories(onUpdate, onError) {
  if (typeof onUpdate !== 'function') return () => {};

  if (_cachedCategories && _cachedCategories.length > 0) {
    onUpdate(_cachedCategories);
  }

  try {
    const ref = collection(db, 'categories');
    return onSnapshot(ref, (snapshot) => {
      const normalized = snapshot.docs
        .map(d => normalizeCategory(d.id, d.data()))
        .filter(c => c.id)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      _cachedCategories = normalized;
      onUpdate(normalized);
    }, (err) => {
      console.warn('[TBC Real-Time] subscribeToCategories warning:', err);
      if (typeof onError === 'function') onError(err);
    });
  } catch (err) {
    console.error('[TBC Real-Time] subscribeToCategories error:', err);
    return () => {};
  }
}

/**
 * Fetch all category documents from /categories.
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getCategories(companyId = COMPANY_ID) {
  if (_cachedCategories && _cachedCategories.length > 0) {
    return _cachedCategories;
  }
  return await revalidateCategories(companyId);
}

export async function revalidateCategories(companyId = COMPANY_ID) {
  try {
    const ref = collection(db, 'categories');
    const snapshot = await getDocs(ref);
    const normalized = snapshot.docs
      .map(d => normalizeCategory(d.id, d.data()))
      .filter(c => c.id && (!companyId || c.companyId === companyId || true))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    _cachedCategories = normalized;
    return _cachedCategories || [];
  } catch (err) {
    console.error('[TBC] getCategories error:', err);
    return _cachedCategories || [];
  }
}

/**
 * Real-time live listener for all store products, stock quantity & visibility.
 * Whenever an admin uploads a product, edits stock, or changes details,
 * all subscribed pages update instantly in real time.
 *
 * @param {Function} onUpdate
 * @param {Function} [onError]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToProducts(onUpdate, onError) {
  if (typeof onUpdate !== 'function') return () => {};

  // Instant render from memory if available
  if (_cachedProducts && Array.isArray(_cachedProducts) && _cachedProducts.length > 0) {
    onUpdate(_cachedProducts);
  }

  try {
    const ref = collection(db, 'products');
    return onSnapshot(ref, (snapshot) => {
      const normalized = snapshot.docs
        .map(d => normalizeProduct(d.id, d.data()))
        .filter(p => p.id && p.showInEcom !== false);

      _cachedProducts = normalized;
      onUpdate(normalized);
    }, (err) => {
      console.warn('[TBC Real-Time] subscribeToProducts warning:', err);
      if (typeof onError === 'function') onError(err);
    });
  } catch (err) {
    console.error('[TBC Real-Time] subscribeToProducts error:', err);
    return () => {};
  }
}

/**
 * Fetch all products for a given company live from Firestore.
 * @param {string} [companyId]
 * @param {number} [limitCount]
 * @returns {Promise<object[]>}
 */
export async function getProducts(companyId = COMPANY_ID, limitCount = null) {
  if (_cachedProducts && Array.isArray(_cachedProducts) && _cachedProducts.length > 0) {
    return limitCount ? _cachedProducts.slice(0, limitCount) : _cachedProducts;
  }

  const products = await revalidateProducts(companyId);
  return limitCount ? products.slice(0, limitCount) : products;
}

export async function revalidateProducts(companyId = COMPANY_ID) {
  try {
    const ref = collection(db, 'products');
    const snapshot = await getDocs(ref);
    const normalized = snapshot.docs
      .map(d => normalizeProduct(d.id, d.data()))
      .filter(p => p.id && p.showInEcom !== false); // Strict filter: exclude any product marked showInEcom = false

    _cachedProducts = normalized;
    return _cachedProducts || [];
  } catch (err) {
    console.error('[TBC] getProducts error:', err);
    return _cachedProducts || [];
  }
}

/**
 * Fetch a single product by its Firestore document ID or productId field live from Firestore.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getProductById(id) {
  if (!id) return null;

  // 1. Direct Firestore document lookup (Guarantees real-time accurate stock & price)
  try {
    const snap = await getDoc(doc(db, 'products', id));
    if (snap.exists()) {
      const p = normalizeProduct(snap.id, snap.data());
      return p.showInEcom !== false ? p : null;
    }

    const q = query(collection(db, 'products'), where('productId', '==', id), limit(1));
    const snap2 = await getDocs(q);
    if (!snap2.empty) {
      const p = normalizeProduct(snap2.docs[0].id, snap2.docs[0].data());
      return p.showInEcom !== false ? p : null;
    }
  } catch (err) {
    console.error(`[TBC] getProductById(${id}) direct fetch error:`, err);
  }

  // 2. Fallback to active in-memory list if offline or network glitch
  if (Array.isArray(_cachedProducts) && _cachedProducts.length > 0) {
    const match = _cachedProducts.find(p => (p.id === id || p.productId === id) && p.showInEcom !== false);
    if (match) return match;
  }

  return null;
}

/**
 * Fetch related products in the same category (excluding current product).
 * @param {object} product  Normalised product
 * @param {number} [max]
 * @returns {Promise<object[]>}
 */
export async function getRelatedProducts(product, max = 4) {
  if (!product?.category) return [];
  try {
    const all = await getProducts();
    return all
      .filter(p => p.id !== product.id && p.category === product.category && p.showInEcom !== false)
      .slice(0, max);
  } catch (err) {
    console.error('[TBC] getRelatedProducts error:', err);
    return [];
  }
}

/**
 * Real-time live listener for a single product's stock & availability.
 * @param {string} id
 * @param {Function} onUpdate
 * @param {Function} [onError]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToProduct(id, onUpdate, onError) {
  if (!id || typeof onUpdate !== 'function') return () => {};

  // Instant in-memory match if available
  if (Array.isArray(_cachedProducts)) {
    const cachedMatch = _cachedProducts.find(p => p.id === id || p.productId === id);
    if (cachedMatch) onUpdate(cachedMatch);
  }

  try {
    const docRef = doc(db, 'products', id);
    return onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const liveProd = normalizeProduct(docSnap.id, docSnap.data());
        
        // Update in-memory registry
        if (Array.isArray(_cachedProducts)) {
          const idx = _cachedProducts.findIndex(p => p.id === id || p.productId === id);
          if (idx > -1) _cachedProducts[idx] = liveProd;
          else _cachedProducts.push(liveProd);
        }

        onUpdate(liveProd);
      }
    }, (err) => {
      console.warn('[TBC Real-Time] subscribeToProduct error:', err);
      if (typeof onError === 'function') onError(err);
    });
  } catch (err) {
    console.error('[TBC Real-Time] subscribeToProduct exception:', err);
    return () => {};
  }
}


// ═══════════════════════════════════════════════════════════════
// 3.  INVOICES (ORDERS) — CREATE  —  /invoices
//     orderType: 'online'
//     status: 'Awaiting Acceptance'
//     createdAt: serverTimestamp()
//     items[]: product details
// ═══════════════════════════════════════════════════════════════

/**
 * Create a new order document in /invoices on checkout.
 *
 * @param {object} orderData
 * @param {object}   orderData.customerDetails  { name, phone, email, address, city, state, pincode, landmark }
 * @param {object[]} orderData.items            Cart items: { productId, name, color, size, price, qty, imageUrl }
 * @param {string}   orderData.paymentMethod    'cod' | 'Razorpay Online' | 'upi' | 'card'
 * @param {number}   orderData.subtotal
 * @param {number}   orderData.totalAmount
 * @param {string}   [orderData.razorpayOrderId]  Razorpay order reference
 * @param {string}   [orderData.razorpayPaymentId] Razorpay payment reference
 * @returns {Promise<{ success: boolean, invoiceId: string }>}
 */
export async function createInvoice(orderData) {
  const cd = orderData.customerDetails || {};

  const isOnline = ['razorpay online', 'upi', 'card'].includes(
    (orderData.paymentMethod || '').toLowerCase()
  );

  const payload = {
    // ── Identity ──────────────────────────────────────────
    companyId:          COMPANY_ID,
    branchId:           BRANCH_ID,
    orderType:          'online',
    customerSource:     'website',

    // ── Status ────────────────────────────────────────────
    status:             isOnline ? 'Awaiting Acceptance' : 'Awaiting Acceptance',
    paymentStatus:      isOnline ? 'Paid' : 'Pending',
    paymentMethod:      orderData.paymentMethod || 'cod',

    // ── Customer ──────────────────────────────────────────
    customerName:        cd.name         || orderData.customerName        || '',
    customerPhoneNumber: cd.phone        || orderData.customerPhoneNumber || '',
    customerEmail:       cd.email        || orderData.customerEmail        || '',
    customerAddress:     cd.address      || orderData.customerAddress      || '',
    landmark:            cd.landmark     || orderData.landmark             || '',
    city:                cd.city         || orderData.city                 || '',
    state:               cd.state        || orderData.state                || '',
    pincode:             cd.pincode      || orderData.pincode              || '',

    // ── Financials ────────────────────────────────────────
    subtotal:            Number(orderData.subtotal     || 0),
    cgstAmount:          Number(orderData.cgstAmount   || Math.round((orderData.subtotal || 0) * 0.025)),
    sgstAmount:          Number(orderData.sgstAmount   || Math.round((orderData.subtotal || 0) * 0.025)),
    discountAmount:      Number(orderData.discountAmount || 0),
    totalAmount:         Number(orderData.totalAmount  || 0),

    // ── Payment References ────────────────────────────────
    ...(orderData.razorpayOrderId   && { razorpayOrderId:   orderData.razorpayOrderId }),
    ...(orderData.razorpayPaymentId && { razorpayPaymentId: orderData.razorpayPaymentId }),

    // ── Items ─────────────────────────────────────────────
    items: (orderData.items || []).map(item => ({
      productId: item.productId || item.id  || '',
      name:      item.name      || '',
      color:     item.color     || 'Default',
      size:      item.size      || 'Standard',
      price:     Number(item.price    || 0),
      qty:       Number(item.qty      || item.quantity || 1),
      imageUrl:  item.imageUrl  || item.image
        || (Array.isArray(item.imageUrls) ? item.imageUrls[0] : '')
        || '',
    })),

    // ── Timestamps ────────────────────────────────────────
    createdAt:  serverTimestamp(),
    updatedAt:  serverTimestamp(),
    orderDateStr: new Date().toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    }),
  };

  try {
    const docRef   = await addDoc(collection(db, 'invoices'), payload);
    console.info(`[TBC] Invoice created: ${docRef.id}`);

    // Automatically decrement product & variant stock atomically in Firestore
    try {
      if (Array.isArray(payload.items) && payload.items.length > 0) {
        await decrementStockForOrder(payload.items);
      }
    } catch (stockErr) {
      console.warn('[TBC] Stock decrement notice:', stockErr);
    }

    return { success: true, invoiceId: docRef.id, orderId: docRef.id };
  } catch (err) {
    console.error('[TBC] createInvoice error:', err);
    // Return a local fallback ID so UI can still show an order confirmation
    const fallbackId = `TBC-${Date.now()}`;
    return { success: false, invoiceId: fallbackId, orderId: fallbackId, error: err.message };
  }
}

// Alias kept for backwards compatibility with existing checkout.html
export const saveOrderToFirestore = createInvoice;


// ═══════════════════════════════════════════════════════════════
// 4.  INVENTORY INTEGRITY  —  runTransaction
//     Atomically decrement stock[branchId] on a specific variant.
// ═══════════════════════════════════════════════════════════════

/**
 * Atomically decrement the stock of a specific product variant
 * in its branch-specific stock map using a Firestore transaction.
 *
 * Stock map shape: variants[n].stock: { [branchId]: number }
 *
 * @param {string} productId  Firestore document ID of the product
 * @param {string} variantKey Variant key (id or "size::color::index")
 * @param {number} qty        Quantity to decrement
 * @param {string} [branchId]
 * @returns {Promise<{ success: boolean, newStock: number | null }>}
 */
export async function decrementVariantStock(productId, variantKey, qty = 1, branchId = BRANCH_ID) {
  if (!productId) return { success: false, error: 'No productId provided.' };
  const productRef = doc(db, 'products', productId);

  try {
    const result = await runTransaction(db, async (transaction) => {
      const productSnap = await transaction.get(productRef);

      if (!productSnap.exists()) {
        throw new Error(`Product ${productId} not found.`);
      }

      const data = productSnap.data();
      const updates = { updatedAt: serverTimestamp() };

      // 1. Decrement Top-Level Product Stock fields if present
      if (typeof data.stock === 'number') {
        updates.stock = Math.max(0, data.stock - qty);
      }
      if (typeof data.availableStock === 'number') {
        updates.availableStock = Math.max(0, data.availableStock - qty);
      }
      if (typeof data.quantity === 'number') {
        updates.quantity = Math.max(0, data.quantity - qty);
      }

      // 2. Decrement Variant Stock if variants array exists
      if (Array.isArray(data.variants) && data.variants.length > 0) {
        const variants = [...data.variants];

        // Find variant match by id, key, size::color, size, or color
        let idx = variants.findIndex(
          v => v.id === variantKey || v.key === variantKey ||
               `${v.size || ''}::${v.color || ''}` === variantKey ||
               (v.size && variantKey && String(variantKey).includes(v.size))
        );

        if (idx === -1) idx = 0; // Default to first variant if specific key not matched

        const variant = { ...variants[idx] };

        if (typeof variant.stock === 'object' && variant.stock !== null) {
          const stockMap = { ...variant.stock };
          const currentQty = Number(stockMap[branchId] ?? stockMap.main ?? 0);
          stockMap[branchId] = Math.max(0, currentQty - qty);
          if (stockMap.main !== undefined) stockMap.main = Math.max(0, Number(stockMap.main) - qty);
          variant.stock = stockMap;
        } else if (typeof variant.stock === 'number') {
          variant.stock = Math.max(0, variant.stock - qty);
        } else if (typeof variant.quantity === 'number') {
          variant.quantity = Math.max(0, variant.quantity - qty);
        } else {
          variant.stock = Math.max(0, 10 - qty);
        }

        variants[idx] = variant;
        updates.variants = variants;
      }

      transaction.update(productRef, updates);
      return true;
    });

    console.info(`[TBC] Stock decremented for product ${productId}, qty ${qty}`);
    return { success: true };

  } catch (err) {
    console.error('[TBC] decrementVariantStock failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Decrement stock for every item in a cart/order atomically.
 * Runs each product as a separate transaction (Firestore limit: 1 doc per txn recommended for safety).
 *
 * @param {object[]} items  Array of { productId, variantKey, qty }
 * @param {string}   [branchId]
 * @returns {Promise<{ success: boolean, results: object[] }>}
 */
export async function decrementStockForOrder(items = [], branchId = BRANCH_ID) {
  const results = await Promise.allSettled(
    items.map(item =>
      decrementVariantStock(item.productId, item.variantKey || item.size + '::' + item.color, item.qty || 1, branchId)
    )
  );

  const failures = results.filter(r => r.status === 'rejected' || r.value?.success === false);
  if (failures.length > 0) {
    console.warn('[TBC] Some stock decrements failed:', failures);
  }

  return {
    success: failures.length === 0,
    results: results.map(r => r.value || { success: false, error: r.reason?.message }),
  };
}


// ═══════════════════════════════════════════════════════════════
// 5.  CUSTOMER ORDER HISTORY  —  /invoices
//     Query by customerPhoneNumber. Render with status + totalAmount.
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch all orders for a customer identified by phone number.
 * Returns orders sorted newest-first.
 * @param {string} phoneNumber
 * @returns {Promise<object[]>}
 */
export async function getCustomerOrders(phoneNumber) {
  if (!phoneNumber) return [];
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  if (!cleanPhone) return [];

  try {
    const q        = query(
      collection(db, 'invoices'),
      where('customerPhoneNumber', '==', cleanPhone)
    );
    const snapshot = await getDocs(q);
    let orders     = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

    // Fallback: some docs may use 'customerPhone' key
    if (orders.length === 0) {
      const q2   = query(collection(db, 'invoices'), where('customerPhone', '==', cleanPhone));
      const snap2 = await getDocs(q2);
      orders      = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    const sorted = orders.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    return sorted;

  } catch (err) {
    console.error('[TBC] getCustomerOrders error:', err);
    return [];
  }
}

/**
 * Real-time live listener for customer order updates with zero-latency caching.
 * @param {string} phoneNumber
 * @param {Function} onUpdate
 * @returns {Function} Unsubscribe function
 */
export function subscribeToCustomerOrders(identifier, onUpdate) {
  if (typeof onUpdate !== 'function') return () => {};

  try {
    const ref = collection(db, 'invoices');
    return onSnapshot(ref, (snapshot) => {
      const allDocs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

      if (!identifier) {
        allDocs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        onUpdate(allDocs);
        return;
      }

      const cleanPhone = String(identifier).replace(/\D/g, '').slice(-10);
      const cleanEmail = String(identifier).toLowerCase().trim();

      const matched = allDocs.filter(doc => {
        const p1 = String(doc.customerPhoneNumber || '').replace(/\D/g, '').slice(-10);
        const p2 = String(doc.customerPhone || '').replace(/\D/g, '').slice(-10);
        const p3 = String(doc.customerDetails?.phone || doc.phone || '').replace(/\D/g, '').slice(-10);
        const e1 = String(doc.customerEmail || doc.customerDetails?.email || doc.email || '').toLowerCase().trim();

        if (cleanPhone && cleanPhone.length >= 7) {
          if (p1.includes(cleanPhone) || p2.includes(cleanPhone) || p3.includes(cleanPhone) || cleanPhone.includes(p1)) {
            return true;
          }
        }
        if (cleanEmail && cleanEmail.includes('@') && e1 === cleanEmail) {
          return true;
        }
        return false;
      });

      const resultOrders = (matched.length > 0) ? matched : allDocs;

      resultOrders.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      console.info(`[TBC Real-Time] Streamed ${resultOrders.length} customer order(s) for "${identifier}".`);
      onUpdate(resultOrders);
    }, (err) => {
      console.error('[TBC Real-Time] subscribeToCustomerOrders error:', err);
    });
  } catch (err) {
    console.error('[TBC Real-Time] subscribeToCustomerOrders exception:', err);
    return () => {};
  }
}

/**
 * Render a status badge HTML string.
 * Color-codes every step of the order lifecycle.
 * @param {string} status
 * @returns {string} HTML string
 */
export function renderStatusBadge(status) {
  const map = {
    'Awaiting Acceptance': 'bg-amber-100 text-amber-800',
    'Processing':          'bg-blue-100 text-blue-800',
    'Packed':              'bg-indigo-100 text-indigo-800',
    'Shipped':             'bg-violet-100 text-violet-800',
    'Out for Delivery':    'bg-orange-100 text-orange-800',
    'Delivered':           'bg-green-100 text-green-800',
    'Cancelled':           'bg-red-100 text-red-800',
    'Pending':             'bg-gray-100 text-gray-600',
    'Paid':                'bg-emerald-100 text-emerald-800',
  };
  const cls = map[status] || 'bg-gray-100 text-gray-600';
  return `<span class="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cls}">${status || 'Unknown'}</span>`;
}


// ═══════════════════════════════════════════════════════════════
// 6.  REAL-TIME ORDER LISTENER  —  /invoices  (onSnapshot)
//     Listens to all online orders in real time.
// ═══════════════════════════════════════════════════════════════

/**
 * Subscribe to all online invoices in real time using onSnapshot.
 * Ideal for an admin dashboard order feed.
 *
 * @param {Function} onUpdate   Called with (orders: object[]) on every change
 * @param {Function} [onError]  Called with (error) on subscription failure
 * @param {object}   [options]
 * @param {string}     [options.companyId]  Filter by company (default: COMPANY_ID)
 * @param {string}     [options.status]     Optional: filter by specific status
 * @returns {Function} Unsubscribe function — call this to stop listening
 *
 * @example
 *   const unsub = subscribeToOnlineOrders(orders => renderOrderFeed(orders));
 *   // Later: unsub(); // stops the listener
 */
export function subscribeToOnlineOrders(onUpdate, onError, options = {}) {
  try {
    const ref = collection(db, 'invoices');
    return onSnapshot(ref, (snapshot) => {
      let orders = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => {
          // STRICT RULE: Show ONLY ecom order bills where orderType === 'online' (or customerSource === 'website')
          const orderType = String(d.orderType || '').toLowerCase().trim();
          const source = String(d.customerSource || d.source || '').toLowerCase().trim();

          return orderType === 'online' || source === 'website';
        })
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

      console.info(`[TBC Ecom Admin] Streamed ${orders.length} e-commerce order bill(s) (orderType='online').`);
      onUpdate(orders);
    }, (err) => {
      console.error('[TBC Ecom Admin] subscribeToOnlineOrders error:', err);
      if (typeof onError === 'function') onError(err);
    });
  } catch (err) {
    console.error('[TBC Ecom Admin] subscribeToOnlineOrders exception:', err);
    return () => {};
  }
}

/**
 * Subscribe to a SINGLE invoice document in real time.
 * Use this on the order-tracking page to show live status updates.
 *
 * @param {string}   invoiceId
 * @param {Function} onUpdate  Called with the order object on every change
 * @param {Function} [onError]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToInvoice(invoiceId, onUpdate, onError) {
  if (!invoiceId) return () => {};

  const unsubscribe = onSnapshot(
    doc(db, 'invoices', invoiceId),
    (snap) => {
      if (snap.exists()) {
        onUpdate({ id: snap.id, ...snap.data() });
      } else {
        console.warn(`[TBC] Invoice ${invoiceId} does not exist.`);
      }
    },
    (err) => {
      console.error(`[TBC] subscribeToInvoice(${invoiceId}) error:`, err);
      if (typeof onError === 'function') onError(err);
    }
  );

  return unsubscribe;
}


// ═══════════════════════════════════════════════════════════════
// 7.  ORDER STATUS STATE MACHINE  —  /invoices
//     Advance status through the defined lifecycle.
// ═══════════════════════════════════════════════════════════════

/**
 * Advance an invoice to the next logical status in the lifecycle.
 *
 * Flow: Awaiting Acceptance → Processing → Packed → Shipped → Out for Delivery → Delivered
 *
 * @param {string} invoiceId  Firestore document ID
 * @returns {Promise<{ success: boolean, previousStatus: string, newStatus: string | null }>}
 *
 * @example
 *   const result = await advanceOrderStatus('abc123');
 *   // result: { success: true, previousStatus: 'Processing', newStatus: 'Packed' }
 */
export async function advanceOrderStatus(invoiceId) {
  if (!invoiceId) return { success: false, error: 'No invoiceId provided.' };

  const invoiceRef = doc(db, 'invoices', invoiceId);

  try {
    const snap = await getDoc(invoiceRef);
    if (!snap.exists()) throw new Error(`Invoice ${invoiceId} not found.`);

    const currentStatus = snap.data().status;
    const currentIndex  = ORDER_STATUS_FLOW.indexOf(currentStatus);

    if (currentIndex === -1) {
      throw new Error(`Unknown status "${currentStatus}". Cannot advance.`);
    }
    if (currentIndex === ORDER_STATUS_FLOW.length - 1) {
      return {
        success: false,
        previousStatus: currentStatus,
        newStatus: null,
        error: `Order is already at the final status: "${currentStatus}".`,
      };
    }

    const newStatus = ORDER_STATUS_FLOW[currentIndex + 1];

    await updateDoc(invoiceRef, {
      status:    newStatus,
      updatedAt: serverTimestamp(),
      [`statusHistory.${newStatus}`]: serverTimestamp(), // audit trail
    });

    console.info(`[TBC] Invoice ${invoiceId}: "${currentStatus}" → "${newStatus}"`);
    return { success: true, previousStatus: currentStatus, newStatus };

  } catch (err) {
    console.error('[TBC] advanceOrderStatus error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Set an invoice to a specific status directly (for admin overrides).
 *
 * @param {string} invoiceId
 * @param {string} status   Must be a value from ORDER_STATUS_FLOW or 'Cancelled'
 * @returns {Promise<{ success: boolean }>}
 */
export async function setOrderStatus(invoiceId, status) {
  const allowed = [...ORDER_STATUS_FLOW, 'Cancelled', 'Pending', 'Paid'];
  if (!allowed.includes(status)) {
    return { success: false, error: `Invalid status "${status}".` };
  }

  try {
    await updateDoc(doc(db, 'invoices', invoiceId), {
      status,
      updatedAt: serverTimestamp(),
      [`statusHistory.${status}`]: serverTimestamp(),
    });
    return { success: true };
  } catch (err) {
    console.error('[TBC] setOrderStatus error:', err);
    return { success: false, error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════
// 8.  COMPANY PROFILE & BANNER  —  /companies/{companyId}
//     Fetch: heroMediaUrl, heroHeading, heroSubheading
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch the company profile document from /companies/{companyId}.
 * Returns hero banner fields alongside other company data.
 *
 * @param {string} [companyId]
 * @returns {Promise<object|null>}
 *
 * Banner fields returned:
 *   .heroMediaUrl     — URL for hero image or video
 *   .heroHeading      — Main headline text
 *   .heroSubheading   — Subheadline / tagline text
 */
let _cachedCompany = getCachedCompany();

export async function getCompanyProfile(companyId = COMPANY_ID) {
  if (_cachedCompany) {
    return _cachedCompany;
  }
  return await revalidateCompany(companyId);
}

export async function revalidateCompany(companyId = COMPANY_ID) {
  try {
    const snap = await getDoc(doc(db, 'companies', companyId));
    let raw = null;
    if (snap.exists()) {
      raw = { id: snap.id, ...snap.data() };
    } else {
      console.warn(`[TBC] Company "${companyId}" not found. Fetching first available.`);
      const all = await getDocs(query(collection(db, 'companies'), limit(1)));
      if (!all.empty) raw = { id: all.docs[0].id, ...all.docs[0].data() };
    }

    if (!raw) return null;

    const name = raw.name || raw.companyName || raw.brandName || 'THE BANIYAN COMPANY';
    const logo = raw.logo || raw.logoUrl || raw.imageUrl || raw.image || raw.icon || 'tbclogo.svg';
    const handle = raw.handle || raw.username || ('@' + name.toLowerCase().replace(/[^a-z0-9]/g, ''));

    const result = {
      ...raw,
      name,
      logo,
      handle,
    };
    _cachedCompany = result;
    setCachedCompany(_cachedCompany);
    return result;
  } catch (err) {
    console.error('[TBC] getCompanyProfile error:', err);
    return _cachedCompany || null;
  }
}

// Alias
export const getCompany = getCompanyProfile;

/**
 * Subscribe to the company document in real time.
 * Use this on the homepage so the hero banner updates instantly
 * when an admin changes it in the console or admin panel.
 *
 * @param {Function} onUpdate  Called with the company object on every change
 * @param {Function} [onError]
 * @param {string}   [companyId]
 * @returns {Function} Unsubscribe function
 *
 * @example
 *   const unsub = subscribeToCompanyBanner(company => {
 *     document.getElementById('hero-heading').textContent = company.heroHeading;
 *     document.getElementById('hero-img').src = company.heroMediaUrl;
 *   });
 */
export function subscribeToCompanyBanner(onUpdate, onError, companyId = COMPANY_ID) {
  const unsubscribe = onSnapshot(
    doc(db, 'companies', companyId),
    (snap) => {
      if (snap.exists()) {
        onUpdate({ id: snap.id, ...snap.data() });
      }
    },
    (err) => {
      console.error('[TBC] subscribeToCompanyBanner error:', err);
      if (typeof onError === 'function') onError(err);
    }
  );
  return unsubscribe;
}


// ═══════════════════════════════════════════════════════════════
// 9.  ADMIN — UPDATE COMPANY BANNER  —  /companies/{companyId}
//     updateDoc for admin panel: heroMediaUrl, heroHeading, heroSubheading.
//     The homepage onSnapshot listener receives the change instantly.
// ═══════════════════════════════════════════════════════════════

/**
 * Update the homepage hero banner fields in /companies/{companyId}.
 * Because subscribeToCompanyBanner() uses onSnapshot, the website
 * reflects the change in real time — no page reload required.
 *
 * @param {object} bannerData
 * @param {string}   bannerData.heroMediaUrl     New hero image/video URL
 * @param {string}   bannerData.heroHeading      New heading text
 * @param {string}   bannerData.heroSubheading   New subheading text
 * @param {string}   [companyId]
 * @returns {Promise<{ success: boolean }>}
 *
 * @example  (Admin Panel)
 *   await updateCompanyBanner({
 *     heroMediaUrl:   'https://cdn.example.com/summer-banner.jpg',
 *     heroHeading:    'Summer Luxe 2026',
 *     heroSubheading: 'Breathable. Sustainable. Bold.',
 *   });
 */
export async function updateCompanyBanner(bannerData, companyId = COMPANY_ID) {
  const { heroMediaUrl, heroHeading, heroSubheading } = bannerData;

  // Build only the fields that were actually provided
  const updates = { updatedAt: serverTimestamp() };
  if (heroMediaUrl    !== undefined) updates.heroMediaUrl    = heroMediaUrl;
  if (heroHeading     !== undefined) updates.heroHeading     = heroHeading;
  if (heroSubheading  !== undefined) updates.heroSubheading  = heroSubheading;

  try {
    await updateDoc(doc(db, 'companies', companyId), updates);
    console.info('[TBC] Company banner updated:', updates);
    return { success: true };
  } catch (err) {
    console.error('[TBC] updateCompanyBanner error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Generic admin function to update any fields on the company document.
 * @param {object} fields  Key-value pairs to merge into the document
 * @param {string} [companyId]
 * @returns {Promise<{ success: boolean }>}
 */
export async function updateCompanySettings(fields = {}, companyId = COMPANY_ID) {
  try {
    await updateDoc(doc(db, 'companies', companyId), {
      ...fields,
      updatedAt: serverTimestamp(),
    });
    _cachedCompany = null;
    localStorage.removeItem('tbc_cache_company');
    await revalidateCompany(companyId);
    return { success: true };
  } catch (err) {
    console.error('[TBC] updateCompanySettings error:', err);
    return { success: false, error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════
// MISC  — kept for backwards compatibility
// ═══════════════════════════════════════════════════════════════

/** @deprecated Use createInvoice() */
export async function saveOrderToFirestore_legacy(orderData) {
  return createInvoice(orderData);
}
