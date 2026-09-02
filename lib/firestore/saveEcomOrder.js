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

  // 4. Construct Unified Dual-Write Payload matching OneSpace POS Schema
  const payload = {
    id: orderId,
    companyId: targetCompanyId,
    branchId: orderData.branchId || 'online',
    branchName: orderData.branchName || 'Online Store',
    createdBy: orderData.createdBy || 'ecom-checkout',
    customerName: String(orderData.customerName || cd.name || 'Valued Customer').trim(),
    customerPhoneNumber: rawPhone,
    customerEmail: String(orderData.customerEmail || cd.email || '').trim(),
    customerAddress: String(orderData.customerAddress || cd.address || `${orderData.doorNo || cd.doorNo || ''}, ${orderData.streetName || cd.streetName || ''}`).trim(),
    customerCity: String(orderData.customerCity || orderData.city || cd.city || '').trim(),
    customerState: String(orderData.customerState || orderData.state || cd.state || '').trim(),
    customerZip: String(orderData.customerZip || orderData.pincode || cd.pincode || '').trim(),
    customerSource: orderData.customerSource || 'website',
    orderType: orderData.orderType || 'online',
    status: orderData.status || 'Awaiting Acceptance',
    items: Array.isArray(orderData.items) ? orderData.items.map(item => ({
      productId: item.productId || item.id || '',
      name: item.name || 'Apparel Item',
      size: String(item.size || 'M').toUpperCase(),
      color: item.color || 'Default',
      qty: Number(item.qty ?? item.quantity ?? 1),
      price: Number(item.price || 0),
      imageUrl: item.imageUrl || item.image || (Array.isArray(item.imageUrls) ? item.imageUrls[0] : '') || ''
    })) : [],
    subtotal: subtotal,
    discountAmount: discountAmount,
    deliveryCharge: deliveryCharge,
    shippingCharge: shippingCharge,
    totalAmount: totalAmount,
    paymentMethod: orderData.paymentMethod || 'cod',
    paymentStatus: orderData.paymentStatus || 'PENDING',
    stockAdjusted: orderData.stockAdjusted !== undefined ? Boolean(orderData.stockAdjusted) : false,
    createdAt: serverTimestamp()
  };

  // 5. Execute Atomic Write Batch
  if (!targetDb) {
    throw new Error("Firestore db instance missing. Pass db instance or use window.tbcDb.");
  }

  const batch = writeBatch(targetDb);
  
  const companyInvoiceRef = doc(targetDb, `companies/${targetCompanyId}/invoices`, orderId);
  const rootInvoiceRef = doc(targetDb, 'invoices', orderId);

  batch.set(companyInvoiceRef, payload);
  batch.set(rootInvoiceRef, payload);

  await batch.commit();

  return orderId;
}

