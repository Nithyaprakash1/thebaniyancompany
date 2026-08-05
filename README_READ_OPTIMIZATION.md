# THE BANIYAN COMPANY — Firestore Read Operation Optimization Guide

This document outlines the current data access architecture, identifies remaining Firestore read call locations, and details the optimal zero-read caching strategy for maximum cost efficiency.

---

## 1. Overview of Current Data Flow & Caching

The application uses **Firebase v10 Modular SDK** via `js/products-service.js`.

To minimize read costs, three primary LocalStorage caches are maintained on the client:
- **`tbc_cache_products`**: Full normalized product catalog with variants and stock.
- **`tbc_cache_categories`**: Product category catalog.
- **`tbc_cache_company`**: Store profile, delivery configuration, and hero banner settings.

### How Caching Operates Currently
1. When `getProducts()`, `getCategories()`, or `getCompany()` is invoked by any storefront page (`home.html`, `shop.html`, `product-detail.html`, `cart.html`, `reels.html`), the service checks `localStorage`.
2. **Cache Hit**: If data exists in LocalStorage, it returns instantly with **0 Firestore Reads**.
3. **Cache Miss**: If LocalStorage is empty (first-time visitor or cleared cache), it fetches from Firestore (`getDocs(collection(db, "products"))`), normalizes the dataset, and caches it locally.

---

## 2. Inventory of All Read Operations in Codebase

| Page / Module | Collection | Read Function | Cache Key | Optimization Status |
| :--- | :--- | :--- | :--- | :--- |
| **`home.html`** | `/products`, `/categories`, `/companies` | `getProducts()`, `getCategories()`, `getCompany()` | `tbc_cache_*` | ✅ Cached (0 reads on repeat visits) |
| **`shop.html`** | `/products`, `/categories` | `getProducts()`, `getCategories()` | `tbc_cache_*` | ✅ Cached (0 reads on repeat visits) |
| **`product-detail.html`** | `/products` | `getProductById()`, `getRelatedProducts()` | `tbc_cache_products` | ✅ Reads from local array first |
| **`reels.html`** | `/products`, `/companies` | `getProducts()`, `getCompany()` | `tbc_cache_*` | ✅ Cached |
| **`admin.html`** | `/products`, `/categories`, `/invoices`, `/companies` | `onSnapshot()` / `getDocs()` | *Live Stream* | ⚡ Real-time (Admin monitoring requires live updates) |

---

## 3. Why Read Costs Can Still Accumulate

1. **Unregistered Visitors / Incognito Tabs**: Every new browser session without existing `localStorage` triggers 1 query read per collection (`products`, `categories`, `company`).
2. **Missing IndexedDB Offline Persistence**: Without Firebase SDK native offline persistence (`enableMultiTabIndexedDbPersistence`), individual document lookups or cache invalidations force network fetches.
3. **Admin Real-Time Subscriptions**: Opening `admin.html` activates `onSnapshot` listeners on `/invoices` and `/products`, which count as 1 read per document in the query set upon initialization.
4. **Frequent Cache Invalidation**: When products are updated in `admin.html`, calling `clearTbcCache()` flushes client LocalStorage, causing the next visit to re-fetch catalog data.

---

## 4. The Optimal Path for Minimum Read Costs

Feed the recommendations below to your AI assistant to implement full 0-cost read optimizations:

### Recommendation A: Enable Native Firestore IndexedDB Offline Persistence
In `js/firebase-config.js`, enable multi-tab persistent cache so Firestore automatically serves all repeated queries from IndexedDB without network requests:

```javascript
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
```

### Recommendation B: Cache Invalidation via Version / Revision Timestamp
Instead of fetching all documents on every miss, fetch a lightweight single metadata document `/companies/thebaniyancompany`:
- Check `company.catalogVersion`.
- If `catalogVersion` matches `localStorage.getItem('tbc_catalog_version')`, use local cached products.
- If `catalogVersion` has changed (e.g. admin edited a product), fetch updated catalog documents and update `localStorage`.

### Recommendation C: Admin Query Scoping & Pagination
In `admin.html`, limit initial invoice streams to recent orders (`limit(50)`):
```javascript
const invoicesQuery = query(
  collection(db, 'invoices'),
  orderBy('createdAt', 'desc'),
  limit(50)
);
```

---

## 5. Summary & Checklist for AI Optimization

- [x] Auto-redirect `index.html` to `home.html` (instant load without rendering overhead).
- [x] Shared LocalStorage catalog cache implemented across storefront pages.
- [ ] Enforce Firestore SDK `persistentLocalCache` in `js/firebase-config.js`.
- [ ] Implement `catalogVersion` timestamp check for smart background revalidation.
