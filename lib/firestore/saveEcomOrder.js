import { doc, writeBatch, serverTimestamp } from 'firebase/firestore';

/**
 * Save E-Commerce Order into Dual Firestore Locations atomically using writeBatch:
 * 1. Subcollection: companies/{companyId}/invoices/{orderId}
 * 2. Root Collection: invoices/{orderId}
 *
 * @param {object|import('firebase/firestore').Firestore} arg1 EcomOrderInput object OR db instance
 * @param {string} [arg2] companyId or orderData
 * @param {object} [arg3] orderData
 * @returns {Promise<string>} orderId
 */
export async function saveEcomOrder(arg1, arg2, arg3) {
  let targetDb = null;
  let targetCompanyId = 'thebaniyancompany';
  let orderData = {};

  // Case 1: saveEcomOrder(input) - single EcomOrderInput object argument
  if (arg1 && typeof arg1 === 'object' && !arg1.getDocs && !arg1.type && (arg1.companyId || arg1.customerName || arg1.items)) {
    orderData = arg1;
    targetCompanyId = arg1.companyId || 'thebaniyancompany';
  }
  // Case 2: saveEcomOrder(db, companyId, orderData)
  else if (arg1 && typeof arg1 === 'object' && (arg1.type === 'firestore' || arg1._delegate || typeof arg1.app === 'object')) {
    targetDb = arg1;
    targetCompanyId = typeof arg2 === 'string' ? arg2 : (arg2?.companyId || 'thebaniyancompany');
    orderData = arg3 || arg2 || {};
  }
  // Case 3: saveEcomOrder(companyId, orderData)
  else if (typeof arg1 === 'string') {
    targetCompanyId = arg1;
    orderData = arg2 || {};
  }
  // Fallback
  else {
    orderData = arg1 || {};
    targetCompanyId = orderData.companyId || 'thebaniyancompany';
  }

  // 1. Generate Unique Order ID (Format: INV-1725283200000-492)
  const orderId = orderData.id || orderData.orderId || orderData.invoiceId || 
    `INV-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

  // 2. Sanitize Customer Details
  const cd = orderData.customerDetails || {};
  const rawPhone = String(
    orderData.customerPhoneNumber || orderData.customerPhone || orderData.phone || cd.phone || ''
  ).trim();

  // 3. Financial Breakdown
  const subtotal = Number(orderData.subtotal || 0);
  const deliveryCharge = Number(orderData.deliveryCharge ?? orderData.deliveryFee ?? orderData.shippingCharge ?? 0);
  const shippingCharge = Number(orderData.shippingCharge ?? orderData.deliveryCharge ?? orderData.deliveryFee ?? 0);
  const discountAmount = Number(orderData.discountAmount || 0);
  const totalAmount = Number(orderData.totalAmount ?? (subtotal + deliveryCharge - discountAmount));

  const cleanName = String(orderData.customerName || cd.name || 'Valued Customer').trim();
  const cleanEmail = String(orderData.customerEmail || cd.email || '').trim();
  const addressLine1 = String(orderData.customerAddress || cd.address || `${orderData.doorNo || cd.doorNo || ''}, ${orderData.streetName || cd.streetName || ''}`).trim();
  const city = String(orderData.customerCity || orderData.city || cd.city || '').trim();
  const state = String(orderData.customerState || orderData.state || cd.state || '').trim();
  const pincode = String(orderData.customerZip || orderData.pincode || cd.pincode || '').trim();
  const paymentMethod = orderData.paymentMethod || 'COD';
  const paymentStatus = orderData.paymentStatus || 'Pending';
  const orderStatus = orderData.orderStatus || orderData.status || 'pending';

  // 4. Construct Unified Multi-Tenant Payload
  const sanitizedItems = Array.isArray(orderData.items) ? orderData.items.map(item => {
    const qty = Number(item.qty ?? item.quantity ?? 1);
    const price = Number(item.price || 0);
    const size = String(item.size || 'M').toUpperCase();
    const color = item.color || 'Default';
    const imgUrl = item.imageUrl || item.image || (Array.isArray(item.imageUrls) ? item.imageUrls[0] : '') || '';

    return {
      productId: item.productId || item.id || '',
      name: item.name || 'Apparel Item',
      image: imgUrl,
      price: price,
      quantity: qty,
      variant: item.variant || item.variantKey || `${size}::${color}`,
      subtotal: price * qty,
      // Compatibility keys:
      size: size,
      color: color,
      qty: qty,
      imageUrl: imgUrl
    };
  }) : [];

  const payload = {
    // ── Scalable Multi-Tenant Order Schema ────────────────
    orderId: orderId,
    companyId: targetCompanyId,

    customer: {
      customerId: orderData.customerId || cd.customerId || rawPhone || 'guest',
      name: cleanName,
      phone: rawPhone,
      email: cleanEmail
    },

    items: sanitizedItems,

    pricing: {
      subtotal: subtotal,
      discount: discountAmount,
      deliveryCharge: deliveryCharge,
      tax: Number(orderData.tax || 0),
      total: totalAmount
    },

    payment: {
      method: paymentMethod,
      status: paymentStatus
    },

    shippingAddress: {
      name: cleanName,
      phone: rawPhone,
      addressLine1: addressLine1,
      addressLine2: orderData.landmark || cd.landmark || '',
      city: city,
      state: state,
      pincode: pincode
    },

    orderStatus: orderStatus,

    // ── Flat Accessors for Full UI/Admin Backwards-Compatibility ──
    id: orderId,
    invoiceId: orderId,
    branchId: orderData.branchId || 'online',
    branchName: orderData.branchName || 'Online Store',
    createdBy: orderData.createdBy || 'ecom-checkout',
    customerName: cleanName,
    customerPhoneNumber: rawPhone,
    customerPhone: rawPhone,
    phone: rawPhone,
    customerEmail: cleanEmail,
    email: cleanEmail,
    customerAddress: addressLine1,
    address: addressLine1,
    customerCity: city,
    city: city,
    customerState: state,
    state: state,
    customerZip: pincode,
    pincode: pincode,
    customerSource: orderData.customerSource || 'website',
    orderType: orderData.orderType || 'online',
    status: orderData.status || orderStatus,
    subtotal: subtotal,
    discountAmount: discountAmount,
    deliveryCharge: deliveryCharge,
    shippingCharge: shippingCharge,
    totalAmount: totalAmount,
    paymentMethod: paymentMethod,
    paymentStatus: paymentStatus,
    stockAdjusted: orderData.stockAdjusted !== undefined ? Boolean(orderData.stockAdjusted) : false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  // 5. Execute Atomic Write Batch
  if (!targetDb) {
    throw new Error("Firestore db instance missing. Pass db instance or use window.tbcDb.");
  }

  const batch = writeBatch(targetDb);
  
  const companyOrderRef = doc(targetDb, `companies/${targetCompanyId}/orders`, orderId);
  const companyInvoiceRef = doc(targetDb, `companies/${targetCompanyId}/invoices`, orderId);
  const rootInvoiceRef = doc(targetDb, 'invoices', orderId);

  batch.set(companyOrderRef, payload);
  batch.set(companyInvoiceRef, payload);
  batch.set(rootInvoiceRef, payload);

  await batch.commit();

  // Update local browser cache if running client-side
  try {
    if (typeof localStorage !== 'undefined') {
      const key = `tbc_cache_orders_${targetCompanyId}`;
      const raw = localStorage.getItem(key);
      let list = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
        } catch(_) {}
      }
      list = list.filter(o => o.id !== orderId);
      list.unshift({ id: orderId, ...payload });
      localStorage.setItem(key, JSON.stringify({ time: Date.now(), data: list.slice(0, 250) }));
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('tbc_orders_updated', { detail: { count: list.length, companyId: targetCompanyId } }));
      }
    }
  } catch (e) {}

  return {
    success: true,
    orderId: orderId,
    invoiceId: orderId,
    id: orderId,
    toString() { return orderId; }
  };
}

