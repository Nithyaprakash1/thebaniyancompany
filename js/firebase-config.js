/**
 * THE BANIYAN COMPANY — Firebase Configuration & Initialization
 * Uses Firebase Modular Web SDK v10 (CDN Module)
 * Project: onespacebillingpro
 */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Real Firebase Project Configuration (onespacebillingpro)
const firebaseConfig = {
  apiKey: "AIzaSyAK-gAr9AHukJb7qrlSabsW7MlB_3LvB5E",
  authDomain: "onespacebillingpro.firebaseapp.com",
  projectId: "onespacebillingpro",
  storageBucket: "onespacebillingpro.firebasestorage.app",
  messagingSenderId: "653289419687",
  appId: "1:653289419687:web:e6f4aca6f91b15645c7c82"
};

// Initialize Firebase App instance safely (prevent duplicate init)
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

// Attach globally for legacy script access
window.tbcFirebaseApp = app;
window.tbcDb = db;

export {
  app,
  db,
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  onSnapshot,
};

import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
export const auth = getAuth(app);
