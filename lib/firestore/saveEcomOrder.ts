import { db } from '../firebase-config';
import { doc, writeBatch, serverTimestamp } from 'firebase/firestore';

export interface EcomOrderItem {
  productId: string;
  name: string;
  size: string;
  color: string;
  qty: number;
  price: number;
  imageUrl?: string;
}

export interface EcomOrderInput {
  companyId: string;
  customerName: string;
  customerPhoneNumber: string;
  customerEmail?: string;
  customerAddress: string;
  customerCity?: string;
  customerState?: string;
  customerZip?: string;
  items: EcomOrderItem[];
  subtotal: number;
  discountAmount?: number;
  deliveryCharge?: number;
  shippingCharge?: number;
  totalAmount: number;
  paymentMethod: 'cod' | 'upi' | 'card' | 'razorpay' | 'whatsapp' | string;
  paymentStatus: 'PENDING' | 'PAID' | string;
  stockAdjusted?: boolean;
}

/**
 * Saves E-Commerce order directly into OneSpace Billing POS processing queue
 */
export async function saveEcomOrder(input: EcomOrderInput): Promise<string> {
  const orderId = `INV-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;
  const batch = writeBatch(db);

  const deliveryFee = input.deliveryCharge ?? input.shippingCharge ?? 0;

  const orderData = {
    id: orderId,
    companyId: input.companyId,
    branchId: 'online',
    branchName: 'Online Store',
    createdBy: 'ecom-checkout',
    customerName: input.customerName,
    customerPhoneNumber: input.customerPhoneNumber,
    customerEmail: input.customerEmail || '',
    customerAddress: input.customerAddress,
    customerCity: input.customerCity || '',
    customerState: input.customerState || '',
    customerZip: input.customerZip || '',
    customerSource: 'website',
    orderType: 'online',
    status: 'Awaiting Acceptance',
    items: input.items.map(item => ({
      productId: item.productId,
      name: item.name,
      size: String(item.size || 'M').toUpperCase(),
      color: item.color || 'Default',
      qty: Number(item.qty),
      price: Number(item.price),
      imageUrl: item.imageUrl || ''
    })),
    subtotal: input.subtotal,
    discountAmount: input.discountAmount || 0,
    deliveryCharge: deliveryFee,
    shippingCharge: deliveryFee,
    totalAmount: input.totalAmount,
    paymentMethod: input.paymentMethod,
    paymentStatus: input.paymentStatus,
    stockAdjusted: input.stockAdjusted !== undefined ? input.stockAdjusted : false,
    createdAt: serverTimestamp(),
  };

  // 1. Scoped Company Order Path (OneSpace Billing POS Primary)
  const companyOrderRef = doc(db, `companies/${input.companyId}/invoices`, orderId);
  batch.set(companyOrderRef, orderData);

  // 2. Global Invoices Path (Real-time POS Sound Pulse)
  const rootOrderRef = doc(db, 'invoices', orderId);
  batch.set(rootOrderRef, orderData);

  await batch.commit();
  return orderId;
}
