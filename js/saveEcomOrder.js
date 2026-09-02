import { doc, writeBatch, serverTimestamp } from './firebase-config.js';

/**
 * Save E-Commerce Order into Dual Firestore Locations atomically using writeBatch:
 * 1. Subcollection: companies/{companyId}/invoices/{orderId}
 * 2. Root Collection: invoices/{orderId}
 *
 * @param {import('firebase/firestore').Firestore} db
 * @param {string} [companyId]
 * @param {object} [orderData]
 * @returns {Promise<string>} orderId
 */
export async function saveEcomOrder(db, companyId, orderData = {}) {
  const targetCompanyId = companyId || 'thebaniyancompany';
  
  // 1. Generate Unique Order ID if not provided
  const orderId = orderData.orderId || orderData.id || orderData.invoiceId || 
    `INV_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  // 2. Sanitize Customer Details
  const cd = orderData.customerDetails || {};
  const rawPhone = String(
    orderData.customerPhoneNumber || orderData.customerPhone || orderData.phone || cd.phone || ''
  ).trim();
  const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);

  // 3. Calculate Financial Totals
  const subtotal = Number(orderData.subtotal || 0);
  const deliveryFee = Number(orderData.deliveryFee || orderData.shippingCharge || 0);
  const discountAmount = Number(orderData.discountAmount || 0);
  const totalAmount = Number(orderData.totalAmount || (subtotal + deliveryFee - discountAmount));

  // 4. Construct Unified Payload
  const payload = {
    // Identifiers
    id: orderId,
    orderId: orderId,
    invoiceId: orderId,
    companyId: targetCompanyId,
    branchId: orderData.branchId || 'online',
    orderType: 'online',
    customerSource: 'website',
    source: 'website',

    // Status & Payment
    status: orderData.status || 'Awaiting Acceptance',
    paymentStatus: orderData.paymentStatus || (orderData.razorpayPaymentId ? 'Paid' : 'Pending'),
    paymentMethod: orderData.paymentMethod || 'Razorpay Online Payment',

    // Customer Information
    customerName: String(orderData.customerName || cd.name || 'Valued Customer').trim(),
    customerPhoneNumber: cleanPhone,
    customerPhone: cleanPhone,
    phone: cleanPhone,
    customerEmail: String(orderData.customerEmail || cd.email || '').trim(),
    email: String(orderData.customerEmail || cd.email || '').trim(),
    
    // Delivery Address
    customerAddress: orderData.customerAddress || cd.address || `${orderData.doorNo || cd.doorNo || ''}, ${orderData.streetName || cd.streetName || ''}`.trim(),
    doorNo: orderData.doorNo || cd.doorNo || '',
    streetName: orderData.streetName || cd.streetName || '',
    landmark: orderData.landmark || cd.landmark || '',
    city: orderData.city || cd.city || 'Coimbatore',
    state: orderData.state || cd.state || 'Tamil Nadu',
    pincode: orderData.pincode || cd.pincode || '',

    // Financial Breakdown
    subtotal: subtotal,
    deliveryFee: deliveryFee,
    shippingCharge: deliveryFee,
    discountAmount: discountAmount,
    cgstAmount: Number(orderData.cgstAmount || 0),
    sgstAmount: Number(orderData.sgstAmount || 0),
    totalAmount: totalAmount,

    // Payment References
    razorpayOrderId: orderData.razorpayOrderId || null,
    razorpayPaymentId: orderData.razorpayPaymentId || null,
    razorpaySignature: orderData.razorpaySignature || null,
    whatsappOrder: Boolean(orderData.whatsappOrder),

    // Items List
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

    // Timestamps
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  // 5. Execute Atomic Write Batch
  const batch = writeBatch(db);
  
  const companyInvoiceRef = doc(db, `companies/${targetCompanyId}/invoices`, orderId);
  const rootInvoiceRef = doc(db, 'invoices', orderId);

  batch.set(companyInvoiceRef, payload);
  batch.set(rootInvoiceRef, payload);

  await batch.commit();

  return orderId;
}
