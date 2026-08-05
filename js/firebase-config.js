/**
 * THE BANIYAN COMPANY — Firebase Configuration & Initialization
 * Uses Firebase Modular Web SDK v10 (CDN Module)
 * Project: shoespot1-56237783-59577
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

// Real Firebase Project Configuration
const firebaseConfig = {
  apiKey: "AIzaSyC_uFXsHvXc3sYgq5fDhHMU4aQd-RNpWMQ",
  authDomain: "shoespot1-56237783-59577.firebaseapp.com",
  databaseURL: "https://shoespot1-56237783-59577-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "shoespot1-56237783-59577",
  storageBucket: "shoespot1-56237783-59577.firebasestorage.app",
  messagingSenderId: "700646716884",
  appId: "1:700646716884:web:5779e725bb44bfdbc11241"
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
