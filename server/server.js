const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const admin = require('firebase-admin');

dotenv.config();
const app = express();
const PORT = Number(process.env.PORT || 5000);
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '100kb' }));

function firebaseDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      let credentials;
      try { credentials = JSON.parse(raw); }
      catch { credentials = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
      credentials.private_key = credentials.private_key?.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(credentials) });
    } else {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    }
  }
  return admin.firestore();
}

function razorpayClient() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error('Razorpay server credentials are not configured.');
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

function sanitizeCustomer(customer = {}) {
  const fields = ['name', 'phone', 'email', 'address', 'landmark', 'city', 'state', 'pincode', 'doorNo', 'streetName'];
  const result = Object.fromEntries(fields.map(field => [field, String(customer[field] || '').trim()]));
  if (!result.name || !/^\d{10}$/.test(result.phone.replace(/\D/g, '')) || !result.address || !result.city || !result.state || !/^\d{6}$/.test(result.pincode)) {
    throw new Error('Please provide a valid name, phone number, and complete delivery address.');
  }
  result.phone = result.phone.replace(/\D/g, '').slice(-10);
  return result;
}

function makeOrderNumber() { return `TBC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }

async function resolveItems(transaction, requestedItems) {
  if (!Array.isArray(requestedItems) || !requestedItems.length || requestedItems.length > 25) throw new Error('Your cart is empty or invalid.');
  const lines = [];
  let subtotal = 0;
  for (const requested of requestedItems) {
    const productId = String(requested.productId || '');
    const quantity = Number(requested.quantity);
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 25) throw new Error('One or more cart quantities are invalid.');
    const ref = firebaseDb().collection('products').doc(productId);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error('A product in your bag is no longer available.');
    const product = snapshot.data();
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const index = variants.findIndex((variant, variantIndex) =>
      (requested.variantKey && (variant.id === requested.variantKey || `${variant.size || ''}::${variant.color || ''}::${variantIndex}` === requested.variantKey)) ||
      (!requested.variantKey && String(variant.size || '') === String(requested.size || '') && String(variant.color || '') === String(requested.color || ''))
    );
    if (index < 0) throw new Error(`${product.name || 'Selected product'} no longer has the selected variant.`);
    const variant = variants[index];
    const stock = Number(variant?.stock?.main || 0);
    if (stock < quantity) throw new Error(`${product.name || 'Selected product'} has insufficient stock.`);
    const unitPrice = Number(variant.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('A product price is invalid.');
    variants[index] = { ...variant, stock: { ...(variant.stock || {}), main: stock - quantity } };
    lines.push({
      ref, variants, item: {
        productId: snapshot.id,
        productName: String(product.name || ''),
        selectedVariant: { id: variant.id || null, size: variant.size || '', color: variant.color || '' },
        quantity, unitPrice, imageUrl: Array.isArray(product.imageUrls) ? product.imageUrls[0] || '' : ''
      }, companyId: product.companyId || null
    });
    subtotal += unitPrice * quantity;
  }
  return { lines, subtotal };
}

async function persistOrder({ customer, requestedItems, paymentMethod, paymentStatus, razorpay = {}, whatsappOrder = false }) {
  const db = firebaseDb();
  const cleanCustomer = sanitizeCustomer(customer);
  const orderId = makeOrderNumber();
  await db.runTransaction(async transaction => {
    const { lines, subtotal } = await resolveItems(transaction, requestedItems);
    const tax = Math.round(subtotal * 0.05);
    const totalAmount = subtotal + tax;
    const order = {
      orderId,
      customerName: cleanCustomer.name,
      customerPhone: cleanCustomer.phone,
      customerEmail: cleanCustomer.email || null,
      shippingAddress: cleanCustomer.address,
      landmark: cleanCustomer.landmark || null,
      city: cleanCustomer.city,
      state: cleanCustomer.state,
      pincode: cleanCustomer.pincode,
      companyId: lines.find(line => line.companyId)?.companyId || null,
      branchId: null,
      items: lines.map(line => line.item),
      subtotal, discount: 0, tax, shippingCharge: 0, totalAmount,
      paymentMethod, paymentStatus, orderStatus: 'Pending',
      razorpayOrderId: razorpay.orderId || null,
      razorpayPaymentId: razorpay.paymentId || null,
      razorpaySignature: razorpay.signature || null,
      whatsappOrder: Boolean(whatsappOrder), notes: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    lines.forEach(line => transaction.update(line.ref, { variants: line.variants, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
    transaction.set(db.collection('orders').doc(orderId), order);
  });
  return { orderId };
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/create-razorpay-order', async (req, res) => {
  try {
    const customer = sanitizeCustomer(req.body.customer);
    const db = firebaseDb();
    let calculated;
    await db.runTransaction(async transaction => { calculated = await resolveItems(transaction, req.body.items); });
    const tax = Math.round(calculated.subtotal * 0.05);
    const order = await razorpayClient().orders.create({
      amount: (calculated.subtotal + tax) * 100,
      currency: 'INR', receipt: makeOrderNumber(), notes: { customerPhone: customer.phone }
    });
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to create payment order.' }); }
});

app.post('/api/place-cod-order', async (req, res) => {
  try { res.status(201).json(await persistOrder({ ...req.body, paymentMethod: 'Cash on Delivery (COD)', paymentStatus: 'Pending' })); }
  catch (error) { res.status(400).json({ error: error.message || 'Unable to place order.' }); }
});

app.post('/api/place-whatsapp-order', async (req, res) => {
  try { res.status(201).json(await persistOrder({ ...req.body, paymentMethod: 'WhatsApp Order', paymentStatus: 'Pending', whatsappOrder: true })); }
  catch (error) { res.status(400).json({ error: error.message || 'Unable to place WhatsApp order.' }); }
});

app.post('/api/complete-razorpay-order', async (req, res) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;
    if (!orderId || !paymentId || !signature) throw new Error('Payment verification details are missing.');
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw new Error('Payment verification failed.');
    const saved = await persistOrder({ ...req.body, paymentMethod: 'Razorpay Online Payment', paymentStatus: 'Paid', razorpay: { orderId, paymentId, signature } });
    res.status(201).json(saved);
  } catch (error) { res.status(400).json({ error: error.message || 'Unable to complete payment.' }); }
});

app.listen(PORT, () => console.log(`Payment service running on port ${PORT}`));
