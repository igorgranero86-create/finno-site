// ================================================================
// api.js — Firebase init, Firestore helpers, Pluggy, plan state
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  sendEmailVerification,
  sendPasswordResetEmail,
  updateProfile,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

// ── Firebase config ───────────────────────────────────────────────
export const firebaseConfig = {
  apiKey: "AIzaSyDJ9MPvf0VRz7gsI5kezOWzUYbu4luUyv4",
  authDomain: "app-fino.firebaseapp.com",
  projectId: "app-fino",
  storageBucket: "app-fino.firebasestorage.app",
  messagingSenderId: "269576667997",
  appId: "1:269576667997:web:89c81d6410f3498755deb4",
  measurementId: "G-SRKRVPQZGF"
};

// ── Firebase init ─────────────────────────────────────────────────
export const app = initializeApp(firebaseConfig);
export const analytics = getAnalytics(app);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'southamerica-east1');
auth.languageCode = 'pt-BR';

// Re-export auth functions needed by auth.js
export {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  sendEmailVerification,
  sendPasswordResetEmail,
  updateProfile,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  signOut,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
};

// ── Firestore helpers ─────────────────────────────────────────────

/**
 * Creates a user document in Firestore (only if it doesn't exist).
 * Optionally merges CPF if provided.
 */
export async function saveUserProfile(user, extra = {}) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      email: user.email || null,
      phone: user.phoneNumber || null,
      displayName: user.displayName || extra.displayName || null,
      photoURL: user.photoURL || null,
      provider: extra.provider || 'email',
      cpf: extra.cpf || null,
      createdAt: serverTimestamp(),
    });
  } else if (extra.cpf) {
    await setDoc(ref, { cpf: extra.cpf }, { merge: true });
  }
}

/**
 * Returns true if the given CPF is not yet registered.
 */
export async function checkCPFUnique(cpf) {
  const clean = cpf.replace(/\D/g, '');
  try {
    const snap = await getDoc(doc(db, 'cpfs', clean));
    return !snap.exists();
  } catch (e) {
    return true; // allow if check fails
  }
}

/**
 * Registers the CPF in Firestore so it cannot be reused.
 */
export async function saveCPF(cpf, uid) {
  const clean = cpf.replace(/\D/g, '');
  try {
    await setDoc(doc(db, 'cpfs', clean), { uid, createdAt: serverTimestamp() });
  } catch (e) {
    console.warn('CPF save error', e);
  }
}

// ── Plan state helpers ────────────────────────────────────────────
// States: 'none' | 'free' | 'trial' | 'expired' | 'premium'

export function getPlanState(uid) {
  if (!uid) return 'none';
  const plan = localStorage.getItem('finno_plan_' + uid) || 'none';
  const trialStart = localStorage.getItem('finno_trial_start_' + uid);
  if (plan === 'premium') return 'premium';
  if (plan === 'trial' && trialStart) {
    return (Date.now() - parseInt(trialStart)) / 86400000 <= 7 ? 'trial' : 'expired';
  }
  if (plan === 'free') return 'free';
  return 'none';
}

export function getTrialDaysLeft(uid) {
  const ts = localStorage.getItem('finno_trial_start_' + uid);
  return ts ? Math.max(0, Math.ceil(7 - (Date.now() - parseInt(ts)) / 86400000)) : 0;
}

export function getBankLimit(state) {
  return state === 'premium' ? 2 : state === 'trial' ? 1 : 0;
}

// ── Pluggy data fetch ─────────────────────────────────────────────
// Obtém o accessToken via Cloud Function — credenciais nunca chegam ao frontend.
// Retorna null em qualquer falha, ativando o modo demo automaticamente.
export async function fetchPluggyData() {
  try {
    const user = auth.currentUser;
    if (!user) return null; // sem sessão ativa → modo demo
    const getToken = httpsCallable(functions, 'getPluggyAccessToken');
    const result = await getToken();
    return result.data?.apiKey || null;
  } catch (e) {
    console.warn('Pluggy token indisponível, usando modo demo:', e.message);
    return null;
  }
}

// ── Pluggy Connect Token ──────────────────────────────────────────
// Gera um Connect Token via Cloud Function para abrir o widget Pluggy Connect.
// Lança erro se o usuário não estiver autenticado ou se a função falhar.
export async function getPluggyConnectToken() {
  const user = auth.currentUser;
  if (!user) throw new Error('Usuário não autenticado.');
  const createToken = httpsCallable(functions, 'createPluggyConnectToken');
  const result = await createToken();
  return result.data?.connectToken || null;
}

// ── Firebase error → Portuguese messages ─────────────────────────
export function firebaseErrPT(code) {
  const map = {
    'auth/email-already-in-use': 'Este e-mail já está cadastrado. Faça login.',
    'auth/invalid-email': 'E-mail inválido.',
    'auth/weak-password': 'Senha fraca. Use letras, números e símbolos.',
    'auth/user-not-found': 'E-mail não encontrado. Crie uma conta.',
    'auth/wrong-password': 'Senha incorreta.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde alguns minutos.',
    'auth/invalid-phone-number': 'Número de telefone inválido.',
    'auth/invalid-verification-code': 'Código incorreto. Tente novamente.',
    'auth/code-expired': 'Código expirado. Solicite um novo.',
    'auth/popup-closed-by-user': 'Login cancelado.',
    'auth/network-request-failed': 'Sem conexão. Verifique sua internet.',
  };
  return map[code] || 'Erro inesperado. Tente novamente.';
}

// Expose plan helpers to window (used by HTML onclick attributes)
window.getPlanState = getPlanState;
window.getTrialDaysLeft = getTrialDaysLeft;
window.getBankLimit = getBankLimit;
