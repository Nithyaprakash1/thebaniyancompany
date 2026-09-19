/**
 * THE BANIYAN COMPANY — Client-Side Image Optimizer & Firebase Storage Upload Module
 * Converts JPG, JPEG, PNG, WEBP, etc. to WebP format in browser.
 * Generates Dual-Resolution WebP images:
 * - Thumbnail: Max 300 x 300 px, WebP quality 0.78
 * - Medium: Max 1000 x 1000 px, WebP quality 0.82
 * Preserves exact aspect ratio without stretching.
 */

import { storage, ref, uploadBytesResumable, getDownloadURL } from './firebase-config.js';

export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Scale dimensions preserving exact aspect ratio within max box bounds
 */
function getScaledDimensions(origWidth, origHeight, maxWidth, maxHeight) {
  let width = origWidth;
  let height = origHeight;

  if (width > maxWidth || height > maxHeight) {
    const widthRatio = maxWidth / origWidth;
    const heightRatio = maxHeight / origHeight;
    const scale = Math.min(widthRatio, heightRatio);

    width = Math.round(origWidth * scale);
    height = Math.round(origHeight * scale);
  }

  return { width, height };
}

/**
 * Render image onto HTML5 canvas and export as WebP Blob
 */
function renderCanvasToBlob(img, width, height, quality) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Fill white background for transparent PNGs converted to WebP
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);

      ctx.drawImage(img, 0, 0, width, height);

      // Export canvas to WebP Blob (fallback to JPEG if webp not supported by very old browser)
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            // Fallback
            canvas.toBlob((jpgBlob) => {
              if (jpgBlob) resolve(jpgBlob);
              else reject(new Error('Canvas image compression failed.'));
            }, 'image/jpeg', quality);
          }
        },
        'image/webp',
        quality
      );
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Process a File client-side to generate Thumbnail & Medium WebP blobs
 * @param {File} file
 * @returns {Promise<{ originalSize: number, mediumBlob: Blob, mediumSize: number, thumbBlob: Blob, thumbSize: number, width: number, height: number, savingsPct: number }>}
 */
export async function optimizeImage(file) {
  if (!file) throw new Error('No file provided.');
  if (!file.type || !file.type.startsWith('image/')) {
    throw new Error(`File "${file.name}" is not a supported image format.`);
  }

  // Max 15MB raw input guard
  const MAX_RAW_SIZE = 15 * 1024 * 1024;
  if (file.size > MAX_RAW_SIZE) {
    throw new Error(`File "${file.name}" exceeds the maximum 15MB file size limit.`);
  }

  const originalSize = file.size;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read file "${file.name}".`));
    reader.onload = async (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error(`File "${file.name}" appears to be corrupt or unreadable.`));
      img.onload = async () => {
        try {
          const origW = img.width || img.naturalWidth;
          const origH = img.height || img.naturalHeight;

          if (!origW || !origH) {
            throw new Error(`Invalid image dimensions for file "${file.name}".`);
          }

          // 1. Medium Image (Max 1000 x 1000, WebP, Quality 0.82)
          const mediumDim = getScaledDimensions(origW, origH, 1000, 1000);
          const mediumBlob = await renderCanvasToBlob(img, mediumDim.width, mediumDim.height, 0.82);

          // 2. Thumbnail (Max 300 x 300, WebP, Quality 0.78)
          const thumbDim = getScaledDimensions(origW, origH, 300, 300);
          const thumbBlob = await renderCanvasToBlob(img, thumbDim.width, thumbDim.height, 0.78);

          const mediumSize = mediumBlob.size;
          const thumbSize = thumbBlob.size;
          const totalOptimizedSize = mediumSize + thumbSize;
          const savedBytes = Math.max(0, originalSize - mediumSize);
          const savingsPct = originalSize > 0 ? Math.round((savedBytes / originalSize) * 100) : 0;

          resolve({
            file,
            name: file.name,
            originalSize,
            mediumBlob,
            mediumSize,
            thumbBlob,
            thumbSize,
            width: origW,
            height: origH,
            savingsPct
          });
        } catch (err) {
          reject(err);
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Upload client-optimized image blobs to Firebase Storage
 * @param {File|object} input File or pre-optimized image object
 * @param {string} [productId] Product ID or prefix
 * @param {number} [index] Index in multi-image sequence
 * @param {Function} [onProgress] Callback for upload percentage updates
 * @returns {Promise<{ mediumUrl: string, thumbUrl: string, originalSize: number, mediumSize: number, thumbSize: number, savingsPct: number }>}
 */
export async function uploadOptimizedProductImages(input, productId = 'prod', index = 0, onProgress = () => {}) {
  let opt = input;
  if (input instanceof File) {
    onProgress(10, 'Compressing & converting to WebP...');
    opt = await optimizeImage(input);
  }

  const timestamp = Date.now();
  const cleanId = String(productId).replace(/[^a-zA-Z0-9_-]/g, '') || 'product';
  const mediumPath = `products/${cleanId}/medium_${timestamp}_${index}.webp`;
  const thumbPath = `products/${cleanId}/thumb_${timestamp}_${index}.webp`;

  onProgress(25, 'Uploading Medium WebP to Firebase Storage...');

  const mediumRef = ref(storage, mediumPath);
  const thumbRef = ref(storage, thumbPath);

  // Upload Medium WebP
  const mediumUploadTask = uploadBytesResumable(mediumRef, opt.mediumBlob, {
    contentType: 'image/webp',
    customMetadata: { originalName: opt.name || 'image', type: 'medium' }
  });

  const mediumUrl = await new Promise((resolve, reject) => {
    mediumUploadTask.on(
      'state_changed',
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 50) + 25;
        onProgress(pct, `Uploading Medium WebP... ${pct}%`);
      },
      (err) => reject(new Error(`Firebase Storage Upload Error (Medium): ${err.message}`)),
      async () => {
        const url = await getDownloadURL(mediumUploadTask.snapshot.ref);
        resolve(url);
      }
    );
  });

  onProgress(75, 'Uploading Thumbnail WebP...');

  // Upload Thumbnail WebP
  const thumbUploadTask = uploadBytesResumable(thumbRef, opt.thumbBlob, {
    contentType: 'image/webp',
    customMetadata: { originalName: opt.name || 'image', type: 'thumb' }
  });

  const thumbUrl = await new Promise((resolve, reject) => {
    thumbUploadTask.on(
      'state_changed',
      (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 20) + 75;
        onProgress(pct, `Uploading Thumbnail... ${pct}%`);
      },
      (err) => reject(new Error(`Firebase Storage Upload Error (Thumbnail): ${err.message}`)),
      async () => {
        const url = await getDownloadURL(thumbUploadTask.snapshot.ref);
        resolve(url);
      }
    );
  });

  onProgress(100, 'Upload complete!');

  return {
    mediumUrl,
    thumbUrl,
    originalSize: opt.originalSize,
    mediumSize: opt.mediumSize,
    thumbSize: opt.thumbSize,
    savingsPct: opt.savingsPct
  };
}

// Global exposure for non-module HTML access
window.tbcImageOptimizer = {
  optimizeImage,
  uploadOptimizedProductImages,
  formatBytes
};
