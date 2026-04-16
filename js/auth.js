// ================================================================
// auth.js — All authentication flows
// ================================================================

// Em produção: false. Em dev/staging com domínio não autorizado: true.
const IS_DEMO_MODE = false;

import {
  auth, db,
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
  serverTimestamp,
  firebaseErrPT,
  saveUserProfile,
  checkCPFUnique,
  saveCPF,
  deleteAccountViaCloud
} from './api.js';

// ── DOM helpers (shared with app.js via window) ───────────────────
function toast(msg, type = 'success') { window.toast?.(msg, type); }
function showErr(id, msg) { window.showErr?.(id, msg); }
function clearErr(id) { window.clearErr?.(id); }
function showScreen(id) { window.showScreen?.(id); }
function showView(id) { window.showView?.(id); }
function closeModal(id) { window.closeModal?.(id); }
function setAvatar(user) { window.setAvatar?.(user); }

// ── Navigation ─────────────────────────────────────────────────────
function goToAuth(mode) {
  showScreen('screen-auth');
  showView(mode === 'register' ? 'auth-register' : 'auth-login');
}
window.goToAuth = goToAuth;

function goBackToSplash() {
  showScreen('screen-splash');
}
window.goBackToSplash = goBackToSplash;

// ── Password strength ─────────────────────────────────────────────
function checkStrength(pwd) {
  const wrap = document.getElementById('pwd-strength');
  if (!pwd) { if (wrap) wrap.style.display = 'none'; return; }
  if (wrap) wrap.style.display = 'flex';

  let score = 0;
  if (pwd.length >= 8) score++;
  if (/[A-Z]/.test(pwd)) score++;
  if (/[0-9]/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;

  const colors = ['#f87171', '#fbbf24', '#60a5fa', '#4ade80'];
  const labels = ['Fraca', 'Média', 'Boa', 'Forte'];
  const bars = [
    document.getElementById('pbar1'),
    document.getElementById('pbar2'),
    document.getElementById('pbar3'),
    document.getElementById('pbar4')
  ];

  bars.forEach((b, i) => {
    if (b) b.style.background = i < score ? colors[score - 1] : 'var(--surface3)';
  });
  const lbl = document.getElementById('plabel');
  if (lbl) { lbl.textContent = labels[score - 1] || ''; lbl.style.color = colors[score - 1] || 'var(--muted)'; }
}
window.checkStrength = checkStrength;

function validateStrongPassword(pwd) {
  if (pwd.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (!/[0-9]/.test(pwd)) return 'A senha deve conter pelo menos um número.';
  if (!/[^A-Za-z0-9]/.test(pwd)) return 'A senha deve conter pelo menos um símbolo (!@#$%...).';
  return null;
}

// ── CPF helpers ───────────────────────────────────────────────────
function formatCPF(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 11);
  if (v.length > 9) v = v.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
  else if (v.length > 6) v = v.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
  else if (v.length > 3) v = v.replace(/(\d{3})(\d{1,3})/, '$1.$2');
  input.value = v;
}
window.formatCPF = formatCPF;

function validateCPF(cpf) {
  const c = cpf.replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(c[i]) * (10 - i);
  let r = (sum * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  if (r !== parseInt(c[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(c[i]) * (11 - i);
  r = (sum * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  return r === parseInt(c[10]);
}

// ── Register (email + verification) ──────────────────────────────
async function doRegister() {
  clearErr('reg-error');

  const lgpdEl = document.getElementById('lgpd-consent');
  const lgpdErr = document.getElementById('lgpd-error');
  if (!lgpdEl?.checked) {
    if (lgpdErr) lgpdErr.style.display = 'block';
    return;
  }
  if (lgpdErr) lgpdErr.style.display = 'none';
  // Suporta tanto o campo unificado "reg-nome-completo" quanto os campos separados legados
  const nomeCompleto = (
    document.getElementById('reg-nome-completo')?.value.trim() ||
    ((document.getElementById('reg-nome')?.value.trim() || '') +
     ' ' + (document.getElementById('reg-sobrenome')?.value.trim() || '')).trim()
  );
  const cpf   = document.getElementById('reg-cpf').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const senha = document.getElementById('reg-senha').value;

  if (!nomeCompleto || nomeCompleto.split(' ').length < 2) {
    return showErr('reg-error', 'Informe seu nome completo (nome e sobrenome).');
  }
  if (!cpf) return showErr('reg-error', 'Informe seu CPF.');
  if (!validateCPF(cpf)) return showErr('reg-error', 'CPF inválido. Confira os dígitos e tente novamente.');
  if (!email.includes('@') || !email.includes('.')) return showErr('reg-error', 'E-mail inválido.');
  const pwdErr = validateStrongPassword(senha);
  if (pwdErr) return showErr('reg-error', pwdErr);

  const btn = document.querySelector('#auth-register .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }

  const cpfFree = await checkCPFUnique(cpf);
  if (!cpfFree) {
    showErr('reg-error', 'Este CPF já possui uma conta. Faça login ou recupere sua senha.');
    if (btn) { btn.disabled = false; btn.textContent = 'Criar conta segura →'; }
    return;
  }

  if (btn) btn.textContent = 'Criando sua conta…';

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, senha);
    await updateProfile(cred.user, { displayName: nomeCompleto });
    await sendEmailVerification(cred.user);
    await saveUserProfile(cred.user, { displayName: nomeCompleto, provider: 'email' });
    await saveCPF(cpf, cred.user.uid);

    const subEl = document.getElementById('verify-email-sub');
    if (subEl) subEl.textContent = `Enviamos um link de confirmação para ${email}. Clique no link para ativar sua conta.`;
    showScreen('screen-verify-email');
    toast('Conta criada! Confirme seu e-mail para continuar.', 'success');
  } catch (e) {
    // Erros de Cloud Function expõem e.message diretamente; erros Auth usam e.code
    const msg = e.code?.startsWith('functions/')
      ? (e.message || 'Erro inesperado. Tente novamente.')
      : firebaseErrPT(e.code);
    showErr('reg-error', msg);
    if (btn) { btn.disabled = false; btn.textContent = 'Criar conta segura →'; }
  }
}
window.doRegister = doRegister;

// ── Login (email) ─────────────────────────────────────────────────
async function doLogin() {
  clearErr('login-error');
  const email = document.getElementById('login-email').value.trim();
  const senha = document.getElementById('login-senha').value;

  if (!email.includes('@')) return showErr('login-error', 'E-mail inválido.');
  if (!senha) return showErr('login-error', 'Informe sua senha.');

  const btn = document.querySelector('#auth-login .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Entrando...'; }

  try {
    const cred = await signInWithEmailAndPassword(auth, email, senha);
    // Check email verification
    if (!cred.user.emailVerified) {
      const subEl = document.getElementById('verify-email-sub');
      if (subEl) subEl.textContent = `Confirme o e-mail enviado para ${email} antes de entrar.`;
      showScreen('screen-verify-email');
      if (btn) { btn.disabled = false; btn.textContent = 'Acessar minha conta →'; }
    }
    // onAuthStateChanged in app.js handles navigation for verified users
  } catch (e) {
    showErr('login-error', firebaseErrPT(e.code));
    if (btn) { btn.disabled = false; btn.textContent = 'Acessar minha conta →'; }
  }
}
window.doLogin = doLogin;

// ── Google auth ───────────────────────────────────────────────────
// Modal de consentimento LGPD exibido apenas para novos usuários Google.
function showGoogleConsentModal() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:flex-end;justify-content:center;padding:16px';
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:20px 20px 16px 16px;padding:24px;width:100%;max-width:420px;box-shadow:0 -8px 32px rgba(0,0,0,0.4)">
        <div style="font-family:Syne,sans-serif;font-weight:700;font-size:1.05rem;margin-bottom:8px">Antes de criar sua conta</div>
        <p style="font-size:0.82rem;color:var(--muted);line-height:1.6;margin-bottom:16px">Para usar o Finno, você precisa aceitar nossos Termos de Uso e Política de Privacidade.</p>
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:0.82rem;color:var(--muted);line-height:1.5;margin-bottom:20px">
          <input type="checkbox" id="google-lgpd-cb" style="margin-top:2px;accent-color:var(--accent);flex-shrink:0">
          <span>Li e concordo com os <a href="/pages/terms.html" target="_blank" style="color:var(--accent)">Termos de Uso</a> e a <a href="/pages/privacy.html" target="_blank" style="color:var(--accent)">Política de Privacidade</a>. Meus dados são protegidos conforme a LGPD.</span>
        </label>
        <button id="google-consent-ok" style="width:100%;background:linear-gradient(135deg,var(--accent),#0052cc);color:#fff;border:none;border-radius:12px;padding:14px;font-family:Syne,sans-serif;font-weight:700;font-size:0.95rem;cursor:pointer;margin-bottom:10px">Concordar e entrar</button>
        <button id="google-consent-cancel" style="width:100%;background:none;border:none;color:var(--muted);padding:10px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.85rem">Cancelar</button>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('google-consent-ok').onclick = () => {
      const cb = document.getElementById('google-lgpd-cb');
      if (!cb.checked) { cb.style.outline = '2px solid var(--danger)'; return; }
      overlay.remove();
      resolve(true);
    };
    document.getElementById('google-consent-cancel').onclick = () => { overlay.remove(); resolve(false); };
  });
}

// Demo fallback: when Firebase popup fails (domain not authorized,
// file:// protocol, etc), create a demo account so the UX still works.
async function authGoogle() {
  // Show loading on all Google buttons
  const googleBtns = [];
  document.querySelectorAll('.social-btn').forEach(b => {
    if (b.textContent.includes('Google')) {
      googleBtns.push({ el: b, orig: b.innerHTML });
      b.disabled = true;
      b.innerHTML = '<span class="sicon">⏳</span> Conectando...';
    }
  });
  const restore = () => googleBtns.forEach(g => { g.el.disabled = false; g.el.innerHTML = g.orig; });

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const cred = await signInWithPopup(auth, provider);
    // Verificar se é novo usuário (doc ainda não existe no Firestore)
    const userRef = doc(db, 'users', cred.user.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      const accepted = await showGoogleConsentModal();
      if (!accepted) {
        await signOut(auth);
        restore();
        toast('É necessário aceitar os Termos para criar sua conta.', 'error');
        return;
      }
    }
    await saveUserProfile(cred.user, { provider: 'google' });
    // onAuthStateChanged handles routing
  } catch (e) {
    restore();

    // User cancelled — silent
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;

    // Domain not in Firebase Authorized Domains OR popup blocked:
    // fall back to demo Google account so the app still functions
    const isDomainIssue = (
      e.code === 'auth/unauthorized-domain' ||
      e.code === 'auth/popup-blocked' ||
      e.code === 'auth/operation-not-supported-in-this-environment'
    );

    if (isDomainIssue) {
      if (IS_DEMO_MODE) {
        toast('Abrindo modo demo do Google...', 'success');
        await _demoGoogleLogin();
      } else {
        toast('Login com Google indisponível neste domínio. Use e-mail ou celular.', 'error');
      }
      return;
    }

    toast(firebaseErrPT(e.code) || 'Erro ao entrar com Google. Tente pelo e-mail.', 'error');
  }
}
window.authGoogle = authGoogle;

// Creates a Firebase email/password account that simulates a Google login.
// Used only when IS_DEMO_MODE=true (dev/staging sem domínio autorizado).
// demoMode:true é gravado no Firestore para permitir bypass seguro do gate de e-mail.
async function _demoGoogleLogin() {
  const googleNames = ['Ana Lima', 'Carlos Souza', 'Mariana Costa', 'Rafael Oliveira', 'Juliana Santos'];
  const displayName = googleNames[Math.floor(Math.random() * googleNames.length)];
  const tag = Date.now().toString(36);
  const email = `demo.google.${tag}@finno.app`;
  const password = `Finno@Demo${tag}`;

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName });
    await saveUserProfile(cred.user, { provider: 'google', displayName, demoMode: true });
    toast(`Entrando como ${displayName} (modo demo) ✓`, 'success');
    // onAuthStateChanged picks this up — provider will be 'password'.
  } catch (e) {
    if (e.code === 'auth/email-already-in-use') {
      // Demo account already exists — sign in
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (e2) {
        toast('Erro no modo demo. Use login por e-mail.', 'error');
      }
    } else {
      toast('Modo demo indisponível. Use e-mail para criar conta.', 'error');
    }
  }
}

// ── Phone auth (SMS) ──────────────────────────────────────────────
// Strategy:
//  1. Try real Firebase signInWithPhoneNumber
//  2. If Firebase SMS is not configured or domain is restricted → fall
//     back to demo mode: show OTP screen, accept "123456" as the code
//     and create an email/password account under the hood.

let confirmationResult = null;
let _demoPhoneMode = false; // true when running the SMS demo fallback

async function sendSMS() {
  clearErr('phone-error');

  const lgpdPhone = document.getElementById('lgpd-consent-phone');
  const lgpdPhoneErr = document.getElementById('lgpd-error-phone');
  if (!lgpdPhone?.checked) {
    if (lgpdPhoneErr) lgpdPhoneErr.style.display = 'block';
    return;
  }
  if (lgpdPhoneErr) lgpdPhoneErr.style.display = 'none';

  const cpf  = document.getElementById('phone-cpf')?.value.trim() || '';
  const nome = document.getElementById('phone-nome')?.value.trim() || '';
  const ddi  = document.getElementById('phone-ddi').value;
  const raw  = document.getElementById('phone-number').value;
  const num  = raw.replace(/\D/g, '');

  if (!nome || nome.split(' ').length < 2) return showErr('phone-error', 'Informe seu nome completo (nome e sobrenome).');
  if (!cpf) return showErr('phone-error', 'Informe seu CPF.');
  if (!validateCPF(cpf)) return showErr('phone-error', 'CPF inválido. Verifique e tente novamente.');
  if (num.length < 8) return showErr('phone-error', 'Número de celular inválido. Ex: (11) 99999-9999.');

  window._pendingCPF   = cpf;
  window._pendingName  = nome;
  window._pendingPhone = ddi + num;

  const cpfFree = await checkCPFUnique(cpf);
  if (!cpfFree) return showErr('phone-error', 'Este CPF já possui uma conta cadastrada. Faça login.');

  const fullPhone = window._pendingPhone;
  const btn = document.querySelector('#auth-phone .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando SMS...'; }
  _demoPhoneMode = false;

  // ── Try real Firebase SMS ──────────────────────────────────────
  try {
    if (window.recaptchaVerifier) {
      try { window.recaptchaVerifier.clear(); } catch (_) {}
      window.recaptchaVerifier = null;
    }
    window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
      size: 'invisible',
      callback: () => {}
    });
    confirmationResult = await signInWithPhoneNumber(auth, fullPhone, window.recaptchaVerifier);
    const subEl = document.getElementById('otp-sub');
    if (subEl) subEl.textContent = `Código enviado para ${fullPhone}. Digite abaixo.`;
    showView('auth-otp');
    setTimeout(() => { const f = document.querySelector('.otp-input'); if (f) f.focus(); }, 100);
    toast('SMS enviado! Verifique seu celular.', 'success');
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar código SMS'; }
    return;
  } catch (e) {
    if (window.recaptchaVerifier) {
      try { window.recaptchaVerifier.clear(); } catch (_) {}
      window.recaptchaVerifier = null;
    }

    // Handle "too-many-requests" and "invalid-phone-number" as real errors (not demo fallback)
    if (e.code === 'auth/too-many-requests') {
      showErr('phone-error', 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar código SMS'; }
      return;
    }
    if (e.code === 'auth/invalid-phone-number') {
      showErr('phone-error', 'Número inválido. Use o formato +55 (11) 99999-9999.');
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar código SMS'; }
      return;
    }

    // Everything else → demo apenas se IS_DEMO_MODE estiver ativo
    if (IS_DEMO_MODE) {
      console.warn('[Finno] SMS via Firebase falhou, ativando modo demo:', e.code);
      _demoPhoneMode = true;
    } else {
      showErr('phone-error', 'Não foi possível enviar o SMS. Tente novamente ou use e-mail.');
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar código SMS'; }
    }
  }

  // ── Demo SMS mode ──────────────────────────────────────────────
  if (_demoPhoneMode) {
    // Show OTP screen with demo code hint
    const subEl = document.getElementById('otp-sub');
    if (subEl) subEl.innerHTML =
      `Código de verificação do app Finno enviado para ${window._pendingPhone || 'seu número'}.<br>
       <span style="color:var(--accent);font-weight:600">Código de teste: <span style="letter-spacing:0.15em">1 2 3 4 5 6</span></span>`;

    // Add a small demo badge below the OTP inputs
    const otpErr = document.getElementById('otp-error');
    if (otpErr) {
      otpErr.textContent = '🔬 Demonstração: use o código 123456 para continuar.';
      otpErr.style.display = 'block';
      otpErr.style.background = 'rgba(251,191,36,0.08)';
      otpErr.style.color = 'var(--warning)';
      otpErr.style.border = '1px solid rgba(251,191,36,0.2)';
      otpErr.style.borderRadius = '10px';
      otpErr.style.padding = '10px 14px';
      otpErr.style.marginBottom = '10px';
    }

    showView('auth-otp');
    setTimeout(() => { const f = document.querySelector('.otp-input'); if (f) f.focus(); }, 100);
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar código SMS'; }
  }
}
window.sendSMS = sendSMS;

async function verifyOTP() {
  const code = Array.from(document.querySelectorAll('.otp-input')).map(i => i.value).join('');
  clearErr('otp-error');
  if (code.length < 6) return showErr('otp-error', 'Digite todos os 6 dígitos do código.');

  const btn = document.querySelector('#auth-otp .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

  // ── Demo mode path ─────────────────────────────────────────────
  if (_demoPhoneMode) {
    if (code !== '123456') {
      showErr('otp-error', 'Código incorreto. No modo demo use: 123456');
      document.querySelectorAll('.otp-input').forEach(i => { i.value = ''; i.classList.add('shake'); });
      setTimeout(() => document.querySelectorAll('.otp-input').forEach(i => i.classList.remove('shake')), 500);
      document.querySelector('.otp-input')?.focus();
      if (btn) { btn.disabled = false; btn.textContent = 'Verificar e entrar'; }
      return;
    }
    await _createDemoPhoneAccount();
    return;
  }

  // ── Real Firebase path ─────────────────────────────────────────
  if (!confirmationResult) {
    showErr('otp-error', 'Sessão expirada. Solicite um novo código.');
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar e entrar'; }
    return;
  }

  try {
    const cred = await confirmationResult.confirm(code);
    const displayName = window._pendingName || '';
    if (displayName) await updateProfile(cred.user, { displayName });
    await saveUserProfile(cred.user, { provider: 'phone', displayName, cpf: (window._pendingCPF || '').replace(/\D/g, '') });
    if (window._pendingCPF) await saveCPF(window._pendingCPF, cred.user.uid);
    window._pendingCPF = null; window._pendingName = null;
    // onAuthStateChanged handles routing
  } catch (e) {
    let msg = firebaseErrPT(e.code) || 'Erro na verificação.';
    if (e.code === 'auth/invalid-verification-code') msg = 'Código incorreto. Verifique e tente novamente.';
    if (e.code === 'auth/code-expired') msg = 'Código expirado. Solicite um novo SMS.';
    showErr('otp-error', msg);
    document.querySelectorAll('.otp-input').forEach(i => { i.value = ''; i.classList.add('shake'); });
    setTimeout(() => document.querySelectorAll('.otp-input').forEach(i => i.classList.remove('shake')), 500);
    document.querySelector('.otp-input')?.focus();
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar e entrar'; }
  }
}
window.verifyOTP = verifyOTP;

// Creates an email/password Firebase account to simulate phone login.
// Usado apenas com IS_DEMO_MODE=true. demoMode:true gravado via saveUserProfile.
async function _createDemoPhoneAccount() {
  const phone = (window._pendingPhone || '').replace(/\D/g, '');
  const tag = Date.now().toString(36);
  const email = `demo.phone.${phone || tag}@finno.app`;
  const password = `Finno@Phone${phone || tag}`;
  const displayName = window._pendingName || 'Usuário';

  try {
    let cred;
    try {
      cred = await createUserWithEmailAndPassword(auth, email, password);
    } catch (e) {
      if (e.code === 'auth/email-already-in-use') {
        cred = await signInWithEmailAndPassword(auth, email, password);
      } else throw e;
    }
    await updateProfile(cred.user, { displayName });
    await saveUserProfile(cred.user, { provider: 'phone', displayName, demoMode: true });
    if (window._pendingCPF) await saveCPF(window._pendingCPF, cred.user.uid);
    window._pendingCPF = null; window._pendingName = null; window._pendingPhone = null;
    _demoPhoneMode = false;
    toast(`Bem-vindo, ${displayName.split(' ')[0]}! ✓`, 'success');
    // onAuthStateChanged picks this up
  } catch (e) {
    toast('Erro ao criar conta demo. Tente pelo e-mail.', 'error');
    const btn = document.querySelector('#auth-otp .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar e entrar'; }
  }
}

function otpNext(input, idx) {
  input.value = input.value.replace(/[^0-9]/g, '');
  if (input.value && idx < 5) {
    const next = document.querySelectorAll('.otp-input')[idx + 1];
    if (next) next.focus();
  }
  if (idx === 5 && input.value) verifyOTP();
}
window.otpNext = otpNext;

function otpBack(e, input, idx) {
  if (e.key === 'Backspace' && !input.value && idx > 0) {
    const prev = document.querySelectorAll('.otp-input')[idx - 1];
    if (prev) prev.focus();
  }
}
window.otpBack = otpBack;

// ── Forgot password ───────────────────────────────────────────────
async function doForgot() {
  clearErr('forgot-error');
  const email = document.getElementById('forgot-email').value.trim();
  if (!email.includes('@')) return showErr('forgot-error', 'Informe um e-mail válido.');

  const btn = document.querySelector('#auth-forgot .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }

  try {
    await sendPasswordResetEmail(auth, email);
    const msgEl = document.getElementById('forgot-msg');
    if (msgEl) { msgEl.textContent = '✓ Link enviado para ' + email + '. Verifique sua caixa de entrada (e spam).'; msgEl.style.display = 'block'; }
    const emailEl = document.getElementById('forgot-email');
    if (emailEl) emailEl.value = '';
  } catch (e) {
    showErr('forgot-error', firebaseErrPT(e.code));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Enviar link'; }
  }
}
window.doForgot = doForgot;

// ── Email verification ────────────────────────────────────────────
async function checkEmailVerification() {
  const user = auth.currentUser;
  if (!user) { showScreen('screen-splash'); return; }

  const btn = document.getElementById('check-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Verificando...'; }

  try {
    await user.reload();
    if (user.emailVerified) {
      const { getPlanState } = await import('./api.js');
      const uid = user.uid;
      const state = getPlanState(uid);
      const setupDone = localStorage.getItem('finno_setup_' + uid);
      toast('E-mail confirmado! Bem-vindo ao Finno ✓', 'success');

      // Developer always gets premium
      if (['igorgranero86@gmail.com'].includes(user.email)) {
        localStorage.setItem('finno_plan_' + uid, 'premium');
        localStorage.setItem('finno_setup_' + uid, '1');
      }

      if (setupDone) {
        showScreen('screen-loading');
        window.runLoadingSequence?.(() => {
          showScreen('screen-dashboard');
          window.buildDashboard?.();
          window.applyPlanUI?.(getPlanState(uid));
        });
      } else if (state !== 'none' && state !== 'free') {
        showScreen('screen-connect');
        window.showConnectState?.(state, uid);
      } else {
        showScreen('screen-plan');
      }
    } else {
      toast('E-mail ainda não confirmado. Verifique sua caixa de entrada e spam.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Já confirmei, continuar →'; }
    }
  } catch (e) {
    toast('Erro ao verificar. Tente novamente.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Já confirmei, continuar →'; }
  }
}
window.checkEmailVerification = checkEmailVerification;

async function resendVerificationEmail() {
  const user = auth.currentUser;
  if (!user) return;
  const btn = document.getElementById('resend-verify-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }
  try {
    await sendEmailVerification(user);
    toast('E-mail de confirmação reenviado! Verifique sua caixa de entrada.', 'success');
  } catch (e) {
    if (e.code === 'auth/too-many-requests') {
      toast('Aguarde alguns minutos para reenviar.', 'error');
    } else {
      toast(firebaseErrPT(e.code), 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Reenviar e-mail de confirmação'; }
  }
}
window.resendVerificationEmail = resendVerificationEmail;

// ── Logout ────────────────────────────────────────────────────────
function confirmLogout() {
  document.getElementById('modal-logout')?.classList.add('open');
}
window.confirmLogout = confirmLogout;

async function doLogout() {
  try {
    const uid = auth.currentUser?.uid;
    closeModal('modal-logout');
    closeModal('modal-account');
    window.connectedItems = [];
    await signOut(auth);
    // Reset loading steps
    ['step1', 'step2', 'step3', 'step4', 'step5'].forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('active', 'done');
        const icon = el.querySelector('.step-icon');
        const icons = ['🔐', '🏦', '📊', '🤖', '✨'];
        if (icon) icon.textContent = icons[i] || '⚡';
      }
    });
    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = '0%';
    showScreen('screen-splash');
  } catch (e) {
    console.error('Logout error:', e);
    showScreen('screen-splash');
  }
}
window.doLogout = doLogout;

// ── Toggle password visibility ────────────────────────────────────
function togglePwd(id, icon) {
  const inp = document.getElementById(id);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  if (icon) icon.textContent = inp.type === 'password' ? '👁' : '🙈';
}
window.togglePwd = togglePwd;

// ── Account menu ──────────────────────────────────────────────────
function openAccountMenu() {
  const user = auth.currentUser;
  if (!user) return;

  // Populate name and email
  const nameEl = document.getElementById('menu-name');
  const emailEl = document.getElementById('menu-email');
  const editNameEl = document.getElementById('edit-name');
  const initialsEl = document.getElementById('menu-initials');
  const photoEl = document.getElementById('menu-photo');

  if (nameEl) nameEl.textContent = user.displayName || 'Usuário';
  if (emailEl) emailEl.textContent = user.email || user.phoneNumber || '';
  if (editNameEl) editNameEl.value = user.displayName || '';

  // Avatar
  const savedPhoto = localStorage.getItem('finno_photo_' + user.uid);
  const removeBtnEl = document.getElementById('remove-photo-btn');
  if (savedPhoto) {
    if (photoEl) { photoEl.src = savedPhoto; photoEl.style.display = 'block'; }
    if (initialsEl) initialsEl.style.display = 'none';
    if (removeBtnEl) removeBtnEl.style.display = 'flex';
  } else {
    if (photoEl) photoEl.style.display = 'none';
    if (removeBtnEl) removeBtnEl.style.display = 'none';
    const name = user.displayName || user.email || '?';
    const parts = name.split(' ');
    const initials = parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
    if (initialsEl) { initialsEl.textContent = initials; initialsEl.style.display = 'block'; }
  }

  // Plan badge
  const { getPlanState } = window;
  const state = getPlanState ? getPlanState(user.uid) : 'free';
  const badge = document.getElementById('menu-plan-badge');
  if (badge) {
    const labels = { premium:'⭐ Premium', trial:'🔬 Trial ativo', free:'🆓 Gratuito', expired:'⚠️ Trial expirado', none:'🆓 Gratuito' };
    badge.textContent = labels[state] || '🆓 Gratuito';
    badge.style.color = state === 'premium' ? 'var(--accent)' : 'var(--muted)';
    badge.style.background = state === 'premium' ? 'rgba(124,109,250,0.15)' : 'rgba(255,255,255,0.06)';
  }

  // Banks count
  const banksLabel = document.getElementById('banks-count-label');
  if (banksLabel) {
    const banks = window.connectedItems?.length || 0;
    banksLabel.textContent = banks > 0 ? banks + ' banco(s) conectado(s)' : 'Nenhum banco conectado';
  }

  // Plan sections
  const fs = document.getElementById('plan-section-free');
  const ps = document.getElementById('plan-section-premium');
  if (fs) fs.style.display = state === 'premium' ? 'none' : 'block';
  if (ps) ps.style.display = state === 'premium' ? 'block' : 'none';

  // Hide password section for non-email providers
  const isEmailUser = user.providerData.some(p => p.providerId === 'password');
  const pwdSection = document.getElementById('pwd-section');
  if (pwdSection) pwdSection.style.display = isEmailUser ? 'block' : 'none';

  document.getElementById('modal-account')?.classList.add('open');
}
window.openAccountMenu = openAccountMenu;

// ── Profile editing ───────────────────────────────────────────────
async function saveProfile() {
  const user = auth.currentUser;
  if (!user) return;
  const newName = document.getElementById('edit-name').value.trim();
  if (!newName) { toast('Informe um nome válido.', 'error'); return; }

  const btn = document.querySelector('#modal-account button[onclick="saveProfile()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvando...'; }

  try {
    await updateProfile(user, { displayName: newName });

    // Update UI immediately
    const nameEl = document.getElementById('menu-name');
    if (nameEl) nameEl.textContent = newName;
    setAvatar(user);

    // Update home greeting
    const homeNameEl = document.getElementById('home-user-name');
    if (homeNameEl) {
      const firstName = newName.split(' ')[0];
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
      homeNameEl.textContent = greeting + ', ' + firstName + ' 👋';
    }

    // Save to Firestore
    try {
      await setDoc(doc(db, 'users', user.uid), { displayName: newName }, { merge: true });
    } catch(e) { /* Firestore optional */ }

    toast('Nome atualizado! ✓', 'success');
  } catch (e) {
    toast('Erro ao salvar nome: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar nome'; }
  }
}
window.saveProfile = saveProfile;

// ── Password change (requires re-authentication) ──────────────────
async function changePassword() {
  const user = auth.currentUser;
  if (!user) return;

  const isEmailUser = user.providerData.some(p => p.providerId === 'password');
  if (!isEmailUser) {
    showPwdMsg('Sua conta usa Google ou celular. Alteração de senha não aplicável.', 'error');
    return;
  }

  const currentPwd = document.getElementById('edit-current-pwd')?.value;
  const newPwd = document.getElementById('edit-new-pwd').value;
  const confirmPwd = document.getElementById('edit-confirm-pwd').value;

  if (!newPwd) { showPwdMsg('Informe a nova senha.', 'error'); return; }
  const pwdErr = validateStrongPassword(newPwd);
  if (pwdErr) { showPwdMsg(pwdErr, 'error'); return; }
  if (newPwd !== confirmPwd) { showPwdMsg('As senhas não coincidem.', 'error'); return; }

  const btn = document.querySelector('#modal-account button[onclick="changePassword()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Alterando...'; }

  try {
    // Re-authenticate first if current password provided (required after recent sign-in gap)
    if (currentPwd) {
      const credential = EmailAuthProvider.credential(user.email, currentPwd);
      await reauthenticateWithCredential(user, credential);
    }

    await updatePassword(user, newPwd);
    showPwdMsg('Senha alterada com sucesso! ✓', 'success');
    document.getElementById('edit-new-pwd').value = '';
    document.getElementById('edit-confirm-pwd').value = '';
    if (document.getElementById('edit-current-pwd')) document.getElementById('edit-current-pwd').value = '';
  } catch (e) {
    if (e.code === 'auth/requires-recent-login' || e.code === 'auth/wrong-password') {
      showPwdMsg('Senha atual incorreta ou sessão expirada. Informe sua senha atual.', 'error');
      // Show current password field
      const curPwdWrap = document.getElementById('current-pwd-wrap');
      if (curPwdWrap) curPwdWrap.style.display = 'block';
    } else {
      showPwdMsg(firebaseErrPT(e.code) || e.message, 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Alterar senha'; }
  }
}
window.changePassword = changePassword;

function showPwdMsg(msg, type) {
  const el = document.getElementById('pwd-change-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = type === 'success' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
  el.style.color = type === 'success' ? 'var(--success)' : 'var(--danger)';
  el.style.border = type === 'success' ? '1px solid rgba(74,222,128,0.2)' : '1px solid rgba(248,113,113,0.2)';
}

// ── Photo upload ──────────────────────────────────────────────────
function triggerPhotoUpload() {
  document.getElementById('photo-upload')?.click();
}
window.triggerPhotoUpload = triggerPhotoUpload;

function handlePhotoUpload(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Foto muito grande. Máximo 5MB.', 'error'); return; }

  const user = auth.currentUser;
  if (!user) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;

    // ✅ PRODUÇÃO: salva foto em localStorage como base64 (funcional para MVP).
    // 🔜 MIGRAÇÃO FUTURA: usar Firebase Storage:
    //   const storageRef = ref(storage, `avatars/${user.uid}`);
    //   await uploadBytes(storageRef, file);
    //   const url = await getDownloadURL(storageRef);
    //   await updateProfile(user, { photoURL: url });
    //   Remover 'finno_photo_' do localStorage após migração.
    try {
      localStorage.setItem('finno_photo_' + user.uid, dataUrl);
    } catch(ex) {
      toast('Não foi possível salvar a foto (armazenamento cheio).', 'error');
      return;
    }

    // Update menu avatar
    const menuPhoto = document.getElementById('menu-photo');
    const menuInitials = document.getElementById('menu-initials');
    if (menuPhoto) { menuPhoto.src = dataUrl; menuPhoto.style.display = 'block'; }
    if (menuInitials) menuInitials.style.display = 'none';

    // Mostrar botão de remover foto
    const removeBtn = document.getElementById('remove-photo-btn');
    if (removeBtn) removeBtn.style.display = 'flex';

    // Update nav avatar
    const navAvatar = document.getElementById('nav-avatar');
    if (navAvatar) {
      navAvatar.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    }

    // Clear input for re-selection
    input.value = '';

    toast('Foto atualizada! ✓', 'success');
  };
  reader.onerror = () => toast('Erro ao carregar a foto.', 'error');
  reader.readAsDataURL(file);
}
window.handlePhotoUpload = handlePhotoUpload;

// Remove photo
function removePhoto() {
  const user = auth.currentUser;
  if (!user) return;
  localStorage.removeItem('finno_photo_' + user.uid);

  // Update menu
  const menuPhoto = document.getElementById('menu-photo');
  const menuInitials = document.getElementById('menu-initials');
  if (menuPhoto) { menuPhoto.src = ''; menuPhoto.style.display = 'none'; }
  if (menuInitials) menuInitials.style.display = 'block';

  // Esconder botão de remover foto
  const removeBtn = document.getElementById('remove-photo-btn');
  if (removeBtn) removeBtn.style.display = 'none';

  // Update nav avatar
  setAvatar(user);
  toast('Foto removida.', 'success');
}
window.removePhoto = removePhoto;

// ── Account deletion (LGPD art. 18, VI) ──────────────────────────
// Ordem segura: Auth primeiro → só apaga dados se Auth foi deletada com sucesso.
// Isso evita estado parcial (dados apagados mas conta ainda existindo).
export async function confirmDeleteAccount() {
  const user = auth.currentUser;
  if (!user) return;

  const confirmed = confirm(
    'Tem certeza? Esta ação é irreversível.\n\n' +
    'Seus dados serão apagados permanentemente: transações, metas e perfil.'
  );
  if (!confirmed) return;

  const uid = user.uid;
  const provider = user.providerData[0]?.providerId;

  // Usuários e-mail: reautenticar preventivamente para garantir sessão recente.
  // Evita que user.delete() falhe depois que os dados do Firestore já foram apagados.
  if (provider === 'password') {
    const senha = prompt('Para confirmar, informe sua senha atual:');
    if (!senha) return;
    try {
      const cred = EmailAuthProvider.credential(user.email, senha);
      await reauthenticateWithCredential(user, cred);
    } catch (e) {
      toast('Senha incorreta. Exclusão cancelada.', 'error');
      return;
    }
  }

  try {
    // Cloud Function apaga Firestore + conta Auth atomicamente via Admin SDK.
    // Admin SDK nunca requer sessão recente — elimina o risco de estado parcial
    // que existia quando user.delete() era chamado pelo cliente.
    await deleteAccountViaCloud();

    // Limpar localStorage — feito após CF pois é local e não pode falhar.
    Object.keys(localStorage)
      .filter(k => k.includes(uid))
      .forEach(k => localStorage.removeItem(k));

    // Encerrar sessão local — o token Firebase ainda existe em memória mesmo após
    // o Auth user ter sido deletado no servidor.
    await signOut(auth).catch(() => {});

    window.toast?.('Conta excluída com sucesso.', 'success');
    window.showScreen?.('screen-splash');
  } catch (e) {
    console.error('Erro ao excluir conta:', e);
    toast('Erro ao excluir conta. Tente novamente.', 'error');
  }
}
window.confirmDeleteAccount = confirmDeleteAccount;

// ── Bank navigation helper ────────────────────────────────────────
function goToBanks() {
  closeModal('modal-account');
  window.goToBankConnect?.();
}
window.goToBanks = goToBanks;
