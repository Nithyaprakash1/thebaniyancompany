import { db } from './firebase-config';
import { collection, query, where, getDocs, doc, writeBatch, serverTimestamp } from 'firebase/firestore';

export interface ProductVariant {
  size: string;
  color: string;
  price: number;
  mrp?: number;
  cost?: number;
  stock: Record<string, number> | number;
}

export interface Product {
  id: string;
  productId: string;
  name: string;
  description?: string;
  category: string;
  gender?: string;
  material?: string;
  imageUrls: string[];
  tag?: string;
  discount?: number;
  showInEcom: boolean;
  variants: ProductVariant[];
  companyId: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface Category {
  id: string;
  name: string;
  companyId: string;
  imageUrl?: string;
  icon?: string;
  createdAt?: any;
}

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
 * Calculates total stock for a variant across all branches or raw number
 */
export function getVariantStock(stock: Record<string, number> | number | undefined | any): number {
  if (!stock) return 0;
  if (typeof stock === 'number') return Math.max(0, stock);
  if (typeof stock === 'string') {
    const n = Number(stock.replace(/[^0-9.-]+/g, ''));
    return !isNaN(n) ? Math.max(0, n) : 0;
  }
  if (typeof stock === 'object' && stock !== null && 'stock' in stock && stock.stock !== undefined) {
    return getVariantStock(stock.stock);
  }
  if (typeof stock === 'object' && stock !== null) {
    return Object.values(stock).reduce((acc: number, val: any) => {
      const num = typeof val === 'number' ? val : Number(String(val).replace(/[^0-9.-]+/g, ''));
      return acc + (!isNaN(num) && num > 0 ? num : 0);
    }, 0);
  }
  return 0;
}

/**
 * Fetches all products enabled for E-Commerce
 */
export async function getEcomProducts(companyId: string): Promise<Product[]> {
  const companyProductsRef = collection(db, `companies/${companyId}/products`);
  const q = query(companyProductsRef, where('showInEcom', '==', true));
  
  const snapshot = await getDocs(q);
  let products = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })) as Product[];

  if (products.length === 0) {
    const rootRef = collection(db, 'products');
    const q2 = query(rootRef, where('showInEcom', '==', true));
    const snapshot2 = await getDocs(q2);
    products = snapshot2.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
      .filter((p: any) => !p.companyId || p.companyId === companyId) as Product[];
  }

  return products;
}

/**
 * Fetches all categories for E-Commerce
 */
export async function getEcomCategories(companyId: string): Promise<Category[]> {
  const categoriesRef = collection(db, 'categories');
  const q = query(categoriesRef, where('companyId', '==', companyId));
  
  const snapshot = await getDocs(q);
  if (!snapshot.empty) {
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as Category[];
  }

  const allSnapshot = await getDocs(categoriesRef);
  return allSnapshot.docs
    .map(doc => ({
      id: doc.id,
      ...doc.data()
    }))
    .filter((c: any) => !c.companyId || c.companyId === companyId) as Category[];
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
