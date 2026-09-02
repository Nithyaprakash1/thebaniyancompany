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
 * Fetches all products enabled for E-Commerce (where showInEcom == true)
 * Path: companies/{companyId}/products (or global products collection where companyId == companyId)
 * @param {string} [companyId]
 * @returns {Promise<object[]>}
 */
export async function getEcomProducts(companyId = COMPANY_ID) {
  try {
    const targetCompanyId = companyId || COMPANY_ID;
    const companyProductsRef = collection(db, `companies/${targetCompanyId}/products`);
    const q1 = query(companyProductsRef, where('showInEcom', '==', true));
    const snapshot1 = await getDocs(q1);

    let products = snapshot1.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    if (products.length === 0) {
      const rootRef = collection(db, 'products');
      const q2 = query(rootRef, where('showInEcom', '==', true));
      const snapshot2 = await getDocs(q2);
      products = snapshot2.docs
        .map(doc => ({
          id: doc.id,
          ...doc.data()
        }))
        .filter(p => !p.companyId || p.companyId === targetCompanyId);
    }

    return products;
  } catch (err) {
    console.error('[TBC] getEcomProducts error:', err);
    return [];
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
// 3.  INVOICES (ORDERS) — CREATE  —  Dual Location (Subcollection & Root)
//     1. /companies/{companyId}/invoices/{orderId}
//     2. /invoices/{orderId}
// ═══════════════════════════════════════════════════════════════

/**
 * Create a new order document in BOTH company subcollection and root /invoices on checkout.
 * Guaranteed zero-failure schema with atomic stock reduction.
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

  // Derive explicit paymentStatus
  let paymentStatus = orderData.paymentStatus;
  if (!paymentStatus) {
    if (isOnlinePayment) {
      paymentStatus = 'Paid';
    } else {
      paymentStatus = 'Pending';
    }
  }

  // Resolve target companyId
  const companyId = orderData.companyId || COMPANY_ID;

  // Generate unique order ID if not already generated
  const orderId = orderData.id || orderData.orderId || orderData.invoiceId || `INV_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  // Sanitize customer contact
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

  // Financials
  const subtotal = Number(orderData.subtotal || 0);
  const deliveryFee = Number(orderData.deliveryFee || 0);
  const discountAmount = Number(orderData.discountAmount || 0);
  const cgstAmount = Number(orderData.cgstAmount || 0);
  const sgstAmount = Number(orderData.sgstAmount || 0);
  const totalAmount = Number(orderData.totalAmount || (subtotal + deliveryFee + cgstAmount + sgstAmount - discountAmount));

  // Sanitize Items array
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
      color: colorStr,
      size: sizeStr,
      price: priceNum,
      qty: qtyNum,
      quantity: qtyNum,
      originalPrice: origPrice,
      mrp: origPrice,
      variantKey: String(item.variantKey || `${sizeStr}::${colorStr}`).trim(),
      imageUrl: imgUrl
    };
  });

  const nowMs = Date.now();
  const rawPayload = {
    // ── Identity ──────────────────────────────────────────
    id:                  orderId,
    orderId:             orderId,
    invoiceId:           orderId,
    companyId:           companyId,
    branchId:            orderData.branchId || BRANCH_ID,
    orderType:           orderData.orderType || 'online',
    customerSource:      'website',
    source:              'website',

    // ── Status ────────────────────────────────────────────
    status:              orderData.status || 'Awaiting Acceptance',
    paymentStatus:       paymentStatus,
    paymentMethod:       methodRaw,

    // ── Customer ──────────────────────────────────────────
    customerName:        cleanName,
    customerPhoneNumber: cleanPhone,
    customerPhone:       cleanPhone,
    phone:               cleanPhone,
    customerEmail:       cleanEmail,
    email:               cleanEmail,
    customerAddress:     cleanAddress,
    address:             cleanAddress,
    doorNo:              cleanDoor,
    streetName:          cleanStreet,
    landmark:            cleanLandmark,
    city:                cleanCity,
    state:               cleanState,
    pincode:             cleanPincode,

    // ── Financials ────────────────────────────────────────
    subtotal:            subtotal,
    deliveryFee:         deliveryFee,
    shippingCharge:      deliveryFee,
    cgstAmount:          cgstAmount,
    sgstAmount:          sgstAmount,
    discountAmount:      discountAmount,
    totalAmount:         totalAmount,

    // ── Payment References ────────────────────────────────
    razorpayOrderId:     String(orderData.razorpayOrderId || '').trim() || null,
    razorpayPaymentId:   String(orderData.razorpayPaymentId || '').trim() || null,
    razorpaySignature:   String(orderData.razorpaySignature || '').trim() || null,
    whatsappOrder:       Boolean(isWhatsApp),

    // ── Items ─────────────────────────────────────────────
    items:               sanitizedItems,

    // ── Timestamps ────────────────────────────────────────
    timestamp:           nowMs,
    createdAt:           serverTimestamp(),
    updatedAt:           serverTimestamp(),
    orderDateStr:        new Date().toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    }),
  };

  const payload = cleanFirestoreDoc(rawPayload);

  // References for Dual-Location Persistence:
  // 1. Company subcollection: companies/${companyId}/invoices/${orderId}
  // 2. Root collection: invoices/${orderId}
  const companyInvoiceRef = doc(db, `companies/${companyId}/invoices`, orderId);
  const rootInvoiceRef = doc(db, 'invoices', orderId);

  let success = false;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const batch = writeBatch(db);
      batch.set(companyInvoiceRef, payload);
      batch.set(rootInvoiceRef, payload);
      await batch.commit();
      console.info(`[TBC] Order invoice successfully saved atomically via writeBatch in dual locations (attempt ${attempt}): ${orderId}`);
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

  // Automatically decrement product & variant stock atomically in Firestore
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
  const targetDb = dbInstance || db;
  const targetCompanyId = companyId || COMPANY_ID;
  
  const orderId = orderData.orderId || orderData.id || orderData.invoiceId || 
    `INV_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  const cd = orderData.customerDetails || {};
  const rawPhone = String(
    orderData.customerPhoneNumber || orderData.customerPhone || orderData.phone || cd.phone || ''
  ).trim();
  const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);

  const subtotal = Number(orderData.subtotal || 0);
  const deliveryFee = Number(orderData.deliveryFee || orderData.shippingCharge || 0);
  const discountAmount = Number(orderData.discountAmount || 0);
  const totalAmount = Number(orderData.totalAmount || (subtotal + deliveryFee - discountAmount));

  const payload = {
    id: orderId,
    orderId: orderId,
    invoiceId: orderId,
    companyId: targetCompanyId,
    branchId: orderData.branchId || 'online',
    orderType: 'online',
    customerSource: 'website',
    source: 'website',

    status: orderData.status || 'Awaiting Acceptance',
    paymentStatus: orderData.paymentStatus || (orderData.razorpayPaymentId ? 'Paid' : 'Pending'),
    paymentMethod: orderData.paymentMethod || 'Razorpay Online Payment',

    customerName: String(orderData.customerName || cd.name || 'Valued Customer').trim(),
    customerPhoneNumber: cleanPhone,
    customerPhone: cleanPhone,
    phone: cleanPhone,
    customerEmail: String(orderData.customerEmail || cd.email || '').trim(),
    email: String(orderData.customerEmail || cd.email || '').trim(),
    
    customerAddress: orderData.customerAddress || cd.address || `${orderData.doorNo || cd.doorNo || ''}, ${orderData.streetName || cd.streetName || ''}`.trim(),
    doorNo: orderData.doorNo || cd.doorNo || '',
    streetName: orderData.streetName || cd.streetName || '',
    landmark: orderData.landmark || cd.landmark || '',
    city: orderData.city || cd.city || 'Coimbatore',
    state: orderData.state || cd.state || 'Tamil Nadu',
    pincode: orderData.pincode || cd.pincode || '',

    subtotal: subtotal,
    deliveryFee: deliveryFee,
    shippingCharge: deliveryFee,
    discountAmount: discountAmount,
    cgstAmount: Number(orderData.cgstAmount || 0),
    sgstAmount: Number(orderData.sgstAmount || 0),
    totalAmount: totalAmount,

    razorpayOrderId: orderData.razorpayOrderId || null,
    razorpayPaymentId: orderData.razorpayPaymentId || null,
    razorpaySignature: orderData.razorpaySignature || null,
    whatsappOrder: Boolean(orderData.whatsappOrder),

    items: Array.isArray(orderData.items) ? orderData.items.map(item => ({
      productId: item.productId || item.id || '',
      name: item.name || 'Apparel Item',
      color: item.color || 'Default',
      size: String(item.size || 'M').toUpperCase(),
      price: Number(item.price || 0),
      qty: Number(item.qty || item.quantity || 1),
      quantity: Number(item.qty || item.quantity || 1),
      originalPrice: Number(item.originalPrice || item.mrp || item.price || 0),
      mrp: Number(item.mrp || item.originalPrice || item.price || 0),
      variantKey: item.variantKey || `${String(item.size || 'M').toUpperCase()}::${item.color || 'Default'}`,
      imageUrl: item.imageUrl || item.image || ''
    })) : [],

    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  const batch = writeBatch(targetDb);
  
  const companyInvoiceRef = doc(targetDb, `companies/${targetCompanyId}/invoices`, orderId);
  const rootInvoiceRef = doc(targetDb, 'invoices', orderId);

  batch.set(companyInvoiceRef, payload);
  batch.set(rootInvoiceRef, payload);

  await batch.commit();

  // Return string orderId, with attached compatibility properties if checked as an object
  const resStr = String(orderId);
  Object.defineProperties(resStr, {
    invoiceId: { value: orderId, enumerable: false },
    orderId: { value: orderId, enumerable: false },
    success: { value: true, enumerable: false }
  });

  return orderId;
}

// Alias kept for backwards compatibility with existing checkout.html
export const saveOrderToFirestore = saveEcomOrder;


// ═══════════════════════════════════════════════════════════════
// 4.  INVENTORY INTEGRITY  —  runTransaction
//     Atomically decrement stock[branchId] on a specific variant.
// ═══════════════════════════════════════════════════════════════

/**
 * Atomically decrement the stock of a specific product variant
 * in its branch-specific stock map using a Firestore transaction.
 *
 * @param {string} productId  Firestore document ID of the product
 * @param {string} variantKey Variant key (id or "size::color")
 * @param {number} qty        Quantity to decrement
 * @param {string} [branchId]
 * @param {string} [sizeParam]
 * @param {string} [colorParam]
 * @returns {Promise<{ success: boolean, newStock?: number, error?: string }>}
 */
export async function decrementVariantStock(productId, variantKey, qty = 1, branchId = BRANCH_ID, sizeParam = '', colorParam = '') {
  if (!productId) return { success: false, error: 'No productId provided.' };
  const productRef = doc(db, 'products', productId);

  try {
    await runTransaction(db, async (transaction) => {
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
            if (vSize === targetSize && (vColor === targetColor || !vColor || !targetColor)) return true;
          }
          if (targetSize && vSize === targetSize) return true;
          return false;
        });

        if (idx === -1) idx = 0; // Default to first variant if specific match not found

        const variant = { ...variants[idx] };

        if (typeof variant.stock === 'object' && variant.stock !== null) {
          const stockMap = { ...variant.stock };
          // Decrement all standard branch keys to keep POS & Online store strictly in sync
          const branchKeys = ['main', 'online', branchId, 'default', 'warehouse', 'store'];
          let decremented = false;

          branchKeys.forEach(k => {
            if (stockMap[k] !== undefined && stockMap[k] !== null) {
              stockMap[k] = Math.max(0, Number(stockMap[k] || 0) - qty);
              decremented = true;
            }
          });

          if (!decremented) {
            const firstVal = Number(Object.values(stockMap)[0] || 0);
            stockMap.main = Math.max(0, firstVal - qty);
            stockMap.online = Math.max(0, firstVal - qty);
          } else {
            if (stockMap.main !== undefined && stockMap.online === undefined) stockMap.online = stockMap.main;
            if (stockMap.online !== undefined && stockMap.main === undefined) stockMap.main = stockMap.online;
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
      }

      transaction.update(productRef, updates);
    });

    console.info(`[TBC] Stock successfully decremented for product ${productId}, qty ${qty}`);
    return { success: true };

  } catch (err) {
    console.error('[TBC] decrementVariantStock failed:', err.message);
    return { success: false, error: err.message };
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

    const snaps = await Promise.allSettled([
      getDocs(q1), getDocs(q2), getDocs(q3), getDocs(q4)
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
 * Real-time live listener for customer order updates across dual collections.
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

    const docsMap1 = new Map();
    const docsMap2 = new Map();

    const combineAndNotify = () => {
      if (!identifier) {
        onUpdate([]);
        return;
      }

      const cleanPhone = String(identifier).replace(/\D/g, '').slice(-10);
      const cleanEmail = String(identifier).toLowerCase().trim();

      const combinedMap = new Map([...docsMap1, ...docsMap2]);
      const allDocs = Array.from(combinedMap.values());

      const matched = allDocs.filter(doc => {
        const p1 = String(doc.customerPhoneNumber || '').replace(/\D/g, '').slice(-10);
        const p2 = String(doc.customerPhone || '').replace(/\D/g, '').slice(-10);
        const p3 = String(doc.customerDetails?.phone || doc.phone || '').replace(/\D/g, '').slice(-10);
        const e1 = String(doc.customerEmail || doc.customerDetails?.email || doc.email || '').toLowerCase().trim();

        if (cleanPhone && cleanPhone.length >= 7) {
          if (p1 === cleanPhone || p2 === cleanPhone || p3 === cleanPhone ||
              p1.includes(cleanPhone) || p2.includes(cleanPhone) || p3.includes(cleanPhone) || cleanPhone.includes(p1)) {
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

    return () => {
      unsub1();
      unsub2();
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

    const docsMap1 = new Map();
    const docsMap2 = new Map();

    const combineAndNotify = () => {
      const combinedMap = new Map([...docsMap1, ...docsMap2]);
      let orders = Array.from(combinedMap.values())
        .filter(d => {
          const orderType = String(d.orderType || '').toLowerCase().trim();
          const source = String(d.customerSource || d.source || '').toLowerCase().trim();
          const method = String(d.paymentMethod || '').toLowerCase().trim();

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

      console.info(`[TBC Ecom Admin] Streamed ${orders.length} e-commerce order bill(s) across dual collections.`);
      onUpdate(orders);
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
      console.error('[TBC Ecom Admin] subscribeToOnlineOrders ref1 error:', err);
      if (typeof onError === 'function') onError(err);
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
      console.warn('[TBC Ecom Admin] subscribeToOnlineOrders ref2 warning:', err);
    });

    return () => {
      unsub1();
      unsub2();
    };
  } catch (err) {
    console.error('[TBC Ecom Admin] subscribeToOnlineOrders exception:', err);
    return () => {};
  }
}

/**
 * Subscribe to a SINGLE invoice document in real time across dual locations.
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

  let doc1 = null;
  let doc2 = null;

  const notify = () => {
    const active = doc1 || doc2;
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

  return () => {
    unsub1();
    unsub2();
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

  try {
    let snap = await getDoc(rootRef);
    if (!snap.exists()) {
      snap = await getDoc(companyRef);
    }
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
    const updatePayload = {
      status:    newStatus,
      updatedAt: serverTimestamp(),
      [`statusHistory.${newStatus}`]: serverTimestamp(),
    };

    await Promise.allSettled([
      updateDoc(rootRef, updatePayload),
      updateDoc(companyRef, updatePayload)
    ]);

    console.info(`[TBC] Invoice ${invoiceId}: "${currentStatus}" → "${newStatus}" updated across collections`);
    return { success: true, previousStatus: currentStatus, newStatus };

  } catch (err) {
    console.error('[TBC] advanceOrderStatus error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Set an invoice to a specific status directly in dual collections.
 *
 * @param {string} invoiceId
 * @param {string} status   Must be a value from ORDER_STATUS_FLOW or 'Cancelled' / 'Pending' / 'Paid'
 * @param {string} [companyId]
 * @returns {Promise<{ success: boolean }>}
 */
export async function setOrderStatus(invoiceId, status, companyId = COMPANY_ID) {
  const allowed = [...ORDER_STATUS_FLOW, 'Cancelled', 'Pending', 'Paid'];
  if (!allowed.includes(status)) {
    return { success: false, error: `Invalid status "${status}".` };
  }

  const updatePayload = {
    status,
    updatedAt: serverTimestamp(),
    [`statusHistory.${status}`]: serverTimestamp(),
  };

  const rootRef = doc(db, 'invoices', invoiceId);
  const companyRef = doc(db, `companies/${companyId}/invoices`, invoiceId);

  try {
    const results = await Promise.allSettled([
      updateDoc(rootRef, updatePayload),
      updateDoc(companyRef, updatePayload)
    ]);

    const isSuccess = results.some(r => r.status === 'fulfilled');
    if (isSuccess) {
      return { success: true };
    }

    // Fallback: merge if documents need creation/merge
    await Promise.allSettled([
      setDoc(rootRef, updatePayload, { merge: true }),
      setDoc(companyRef, updatePayload, { merge: true })
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

    const name = raw.name || raw.companyName || raw.brandName || 'OneSpace Commerce';
    const logo = raw.logo || raw.logoUrl || raw.imageUrl || raw.image || raw.icon || 'assets/onespace-commerce-logo.png';
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
