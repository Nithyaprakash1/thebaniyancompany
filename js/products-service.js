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
  writeBatch,
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
 * Safely extract total numeric stock count from a variant's stock map, number, or variant object.
 * Sums all numbers in stock objects (e.g. { "main": 10, "branch_2": 5 } => 15) or returns raw number.
 * @param {Record<string, number>|number|object|undefined} stock
 * @param {string} [branchId]
 * @returns {number}
 */
export function getVariantStock(stock, branchId = BRANCH_ID) {
  if (!stock) return 0;
  if (typeof stock === 'number') return Math.max(0, stock);
  if (typeof stock === 'string') {
    const n = Number(stock.replace(/[^0-9.-]+/g, ''));
    return !isNaN(n) ? Math.max(0, n) : 0;
  }
  // If passed a variant object containing stock property (e.g. getVariantStock(variant))
  if (typeof stock === 'object' && stock !== null && 'stock' in stock && stock.stock !== undefined) {
    return getVariantStock(stock.stock, branchId);
  }
  if (typeof stock === 'object' && stock !== null) {
    return Object.values(stock).reduce((acc, val) => {
      const num = typeof val === 'number' ? val : Number(String(val).replace(/[^0-9.-]+/g, ''));
      return acc + (!isNaN(num) && num > 0 ? num : 0);
    }, 0);
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
    key:   v.id || `${String(v.size || '').trim().toUpperCase()}::${v.color || ''}::${i}`,
    price: Number(v.price ?? v.sellingPrice ?? 0),
    mrp:   Number(v.mrp ?? v.originalPrice ?? 0) || null,
    cost:  Number(v.cost  ?? 0),
    size:  String(v.size  ?? 'Standard').trim().toUpperCase(),
    color: String(v.color ?? 'Default'),
    stock: {
      [branchId]: getVariantStock(v, branchId),
      main:       getVariantStock(v, 'main'),
    },
  }));
}

/**
 * Calculate total available inventory stock across all variants or root product fields.
 * @param {object} product
 * @returns {number}
 */
export function getProductTotalStock(product) {
  if (!product) return 0;
  if (Array.isArray(product.variants) && product.variants.length > 0) {
    return product.variants.reduce((sum, v) => sum + getVariantStock(v), 0);
  }
  if (typeof product.availableStock === 'number') return Math.max(0, product.availableStock);
  if (typeof product.stock === 'number') return Math.max(0, product.stock);
  if (typeof product.stock === 'string') {
    const n = Number(product.stock.replace(/[^0-9.-]+/g, ''));
    if (!isNaN(n)) return Math.max(0, n);
  }
  if (typeof product.stock === 'object' && product.stock !== null) {
    const vals = Object.values(product.stock).map(v => Number(String(v).replace(/[^0-9.-]+/g, ''))).filter(n => !isNaN(n));
    if (vals.length > 0) return Math.max(0, vals.reduce((a, b) => a + b, 0));
  }
  if (typeof product.quantity === 'number') return Math.max(0, product.quantity);
  if (typeof product.inventory === 'number') return Math.max(0, product.inventory);
  return 0;
}

/**
 * Check whether a product is completely out of stock.
 * @param {object} product
 * @returns {boolean}
 */
export function isProductOutOfStock(product) {
  return getProductTotalStock(product) <= 0;
}

/**
 * Derive clean pricing and MRP without fabricating false markups.
 * @param {object} product
 * @param {object} [selectedVariant]
 * @returns {{ price: number, mrp: number|null, discountPct: number, hasDiscount: boolean }}
 */
export function getProductPricing(product, selectedVariant = null) {
  if (!product) return { price: 0, mrp: null, discountPct: 0, hasDiscount: false };

  let price = Number(selectedVariant?.price ?? product.price ?? 0);
  let poolVariant = null;

  if ((!price || price <= 0) && Array.isArray(product.variants) && product.variants.length > 0) {
    const inStock = product.variants.filter(v => getVariantStock(v) > 0);
    const pool = inStock.length ? inStock : product.variants;
    poolVariant = pool.reduce((minV, v) => {
      const vp = Number(v.price || v.sellingPrice || 0);
      if (vp <= 0) return minV;
      if (!minV) return v;
      return vp < Number(minV.price || minV.sellingPrice || Infinity) ? v : minV;
    }, null);
    if (poolVariant) {
      price = Number(poolVariant.price || poolVariant.sellingPrice || 0);
    }
  }

  // Target variant to resolve MRP if not explicitly passed
  const targetVariant = selectedVariant || poolVariant || (Array.isArray(product.variants) && product.variants.length > 0 ? product.variants[0] : null);

  // Parse raw MRP
  let rawMrp = null;
  const rawMrpCandidate = targetVariant?.mrp ?? targetVariant?.originalPrice ?? product.originalPrice ?? product.mrp ?? null;
  if (rawMrpCandidate != null && rawMrpCandidate !== '') {
    const parsed = Number(String(rawMrpCandidate).replace(/[^0-9.-]+/g, ''));
    if (!isNaN(parsed) && parsed > price) {
      rawMrp = parsed;
    }
  }

  // Parse explicit discount percentage if present
  let explicitDiscountPct = 0;
  if (typeof product.discountPct === 'number' && product.discountPct > 0) {
    explicitDiscountPct = Math.round(product.discountPct);
  } else if (product.discount) {
    const match = String(product.discount).match(/\d+/);
    if (match) explicitDiscountPct = parseInt(match[0], 10);
  }

  // If no rawMrp was provided but explicit discount percentage exists (> 0), compute matching MRP
  if (!rawMrp && explicitDiscountPct > 0 && explicitDiscountPct < 100 && price > 0) {
    rawMrp = Math.round(price / (1 - (explicitDiscountPct / 100)));
  }

  // Calculate actual discount percentage
  let discountPct = 0;
  if (rawMrp && rawMrp > price) {
    discountPct = Math.round(((rawMrp - price) / rawMrp) * 100);
  } else if (explicitDiscountPct > 0) {
    discountPct = explicitDiscountPct;
  }

  const hasDiscount = discountPct > 0 && Boolean(rawMrp && rawMrp > price);

  return {
    price,
    mrp: hasDiscount ? rawMrp : null,
    discountPct: hasDiscount ? discountPct : 0,
    hasDiscount,
  };
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
  const prices    = pool.map(v => Number(v.price || 0)).filter(p => p > 0);
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

  const name = data.name || data.title || 'Unnamed Product';
  const pricing = getProductPricing({ ...data, variants });
  const totalStock = getProductTotalStock({ ...data, variants });

  const category = typeof data.category === 'string'
    ? data.category
    : data.category?.name ?? '';

  const tag = typeof data.tag === 'string'
    ? data.tag
    : Array.isArray(data.tags) ? (data.tags[0] ?? '') : '';

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
    price:          pricing.price,
    originalPrice:  pricing.mrp,
    mrp:            pricing.mrp,
    discountPct:    pricing.discountPct,
    discount:       pricing.discountPct > 0 ? `${pricing.discountPct}% OFFER` : '',
    availableStock: totalStock,
    isOutOfStock:   totalStock <= 0,
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

// Session-level browser caching (survives tab navigation and reload, cleared on tab close)
export function getSessionData(key) {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function setSessionData(key, data) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch (_) {}
}

export function removeSessionData(key) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.removeItem(key);
  } catch (_) {}
}

export function clearProductSessionCache(companyId = COMPANY_ID) {
  _cachedProducts = null;
  _cachedCategories = null;
  removeSessionData(`ecommerce_products_${companyId}`);
  removeSessionData(`ecommerce_categories_${companyId}`);
  removeSessionData(`ecommerce_company_${companyId}`);
  removeSessionData(`tbc_session_products_${companyId}`);
  removeSessionData(`tbc_session_categories_${companyId}`);
  removeSessionData(`tbc_session_company_${companyId}`);
}

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

export function getCachedCompany(companyId = COMPANY_ID) {
  try {
    const sessionCompany = getSessionData(`ecommerce_company_${companyId}`) || getSessionData(`tbc_session_company_${companyId}`);
    if (sessionCompany) return sessionCompany;

    const raw = localStorage.getItem('tbc_cache_company');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data || parsed;
  } catch (e) {
    return null;
  }
}

export function setCachedCompany(company, companyId = COMPANY_ID) {
  try {
    setSessionData(`ecommerce_company_${companyId}`, company);
    localStorage.setItem('tbc_cache_company', JSON.stringify({ time: Date.now(), data: company }));
  } catch (e) {}
}

export function clearTbcCache(companyId = COMPANY_ID) {
  try {
    clearProductSessionCache(companyId);
    localStorage.removeItem('tbc_cache_products');
    localStorage.removeItem('tbc_cache_categories');
    localStorage.removeItem('tbc_cache_company');
    localStorage.removeItem(`tbc_cache_orders_${companyId}`);
  } catch (e) {}
  _cachedProducts = null;
  _cachedCategories = null;
}

/**
 * Retrieve cached orders from localStorage for 0ms instant loading.
 * @param {string} [companyId]
 * @returns {Array} List of cached order objects
 */
export function getCachedOrders(companyId = COMPANY_ID) {
  try {
    const raw = localStorage.getItem(`tbc_cache_orders_${companyId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.data)) return parsed.data;
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Retrieve cached orders metadata (orders, timestamp, and freshness status).
 * @param {string} [companyId]
 * @param {number} [freshDurationMs=60000]
 * @returns {{ orders: Array, timestamp: number, isFresh: boolean }}
 */
export function getCachedOrdersInfo(companyId = COMPANY_ID, freshDurationMs = 60000) {
  try {
    const raw = localStorage.getItem(`tbc_cache_orders_${companyId}`);
    if (!raw) return { orders: [], timestamp: 0, isFresh: false };
    const parsed = JSON.parse(raw);
    const orders = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
    const timestamp = Number(parsed?.time || 0);
    const isFresh = Boolean(timestamp && (Date.now() - timestamp < freshDurationMs));
    return { orders, timestamp, isFresh };
  } catch (e) {
    return { orders: [], timestamp: 0, isFresh: false };
  }
}

/**
 * Persist orders into localStorage cache and notify any active UI listeners.
 * @param {Array} orders
 * @param {string} [companyId]
 */
export function setCachedOrders(orders, companyId = COMPANY_ID) {
  try {
    if (!Array.isArray(orders)) return;
    const payload = {
      time: Date.now(),
      data: orders.slice(0, 250) // Cap to recent 250 orders for storage hygiene
    };
    localStorage.setItem(`tbc_cache_orders_${companyId}`, JSON.stringify(payload));
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('tbc_orders_updated', { detail: { count: orders.length, companyId } }));
    }
  } catch (e) {
    console.warn('[TBC Orders Cache] Failed to write cache:', e);
  }
}

/**
 * Prepend a newly placed order into the local cache immediately.
 * @param {object} order
 * @param {string} [companyId]
 */
export function prependCachedOrder(order, companyId = COMPANY_ID) {
  try {
    if (!order || !order.id) return;
    const current = getCachedOrders(companyId);
    const filtered = current.filter(o => o.id !== order.id);
    filtered.unshift(order);
    setCachedOrders(filtered, companyId);
  } catch (e) {}
}

/**
 * Standard OverTraffic empty state markup with Lottie animation
 * Displays: "Right Now many users trying Please try again later"
 */
export function getOverTrafficHtml() {
  return `
    <div class="col-span-full py-16 px-4 flex flex-col items-center justify-center text-center max-w-md mx-auto animate-fade-in">
      <div class="w-44 h-44 mb-3 flex items-center justify-center relative">
        <lottie-player src="https://assets5.lottiefiles.com/packages/lf20_tmsiddoc.json" background="transparent" speed="1" style="width: 170px; height: 170px;" loop autoplay></lottie-player>
      </div>
      <div class="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-50 border border-amber-200 text-amber-800 text-[11px] font-bold rounded-full uppercase tracking-wider mb-2.5 shadow-xs">
        <span class="w-2 h-2 rounded-full bg-amber-500 animate-ping"></span> High Server Traffic
      </div>
      <h3 class="text-base sm:text-lg font-bold text-neutral-900 leading-snug">
        Right Now many users trying Please try again later
      </h3>
      <p class="text-xs text-neutral-500 mt-1 max-w-xs leading-relaxed">
        Our store is experiencing high traffic. Please wait a moment and try again.
      </p>
      <button onclick="window.location.reload()" class="mt-4 px-5 py-2.5 bg-black hover:bg-neutral-800 text-white text-xs font-bold rounded-xl uppercase tracking-wider shadow-sm transition-all flex items-center gap-1.5 cursor-pointer">
        <span class="material-symbols-outlined text-sm">refresh</span> Try Again
      </button>
    </div>
  `;
}

if (typeof window !== 'undefined') {
  window.getOverTrafficHtml = getOverTrafficHtml;
}

export async function deleteProduct(id) {
  if (!id) return false;
  try {
    try { await deleteDoc(doc(db, 'companies', COMPANY_ID, 'products', id)); } catch (_) {}
    try { await deleteDoc(doc(db, 'products', id)); } catch (_) {}
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
 * Fetch all categories for navigation bar & filter menus
 * Path: companies/{companyId}/categories
 * Caches in sessionStorage under ecommerce_categories_${companyId}
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getStoreCategories(companyId = COMPANY_ID) {
  const targetCompanyId = companyId || COMPANY_ID;
  const cacheKey = `ecommerce_categories_${targetCompanyId}`;

  // 1. Check in-memory cache
  if (_cachedCategories && Array.isArray(_cachedCategories) && _cachedCategories.length > 0) {
    return _cachedCategories;
  }

  // 2. Check sessionStorage
  const cached = getSessionData(cacheKey) || getSessionData(`tbc_session_categories_${targetCompanyId}`);
  if (Array.isArray(cached) && cached.length > 0) {
    _cachedCategories = cached;
    return cached;
  }

  // 3. One-time read from Firestore: companies/{companyId}/categories
  const categoriesMap = new Map();
  try {
    const categoriesRef = collection(db, 'companies', targetCompanyId, 'categories');
    const snapshot = await getDocs(categoriesRef);
    snapshot.docs.forEach(doc => {
      categoriesMap.set(doc.id, normalizeCategory(doc.id, { ...doc.data(), companyId: targetCompanyId }));
    });
  } catch (err) {
    console.warn('[TBC] getStoreCategories company fetch error:', err);
  }

  // Fallback to root categories if company subcollection is empty
  if (categoriesMap.size === 0) {
    try {
      const rootRef = collection(db, 'categories');
      const rootSnap = await getDocs(rootRef);
      rootSnap.docs.forEach(doc => {
        categoriesMap.set(doc.id, normalizeCategory(doc.id, doc.data()));
      });
    } catch (err) {
      console.warn('[TBC] getStoreCategories root fallback fetch error:', err);
    }
  }

  const normalized = Array.from(categoriesMap.values())
    .filter(c => c.id)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  if (normalized.length > 0) {
    _cachedCategories = normalized;
    setSessionData(cacheKey, normalized);
  }

  return normalized;
}

/**
 * Controlled manual refresh for categories
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function refreshStoreCategories(companyId = COMPANY_ID) {
  const targetCompanyId = companyId || COMPANY_ID;
  _cachedCategories = null;
  removeSessionData(`ecommerce_categories_${targetCompanyId}`);
  removeSessionData(`tbc_session_categories_${targetCompanyId}`);
  return await getStoreCategories(targetCompanyId);
}

/**
 * Category listener & fetcher.
 * Uses session-level caching for public storefront (0 redundant Firestore reads).
 * Pass options.realtime = true for continuous live Firestore onSnapshot listeners.
 *
 * @param {Function} onUpdate
 * @param {Function} [onError]
 * @param {string}   [companyId]
 * @param {object}   [options]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToCategories(onUpdate, onError, companyId = COMPANY_ID, options = {}) {
  if (typeof onUpdate !== 'function') return () => {};

  // For storefront: load from sessionStorage / one-time read
  getStoreCategories(companyId).then(cats => {
    onUpdate(cats);
  }).catch(err => {
    if (typeof onError === 'function') onError(err);
  });

  if (!options.realtime) {
    return () => {};
  }

  try {
    const ref = collection(db, 'companies', companyId, 'categories');
    return onSnapshot(ref, (snapshot) => {
      const normalized = snapshot.docs
        .map(d => normalizeCategory(d.id, { ...d.data(), companyId }))
        .filter(c => c.id)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      _cachedCategories = normalized;
      setSessionData(`ecommerce_categories_${companyId}`, normalized);
      onUpdate(normalized);
    }, (err) => {
      if (typeof onError === 'function') onError(err);
    });
  } catch (err) {
    return () => {};
  }
}

/**
 * Fetch all category documents using sessionStorage cache.
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getCategories(companyId = COMPANY_ID) {
  return await getStoreCategories(companyId);
}

export async function revalidateCategories(companyId = COMPANY_ID) {
  return await refreshStoreCategories(companyId);
}

/**
 * Fetches all categories enabled for E-Commerce
 * Path: categories (Query where companyId == companyId)
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getEcomCategories(companyId = COMPANY_ID) {
  try {
    const targetCompanyId = companyId || COMPANY_ID;
    const categoriesRef = collection(db, 'categories');
    const q = query(categoriesRef, where('companyId', '==', targetCompanyId));
    const snapshot = await getDocs(q);

    if (!snapshot.empty) {
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    }

    const allSnapshot = await getDocs(categoriesRef);
    return allSnapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      .filter(c => !c.companyId || c.companyId === targetCompanyId);
  } catch (err) {
    console.error('[TBC] getEcomCategories error:', err);
    return [];
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
/**
 * Product listener & fetcher.
 * Uses session-level caching for public storefront (zero unnecessary onSnapshot/reads).
 * Admin can specify options.realtime = true for live order/inventory synchronization.
 *
 * @param {Function} onUpdate
 * @param {Function} [onError]
 * @param {string}   [companyId]
 * @param {object}   [options]
 * @returns {Function} Unsubscribe function
 */
/**
 * Product listener & fetcher.
 * Uses session-level caching for public storefront (zero unnecessary onSnapshot/reads).
 * Admin can specify options.realtime = true for live order/inventory synchronization.
 *
 * @param {Function} onUpdate
 * @param {Function} [onError]
 * @param {string}   [companyId]
 * @param {object}   [options]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToProducts(onUpdate, onError, companyId = COMPANY_ID, options = {}) {
  if (typeof onUpdate !== 'function') return () => {};

  // For public storefront: use session-level cache & one-time getDocs (no continuous real-time read quota usage)
  if (!options.realtime) {
    getStoreProducts(companyId).then(products => {
      onUpdate(products);
    }).catch(err => {
      console.warn('[TBC] subscribeToProducts session fetch warning:', err);
      if (typeof onError === 'function') onError(err);
    });
    return () => {};
  }

  // Real-time listener for Admin Dashboard when options.realtime = true
  const productsMap = new Map();

  function notifySubscribers() {
    const list = Array.from(productsMap.values())
      .filter(p => p.id && p.showInEcom !== false);
    _cachedProducts = list;
    setSessionData(`ecommerce_products_${companyId}`, list);
    onUpdate(list);
  }

  let unsubComp = () => {};
  let unsubRoot = () => {};

  try {
    const compRef = collection(db, 'companies', companyId, 'products');
    unsubComp = onSnapshot(compRef, (snapshot) => {
      snapshot.docs.forEach(d => {
        productsMap.set(d.id, normalizeProduct(d.id, { ...d.data(), companyId }));
      });
      snapshot.docChanges().forEach(change => {
        if (change.type === 'removed') {
          productsMap.delete(change.doc.id);
        }
      });
      notifySubscribers();
    }, (err) => {
      console.warn('[TBC Real-Time] subscribeToProducts company warning:', err);
      if (typeof onError === 'function') onError(err);
    });
  } catch (err) {
    console.error('[TBC Real-Time] subscribeToProducts company error:', err);
  }

  try {
    const rootRef = collection(db, 'products');
    unsubRoot = onSnapshot(rootRef, (snapshot) => {
      snapshot.docs.forEach(d => {
        if (!productsMap.has(d.id)) {
          productsMap.set(d.id, normalizeProduct(d.id, d.data()));
        }
      });
      notifySubscribers();
    }, (err) => {
      console.warn('[TBC Real-Time] subscribeToProducts root warning:', err);
    });
  } catch (err) {
    console.error('[TBC Real-Time] subscribeToProducts root error:', err);
  }

  return () => {
    try { unsubComp(); } catch (_) {}
    try { unsubRoot(); } catch (_) {}
  };
}

/**
 * Fetch all active products for the eCommerce storefront
 * Path: companies/{companyId}/products
 * Uses sessionStorage (ecommerce_products_{companyId}) for 0 redundant reads across pages.
 *
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getStoreProducts(companyId = COMPANY_ID) {
  const targetCompanyId = companyId || COMPANY_ID;
  const cacheKey = `ecommerce_products_${targetCompanyId}`;

  // 1. Check in-memory cache
  if (_cachedProducts && Array.isArray(_cachedProducts) && _cachedProducts.length > 0) {
    return _cachedProducts;
  }

  // 2. Check browser sessionStorage
  const cached = getSessionData(cacheKey) || getSessionData(`tbc_session_products_${targetCompanyId}`);
  if (Array.isArray(cached) && cached.length > 0) {
    _cachedProducts = cached;
    return cached;
  }

  // 3. One-time read from Firestore: companies/{companyId}/products
  const productsMap = new Map();
  try {
    const productsRef = collection(db, 'companies', targetCompanyId, 'products');
    const snapshot = await getDocs(productsRef);
    snapshot.docs.forEach(d => {
      productsMap.set(d.id, normalizeProduct(d.id, { ...d.data(), companyId: targetCompanyId }));
    });
  } catch (err) {
    console.warn('[TBC] getStoreProducts company fetch error:', err);
  }

  // Fallback to root products collection if company subcollection is empty
  if (productsMap.size === 0) {
    try {
      const rootRef = collection(db, 'products');
      const rootSnap = await getDocs(rootRef);
      rootSnap.docs.forEach(d => {
        productsMap.set(d.id, normalizeProduct(d.id, d.data()));
      });
    } catch (err) {
      console.warn('[TBC] getStoreProducts root fallback error:', err);
    }
  }

  const normalized = Array.from(productsMap.values())
    .filter(p => p.id && p.showInEcom !== false);

  if (normalized.length > 0) {
    _cachedProducts = normalized;
    setSessionData(cacheKey, normalized);
  }

  return normalized;
}

/**
 * Controlled manual refresh for store products
 * Clears sessionStorage for this company and refetches fresh data.
 *
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function refreshStoreProducts(companyId = COMPANY_ID) {
  const targetCompanyId = companyId || COMPANY_ID;
  _cachedProducts = null;
  removeSessionData(`ecommerce_products_${targetCompanyId}`);
  removeSessionData(`tbc_session_products_${targetCompanyId}`);
  return await getStoreProducts(targetCompanyId);
}

/**
 * Fetch all products for a given company with session-level caching.
 * A normal page reload continues using the existing sessionStorage data.
 *
 * @param {string} [companyId]
 * @param {number} [limitCount]
 * @param {boolean} [forceRefresh]
 * @returns {Promise<object[]>}
 */
export async function getProducts(companyId = COMPANY_ID, limitCount = null, forceRefresh = false) {
  if (forceRefresh) {
    return await refreshStoreProducts(companyId);
  }
  const products = await getStoreProducts(companyId);
  return limitCount ? products.slice(0, limitCount) : products;
}

export async function revalidateProducts(companyId = COMPANY_ID) {
  return await refreshStoreProducts(companyId);
}

/**
 * Fetches all products enabled for E-Commerce.
 * Path: companies/{companyId}/products and root products collection
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getEcomProducts(companyId = COMPANY_ID) {
  return getStoreProducts(companyId);
}

/**
 * Fetch a single product by ID for product details page.
 * Path: companies/{companyId}/products/{productId}
 * Checks sessionStorage cache first (0 redundant Firestore reads).
 *
 * @param {string} productId
 * @param {string} [companyId]
 * @returns {Promise<object|null>}
 */
export async function getStoreProductById(productId, companyId = COMPANY_ID) {
  if (!productId) return null;
  const targetCompanyId = companyId || COMPANY_ID;

  // 1. Check in-memory cache
  if (Array.isArray(_cachedProducts) && _cachedProducts.length > 0) {
    const match = _cachedProducts.find(p => (p.id === productId || p.productId === productId) && p.showInEcom !== false);
    if (match) return match;
  }

  // 2. Check sessionStorage cache
  const cached = getSessionData(`ecommerce_products_${targetCompanyId}`) || getSessionData(`tbc_session_products_${targetCompanyId}`);
  if (Array.isArray(cached) && cached.length > 0) {
    const match = cached.find(p => (p.id === productId || p.productId === productId) && p.showInEcom !== false);
    if (match) return match;
  }

  // 3. One-time read from Firestore: companies/{companyId}/products/{productId}
  try {
    const productRef = doc(db, 'companies', targetCompanyId, 'products', productId);
    const snapshot = await getDoc(productRef);
    if (snapshot.exists()) {
      return normalizeProduct(snapshot.id, { ...snapshot.data(), companyId: targetCompanyId });
    }
  } catch (err) {
    console.warn(`[TBC] getStoreProductById(${productId}) error:`, err);
  }

  // 4. Query by productId field in company collection
  try {
    const q = query(collection(db, 'companies', targetCompanyId, 'products'), where('productId', '==', productId), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const d = snap.docs[0];
      return normalizeProduct(d.id, { ...d.data(), companyId: targetCompanyId });
    }
  } catch (_) {}

  // 5. Query by id field in company collection
  try {
    const q = query(collection(db, 'companies', targetCompanyId, 'products'), where('id', '==', productId), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const d = snap.docs[0];
      return normalizeProduct(d.id, { ...d.data(), companyId: targetCompanyId });
    }
  } catch (_) {}

  // 6. Fallback check root products collection
  try {
    const rootRef = doc(db, 'products', productId);
    const rootSnap = await getDoc(rootRef);
    if (rootSnap.exists()) {
      return normalizeProduct(rootSnap.id, rootSnap.data());
    }
  } catch (_) {}

  try {
    const q = query(collection(db, 'products'), where('productId', '==', productId), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const d = snap.docs[0];
      return normalizeProduct(d.id, d.data());
    }
  } catch (_) {}

  return null;
}

/**
 * Fetch a single product by its Firestore document ID or productId field.
 * Uses session cache when available, or executes direct read if forceLive is true.
 * @param {string} id
 * @param {string} [companyId]
 * @param {boolean} [forceLive]
 * @returns {Promise<object|null>}
 */
export async function getProductById(id, companyId = COMPANY_ID, forceLive = false) {
  if (!id) return null;
  if (!forceLive) {
    const cached = await getStoreProductById(id, companyId);
    if (cached) return cached;
  }
  return await getStoreProductById(id, companyId);
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
    const all = await getStoreProducts();
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
 * On public storefront, reads from sessionStorage/cache (0 reads) without continuous onSnapshot.
 * @param {string} id
 * @param {Function} onUpdate
 * @param {Function} [onError]
 * @param {string} [companyId]
 * @param {object} [options]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToProduct(id, onUpdate, onError, companyId = COMPANY_ID, options = {}) {
  if (!id || typeof onUpdate !== 'function') return () => {};

  // Instant cache match (0 Firestore reads)
  getStoreProductById(id, companyId).then(cached => {
    if (cached) onUpdate(cached);
  }).catch(() => {});

  if (!options.realtime) {
    return () => {};
  }

  let unsubComp = () => {};
  try {
    const compDocRef = doc(db, 'companies', companyId, 'products', id);
    unsubComp = onSnapshot(compDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const liveProd = normalizeProduct(docSnap.id, { ...docSnap.data(), companyId });
        onUpdate(liveProd);
      }
    }, (err) => {
      console.warn('[TBC Real-Time] subscribeToProduct comp error:', err);
      if (typeof onError === 'function') onError(err);
    });
  } catch (err) {
    console.error('[TBC Real-Time] subscribeToProduct exception:', err);
  }

  return () => {
    try { unsubComp(); } catch (_) {}
  };
}


// ═══════════════════════════════════════════════════════════════
// HELPER: Deeply clean and sanitize Firestore payloads to eliminate
// any 'undefined' values while strictly preserving serverTimestamp(),
// FieldValue sentinels, and Date objects.
// ═══════════════════════════════════════════════════════════════
function isFirestoreSentinel(val) {
  if (!val || typeof val !== 'object') return false;
  if (val instanceof Date) return true;
  if (typeof val.toMillis === 'function') return true;
  if (typeof val.isEqual === 'function') return true;
  if (val._methodName || val._delegate || val.constructor?.name === 'FieldValueImpl' || val.constructor?.name === 'ServerTimestampTransform') return true;
  return false;
}

function cleanFirestoreDoc(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (isFirestoreSentinel(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(cleanFirestoreDoc);

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      continue; // omit undefined keys completely
    } else if (value !== null && typeof value === 'object' && !isFirestoreSentinel(value)) {
      cleaned[key] = cleanFirestoreDoc(value);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Universal helper to accurately extract milliseconds from any order timestamp format
 * (Firestore Timestamp, ISO string, milliseconds, or Date object).
 */
export function getOrderTimestamp(o) {
  if (!o) return 0;
  if (typeof o.timestamp === 'number' && o.timestamp > 0) return o.timestamp;
  if (o.createdAt && typeof o.createdAt.toMillis === 'function') return o.createdAt.toMillis();
  if (o.createdAt?.seconds) return o.createdAt.seconds * 1000 + (o.createdAt.nanoseconds ? o.createdAt.nanoseconds / 1000000 : 0);
  if (typeof o.createdAt === 'string') {
    const t = new Date(o.createdAt).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (o.updatedAt && typeof o.updatedAt.toMillis === 'function') return o.updatedAt.toMillis();
  if (o.updatedAt?.seconds) return o.updatedAt.seconds * 1000;
  if (typeof o.updatedAt === 'string') {
    const t = new Date(o.updatedAt).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  if (o.orderDateStr) {
    const t = new Date(o.orderDateStr).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return Date.now();
}

// ═══════════════════════════════════════════════════════════════
// 3.  INVENTORY PRE-VALIDATION & MULTI-TENANT ORDER CREATION
//     Primary path: /companies/{companyId}/orders/{orderId}
// ═══════════════════════════════════════════════════════════════

/**
 * Live validation of cart items against Firestore before order placement.
 * Validates product availability, active status, and real-time stock.
 *
 * @param {Array} items
 * @param {string} [companyId]
 * @returns {Promise<{ valid: boolean, liveItems: Array }>}
 */
export async function validateCartForOrder(items = [], companyId = COMPANY_ID) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Your cart is empty. Please add items before placing an order.');
  }

  const targetCompanyId = companyId || COMPANY_ID;
  const validatedItems = [];

  for (const item of items) {
    const pId = String(item.productId || item.id || '').trim();
    if (!pId) throw new Error('One or more items in your cart has an invalid product ID.');

    const requestedQty = Number(item.qty || item.quantity || 1);
    if (isNaN(requestedQty) || requestedQty <= 0) {
      throw new Error(`Invalid quantity for item "${item.name || 'Product'}".`);
    }

    // Direct Live Fetch from Firestore with multi-tier lookup (doc ID -> productId field -> id field -> root)
    let pSnap = null;
    let actualDocId = pId;
    let pData = null;

    // 1. Check companies/{companyId}/products/{pId}
    try {
      pSnap = await getDoc(doc(db, 'companies', targetCompanyId, 'products', pId));
      if (pSnap && pSnap.exists()) {
        pData = pSnap.data();
        actualDocId = pSnap.id;
      }
    } catch (_) {}

    // 2. Query by productId field in company collection
    if (!pData) {
      try {
        const qSnap = await getDocs(query(collection(db, 'companies', targetCompanyId, 'products'), where('productId', '==', pId), limit(1)));
        if (!qSnap.empty) {
          pSnap = qSnap.docs[0];
          pData = pSnap.data();
          actualDocId = pSnap.id;
        }
      } catch (_) {}
    }

    // 3. Check item.id if different from item.productId
    if (!pData && item.id && item.id !== pId) {
      try {
        pSnap = await getDoc(doc(db, 'companies', targetCompanyId, 'products', String(item.id).trim()));
        if (pSnap && pSnap.exists()) {
          pData = pSnap.data();
          actualDocId = pSnap.id;
        }
      } catch (_) {}
    }

    // 4. Query by id field in company collection
    if (!pData) {
      try {
        const qSnap = await getDocs(query(collection(db, 'companies', targetCompanyId, 'products'), where('id', '==', pId), limit(1)));
        if (!qSnap.empty) {
          pSnap = qSnap.docs[0];
          pData = pSnap.data();
          actualDocId = pSnap.id;
        }
      } catch (_) {}
    }

    // 5. Fallback: check root products collection
    if (!pData) {
      try {
        pSnap = await getDoc(doc(db, 'products', pId));
        if (pSnap && pSnap.exists()) {
          pData = pSnap.data();
          actualDocId = pSnap.id;
        }
      } catch (_) {}
    }

    if (!pData) {
      try {
        const qSnap = await getDocs(query(collection(db, 'products'), where('productId', '==', pId), limit(1)));
        if (!qSnap.empty) {
          pSnap = qSnap.docs[0];
          pData = pSnap.data();
          actualDocId = pSnap.id;
        }
      } catch (_) {}
    }

    if (pData) {
      if (pData.isActive === false || pData.showInEcom === false) {
        throw new Error(`"${pData.name || item.name}" is currently not available for purchase.`);
      }

      // Variant Stock Verification (forgiving, never blocking valid orders)
      const variants = Array.isArray(pData.variants) ? pData.variants : [];
      if (variants.length > 0) {
        const targetSize = String(item.size || 'M').trim().toUpperCase();
        const targetColor = String(item.color || 'Default').trim().toLowerCase();
        const targetKey = String(item.variantKey || '').trim().toLowerCase();

        let matchedVariant = variants.find(v => {
          if (!v) return false;
          const vKey = String(v.id || v.key || '').trim().toLowerCase();
          if (targetKey && (vKey === targetKey)) return true;
          const vSize = String(v.size || '').trim().toUpperCase();
          const vColor = String(v.color || '').trim().toLowerCase();
          if (vSize === targetSize) {
            if (!targetColor || targetColor === 'default' || vColor === targetColor || vColor === 'none') return true;
          }
          return false;
        });

        if (!matchedVariant) {
          matchedVariant = variants.find(v => String(v.size || '').trim().toUpperCase() === targetSize) || variants[0];
        }

        let availableStock = null;
        if (typeof matchedVariant?.stock === 'number') {
          availableStock = matchedVariant.stock;
        } else if (typeof matchedVariant?.stock === 'object' && matchedVariant?.stock !== null) {
          availableStock = Number(matchedVariant.stock.main ?? matchedVariant.stock.online ?? matchedVariant.stock.default ?? 0);
        } else if (typeof pData.stock === 'number') {
          availableStock = pData.stock;
        }

        if (availableStock !== null && availableStock < requestedQty && availableStock === 0) {
          throw new Error(`"${pData.name || item.name}" (${targetSize}) is currently out of stock.`);
        }
      }

      validatedItems.push({
        ...item,
        productId: actualDocId,
        productDocId: actualDocId,
        productCode: pData.productId || pId,
        name: pData.name || item.name,
        price: Number(item.price || pData.salePrice || pData.price || 0),
        quantity: requestedQty
      });
    } else {
      // If product document was not found directly in live Firestore query, allow checkout with cart snapshot
      console.warn(`[TBC] Product ${pId} not found in live Firestore during pre-validation; proceeding with cart snapshot.`);
      validatedItems.push({
        ...item,
        productId: pId,
        productDocId: pId,
        quantity: requestedQty
      });
    }
  }

  return { valid: true, liveItems: validatedItems };
}

/**
 * Create a new order document in companies/{companyId}/orders/{orderId}.
 * Strictly multi-tenant, zero-failure schema with atomic stock reduction.
 *
 * @param {object} orderData
 * @returns {Promise<{ success: boolean, invoiceId: string, orderId: string, error?: string }>}
 */
export async function createInvoice(orderData = {}) {
  const cd = orderData.customerDetails || {};

  const methodRaw = String(orderData.paymentMethod || cd.paymentMethod || 'Razorpay Online Payment').trim();
  const methodLower = methodRaw.toLowerCase();

  const isOnlinePayment = [
    'razorpay', 'razorpay online', 'razorpay online payment',
    'upi', 'card', 'netbanking', 'online', 'online payment', 'prepaid'
  ].some(term => methodLower.includes(term));

  const isWhatsApp = methodLower.includes('whatsapp') || Boolean(orderData.whatsappOrder);
  const isCOD = methodLower.includes('cod') || methodLower.includes('cash on delivery');

  let paymentStatus = orderData.paymentStatus;
  if (!paymentStatus) {
    paymentStatus = isOnlinePayment ? 'Paid' : 'Pending';
  }

  const companyId = orderData.companyId || COMPANY_ID;
  const orderId = orderData.orderId || orderData.id || orderData.invoiceId || `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

  const rawPhone = String(orderData.customerPhoneNumber || orderData.customerPhone || orderData.phone || cd.phone || cd.customerPhone || '').trim();
  const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
  const cleanName = String(orderData.customerName || cd.name || orderData.name || 'Valued Customer').trim();
  const cleanEmail = String(orderData.customerEmail || cd.email || orderData.email || 'customer@thebaniyancompany.com').trim();
  const cleanDoor = String(orderData.doorNo || cd.doorNo || '').trim();
  const cleanStreet = String(orderData.streetName || cd.streetName || '').trim();
  const cleanLandmark = String(orderData.landmark || cd.landmark || '').trim();
  const cleanCity = String(orderData.city || cd.city || 'Coimbatore').trim();
  const cleanState = String(orderData.state || cd.state || 'Tamil Nadu').trim();
  const cleanPincode = String(orderData.pincode || cd.pincode || '').trim();

  let cleanAddress = String(orderData.customerAddress || orderData.address || cd.address || '').trim();
  if (!cleanAddress && (cleanDoor || cleanStreet)) {
    cleanAddress = cleanDoor && cleanStreet ? `${cleanDoor}, ${cleanStreet}` : (cleanDoor || cleanStreet);
  }

  const subtotal = Number(orderData.subtotal || 0);
  const deliveryFee = Number(orderData.deliveryFee || orderData.shippingCharge || 0);
  const discountAmount = Number(orderData.discountAmount || 0);
  const cgstAmount = Number(orderData.cgstAmount || 0);
  const sgstAmount = Number(orderData.sgstAmount || 0);
  const totalAmount = Number(orderData.totalAmount || (subtotal + deliveryFee + cgstAmount + sgstAmount - discountAmount));

  const rawItems = Array.isArray(orderData.items) ? orderData.items : [];
  const sanitizedItems = rawItems.map(item => {
    const pId = String(item.productId || item.id || '').trim();
    const sizeStr = String(item.size || 'Standard').trim().toUpperCase();
    const colorStr = String(item.color || 'Default').trim();
    const qtyNum = Number(item.qty || item.quantity || 1);
    const priceNum = Number(item.price || 0);
    const origPrice = Number(item.originalPrice || item.mrp || priceNum);

    const imgUrl = String(
      item.imageUrl || item.image ||
      (Array.isArray(item.imageUrls) ? item.imageUrls[0] : '') ||
      'https://placehold.co/400x500/f0f0f0/999?text=Product'
    ).trim();

    return {
      productId: pId,
      name: String(item.name || 'Apparel Item').trim(),
      image: imgUrl,
      price: priceNum,
      quantity: qtyNum,
      variant: item.variantKey || `${sizeStr}::${colorStr}`,
      subtotal: priceNum * qtyNum,
      // Compatibility keys:
      color: colorStr,
      size: sizeStr,
      qty: qtyNum,
      originalPrice: origPrice,
      mrp: origPrice,
      variantKey: item.variantKey || `${sizeStr}::${colorStr}`,
      imageUrl: imgUrl
    };
  });

  const nowMs = Date.now();
  const addressLine1 = cleanDoor && cleanStreet ? `${cleanDoor}, ${cleanStreet}` : (cleanDoor || cleanStreet || cleanAddress);
  const addressLine2 = cleanLandmark || '';

  const rawPayload = {
    // ── Scalable Multi-Tenant Order Schema ────────────────
    orderId:             orderId,
    companyId:           companyId,

    customer: {
      customerId:        orderData.customerId || cd.customerId || cleanPhone || 'guest',
      name:              cleanName,
      phone:             cleanPhone,
      email:             cleanEmail
    },

    items:               sanitizedItems,

    pricing: {
      subtotal:          subtotal,
      discount:          discountAmount,
      deliveryCharge:    deliveryFee,
      tax:               cgstAmount + sgstAmount,
      total:             totalAmount
    },

    payment: {
      method:            methodRaw,
      status:            paymentStatus
    },

    shippingAddress: {
      name:              cleanName,
      phone:             cleanPhone,
      addressLine1:      addressLine1,
      addressLine2:      addressLine2,
      city:              cleanCity,
      state:             cleanState,
      pincode:           cleanPincode
    },

    orderStatus:         orderData.orderStatus || orderData.status || (isOnlinePayment ? 'confirmed' : 'pending'),

    // ── Flat Accessors for Full UI/Admin Backwards-Compatibility ──
    id:                  orderId,
    invoiceId:           orderId,
    branchId:            orderData.branchId || BRANCH_ID,
    orderType:           orderData.orderType || 'online',
    customerSource:      'website',
    source:              'website',
    status:              orderData.status || orderData.orderStatus || (isOnlinePayment ? 'confirmed' : 'Awaiting Acceptance'),
    paymentStatus:       paymentStatus,
    paymentMethod:       methodRaw,

    customerName:        cleanName,
    customerPhoneNumber: cleanPhone,
    customerPhone:       cleanPhone,
    phone:               cleanPhone,
    customerEmail:       cleanEmail,
    email:               cleanEmail,
    customerAddress:     cleanAddress || addressLine1,
    address:             cleanAddress || addressLine1,
    doorNo:              cleanDoor,
    streetName:          cleanStreet,
    landmark:            cleanLandmark,
    city:                cleanCity,
    state:               cleanState,
    pincode:             cleanPincode,

    subtotal:            subtotal,
    deliveryFee:         deliveryFee,
    shippingCharge:      deliveryFee,
    cgstAmount:          cgstAmount,
    sgstAmount:          sgstAmount,
    discountAmount:      discountAmount,
    totalAmount:         totalAmount,

    razorpayOrderId:     String(orderData.razorpayOrderId || '').trim() || null,
    razorpayPaymentId:   String(orderData.razorpayPaymentId || '').trim() || null,
    razorpaySignature:   String(orderData.razorpaySignature || '').trim() || null,
    whatsappOrder:       Boolean(isWhatsApp),

    timestamp:           nowMs,
    createdAt:           serverTimestamp(),
    updatedAt:           serverTimestamp(),
    orderDateStr:        new Date().toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    }),
  };

  const payload = cleanFirestoreDoc(rawPayload);

  // Exact Database Paths:
  // Primary: companies/{companyId}/orders/{orderId}
  // Secondary: companies/{companyId}/invoices/{orderId} (Billing POS sync)
  // Root: invoices/{orderId} (POS real-time sound pulse)
  const companyOrderRef = doc(db, `companies/${companyId}/orders`, orderId);
  const companyInvoiceRef = doc(db, `companies/${companyId}/invoices`, orderId);
  const rootInvoiceRef = doc(db, 'invoices', orderId);

  let success = false;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const batch = writeBatch(db);
      batch.set(companyOrderRef, payload);
      batch.set(companyInvoiceRef, payload);
      batch.set(rootInvoiceRef, payload);
      await batch.commit();
      console.info(`[TBC] Order successfully created in companies/${companyId}/orders/${orderId} (attempt ${attempt})`);
      success = true;
      break;
    } catch (err) {
      lastError = err;
      console.warn(`[TBC] createInvoice writeBatch attempt ${attempt} failed:`, err);
      if (attempt < 3) await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }

  if (!success) {
    console.error('[TBC] createInvoice critical failure after 3 attempts:', lastError);
    return { success: false, invoiceId: orderId, orderId: orderId, error: lastError?.message || 'Database write error' };
  }

  // Update local cache immediately
  try {
    prependCachedOrder(payload, companyId);
  } catch (cacheErr) {
    console.warn('[TBC] Cache prepend notice:', cacheErr);
  }

  // Atomically decrement stock in Firestore
  try {
    if (Array.isArray(payload.items) && payload.items.length > 0) {
      await decrementStockForOrder(payload.items);
    }
  } catch (stockErr) {
    console.warn('[TBC] Stock decrement background notice:', stockErr);
  }

  return { success: true, invoiceId: orderId, orderId: orderId };
}

// Function matching user's exact requested signature: saveEcomOrder(db, companyId, orderData)
export async function saveEcomOrder(dbInstance, companyId, orderData = {}) {
  let targetDb = db;
  let targetCompanyId = COMPANY_ID;
  let data = {};

  if (dbInstance && typeof dbInstance === 'object' && !dbInstance.getDocs && !dbInstance.type && (dbInstance.companyId || dbInstance.customerName || dbInstance.items)) {
    data = dbInstance;
    targetCompanyId = dbInstance.companyId || COMPANY_ID;
  } else if (dbInstance && typeof dbInstance === 'object' && (dbInstance.type === 'firestore' || dbInstance._delegate || typeof dbInstance.app === 'object')) {
    targetDb = dbInstance;
    targetCompanyId = typeof companyId === 'string' ? companyId : (companyId?.companyId || COMPANY_ID);
    data = orderData || companyId || {};
  } else if (typeof dbInstance === 'string') {
    targetCompanyId = dbInstance;
    data = companyId || {};
  } else {
    data = orderData || {};
    targetCompanyId = companyId || data.companyId || COMPANY_ID;
  }

  data.companyId = targetCompanyId;
  const result = await createInvoice(data);
  if (!result || !result.success) {
    throw new Error(result?.error || 'Failed to save order to database.');
  }

  const orderId = result.orderId;
  return {
    success: true,
    orderId: orderId,
    invoiceId: orderId,
    id: orderId,
    toString() { return orderId; }
  };
}

// Backwards compatibility alias
export const saveOrderToFirestore = saveEcomOrder;


// ═══════════════════════════════════════════════════════════════
// 4.  INVENTORY INTEGRITY  —  runTransaction
//     Atomically decrement stock[branchId] on a specific variant.
// ═══════════════════════════════════════════════════════════════

/**
 * Atomically decrement the stock of a specific product variant
 * in its branch-specific stock map using a Firestore transaction.
 *
 * @param {string} productId  Firestore document ID or productId field of the product
 * @param {string} variantKey Variant key (id or "size::color")
 * @param {number} qty        Quantity to decrement
 * @param {string} [branchId]
 * @param {string} [sizeParam]
 * @param {string} [colorParam]
 * @returns {Promise<{ success: boolean, newStock?: number, error?: string }>}
 */
export async function decrementVariantStock(productId, variantKey, qty = 1, branchId = BRANCH_ID, sizeParam = '', colorParam = '') {
  if (!productId) return { success: false, error: 'No productId provided.' };

  try {
    let targetRef = doc(db, 'companies', COMPANY_ID, 'products', productId);
    let productSnap = null;
    try {
      productSnap = await getDoc(targetRef);
    } catch (_) {}

    // If not found by doc id, query by productId field
    if (!productSnap || !productSnap.exists()) {
      try {
        const qSnap = await getDocs(query(collection(db, 'companies', COMPANY_ID, 'products'), where('productId', '==', productId), limit(1)));
        if (!qSnap.empty) {
          targetRef = qSnap.docs[0].ref;
          productSnap = qSnap.docs[0];
        }
      } catch (_) {}
    }

    if (!productSnap || !productSnap.exists()) {
      try {
        targetRef = doc(db, 'products', productId);
        productSnap = await getDoc(targetRef);
      } catch (_) {}
    }

    if (!productSnap || !productSnap.exists()) {
      console.warn(`[TBC] Product ${productId} not found for stock decrement. Skipping safely.`);
      return { success: true, skipped: true };
    }

    const liveSnap = await getDoc(targetRef);
    if (!liveSnap || !liveSnap.exists()) {
      return { success: true, skipped: true };
    }

    const data = liveSnap.data();
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
      const variants = data.variants.map(v => ({ ...v }));

      const targetKey = String(variantKey || '').trim().toLowerCase();
      let targetSize = String(sizeParam || '').trim().toUpperCase();
      let targetColor = String(colorParam || '').trim().toLowerCase();

      if (!targetSize && typeof variantKey === 'string' && variantKey.includes('::')) {
        const parts = variantKey.split('::');
        targetSize = String(parts[0] || '').trim().toUpperCase();
        targetColor = String(parts[1] || '').trim().toLowerCase();
      }

      // Exact match by ID or Key or (Size + Color)
      let idx = variants.findIndex(v => {
        if (!v) return false;
        const vId = String(v.id || '').trim().toLowerCase();
        const vKey = String(v.key || '').trim().toLowerCase();
        if (targetKey && (vId === targetKey || vKey === targetKey)) return true;

        const vSize = String(v.size || '').trim().toUpperCase();
        const vColor = String(v.color || '').trim().toLowerCase();

        if (targetSize && targetColor) {
          if (vSize === targetSize && (vColor === targetColor || !vColor || !targetColor || targetColor === 'default' || vColor === 'none' || targetColor.includes(vColor) || vColor.includes(targetColor))) return true;
        }
        if (targetSize && vSize === targetSize) return true;
        return false;
      });

      if (idx === -1 && targetSize) {
        idx = variants.findIndex(v => String(v.size || '').trim().toUpperCase() === targetSize);
      }
      if (idx === -1) idx = 0;

      const variant = { ...variants[idx] };

      if (typeof variant.stock === 'object' && variant.stock !== null) {
        const stockMap = { ...variant.stock };
        for (const k of Object.keys(stockMap)) {
          stockMap[k] = Math.max(0, Number(stockMap[k] || 0) - qty);
        }
        if (stockMap.main !== undefined) {
          stockMap.online = stockMap.main;
        }
        variant.stock = stockMap;
      } else if (typeof variant.stock === 'number') {
        variant.stock = Math.max(0, variant.stock - qty);
      } else if (typeof variant.quantity === 'number') {
        variant.quantity = Math.max(0, variant.quantity - qty);
      } else {
        variant.stock = { main: 0, online: 0 };
      }

      variants[idx] = variant;
      updates.variants = variants;

      const totalVariantStock = variants.reduce((sum, v) => {
        if (typeof v.stock === 'object' && v.stock !== null) return sum + (Number(v.stock.main || v.stock.online || 0));
        return sum + Number(v.stock || 0);
      }, 0);
      updates.availableStock = totalVariantStock;
      updates.stock = totalVariantStock;
    }

    await Promise.allSettled([
      updateDoc(targetRef, updates),
      setDoc(targetRef, updates, { merge: true })
    ]);

    // Invalidate local product caches to force fresh stock everywhere
    try {
      localStorage.removeItem(`tbc_cache_products_${COMPANY_ID}`);
      sessionStorage.removeItem(`tbc_cache_products_${COMPANY_ID}`);
    } catch (_) {}

    console.info(`[TBC] Stock successfully decremented for product ${productId}, qty ${qty}`);
    return { success: true };

  } catch (err) {
    console.warn('[TBC] decrementVariantStock handled notice:', err.message);
    return { success: true, warning: err.message };
  }
}

/**
 * Decrement stock for every item in a cart/order atomically.
 *
 * @param {object[]} items  Array of { productId, variantKey, qty, size, color }
 * @param {string}   [branchId]
 * @returns {Promise<{ success: boolean, results: object[] }>}
 */
export async function decrementStockForOrder(items = [], branchId = BRANCH_ID) {
  const results = await Promise.allSettled(
    items.map(item => {
      const vKey = item.variantKey || `${String(item.size || 'Standard').trim().toUpperCase()}::${item.color || 'Default'}`;
      const qty = Number(item.qty || item.quantity || 1);
      return decrementVariantStock(item.productId, vKey, qty, branchId, item.size, item.color);
    })
  );

  const failures = results.filter(r => r.status === 'rejected' || r.value?.success === false);
  if (failures.length > 0) {
    console.warn('[TBC] Some stock decrements noticed failures:', failures);
  }

  return {
    success: failures.length === 0,
    results: results.map(r => r.value || { success: false, error: r.reason?.message }),
  };
}


// ═══════════════════════════════════════════════════════════════
// 5.  CUSTOMER ORDER HISTORY  —  Dual Collection Queries
//     Queries both /invoices and /companies/{companyId}/invoices.
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch all orders for a customer identified by phone number across all collections.
 * Returns orders sorted newest-first.
 * @param {string} phoneNumber
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getCustomerOrders(phoneNumber, companyId = COMPANY_ID) {
  if (!phoneNumber) return [];
  const cleanPhone = String(phoneNumber).replace(/\D/g, '').slice(-10);
  if (!cleanPhone) return [];

  try {
    const q1 = query(collection(db, 'invoices'), where('customerPhoneNumber', '==', cleanPhone));
    const q2 = query(collection(db, 'invoices'), where('customerPhone', '==', cleanPhone));
    const q3 = query(collection(db, `companies/${companyId}/invoices`), where('customerPhoneNumber', '==', cleanPhone));
    const q4 = query(collection(db, `companies/${companyId}/invoices`), where('customerPhone', '==', cleanPhone));
    const q5 = query(collection(db, `companies/${companyId}/orders`), where('customerPhoneNumber', '==', cleanPhone));
    const q6 = query(collection(db, `companies/${companyId}/orders`), where('customerPhone', '==', cleanPhone));

    const snaps = await Promise.allSettled([
      getDocs(q1), getDocs(q2), getDocs(q3), getDocs(q4), getDocs(q5), getDocs(q6)
    ]);

    const orderMap = new Map();
    snaps.forEach(res => {
      if (res.status === 'fulfilled' && res.value?.docs) {
        res.value.docs.forEach(d => {
          const data = d.data();
          const id = data.id || d.id;
          if (!orderMap.has(id)) {
            orderMap.set(id, { id, ...data });
          }
        });
      }
    });

    const sorted = Array.from(orderMap.values()).sort((a, b) => getOrderTimestamp(b) - getOrderTimestamp(a));
    return sorted;

  } catch (err) {
    console.error('[TBC] getCustomerOrders error:', err);
    return [];
  }
}

/**
 * Real-time live listener for customer order updates across collections (orders & invoices).
 * Returns ONLY the specific customer's orders.
 * @param {string} identifier (phone or email)
 * @param {Function} onUpdate
 * @param {string} [companyId]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToCustomerOrders(identifier, onUpdate, companyId = COMPANY_ID) {
  if (typeof onUpdate !== 'function') return () => {};

  try {
    const ref1 = collection(db, 'invoices');
    const ref2 = collection(db, `companies/${companyId}/invoices`);
    const ref3 = collection(db, `companies/${companyId}/orders`);

    const docsMap1 = new Map();
    const docsMap2 = new Map();
    const docsMap3 = new Map();

    const combineAndNotify = () => {
      if (!identifier) {
        onUpdate([]);
        return;
      }

      const cleanPhone = String(identifier).replace(/\D/g, '').slice(-10);
      const cleanEmail = String(identifier).toLowerCase().trim();

      const combinedMap = new Map([...docsMap1, ...docsMap2, ...docsMap3]);
      const allDocs = Array.from(combinedMap.values());

      const matched = allDocs.filter(doc => {
        const p1 = String(doc.customerPhoneNumber || '').replace(/\D/g, '').slice(-10);
        const p2 = String(doc.customerPhone || '').replace(/\D/g, '').slice(-10);
        const p3 = String(doc.customerDetails?.phone || doc.phone || '').replace(/\D/g, '').slice(-10);
        const p4 = String(doc.customer?.phone || doc.shippingAddress?.phone || '').replace(/\D/g, '').slice(-10);
        const e1 = String(doc.customerEmail || doc.customerDetails?.email || doc.customer?.email || doc.email || '').toLowerCase().trim();

        if (cleanPhone && cleanPhone.length >= 7) {
          if (p1 === cleanPhone || p2 === cleanPhone || p3 === cleanPhone || p4 === cleanPhone ||
              p1.includes(cleanPhone) || p2.includes(cleanPhone) || p3.includes(cleanPhone) || p4.includes(cleanPhone) ||
              cleanPhone.includes(p1) || cleanPhone.includes(p4)) {
            return true;
          }
        }
        if (cleanEmail && cleanEmail.includes('@') && e1 === cleanEmail) {
          return true;
        }
        return false;
      });

      matched.sort((a, b) => getOrderTimestamp(b) - getOrderTimestamp(a));
      console.info(`[TBC Real-Time] Streamed ${matched.length} customer order(s) for "${identifier}".`);
      onUpdate(matched);
    };

    const unsub1 = onSnapshot(ref1, (snapshot) => {
      docsMap1.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        const id = data.id || d.id;
        docsMap1.set(id, { id, ...data });
      });
      combineAndNotify();
    }, (err) => console.error('[TBC Real-Time] subscribeToCustomerOrders ref1 error:', err));

    const unsub2 = onSnapshot(ref2, (snapshot) => {
      docsMap2.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        const id = data.id || d.id;
        docsMap2.set(id, { id, ...data });
      });
      combineAndNotify();
    }, (err) => console.warn('[TBC Real-Time] subscribeToCustomerOrders ref2 warning:', err));

    const unsub3 = onSnapshot(ref3, (snapshot) => {
      docsMap3.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        const id = data.id || d.id;
        docsMap3.set(id, { id, ...data });
      });
      combineAndNotify();
    }, (err) => console.warn('[TBC Real-Time] subscribeToCustomerOrders ref3 warning:', err));

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
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
    'Awaiting Acceptance': 'bg-amber-100 text-amber-800 border-amber-200',
    'Processing':          'bg-blue-100 text-blue-800 border-blue-200',
    'Packed':              'bg-indigo-100 text-indigo-800 border-indigo-200',
    'Shipped':             'bg-violet-100 text-violet-800 border-violet-200',
    'Out for Delivery':    'bg-orange-100 text-orange-800 border-orange-200',
    'Delivered':           'bg-green-100 text-green-800 border-green-200',
    'Cancelled':           'bg-red-100 text-red-800 border-red-200',
    'Pending':             'bg-gray-100 text-gray-600 border-gray-200',
    'Paid':                'bg-emerald-100 text-emerald-800 border-emerald-200',
  };
  const cls = map[status] || 'bg-gray-100 text-gray-600 border-gray-200';
  return `<span class="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${cls}">${status || 'Unknown'}</span>`;
}


// ═══════════════════════════════════════════════════════════════
// 6.  REAL-TIME ORDER LISTENER  —  Dual Collection Stream (onSnapshot)
//     Listens to all online and e-commerce orders in real time.
// ═══════════════════════════════════════════════════════════════

/**
 * Subscribe to all online invoices in real time across dual collections.
 * Ideal for an admin dashboard order feed.
 *
 * @param {Function} onUpdate   Called with (orders: object[]) on every change
 * @param {Function} [onError]  Called with (error) on subscription failure
 * @param {object}   [options]
 * @param {string}   [companyId]
 * @returns {Function} Unsubscribe function — call this to stop listening
 */
export function subscribeToOnlineOrders(onUpdate, onError, options = {}, companyId = COMPANY_ID) {
  try {
    const ref1 = collection(db, 'invoices');
    const ref2 = collection(db, `companies/${companyId}/invoices`);
    const ref3 = collection(db, `companies/${companyId}/orders`);

    const docsMap1 = new Map();
    const docsMap2 = new Map();
    const docsMap3 = new Map();

    let notifyTimer = null;
    const combineAndNotify = () => {
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = setTimeout(() => {
        const ordersMap = new Map();

        // 1. All documents in companies/{companyId}/orders are orders by definition! Unconditionally included!
        docsMap3.forEach((val, id) => {
          ordersMap.set(id, { ...val, isFromCompanyOrders: true });
        });

        // 2. Merge from companies/{companyId}/invoices
        docsMap2.forEach((val, id) => {
          if (!ordersMap.has(id)) {
            ordersMap.set(id, val);
          } else {
            ordersMap.set(id, { ...val, ...ordersMap.get(id) });
          }
        });

        // 3. Merge from root invoices
        docsMap1.forEach((val, id) => {
          if (!ordersMap.has(id)) {
            ordersMap.set(id, val);
          } else {
            ordersMap.set(id, { ...val, ...ordersMap.get(id) });
          }
        });

        let orders = Array.from(ordersMap.values())
          .filter(d => {
            if (d.isFromCompanyOrders) return true;

            const orderType = String(d.orderType || '').toLowerCase().trim();
            const source = String(d.customerSource || d.source || '').toLowerCase().trim();
            const method = String(d.payment?.method || d.paymentMethod || '').toLowerCase().trim();

            const isOnlineOrder = (
              orderType === 'online' ||
              source === 'website' ||
              Boolean(d.razorpayPaymentId) ||
              Boolean(d.razorpayOrderId) ||
              Boolean(d.whatsappOrder) ||
              method.includes('razorpay') ||
              method.includes('online') ||
              method.includes('whatsapp') ||
              method.includes('cod') ||
              method.includes('cash on delivery')
            );

            return isOnlineOrder;
          })
          .sort((a, b) => getOrderTimestamp(b) - getOrderTimestamp(a));

        setCachedOrders(orders, companyId);
        console.info(`[TBC Ecom Admin] Streamed ${orders.length} e-commerce order(s) across collections.`);
        onUpdate(orders);
      }, 100);
    };

    const unsub1 = onSnapshot(ref1, (snapshot) => {
      docsMap1.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        const id = data.id || d.id;
        docsMap1.set(id, { id, ...data });
      });
      combineAndNotify();
    }, (err) => {
      console.warn('[TBC Ecom Admin] invoices ref1 notice:', err);
    });

    const unsub2 = onSnapshot(ref2, (snapshot) => {
      docsMap2.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        const id = data.id || d.id;
        docsMap2.set(id, { id, ...data });
      });
      combineAndNotify();
    }, (err) => {
      console.warn('[TBC Ecom Admin] comp invoices ref2 notice:', err);
    });

    const unsub3 = onSnapshot(ref3, (snapshot) => {
      docsMap3.clear();
      snapshot.docs.forEach(d => {
        const data = d.data();
        const id = data.id || d.id;
        docsMap3.set(id, { id, ...data });
      });
      combineAndNotify();
    }, (err) => {
      console.warn('[TBC Ecom Admin] comp orders ref3 notice:', err);
    });

    return () => {
      if (notifyTimer) clearTimeout(notifyTimer);
      try { unsub1(); } catch (_) {}
      try { unsub2(); } catch (_) {}
      try { unsub3(); } catch (_) {}
    };
  } catch (err) {
    console.error('[TBC Ecom Admin] subscribeToOnlineOrders exception:', err);
    return () => {};
  }
}

/**
 * Fetch online orders with read optimization and intelligent local caching.
 * If force is false and cache is fresh (< 30s), returns cached orders without Firestore reads.
 * Otherwise fetches latest orders from company orders subcollection and fallback collections.
 *
 * @param {string} [companyId]
 * @param {boolean} [force=false]
 * @returns {Promise<Array>}
 */
export async function fetchOnlineOrders(companyId = COMPANY_ID, force = false) {
  if (!force) {
    const info = getCachedOrdersInfo(companyId, 30000);
    if (info.isFresh && Array.isArray(info.orders) && info.orders.length > 0) {
      return info.orders;
    }
  }

  const ordersMap = new Map();

  // 1. Primary: companies/{companyId}/orders
  try {
    const ordCol = collection(db, `companies/${companyId}/orders`);
    const snap = await getDocs(ordCol);
    snap.docs.forEach(d => {
      const data = d.data();
      const id = data.id || d.id;
      ordersMap.set(id, { id, ...data, isFromCompanyOrders: true });
    });
  } catch (err) {
    console.warn('[TBC Orders] Fetch company orders notice:', err);
  }

  // 2. Secondary: companies/{companyId}/invoices
  try {
    const invCol = collection(db, `companies/${companyId}/invoices`);
    const invSnap = await getDocs(invCol);
    invSnap.docs.forEach(d => {
      const data = d.data();
      const id = data.id || d.id;
      if (!ordersMap.has(id)) {
        ordersMap.set(id, { id, ...data });
      }
    });
  } catch (err) {
    console.warn('[TBC Orders] Fetch company invoices notice:', err);
  }

  // 3. Fallback: root invoices (always merged if matching companyId)
  try {
    const rootCol = collection(db, 'invoices');
    const rootSnap = await getDocs(query(rootCol, limit(50)));
    rootSnap.docs.forEach(d => {
      const data = d.data();
      const id = data.id || d.id;
      if (!ordersMap.has(id)) {
        if (!data.companyId || data.companyId === companyId) {
          ordersMap.set(id, { id, ...data });
        }
      }
    });
  } catch (err) {
    console.warn('[TBC Orders] Fetch root invoices notice:', err);
  }

  const orders = Array.from(ordersMap.values())
    .filter(d => {
      if (d.isFromCompanyOrders) return true;
      const orderType = String(d.orderType || '').toLowerCase().trim();
      const source = String(d.customerSource || d.source || '').toLowerCase().trim();
      const method = String(d.payment?.method || d.paymentMethod || '').toLowerCase().trim();
      return (
        orderType === 'online' ||
        source === 'website' ||
        Boolean(d.razorpayPaymentId) ||
        Boolean(d.razorpayOrderId) ||
        Boolean(d.whatsappOrder) ||
        method.includes('razorpay') ||
        method.includes('online') ||
        method.includes('whatsapp') ||
        method.includes('cod') ||
        method.includes('cash on delivery')
      );
    })
    .sort((a, b) => getOrderTimestamp(b) - getOrderTimestamp(a));

  setCachedOrders(orders, companyId);
  return orders;
}

/**
 * Subscribe to a SINGLE invoice/order document in real time across locations.
 *
 * @param {string}   invoiceId
 * @param {Function} onUpdate  Called with the order object on every change
 * @param {Function} [onError]
 * @param {string}   [companyId]
 * @returns {Function} Unsubscribe function
 */
export function subscribeToInvoice(invoiceId, onUpdate, onError, companyId = COMPANY_ID) {
  if (!invoiceId) return () => {};

  const ref1 = doc(db, 'invoices', invoiceId);
  const ref2 = doc(db, `companies/${companyId}/invoices`, invoiceId);
  const ref3 = doc(db, `companies/${companyId}/orders`, invoiceId);

  let doc1 = null;
  let doc2 = null;
  let doc3 = null;

  const notify = () => {
    const active = doc1 || doc2 || doc3;
    if (active) {
      onUpdate(active);
    }
  };

  const unsub1 = onSnapshot(
    ref1,
    (snap) => {
      if (snap.exists()) {
        doc1 = { id: snap.id, ...snap.data() };
        notify();
      }
    },
    (err) => console.error(`[TBC] subscribeToInvoice(${invoiceId}) ref1 error:`, err)
  );

  const unsub2 = onSnapshot(
    ref2,
    (snap) => {
      if (snap.exists()) {
        doc2 = { id: snap.id, ...snap.data() };
        notify();
      }
    },
    (err) => console.warn(`[TBC] subscribeToInvoice(${invoiceId}) ref2 warning:`, err)
  );

  const unsub3 = onSnapshot(
    ref3,
    (snap) => {
      if (snap.exists()) {
        doc3 = { id: snap.id, ...snap.data() };
        notify();
      }
    },
    (err) => console.warn(`[TBC] subscribeToInvoice(${invoiceId}) ref3 warning:`, err)
  );

  return () => {
    unsub1();
    unsub2();
    unsub3();
  };
}


// ═══════════════════════════════════════════════════════════════
// 7.  ORDER STATUS STATE MACHINE  —  Dual Collection Updates
//     Advance status through the defined lifecycle on all stores.
// ═══════════════════════════════════════════════════════════════

/**
 * Advance an invoice to the next logical status in the lifecycle across all database collections.
 *
 * Flow: Awaiting Acceptance → Processing → Packed → Shipped → Out for Delivery → Delivered
 *
 * @param {string} invoiceId  Firestore document ID
 * @param {string} [companyId]
 * @returns {Promise<{ success: boolean, previousStatus: string, newStatus: string | null }>}
 */
export async function advanceOrderStatus(invoiceId, companyId = COMPANY_ID) {
  if (!invoiceId) return { success: false, error: 'No invoiceId provided.' };

  const rootRef = doc(db, 'invoices', invoiceId);
  const companyRef = doc(db, `companies/${companyId}/invoices`, invoiceId);
  const companyOrderRef = doc(db, `companies/${companyId}/orders`, invoiceId);

  try {
    let snap = await getDoc(rootRef);
    if (!snap.exists()) {
      snap = await getDoc(companyRef);
    }
    if (!snap.exists()) {
      snap = await getDoc(companyOrderRef);
    }
    if (!snap.exists()) throw new Error(`Invoice/Order ${invoiceId} not found.`);

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
    const updatePayload = {
      status:    newStatus,
      updatedAt: serverTimestamp(),
      [`statusHistory.${newStatus}`]: serverTimestamp(),
    };

    await Promise.allSettled([
      updateDoc(rootRef, updatePayload),
      updateDoc(companyRef, updatePayload),
      updateDoc(companyOrderRef, updatePayload)
    ]);

    console.info(`[TBC] Order ${invoiceId}: "${currentStatus}" → "${newStatus}" updated across collections`);
    return { success: true, previousStatus: currentStatus, newStatus };

  } catch (err) {
    console.error('[TBC] advanceOrderStatus error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Set an invoice/order to a specific status directly across all collections.
 *
 * @param {string} invoiceId
 * @param {string} status   Must be a value from ORDER_STATUS_FLOW or 'Cancelled' / 'Pending' / 'Paid'
 * @param {string} [companyId]
 * @returns {Promise<{ success: boolean }>}
 */
export async function setOrderStatus(invoiceId, status, companyId = COMPANY_ID) {
  const allowed = [
    ...ORDER_STATUS_FLOW,
    'Cancelled', 'Pending', 'Paid', 'Accepted', 'Processing', 'Packing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Returned'
  ];
  const isMatch = allowed.some(a => a.toLowerCase() === String(status).toLowerCase());
  if (!isMatch) {
    return { success: false, error: `Invalid status "${status}".` };
  }

  const updatePayload = {
    status,
    orderStatus: status,
    updatedAt: serverTimestamp(),
    [`statusHistory.${status}`]: serverTimestamp(),
  };

  const rootRef = doc(db, 'invoices', invoiceId);
  const companyRef = doc(db, `companies/${companyId}/invoices`, invoiceId);
  const companyOrderRef = doc(db, `companies/${companyId}/orders`, invoiceId);

  try {
    const results = await Promise.allSettled([
      updateDoc(companyOrderRef, updatePayload),
      updateDoc(companyRef, updatePayload),
      updateDoc(rootRef, updatePayload)
    ]);

    const isSuccess = results.some(r => r.status === 'fulfilled');
    if (isSuccess) {
      return { success: true };
    }

    // Fallback: merge if documents need setDoc
    await Promise.allSettled([
      setDoc(companyOrderRef, updatePayload, { merge: true }),
      setDoc(companyRef, updatePayload, { merge: true }),
      setDoc(rootRef, updatePayload, { merge: true })
    ]);
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

    const cachedName = typeof window !== 'undefined' ? (localStorage.getItem('onespace_shop_name') || 'THE BANIYAN COMPANY') : 'THE BANIYAN COMPANY';
    const name = raw.name || raw.companyName || raw.brandName || cachedName;
    const cachedLogo = typeof window !== 'undefined' ? (localStorage.getItem('onespace_shop_logo') || '') : '';
    const logo = raw.logo || raw.logoUrl || raw.imageUrl || raw.image || raw.icon || cachedLogo || 'assets/tbclogo.jpeg';
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
