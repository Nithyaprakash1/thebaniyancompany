'use client';

import React, { useState, useEffect, useMemo, ChangeEvent, FormEvent } from 'react';
import {
  X,
  Plus,
  Trash2,
  Copy,
  UploadCloud,
  Sparkles,
  Layers,
  Image as ImageIcon,
  DollarSign,
  Building,
  Tag,
  Package,
  Check,
  RefreshCw,
  Info,
  Sliders,
  ExternalLink,
  Store
} from 'lucide-react';
import { doc, writeBatch, serverTimestamp, getFirestore } from 'firebase/firestore';

// ==========================================
// TYPES & INTERFACES (Conforms to Schema)
// ==========================================

export interface Branch {
  id: string;
  name: string;
}

export interface ProductVariant {
  size: string;
  color: string;
  colorHex?: string;
  mrp: number;
  price: number;
  cost: number;
  stock: Record<string, number>;
}

export interface ProductDocument {
  id: string;
  companyId: string;
  name: string;
  productId: string;
  category: string;
  supplierId: string;
  gender: 'Unisex' | 'Men' | 'Women' | 'Kids' | string;
  material: string;
  tag: string;
  showInEcom: boolean;
  imageUrls: string[];
  variants: ProductVariant[];
  createdAt?: any;
  updatedAt?: any;
}

export interface AddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (product: ProductDocument) => void;
  companyId?: string;
  firestoreDb?: any;
  branches?: Branch[];
  categories?: string[];
  suppliers?: { id: string; name: string }[];
}

// Preset color options
export const PRESET_COLORS = [
  { name: 'Black', hex: '#000000' },
  { name: 'White', hex: '#ffffff' },
  { name: 'Navy Blue', hex: '#1e3a8a' },
  { name: 'Royal Blue', hex: '#2563eb' },
  { name: 'Crimson Red', hex: '#dc2626' },
  { name: 'Olive Green', hex: '#4d7c0f' },
  { name: 'Charcoal', hex: '#374151' },
  { name: 'Beige', hex: '#d4b996' },
  { name: 'Pastel Pink', hex: '#f472b6' },
];

export const PRESET_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

export const PRESET_TAGS = ['Hot', 'New', 'Trending', 'Best Seller', 'Exclusive', 'Clearance'];

export const PRESET_MATERIALS = [
  '100% Combed Cotton 240 GSM',
  '100% Cotton Bio-Washed',
  'French Terry 260 GSM',
  'Polyester Blend',
  'Linen Fabric',
  'Rayon / Viscose',
  'Cotton Spandex Ribbed'
];

export default function AddProductModal({
  isOpen,
  onClose,
  onSuccess,
  companyId = 'thebaniyancompany',
  firestoreDb,
  branches = [
    { id: 'main', name: 'Main Store' },
    { id: 'branch_02', name: 'Branch 02' },
    { id: 'warehouse', name: 'Warehouse' },
  ],
  categories: initialCategories = ['T-Shirts', 'Pants & Cargo', 'Hoodies & Sweatshirts', 'Shorts', 'Jackets', 'Accessories'],
  suppliers: initialSuppliers = [
    { id: 'SUP-TEX-001', name: 'Vardhman Textiles' },
    { id: 'SUP-TEX-002', name: 'Tirupur Knitters Ltd' },
    { id: 'SUP-TEX-003', name: 'Aravind Dyeing & Spinning' },
  ],
}: AddProductModalProps) {
  // State: Basic Info
  const [name, setName] = useState('');
  const [productId, setProductId] = useState('');
  const [categoryList, setCategoryList] = useState<string[]>(initialCategories);
  const [category, setCategory] = useState(initialCategories[0] || 'T-Shirts');
  const [customCategoryInput, setCustomCategoryInput] = useState('');
  const [showAddCategoryModal, setShowAddCategoryModal] = useState(false);

  const [supplierList, setSupplierList] = useState(initialSuppliers);
  const [supplierId, setSupplierId] = useState(initialSuppliers[0]?.id || '');
  const [newSupplierName, setNewSupplierName] = useState('');
  const [showAddSupplierModal, setShowAddSupplierModal] = useState(false);

  const [gender, setGender] = useState<'Unisex' | 'Men' | 'Women' | 'Kids'>('Unisex');
  const [material, setMaterial] = useState(PRESET_MATERIALS[0]);
  const [tag, setTag] = useState('Trending');
  const [customTagInput, setCustomTagInput] = useState('');
  const [showInEcom, setShowInEcom] = useState(true);

  // State: Images
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [newImageUrl, setNewImageUrl] = useState('');

  // State: Attributes & Variants
  const [availableSizes, setAvailableSizes] = useState<string[]>(PRESET_SIZES);
  const [selectedSizes, setSelectedSizes] = useState<string[]>(['M', 'L']);
  const [customSizeInput, setCustomSizeInput] = useState('');

  const [availableColors, setAvailableColors] = useState<{ name: string; hex: string }[]>(PRESET_COLORS);
  const [selectedColors, setSelectedColors] = useState<{ name: string; hex: string }[]>([PRESET_COLORS[0]]);
  const [customColorName, setCustomColorName] = useState('');
  const [customColorHex, setCustomColorHex] = useState('#6366f1');

  // Variant Matrix
  const [variants, setVariants] = useState<ProductVariant[]>([]);

  // Bulk Apply state
  const [bulkMrp, setBulkMrp] = useState<string>('999');
  const [bulkPrice, setBulkPrice] = useState<string>('699');
  const [bulkCost, setBulkCost] = useState<string>('320');
  const [bulkStock, setBulkStock] = useState<Record<string, string>>({
    main: '20',
    branch_02: '10',
    warehouse: '30'
  });

  // UI status
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Auto-generate SKU
  const generateSku = () => {
    const prefix = name ? name.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() : 'TBC';
    const catCode = category ? category.slice(0, 3).toUpperCase() : 'PRD';
    const rand = Math.floor(100 + Math.random() * 900);
    const sku = `${prefix || 'TBC'}-${catCode}-${rand}`;
    setProductId(sku);
  };

  // Re-generate variants whenever selectedSizes or selectedColors change
  const regenerateVariantsFromSelections = () => {
    if (selectedSizes.length === 0 || selectedColors.length === 0) {
      setVariants([]);
      return;
    }

    const newVariants: ProductVariant[] = [];
    selectedSizes.forEach((size) => {
      selectedColors.forEach((colorObj) => {
        // Check if an existing variant already exists to keep its prices/stocks
        const existing = variants.find(
          (v) => v.size === size && v.color.toLowerCase() === colorObj.name.toLowerCase()
        );

        if (existing) {
          newVariants.push({ ...existing, colorHex: colorObj.hex });
        } else {
          // Initialize with current bulk defaults
          const stockObj: Record<string, number> = {};
          branches.forEach((b) => {
            stockObj[b.id] = parseInt(bulkStock[b.id] || '0', 10) || 0;
          });

          newVariants.push({
            size,
            color: colorObj.name,
            colorHex: colorObj.hex,
            mrp: parseFloat(bulkMrp) || 999,
            price: parseFloat(bulkPrice) || 699,
            cost: parseFloat(bulkCost) || 320,
            stock: stockObj,
          });
        }
      });
    });

    setVariants(newVariants);
  };

  // Auto-sync matrix when user clicks size or color chips
  useEffect(() => {
    regenerateVariantsFromSelections();
  }, [selectedSizes, selectedColors]);

  // Size toggler
  const toggleSize = (size: string) => {
    if (selectedSizes.includes(size)) {
      setSelectedSizes(selectedSizes.filter((s) => s !== size));
    } else {
      setSelectedSizes([...selectedSizes, size]);
    }
  };

  const handleAddCustomSize = () => {
    const trimmed = customSizeInput.trim().toUpperCase();
    if (!trimmed) return;
    if (!availableSizes.includes(trimmed)) {
      setAvailableSizes([...availableSizes, trimmed]);
    }
    if (!selectedSizes.includes(trimmed)) {
      setSelectedSizes([...selectedSizes, trimmed]);
    }
    setCustomSizeInput('');
  };

  // Color toggler
  const toggleColor = (colorObj: { name: string; hex: string }) => {
    const exists = selectedColors.some((c) => c.name.toLowerCase() === colorObj.name.toLowerCase());
    if (exists) {
      setSelectedColors(selectedColors.filter((c) => c.name.toLowerCase() !== colorObj.name.toLowerCase()));
    } else {
      setSelectedColors([...selectedColors, colorObj]);
    }
  };

  const handleAddCustomColor = () => {
    const trimmedName = customColorName.trim();
    if (!trimmedName) return;
    const newCol = { name: trimmedName, hex: customColorHex };
    if (!availableColors.some((c) => c.name.toLowerCase() === trimmedName.toLowerCase())) {
      setAvailableColors([...availableColors, newCol]);
    }
    if (!selectedColors.some((c) => c.name.toLowerCase() === trimmedName.toLowerCase())) {
      setSelectedColors([...selectedColors, newCol]);
    }
    setCustomColorName('');
  };

  // Image actions
  const handleAddImageUrl = () => {
    if (!newImageUrl.trim()) return;
    setImageUrls([...imageUrls, newImageUrl.trim()]);
    setNewImageUrl('');
  };

  const handleRemoveImage = (index: number) => {
    setImageUrls(imageUrls.filter((_, i) => i !== index));
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setImageUrls((prev) => [...prev, event.target!.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  // Bulk matrix updates
  const applyBulkPrices = () => {
    const m = parseFloat(bulkMrp) || 0;
    const p = parseFloat(bulkPrice) || 0;
    const c = parseFloat(bulkCost) || 0;
    setVariants((prev) =>
      prev.map((v) => ({
        ...v,
        mrp: m,
        price: p,
        cost: c,
      }))
    );
  };

  const applyBulkStock = () => {
    setVariants((prev) =>
      prev.map((v) => {
        const updatedStock = { ...v.stock };
        branches.forEach((b) => {
          if (bulkStock[b.id] !== undefined) {
            updatedStock[b.id] = parseInt(bulkStock[b.id], 10) || 0;
          }
        });
        return { ...v, stock: updatedStock };
      })
    );
  };

  const copyFirstRowToAll = () => {
    if (variants.length <= 1) return;
    const first = variants[0];
    setVariants((prev) =>
      prev.map((v, i) =>
        i === 0
          ? v
          : {
              ...v,
              mrp: first.mrp,
              price: first.price,
              cost: first.cost,
              stock: { ...first.stock },
            }
      )
    );
  };

  // Individual variant actions
  const updateVariantField = (
    index: number,
    field: 'mrp' | 'price' | 'cost',
    val: number
  ) => {
    setVariants((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: val };
      return updated;
    });
  };

  const updateVariantStock = (index: number, branchId: string, val: number) => {
    setVariants((prev) => {
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        stock: {
          ...updated[index].stock,
          [branchId]: val,
        },
      };
      return updated;
    });
  };

  const duplicateVariantRow = (index: number) => {
    const target = variants[index];
    const clone: ProductVariant = {
      ...target,
      size: `${target.size}-Copy`,
      stock: { ...target.stock },
    };
    setVariants((prev) => [...prev.slice(0, index + 1), clone, ...prev.slice(index + 1)]);
  };

  const deleteVariantRow = (index: number) => {
    setVariants((prev) => prev.filter((_, i) => i !== index));
  };

  // Total inventory calculation
  const totalStockCount = useMemo(() => {
    return variants.reduce((acc, v) => {
      const rowSum = Object.values(v.stock || {}).reduce((s, n) => s + (n || 0), 0);
      return acc + rowSum;
    }, 0);
  }, [variants]);

  // Handle Form Submission
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!name.trim()) {
      setFormError('Please enter a product name.');
      return;
    }

    const finalSku = productId.trim() || `TBC-${Date.now().toString().slice(-6)}`;

    if (variants.length === 0) {
      setFormError('Please configure at least one product variant (select size and color).');
      return;
    }

    setIsSubmitting(true);

    try {
      const finalTag = customTagInput.trim() || tag;

      const productPayload: ProductDocument = {
        id: finalSku,
        companyId,
        name: name.trim(),
        productId: finalSku,
        category,
        supplierId,
        gender,
        material,
        tag: finalTag,
        showInEcom,
        imageUrls: imageUrls.length > 0 ? imageUrls : ['https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800'],
        variants,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      // Dual-write to Firestore:
      // 1. /products/{productId} (Global Catalog)
      // 2. /companies/{companyId}/products/{productId} (Tenant Catalog)
      const db = firestoreDb || getFirestore();
      const batch = writeBatch(db);

      const globalRef = doc(db, 'products', finalSku);
      const tenantRef = doc(db, 'companies', companyId, 'products', finalSku);

      batch.set(globalRef, productPayload, { merge: true });
      batch.set(tenantRef, productPayload, { merge: true });

      await batch.commit();

      if (onSuccess) {
        onSuccess(productPayload);
      }

      onClose();
    } catch (err: any) {
      console.error('Error saving product to Firestore:', err);
      setFormError(err.message || 'Failed to save product. Check database permissions.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-900/60 backdrop-blur-sm overflow-hidden animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-4xl max-h-[92vh] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        {/* =========================================================
            FIXED TOP HEADER
        ========================================================= */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-600 text-white rounded-xl shadow-md shadow-indigo-100">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 tracking-tight">Add New Product</h2>
              <p className="text-xs text-slate-500">Configure catalog details, attributes, pricing & branch inventory</p>
            </div>
          </div>
          <button
            onClick={onClose}
            type="button"
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* =========================================================
            SCROLLABLE CONTENT BODY
        ========================================================= */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-8">
          {formError && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-xl flex items-center gap-2.5">
              <Info className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{formError}</span>
            </div>
          )}

          {/* =========================================================
              SECTION 1: BASIC PRODUCT INFORMATION & MEDIA
          ========================================================= */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
              <span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 text-xs font-bold flex items-center justify-center">1</span>
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700">Basic Information & Media</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Product Name */}
              <div className="space-y-1.5 md:col-span-2">
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1">
                  Product Title / Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Oversized Heavyweight Cotton T-Shirt"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                />
              </div>

              {/* SKU / Barcode ID */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 flex items-center justify-between">
                  <span>Product SKU / Barcode ID</span>
                  <button
                    type="button"
                    onClick={generateSku}
                    className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
                  >
                    <Sparkles className="w-3 h-3" /> Auto-generate
                  </button>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="e.g. TBC-TEE-001"
                    value={productId}
                    onChange={(e) => setProductId(e.target.value.toUpperCase())}
                    className="w-full px-3.5 py-2.5 font-mono text-sm uppercase bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                  />
                </div>
              </div>

              {/* Category */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-700">Category</label>
                  <button
                    type="button"
                    onClick={() => setShowAddCategoryModal(true)}
                    className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-0.5"
                  >
                    <Plus className="w-3 h-3" /> Add Category
                  </button>
                </div>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
                >
                  {categoryList.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>

              {/* Supplier */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-700">Supplier / Vendor</label>
                  <button
                    type="button"
                    onClick={() => setShowAddSupplierModal(true)}
                    className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-0.5"
                  >
                    <Plus className="w-3 h-3" /> Add Supplier
                  </button>
                </div>
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
                >
                  {supplierList.map((sup) => (
                    <option key={sup.id} value={sup.id}>{sup.name} ({sup.id})</option>
                  ))}
                </select>
              </div>

              {/* Gender */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">Target Audience</label>
                <select
                  value={gender}
                  onChange={(e: any) => setGender(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
                >
                  <option value="Unisex">Unisex</option>
                  <option value="Men">Men</option>
                  <option value="Women">Women</option>
                  <option value="Kids">Kids</option>
                </select>
              </div>

              {/* Fabric / Material */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">Fabric & Material Composition</label>
                <input
                  type="text"
                  list="material-suggestions"
                  placeholder="e.g. 100% Combed Cotton 240 GSM"
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
                />
                <datalist id="material-suggestions">
                  {PRESET_MATERIALS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>

              {/* E-Com Visibility Switch */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">Store Visibility</label>
                <div
                  onClick={() => setShowInEcom(!showInEcom)}
                  className={`flex items-center justify-between p-2.5 border rounded-xl cursor-pointer transition ${
                    showInEcom ? 'bg-emerald-50/60 border-emerald-300' : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Store className={`w-4 h-4 ${showInEcom ? 'text-emerald-600' : 'text-slate-400'}`} />
                    <span className="text-xs font-medium text-slate-800">Publish in E-Commerce Store</span>
                  </div>
                  <div className={`w-10 h-5 flex items-center rounded-full p-1 transition duration-300 ${
                    showInEcom ? 'bg-emerald-500 justify-end' : 'bg-slate-300 justify-start'
                  }`}>
                    <div className="w-3.5 h-3.5 rounded-full bg-white shadow-sm" />
                  </div>
                </div>
              </div>
            </div>

            {/* Badges / Tag Chips */}
            <div className="space-y-2 pt-2">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-slate-400" /> Highlight Badge Tag
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {PRESET_TAGS.map((t) => {
                  const isSelected = tag === t && !customTagInput;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        setTag(t);
                        setCustomTagInput('');
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                          : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
                <input
                  type="text"
                  placeholder="+ Custom tag..."
                  value={customTagInput}
                  onChange={(e) => setCustomTagInput(e.target.value)}
                  className="px-2.5 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg w-32 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>

            {/* Multi-Image Gallery & Uploader */}
            <div className="space-y-2 pt-2">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-slate-400" /> Product Images Gallery
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* File Dropzone */}
                <label className="border-2 border-dashed border-slate-200 hover:border-indigo-400 rounded-xl p-4 flex flex-col items-center justify-center text-center cursor-pointer bg-slate-50/50 hover:bg-indigo-50/30 transition group">
                  <UploadCloud className="w-6 h-6 text-slate-400 group-hover:text-indigo-600 mb-1 transition" />
                  <span className="text-xs font-medium text-slate-700">Click to upload local images</span>
                  <span className="text-[10px] text-slate-400">PNG, JPG, WebP up to 5MB</span>
                  <input
                    type="file"
                    multiple
                    accept="image/*"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>

                {/* URL Input */}
                <div className="flex flex-col justify-between p-3 border border-slate-200 rounded-xl bg-slate-50/50">
                  <div className="space-y-1">
                    <span className="text-xs font-medium text-slate-700">Add Image by Direct URL</span>
                    <p className="text-[10px] text-slate-400">Paste CDN or Unsplash image links</p>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <input
                      type="url"
                      placeholder="https://..."
                      value={newImageUrl}
                      onChange={(e) => setNewImageUrl(e.target.value)}
                      className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={handleAddImageUrl}
                      className="px-3 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg hover:bg-slate-700 transition"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>

              {/* Preview Cards */}
              {imageUrls.length > 0 && (
                <div className="flex flex-wrap gap-2.5 pt-2">
                  {imageUrls.map((url, idx) => (
                    <div
                      key={idx}
                      className="relative group w-20 h-20 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shadow-xs"
                    >
                      <img src={url} alt={`Preview ${idx}`} className="w-full h-full object-cover" />
                      {idx === 0 && (
                        <span className="absolute bottom-1 left-1 px-1 py-0.5 text-[9px] font-bold bg-indigo-600/90 text-white rounded">
                          Cover
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(idx)}
                        className="absolute top-1 right-1 p-1 rounded-md bg-rose-600/90 text-white opacity-0 group-hover:opacity-100 transition shadow"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* =========================================================
              SECTION 2: INTERACTIVE ATTRIBUTE SELECTORS
          ========================================================= */}
          <section className="space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
              <span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 text-xs font-bold flex items-center justify-center">2</span>
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700">Attribute Selectors & Combinations</h3>
            </div>

            {/* Size Chips */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-700">1. Select Available Sizes</label>
                <span className="text-[11px] text-slate-400">{selectedSizes.length} sizes selected</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {availableSizes.map((s) => {
                  const isChecked = selectedSizes.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => toggleSize(s)}
                      className={`min-w-10 px-3 py-1.5 text-xs font-semibold rounded-xl border transition ${
                        isChecked
                          ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {s}
                    </button>
                  );
                })}
                <div className="flex items-center gap-1.5 ml-1">
                  <input
                    type="text"
                    placeholder="Custom size..."
                    value={customSizeInput}
                    onChange={(e) => setCustomSizeInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddCustomSize();
                      }
                    }}
                    className="w-24 px-2.5 py-1 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomSize}
                    className="p-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Color Chips with Swatches */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-slate-700">2. Select Color Variations</label>
                <span className="text-[11px] text-slate-400">{selectedColors.length} colors selected</span>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                {availableColors.map((col) => {
                  const isChecked = selectedColors.some((c) => c.name.toLowerCase() === col.name.toLowerCase());
                  return (
                    <button
                      key={col.name}
                      type="button"
                      onClick={() => toggleColor(col)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium border transition ${
                        isChecked
                          ? 'bg-indigo-50/80 border-indigo-500 text-indigo-900 ring-1 ring-indigo-500 shadow-xs'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-black/10 shrink-0"
                        style={{ backgroundColor: col.hex }}
                      />
                      <span>{col.name}</span>
                      {isChecked && <Check className="w-3 h-3 text-indigo-600 ml-0.5" />}
                    </button>
                  );
                })}

                {/* Add Custom Color */}
                <div className="flex items-center gap-1.5 ml-2 p-1 bg-slate-50 border border-slate-200 rounded-xl">
                  <input
                    type="color"
                    value={customColorHex}
                    onChange={(e) => setCustomColorHex(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border-0 bg-transparent"
                  />
                  <input
                    type="text"
                    placeholder="Color Name"
                    value={customColorName}
                    onChange={(e) => setCustomColorName(e.target.value)}
                    className="w-24 px-2 py-0.5 text-xs bg-transparent border-0 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomColor}
                    className="p-1 rounded bg-slate-200 hover:bg-slate-300 text-slate-700"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* =========================================================
              SECTION 3: VARIANT MATRIX TABLE
          ========================================================= */}
          <section className="space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 text-xs font-bold flex items-center justify-center">3</span>
                <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700">Variant Matrix & Branch Inventory</h3>
              </div>
              <span className="text-xs font-medium px-2.5 py-1 bg-slate-100 text-slate-600 rounded-full">
                {variants.length} Matrix Combinations ({selectedSizes.length} sizes × {selectedColors.length} colors)
              </span>
            </div>

            {/* Bulk Actions Bar */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-indigo-600" /> Quick Bulk Apply
                </span>
                <button
                  type="button"
                  onClick={copyFirstRowToAll}
                  className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" /> Copy Row 1 to All
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 pt-1">
                {/* Bulk MRP */}
                <div className="flex items-center gap-1.5 bg-white px-2 py-1.5 rounded-lg border border-slate-200">
                  <span className="text-[11px] font-medium text-slate-500">MRP: ₹</span>
                  <input
                    type="number"
                    value={bulkMrp}
                    onChange={(e) => setBulkMrp(e.target.value)}
                    className="w-16 text-xs font-semibold focus:outline-none"
                  />
                </div>

                {/* Bulk Price */}
                <div className="flex items-center gap-1.5 bg-white px-2 py-1.5 rounded-lg border border-slate-200">
                  <span className="text-[11px] font-medium text-slate-500">Price: ₹</span>
                  <input
                    type="number"
                    value={bulkPrice}
                    onChange={(e) => setBulkPrice(e.target.value)}
                    className="w-16 text-xs font-semibold focus:outline-none"
                  />
                </div>

                {/* Bulk Cost */}
                <div className="flex items-center gap-1.5 bg-white px-2 py-1.5 rounded-lg border border-slate-200">
                  <span className="text-[11px] font-medium text-slate-500">Cost: ₹</span>
                  <input
                    type="number"
                    value={bulkCost}
                    onChange={(e) => setBulkCost(e.target.value)}
                    className="w-16 text-xs font-semibold focus:outline-none"
                  />
                </div>

                {/* Apply Prices Button */}
                <button
                  type="button"
                  onClick={applyBulkPrices}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg transition"
                >
                  Apply Prices to All
                </button>
              </div>

              {/* Bulk Branch Stocks */}
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-200/60">
                <span className="text-[11px] font-semibold text-slate-600 mr-1">Bulk Stock:</span>
                {branches.map((b) => (
                  <div key={b.id} className="flex items-center gap-1 bg-white px-2 py-1 rounded-lg border border-slate-200">
                    <span className="text-[10px] text-slate-500">{b.name}:</span>
                    <input
                      type="number"
                      value={bulkStock[b.id] || ''}
                      onChange={(e) =>
                        setBulkStock({ ...bulkStock, [b.id]: e.target.value })
                      }
                      className="w-12 text-xs font-semibold focus:outline-none"
                    />
                  </div>
                ))}
                <button
                  type="button"
                  onClick={applyBulkStock}
                  className="ml-auto px-3 py-1 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg transition"
                >
                  Apply Stock to All
                </button>
              </div>
            </div>

            {/* Matrix Table */}
            <div className="border border-slate-200 rounded-xl overflow-x-auto shadow-xs">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                    <th className="p-3">Variant</th>
                    <th className="p-3">MRP (₹)</th>
                    <th className="p-3">Price (₹)</th>
                    <th className="p-3">Cost (₹)</th>
                    {branches.map((b) => (
                      <th key={b.id} className="p-3">{b.name}</th>
                    ))}
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {variants.map((v, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/60 transition">
                      {/* Variant Badge */}
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-3.5 h-3.5 rounded-full border border-black/10 shrink-0"
                            style={{ backgroundColor: v.colorHex || '#000000' }}
                          />
                          <span className="font-bold text-slate-900">{v.size}</span>
                          <span className="text-slate-500">/ {v.color}</span>
                        </div>
                      </td>

                      {/* MRP */}
                      <td className="p-3">
                        <input
                          type="number"
                          value={v.mrp}
                          onChange={(e) =>
                            updateVariantField(idx, 'mrp', parseFloat(e.target.value) || 0)
                          }
                          className="w-20 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                      </td>

                      {/* Selling Price */}
                      <td className="p-3">
                        <input
                          type="number"
                          value={v.price}
                          onChange={(e) =>
                            updateVariantField(idx, 'price', parseFloat(e.target.value) || 0)
                          }
                          className="w-20 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-emerald-600 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                      </td>

                      {/* Cost */}
                      <td className="p-3">
                        <input
                          type="number"
                          value={v.cost}
                          onChange={(e) =>
                            updateVariantField(idx, 'cost', parseFloat(e.target.value) || 0)
                          }
                          className="w-20 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                      </td>

                      {/* Branch Stocks */}
                      {branches.map((b) => (
                        <td key={b.id} className="p-3">
                          <input
                            type="number"
                            value={v.stock[b.id] ?? 0}
                            onChange={(e) =>
                              updateVariantStock(idx, b.id, parseInt(e.target.value, 10) || 0)
                            }
                            className="w-16 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-800 focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        </td>
                      ))}

                      {/* Actions */}
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => duplicateVariantRow(idx)}
                            title="Duplicate Row"
                            className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteVariantRow(idx)}
                            title="Delete Variant"
                            className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {variants.length === 0 && (
                    <tr>
                      <td colSpan={5 + branches.length} className="p-8 text-center text-slate-400">
                        No variants selected. Choose sizes and colors above to generate the matrix.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Quick Category Modal */}
          {showAddCategoryModal && (
            <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
              <div className="bg-white p-5 rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm space-y-3">
                <h4 className="text-sm font-bold text-slate-900">Add Custom Category</h4>
                <input
                  type="text"
                  placeholder="e.g. Denim & Jeans"
                  value={customCategoryInput}
                  onChange={(e) => setCustomCategoryInput(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddCategoryModal(false)}
                    className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (customCategoryInput.trim()) {
                        const trimmed = customCategoryInput.trim();
                        setCategoryList([...categoryList, trimmed]);
                        setCategory(trimmed);
                        setCustomCategoryInput('');
                        setShowAddCategoryModal(false);
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                  >
                    Save Category
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Quick Supplier Modal */}
          {showAddSupplierModal && (
            <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs">
              <div className="bg-white p-5 rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm space-y-3">
                <h4 className="text-sm font-bold text-slate-900">Add New Supplier / Vendor</h4>
                <input
                  type="text"
                  placeholder="Supplier Company Name"
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddSupplierModal(false)}
                    className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (newSupplierName.trim()) {
                        const newSup = {
                          id: `SUP-${Date.now().toString().slice(-4)}`,
                          name: newSupplierName.trim(),
                        };
                        setSupplierList([...supplierList, newSup]);
                        setSupplierId(newSup.id);
                        setNewSupplierName('');
                        setShowAddSupplierModal(false);
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                  >
                    Save Supplier
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================
              FIXED STICKY BOTTOM FOOTER
          ========================================================= */}
          <div className="sticky -bottom-6 -mx-6 px-6 py-4 border-t border-slate-200 bg-white/95 backdrop-blur-sm flex items-center justify-between shrink-0 shadow-lg">
            <div className="flex items-center gap-3">
              <div className="text-xs text-slate-500">
                Total Variants: <strong className="text-slate-800">{variants.length}</strong>
              </div>
              <div className="w-1 h-1 rounded-full bg-slate-300" />
              <div className="text-xs text-slate-500">
                Total Initial Stock: <strong className="text-indigo-600">{totalStockCount} units</strong>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 rounded-xl border border-slate-200 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-xl shadow-md shadow-indigo-200 flex items-center gap-1.5 transition"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Saving Product...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" /> Save Product & Variants
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
