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
  deleteDoc,
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
  deleteDoc,
  serverTimestamp
};

// ── Firestore helpers ─────────────────────────────────────────────

/**
 * Creates a user document in Firestore (only if it doesn't exist).
 * CPF nunca é salvo aqui em texto puro — unicidade é garantida via cpfs/{hash}.
 */
export async function saveUserProfile(user, extra = {}) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const data = {
      uid: user.uid,
      email: user.email || null,
      phone: user.phoneNumber || null,
      displayName: user.displayName || extra.displayName || null,
      photoURL: user.photoURL || null,
      provider: extra.provider || 'email',
      createdAt: serverTimestamp(),
    };
    // Contas demo (IS_DEMO_MODE=true) marcadas no Firestore — bypass seguro para
    // verificação de e-mail sem depender de localStorage (que é manipulável via DevTools).
    if (extra.demoMode) data.demoMode = true;
    await setDoc(ref, data);
  }
}

/**
 * Verifica se o CPF ainda não está registrado — via Cloud Function.
 * Retorna false (bloqueio) em caso de erro, para evitar cadastros duplicados silenciosos.
 */
export async function checkCPFUnique(cpf) {
  try {
    const fn = httpsCallable(functions, 'checkCPFUnique');
    const result = await fn({ cpf });
    return result.data.available === true;
  } catch (e) {
    console.error('Erro ao verificar CPF:', e.message);
    return false; // fail-closed: bloqueia se a verificação falhar
  }
}

/**
 * Registra o hash do CPF via Cloud Function — ambas as gravações (cpfs + users)
 * ficam no servidor, fora do alcance das Firestore Rules do cliente.
 * Lança erro se o CPF já existir ou se a gravação falhar.
 */
export async function saveCPF(cpf, uid) {
  const fn = httpsCallable(functions, 'saveCPF');
  const result = await fn({ cpf });
  // Cache local para acelerar a exclusão de conta sem depender do Firestore
  if (result.data?.cpfHash) {
    localStorage.setItem('finno_cpf_ref_' + uid, result.data.cpfHash);
  }
}

// ── Plan state helpers ────────────────────────────────────────────
// States: 'none' | 'free' | 'trial' | 'expired' | 'premium'

// Estados possíveis: 'none' | 'free' | 'plus' | 'pro' | 'premium' | 'trial' | 'expired'
// Planos pagos: plus=R$9,90 | pro=R$14,90 | premium=R$19,90
// IA: pro, premium, trial | Bancos: premium (2), trial (1) | Anúncios: somente free
export function getPlanState(uid) {
  if (!uid) return 'none';
  const plan = localStorage.getItem('finno_plan_' + uid) || 'none';
  const trialStart = localStorage.getItem('finno_trial_start_' + uid);
  if (plan === 'premium') return 'premium';
  if (plan === 'pro')     return 'pro';
  if (plan === 'plus')    return 'plus';
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

// Retorna true se o plano inclui IA (insights)
export function hasAI(state) {
  return ['pro', 'premium', 'trial'].includes(state);
}

// Retorna true se o plano inclui conexão bancária
export function hasBanks(state) {
  return ['premium', 'trial'].includes(state);
}

// Retorna o limite de bancos conectados por plano
export function getBankLimit(state) {
  if (state === 'premium') return 2;
  if (state === 'trial')   return 1;
  return 0;
}

// ── Pluggy data fetch ─────────────────────────────────────────────
// Obtém o accessToken via Cloud Function — credenciais nunca chegam ao frontend.
// Retorna null em qualquer falha (dashboard entra em modo sem dados bancários).
export async function fetchPluggyData() {
  try {
    const user = auth.currentUser;
    if (!user) return null;
    const getToken = httpsCallable(functions, 'getPluggyAccessToken');
    const result = await getToken();
    return result.data?.apiKey || null;
  } catch (e) {
    console.warn('Pluggy token indisponível:', e.message);
    return null;
  }
}

// ── Account deletion via Cloud Function ──────────────────────────
// Deleta users/{uid} e cpfs/{cpfHash} via Admin SDK (ignora Firestore Rules).
// O cliente deve chamar isso ANTES de user.delete() e depois limpar o localStorage.
export async function deleteAccountViaCloud() {
  const fn = httpsCallable(functions, 'deleteAccount');
  await fn(); // lança HttpsError se o usuário não estiver autenticado ou ocorrer erro
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

/**
 * Sincroniza o plano do usuário com o Firestore via Cloud Function.
 * Planos gratuitos (free, trial) são aceitos; pagos requerem webhook de pagamento.
 * Falha silenciosamente — o plano local (localStorage) continua funcionando para a UI.
 */
export async function savePlanToFirestore(uid, plan) {
  if (!uid) return;
  try {
    const fn = httpsCallable(functions, 'setPlan');
    await fn({ plan });
  } catch (e) {
    // Planos pagos são rejeitados pelo CF por design — log apenas para outros erros.
    if (!e.message?.includes('confirmação de pagamento')) {
      console.warn('Plan sync to Firestore failed:', e.message);
    }
  }
}

// Expose plan helpers to window (used by HTML onclick attributes)
window.getPlanState  = getPlanState;
window.savePlanToFirestore = savePlanToFirestore;
window.hasAI         = hasAI;
window.hasBanks      = hasBanks;
window.getBankLimit  = getBankLimit;
window.getTrialDaysLeft = getTrialDaysLeft;
window.getBankLimit = getBankLimit;
