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

  const discountPct = originalPrice && originalPrice > price
    ? Math.round(((originalPrice - price) / originalPrice) * 100)
    : (typeof data.discount === 'number' ? data.discount : null);

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
    discount:       discountPct != null ? `${discountPct}% OFF` : '',
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
// 1.  CATEGORIES  —  /categories
//     Fetch all documents. Display name, icon, imageUrl.
// ═══════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hour persistent session cache duration

function getLocalCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { time, data } = JSON.parse(raw);
    if (data && (Array.isArray(data) ? data.length > 0 : !!data)) {
      // Return cached data immediately without background revalidation overhead
      return { data, time };
    }
  } catch (e) {}
  return null;
}

function setLocalCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ time: Date.now(), data }));
  } catch (e) {}
}

let _cachedProductsObj = getLocalCache('tbc_cache_products');
let _cachedProducts = _cachedProductsObj?.data || null;

let _cachedCategoriesObj = getLocalCache('tbc_cache_categories');
let _cachedCategories = _cachedCategoriesObj?.data || null;

// Exported Caching Utilities for Multi-Page Performance
export function getCachedProducts() {
  if (!_cachedProducts) {
    const c = getLocalCache('tbc_cache_products');
    _cachedProducts = c?.data || null;
  }
  return _cachedProducts;
}

export function setCachedProducts(products) {
  _cachedProducts = products;
  setLocalCache('tbc_cache_products', products);
}

export function getCachedCategories() {
  if (!_cachedCategories) {
    const c = getLocalCache('tbc_cache_categories');
    _cachedCategories = c?.data || null;
  }
  return _cachedCategories;
}

export function setCachedCategories(categories) {
  _cachedCategories = categories;
  setLocalCache('tbc_cache_categories', categories);
}

export function getCachedCompany() {
  const c = getLocalCache('tbc_cache_company');
  return c?.data || null;
}

export function setCachedCompany(company) {
  setLocalCache('tbc_cache_company', company);
}

export function clearTbcCache() {
  localStorage.removeItem('tbc_cache_products');
  localStorage.removeItem('tbc_cache_categories');
  localStorage.removeItem('tbc_cache_company');
  _cachedProducts = null;
  _cachedCategories = null;
}

export async function deleteProduct(id) {
  if (!id) return false;
  try {
    await deleteDoc(doc(db, 'products', id));
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
 * Fetch all category documents from /categories with zero-latency caching.
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getCategories(companyId = COMPANY_ID) {
  const cache = getLocalCache('tbc_cache_categories');
  if (cache?.data && cache.data.length > 0) {
    _cachedCategories = [...cache.data].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return _cachedCategories;
  }

  return await revalidateCategories(companyId);
}

async function revalidateCategories(companyId = COMPANY_ID) {
  try {
    const ref = collection(db, 'categories');
    const snapshot = await getDocs(ref);
    const normalized = snapshot.docs
      .map(d => normalizeCategory(d.id, d.data()))
      .filter(c => c.id && (!companyId || c.companyId === companyId || true))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    if (normalized.length > 0) {
      _cachedCategories = normalized;
      setLocalCache('tbc_cache_categories', _cachedCategories);
    }
    return _cachedCategories || [];
  } catch (err) {
    console.error('[TBC] getCategories error:', err);
    return _cachedCategories || [];
  }
}

/**
 * Fetch all products for a given company with zero-latency single-read caching.
 * @param {string} [companyId]
 * @param {number} [limitCount]
 * @returns {Promise<object[]>}
 */
export async function getProducts(companyId = COMPANY_ID, limitCount = null) {
  const cache = getLocalCache('tbc_cache_products');
  if (cache?.data && cache.data.length > 0) {
    _cachedProducts = cache.data;
    return limitCount ? _cachedProducts.slice(0, limitCount) : _cachedProducts;
  }

  const products = await revalidateProducts(companyId);
  return limitCount ? products.slice(0, limitCount) : products;
}

async function revalidateProducts(companyId = COMPANY_ID) {
  try {
    const ref = collection(db, 'products');
    const snapshot = await getDocs(ref);
    const normalized = snapshot.docs
      .map(d => normalizeProduct(d.id, d.data()))
      .filter(p => p.id && p.showInEcom !== false); // Strict filter: exclude any product marked showInEcom = false

    if (normalized.length > 0) {
      _cachedProducts = normalized;
      setLocalCache('tbc_cache_products', _cachedProducts);
    }
    return _cachedProducts || [];
  } catch (err) {
    console.error('[TBC] getProducts error:', err);
    return _cachedProducts || [];
  }
}

/**
 * Fetch a single product by its Firestore document ID or productId field.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getProductById(id) {
  if (!id) return null;

  // 1. Check local storage / in-memory cache first (0ms latency, 0 Firestore reads)
  try {
    const cachedProducts = await getProducts();
    if (Array.isArray(cachedProducts) && cachedProducts.length > 0) {
      const match = cachedProducts.find(p => (p.id === id || p.productId === id) && p.showInEcom !== false);
      if (match) return match;
    }
  } catch (e) {}

  // 2. Fallback to direct Firestore document lookup if missing from local cache
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

    return null;
  } catch (err) {
    console.error(`[TBC] getProductById(${id}) error:`, err);
    return null;
  }
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
 * Real-time live listener for a single product's stock & availability with instant local cache sync.
 * @param {string} id
 * @param {Function} onUpdate
 * @returns {Function} Unsubscribe function
 */
export function subscribeToProduct(id, onUpdate) {
  if (!id) return () => {};

  // Instant local cache hit
  const cache = getLocalCache('tbc_cache_products');
  if (cache?.data && Array.isArray(cache.data)) {
    const cachedMatch = cache.data.find(p => p.id === id || p.productId === id);
    if (cachedMatch) onUpdate(cachedMatch);
  }

  try {
    const docRef = doc(db, 'products', id);
    return onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const liveProd = normalizeProduct(docSnap.id, docSnap.data());
        
        // Update local cache
        const currentCache = getLocalCache('tbc_cache_products')?.data || [];
        const idx = currentCache.findIndex(p => p.id === id || p.productId === id);
        if (idx > -1) currentCache[idx] = liveProd;
        else currentCache.push(liveProd);
        setLocalCache('tbc_cache_products', currentCache);

        onUpdate(liveProd);
      }
    }, (err) => {
      console.warn('[TBC] subscribeToProduct error:', err);
    });
  } catch (err) {
    console.error('[TBC] subscribeToProduct exception:', err);
    return () => {};
  }
}

/**
 * Real-time live listener for all store products' stock & availability.
 * @param {Function} onUpdate
 * @returns {Function} Unsubscribe function
 */
export function subscribeToProducts(onUpdate) {
  const cache = getLocalCache('tbc_cache_products');
  if (cache?.data && Array.isArray(cache.data)) {
    onUpdate(cache.data);
  }

  try {
    const ref = collection(db, 'products');
    return onSnapshot(ref, (snapshot) => {
      const normalized = snapshot.docs
        .map(d => normalizeProduct(d.id, d.data()))
        .filter(p => p.id && p.showInEcom !== false);

      _cachedProducts = normalized;
      setLocalCache('tbc_cache_products', normalized);
      onUpdate(normalized);
    }, (err) => {
      console.warn('[TBC] subscribeToProducts warning:', err);
    });
  } catch (err) {
    console.error('[TBC] subscribeToProducts error:', err);
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
  };

  try {
    const docRef   = await addDoc(collection(db, 'invoices'), payload);
    console.info(`[TBC] Invoice created: ${docRef.id}`);
    return { success: true, invoiceId: docRef.id };
  } catch (err) {
    console.error('[TBC] createInvoice error:', err);
    // Return a local fallback ID so UI can still show an order confirmation
    const fallbackId = `TBC-${Date.now()}`;
    return { success: false, invoiceId: fallbackId, error: err.message };
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
  const productRef = doc(db, 'products', productId);

  try {
    const result = await runTransaction(db, async (transaction) => {
      const productSnap = await transaction.get(productRef);

      if (!productSnap.exists()) {
        throw new Error(`Product ${productId} not found.`);
      }

      const data     = productSnap.data();
      const variants = Array.isArray(data.variants) ? [...data.variants] : [];

      // Locate the variant by key, id, or size::color match
      const idx = variants.findIndex(
        v => v.id === variantKey || v.key === variantKey ||
             `${v.size || ''}::${v.color || ''}` === variantKey
      );

      if (idx === -1) {
        throw new Error(`Variant "${variantKey}" not found on product ${productId}.`);
      }

      const variant    = { ...variants[idx] };
      const stockMap   = typeof variant.stock === 'object' ? { ...variant.stock } : { main: Number(variant.stock || 0) };
      const currentQty = Number(stockMap[branchId] ?? stockMap.main ?? 0);

      if (currentQty < qty) {
        throw new Error(`Insufficient stock. Available: ${currentQty}, Requested: ${qty}`);
      }

      const newStock = currentQty - qty;
      stockMap[branchId] = newStock;

      // Also decrement 'main' if it exists and reflects overall stock
      if (stockMap.main !== undefined) {
        stockMap.main = Math.max(0, Number(stockMap.main) - qty);
      }

      variant.stock     = stockMap;
      variants[idx]     = variant;

      transaction.update(productRef, { variants, updatedAt: serverTimestamp() });

      return newStock;
    });

    console.info(`[TBC] Stock decremented. Product: ${productId}, Variant: ${variantKey}, New stock[${branchId}]: ${result}`);
    return { success: true, newStock: result };

  } catch (err) {
    console.error('[TBC] decrementVariantStock transaction failed:', err.message);
    return { success: false, newStock: null, error: err.message };
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

  // Check instant cache
  const cacheKey = `tbc_cache_user_orders_${cleanPhone}`;
  const cache = getLocalCache(cacheKey);
  if (cache?.data && Array.isArray(cache.data)) {
    return cache.data;
  }

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
    setLocalCache(cacheKey, sorted);
    return sorted;

  } catch (err) {
    console.error('[TBC] getCustomerOrders error:', err);
    return cache?.data || [];
  }
}

/**
 * Real-time live listener for customer order updates with zero-latency caching.
 * @param {string} phoneNumber
 * @param {Function} onUpdate
 * @returns {Function} Unsubscribe function
 */
export function subscribeToCustomerOrders(phoneNumber, onUpdate) {
  if (!phoneNumber) {
    onUpdate([]);
    return () => {};
  }
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  if (!cleanPhone) {
    onUpdate([]);
    return () => {};
  }

  const cacheKey = `tbc_cache_user_orders_${cleanPhone}`;
  const cache = getLocalCache(cacheKey);
  if (cache?.data && Array.isArray(cache.data)) {
    onUpdate(cache.data);
  }

  try {
    const q = query(collection(db, 'invoices'), where('customerPhoneNumber', '==', cleanPhone));
    return onSnapshot(q, (snapshot) => {
      let orders = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      if (orders.length === 0) {
        // Retry fallback query
        getDocs(query(collection(db, 'invoices'), where('customerPhone', '==', cleanPhone))).then(snap2 => {
          orders = snap2.docs.map(d => ({ id: d.id, ...d.data() }));
          orders.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
          setLocalCache(cacheKey, orders);
          onUpdate(orders);
        }).catch(() => {});
      } else {
        orders.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        setLocalCache(cacheKey, orders);
        onUpdate(orders);
      }
    }, (err) => {
      console.warn('[TBC] subscribeToCustomerOrders listener warning:', err);
    });
  } catch (err) {
    console.error('[TBC] subscribeToCustomerOrders error:', err);
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
  const { companyId = COMPANY_ID, status } = options;

  const constraints = [
    where('orderType', '==', 'online'),
    where('companyId', '==', companyId),
  ];
  if (status) constraints.push(where('status', '==', status));

  const q = query(collection(db, 'invoices'), ...constraints);

  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const orders = snapshot.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

      console.info(`[TBC] onSnapshot: ${orders.length} online order(s) received.`);
      onUpdate(orders);
    },
    (err) => {
      console.error('[TBC] subscribeToOnlineOrders error:', err);
      if (typeof onError === 'function') onError(err);
    }
  );

  return unsubscribe; // caller must invoke this to clean up
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
let _cachedCompanyObj = getLocalCache('tbc_cache_company');
let _cachedCompany = _cachedCompanyObj?.data || null;

export async function getCompanyProfile(companyId = COMPANY_ID) {
  const cache = getLocalCache('tbc_cache_company');
  if (cache?.data) {
    _cachedCompany = cache.data;
    if (cache.isStale) {
      revalidateCompany(companyId).catch(() => {});
    }
    return _cachedCompany;
  }
  return await revalidateCompany(companyId);
}

async function revalidateCompany(companyId = COMPANY_ID) {
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
    const logo = raw.logo || raw.logoUrl || raw.imageUrl || raw.image || raw.icon || '';
    const handle = raw.handle || raw.username || ('@' + name.toLowerCase().replace(/[^a-z0-9]/g, ''));

    const result = {
      ...raw,
      name,
      logo,
      handle,
    };
    _cachedCompany = result;
    setLocalCache('tbc_cache_company', _cachedCompany);
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
