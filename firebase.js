// نقطة واحدة لتهيئة Firebase. إصدار الـ SDK مثبّت في الروابط أدناه.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, getDocs, updateDoc, collection, query, where, orderBy, limitToLast,
  onSnapshot, writeBatch, serverTimestamp, increment
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const configured =
  typeof firebaseConfig.apiKey === 'string' &&
  firebaseConfig.apiKey.length > 0 &&
  !firebaseConfig.apiKey.startsWith('YOUR_');

let _auth = null;
let _db = null;

if (configured) {
  const app = initializeApp(firebaseConfig);
  _auth = getAuth(app);
  _auth.languageCode = 'ar'; // نافذة Google بالعربية
  try {
    // تخزين محلي لتعمل المحادثات عند انقطاع الاتصال
    _db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    _db = initializeFirestore(app, {});
  }
}

export const auth = _auth;
export const db = _db;

export {
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut,
  doc, getDoc, getDocs, updateDoc, collection, query, where, orderBy, limitToLast,
  onSnapshot, writeBatch, serverTimestamp, increment
};
