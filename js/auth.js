// ================================================================
// auth.js — All authentication flows
// ================================================================

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
  signOut,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
  firebaseErrPT,
  saveUserProfile,
  checkCPFUnique,
  saveCPF
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
  if (!pwd) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';

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
    b.style.background = i < score ? colors[score - 1] : 'var(--surface3)';
  });
  document.getElementById('plabel').textContent = labels[score - 1] || '';
  document.getElementById('plabel').style.color = colors[score - 1] || 'var(--muted)';
}
window.checkStrength = checkStrength;

function validateStrongPassword(pwd) {
  if (pwd.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (!/[0-9]/.test(pwd)) return 'A senha deve conter pelo menos um número.';
  if (!/[^A-Za-z0-9]/.test(pwd)) return 'A senha deve conter pelo menos um caractere especial (!@#$%...).';
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

// ── Register (email) ──────────────────────────────────────────────
async function doRegister() {
  clearErr('reg-error');
  const nome = document.getElementById('reg-nome').value.trim();
  const sobrenome = document.getElementById('reg-sobrenome').value.trim();
  const cpf = document.getElementById('reg-cpf').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const senha = document.getElementById('reg-senha').value;

  if (!nome) return showErr('reg-error', 'Informe seu nome.');
  if (!cpf) return showErr('reg-error', 'Informe seu CPF.');
  if (!validateCPF(cpf)) return showErr('reg-error', 'CPF inválido. Verifique e tente novamente.');
  if (!email.includes('@')) return showErr('reg-error', 'E-mail inválido.');
  const pwdErr = validateStrongPassword(senha);
  if (pwdErr) return showErr('reg-error', pwdErr);

  const btn = document.querySelector('#auth-register .btn-primary');
  btn.disabled = true; btn.textContent = 'Verificando CPF...';

  const cpfFree = await checkCPFUnique(cpf);
  if (!cpfFree) {
    showErr('reg-error', 'Este CPF já possui uma conta cadastrada.');
    btn.disabled = false; btn.textContent = 'Criar conta';
    return;
  }

  btn.textContent = 'Criando conta...';

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, senha);
    const displayName = nome + (sobrenome ? ' ' + sobrenome : '');
    await updateProfile(cred.user, { displayName });
    await sendEmailVerification(cred.user);
    await saveUserProfile(cred.user, { displayName, provider: 'email', cpf: cpf.replace(/\D/g, '') });
    await saveCPF(cpf, cred.user.uid);
    toast('Conta criada! Verifique seu e-mail para confirmar.', 'success');
  } catch (e) {
    showErr('reg-error', firebaseErrPT(e.code));
    btn.disabled = false; btn.textContent = 'Criar conta';
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
  btn.disabled = true; btn.textContent = 'Entrando...';

  try {
    await signInWithEmailAndPassword(auth, email, senha);
    // onAuthStateChanged in app.js handles navigation
  } catch (e) {
    showErr('login-error', firebaseErrPT(e.code));
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}
window.doLogin = doLogin;

// ── Google auth ───────────────────────────────────────────────────
async function authGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const cred = await signInWithPopup(auth, provider);
    await saveUserProfile(cred.user, { provider: 'google' });
    // onAuthStateChanged handles navigation
  } catch (e) {
    if (e.code !== 'auth/popup-closed-by-user') {
      toast(firebaseErrPT(e.code), 'error');
    }
  }
}
window.authGoogle = authGoogle;

// ── Phone auth (SMS) ──────────────────────────────────────────────
let confirmationResult = null;

async function sendSMS() {
  clearErr('phone-error');
  const cpf = document.getElementById('phone-cpf')?.value.trim() || '';
  const nome = document.getElementById('phone-nome')?.value.trim() || '';
  const ddi = document.getElementById('phone-ddi').value;
  const num = document.getElementById('phone-number').value.replace(/\D/g, '');

  if (!cpf) return showErr('phone-error', 'Informe seu CPF.');
  if (!validateCPF(cpf)) return showErr('phone-error', 'CPF inválido.');
  if (!nome) return showErr('phone-error', 'Informe seu nome.');
  if (num.length < 8) return showErr('phone-error', 'Número de celular inválido.');

  window._pendingCPF = cpf;
  window._pendingName = nome + ' ' + (document.getElementById('phone-sobrenome')?.value.trim() || '');

  const cpfFree = await checkCPFUnique(cpf);
  if (!cpfFree) return showErr('phone-error', 'Este CPF já possui uma conta cadastrada. Faça login.');

  const fullPhone = ddi + num;
  const btn = document.querySelector('#auth-phone .btn-primary');
  btn.disabled = true; btn.textContent = 'Enviando SMS...';

  try {
    if (!window.recaptchaVerifier) {
      window.recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
        size: 'invisible',
        callback: () => {}
      });
    }
    confirmationResult = await signInWithPhoneNumber(auth, fullPhone, window.recaptchaVerifier);
    document.getElementById('otp-sub').textContent = 'Enviamos um SMS real para ' + fullPhone + '.';
    showView('auth-otp');
    setTimeout(() => document.querySelector('.otp-input').focus(), 100);
    toast('SMS enviado!', 'success');
  } catch (e) {
    showErr('phone-error', firebaseErrPT(e.code));
    btn.disabled = false; btn.textContent = 'Enviar código SMS';
    if (window.recaptchaVerifier) {
      window.recaptchaVerifier.clear();
      window.recaptchaVerifier = null;
    }
  }
}
window.sendSMS = sendSMS;

async function verifyOTP() {
  const code = Array.from(document.querySelectorAll('.otp-input')).map(i => i.value).join('');
  clearErr('otp-error');
  if (code.length < 6) return;
  if (!confirmationResult) return showErr('otp-error', 'Sessão expirada. Solicite novo código.');

  const btn = document.querySelector('#auth-otp .btn-primary');
  btn.disabled = true; btn.textContent = 'Verificando...';

  try {
    const cred = await confirmationResult.confirm(code);
    const displayName = window._pendingName || '';
    if (displayName) await updateProfile(cred.user, { displayName });
    await saveUserProfile(cred.user, { provider: 'phone', displayName, cpf: (window._pendingCPF || '').replace(/\D/g, '') });
    if (window._pendingCPF) await saveCPF(window._pendingCPF, cred.user.uid);
    window._pendingCPF = null; window._pendingName = null;
    // onAuthStateChanged handles navigation
  } catch (e) {
    showErr('otp-error', firebaseErrPT(e.code));
    document.querySelectorAll('.otp-input').forEach(i => { i.value = ''; i.classList.add('shake'); });
    setTimeout(() => document.querySelectorAll('.otp-input').forEach(i => i.classList.remove('shake')), 500);
    document.querySelector('.otp-input').focus();
    btn.disabled = false; btn.textContent = 'Verificar e entrar';
  }
}
window.verifyOTP = verifyOTP;

function otpNext(input, idx) {
  input.value = input.value.replace(/[^0-9]/g, '');
  if (input.value && idx < 5) document.querySelectorAll('.otp-input')[idx + 1].focus();
  if (idx === 5 && input.value) verifyOTP();
}
window.otpNext = otpNext;

function otpBack(e, input, idx) {
  if (e.key === 'Backspace' && !input.value && idx > 0) {
    document.querySelectorAll('.otp-input')[idx - 1].focus();
  }
}
window.otpBack = otpBack;

// ── Forgot password ───────────────────────────────────────────────
async function doForgot() {
  clearErr('forgot-error');
  const email = document.getElementById('forgot-email').value.trim();
  if (!email.includes('@')) return showErr('forgot-error', 'Informe um e-mail válido.');

  const btn = document.querySelector('#auth-forgot .btn-primary');
  btn.disabled = true; btn.textContent = 'Enviando...';

  try {
    await sendPasswordResetEmail(auth, email);
    document.getElementById('forgot-msg').textContent = '✓ Link enviado para ' + email + '. Verifique sua caixa de entrada.';
    document.getElementById('forgot-msg').style.display = 'block';
    document.getElementById('forgot-email').value = '';
  } catch (e) {
    showErr('forgot-error', firebaseErrPT(e.code));
  } finally {
    btn.disabled = false; btn.textContent = 'Enviar link';
  }
}
window.doForgot = doForgot;

// ── Logout ────────────────────────────────────────────────────────
async function doLogout() {
  try {
    const uid = auth.currentUser?.uid;
    closeModal('modal-logout');
    closeModal('modal-account');
    window.connectedItems = [];
    if (uid) localStorage.removeItem('finno_banks_' + uid);
    await signOut(auth);
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    ['step1', 'step2', 'step3', 'step4', 'step5'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('active', 'done');
        const icon = el.querySelector('.step-icon');
        if (icon) icon.textContent = ['🔐', '🏦', '📊', '🤖', '✨'][['step1','step2','step3','step4','step5'].indexOf(id)];
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
  inp.type = inp.type === 'password' ? 'text' : 'password';
  icon.textContent = inp.type === 'password' ? '👁' : '🙈';
}
window.togglePwd = togglePwd;

// ── Profile editing ───────────────────────────────────────────────
async function saveProfile() {
  const user = auth.currentUser;
  if (!user) return;
  const newName = document.getElementById('edit-name').value.trim();
  if (!newName) { toast('Informe um nome válido.', 'error'); return; }

  try {
    await updateProfile(user, { displayName: newName });
    document.getElementById('menu-name').textContent = newName;
    setAvatar(user);
    await setDoc(doc(db, 'users', user.uid), { displayName: newName }, { merge: true });
    toast('Nome atualizado com sucesso! ✓', 'success');
  } catch (e) {
    toast('Erro ao salvar nome: ' + e.message, 'error');
  }
}
window.saveProfile = saveProfile;

async function changePassword() {
  const user = auth.currentUser;
  if (!user) return;

  const newPwd = document.getElementById('edit-new-pwd').value;
  const confirmPwd = document.getElementById('edit-confirm-pwd').value;

  if (!newPwd) { showPwdMsg('Informe a nova senha.', 'error'); return; }
  const pwdErr = validateStrongPassword(newPwd);
  if (pwdErr) { showPwdMsg(pwdErr, 'error'); return; }
  if (newPwd !== confirmPwd) { showPwdMsg('As senhas não coincidem.', 'error'); return; }

  const isEmailUser = user.providerData.some(p => p.providerId === 'password');
  if (!isEmailUser) {
    showPwdMsg('Sua conta usa login pelo Google ou celular. Alteração de senha não aplicável.', 'error');
    return;
  }

  try {
    const { updatePassword } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    await updatePassword(user, newPwd);
    showPwdMsg('Senha alterada com sucesso! ✓', 'success');
    document.getElementById('edit-new-pwd').value = '';
    document.getElementById('edit-confirm-pwd').value = '';
  } catch (e) {
    if (e.code === 'auth/requires-recent-login') {
      showPwdMsg('Por segurança, faça logout e login novamente antes de alterar a senha.', 'error');
    } else {
      showPwdMsg('Erro: ' + (firebaseErrPT(e.code) || e.message), 'error');
    }
  }
}
window.changePassword = changePassword;

function showPwdMsg(msg, type) {
  const el = document.getElementById('pwd-change-msg');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = type === 'success' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)';
  el.style.color = type === 'success' ? 'var(--success)' : 'var(--danger)';
  el.style.border = type === 'success' ? '1px solid rgba(74,222,128,0.2)' : '1px solid rgba(248,113,113,0.2)';
}

// ── Photo upload ──────────────────────────────────────────────────
function triggerPhotoUpload() {
  document.getElementById('photo-upload').click();
}
window.triggerPhotoUpload = triggerPhotoUpload;

function handlePhotoUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('Imagem muito grande. Use até 2MB.', 'error'); return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const user = auth.currentUser;
    if (user) localStorage.setItem('finno_photo_' + user.uid, dataUrl);

    const photoEl = document.getElementById('menu-photo');
    const initialsEl = document.getElementById('menu-initials');
    const navAvatar = document.getElementById('nav-avatar');

    photoEl.src = dataUrl;
    photoEl.style.display = 'block';
    if (initialsEl) initialsEl.style.display = 'none';
    if (navAvatar) {
      navAvatar.innerHTML = `<img src="${dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    }
    toast('Foto atualizada! ✓', 'success');
  };
  reader.readAsDataURL(file);
}
window.handlePhotoUpload = handlePhotoUpload;

// ── Account menu ──────────────────────────────────────────────────
function openAccountMenu() {
  const user = auth.currentUser;
  if (!user) return;

  const name = user.displayName || user.email?.split('@')[0] || 'Usuário';
  const email = user.email || user.phoneNumber || '';
  const parts = name.trim().split(' ');
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();

  document.getElementById('menu-initials').textContent = initials;
  document.getElementById('menu-name').textContent = name;
  document.getElementById('menu-email').textContent = email;
  document.getElementById('edit-name').value = name;

  const photoEl = document.getElementById('menu-photo');
  const initialsEl = document.getElementById('menu-initials');
  const savedPhoto = localStorage.getItem('finno_photo_' + user.uid);
  if (user.photoURL || savedPhoto) {
    photoEl.src = savedPhoto || user.photoURL;
    photoEl.style.display = 'block';
    initialsEl.style.display = 'none';
  } else {
    photoEl.style.display = 'none';
    initialsEl.style.display = 'flex';
  }

  const uid = user.uid;
  const plan = localStorage.getItem('finno_plan_' + uid) || 'free';
  const badge = document.getElementById('menu-plan-badge');
  if (badge) {
    badge.textContent = plan === 'premium' ? '⭐ Premium' : '🆓 Gratuito';
    badge.style.background = plan === 'premium' ? 'rgba(124,109,250,0.15)' : 'rgba(255,255,255,0.06)';
    badge.style.color = plan === 'premium' ? 'var(--accent)' : 'var(--muted)';
  }

  document.getElementById('plan-section-free').style.display = plan === 'free' ? 'block' : 'none';
  document.getElementById('plan-section-premium').style.display = plan === 'premium' ? 'block' : 'none';

  const banksLabel = document.getElementById('banks-count-label');
  const ci = window.connectedItems || [];
  if (banksLabel) banksLabel.textContent = ci.length > 0 ? `${ci.length} banco(s) conectado(s)` : 'Nenhum banco conectado';

  const banksItem = document.getElementById('banks-menu-item');
  if (banksItem) banksItem.style.display = plan === 'free' ? 'none' : 'flex';

  document.getElementById('edit-new-pwd').value = '';
  document.getElementById('edit-confirm-pwd').value = '';
  document.getElementById('pwd-change-msg').style.display = 'none';

  document.getElementById('modal-account').classList.add('open');
}
window.openAccountMenu = openAccountMenu;

// ── Confirm logout / cancel premium ──────────────────────────────
function confirmLogout() {
  closeModal('modal-account');
  setTimeout(() => document.getElementById('modal-logout').classList.add('open'), 200);
}
window.confirmLogout = confirmLogout;

function goToBanks() {
  closeModal('modal-account');
  const uid = auth.currentUser?.uid;
  const plan = localStorage.getItem('finno_plan_' + uid) || 'free';
  if (plan === 'free') {
    window.showUpgrade?.('Conecte seus bancos automaticamente com o Finno Premium por apenas R$ 19,90/mês.');
  } else {
    showScreen('screen-connect');
  }
}
window.goToBanks = goToBanks;
