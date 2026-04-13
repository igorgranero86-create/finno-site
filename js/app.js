// ================================================================
// app.js — Entry point: onAuthStateChanged, navigation, helpers,
//           onboarding, PWA service worker + install prompt
// ================================================================

import { auth, onAuthStateChanged, getPlanState } from './api.js';
import './auth.js';
import {
  buildDashboard, applyPlanUI, runLoadingSequence,
  showConnectState, maybeShowSimTease, currentPlan
} from './dashboard.js';

// ── Screen / view navigation ──────────────────────────────────────
export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}
window.showScreen = showScreen;

export function showView(id) {
  ['auth-register','auth-login','auth-phone','auth-otp','auth-forgot'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById(id);
  if (el) el.style.display = 'block';
}
window.showView = showView;

// ── UI helpers ────────────────────────────────────────────────────
export function toast(msg, type = 'success') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.className = '', 3200);
}
window.toast = toast;

export function setBtn(id, loading, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = loading;
  el.textContent = loading ? 'Aguarde...' : text;
}
window.setBtn = setBtn;

export function showErr(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}
window.showErr = showErr;

export function clearErr(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}
window.clearErr = clearErr;

export function setAvatar(user) {
  const el = document.getElementById('nav-avatar');
  if (!el) return;
  const name = user.displayName || user.email || user.phoneNumber || '?';
  const parts = name.split(' ');
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
  el.textContent = initials;
  // Restore saved photo if available
  const savedPhoto = localStorage.getItem('finno_photo_' + user.uid);
  if (savedPhoto) {
    el.innerHTML = `<img src="${savedPhoto}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  }
}
window.setAvatar = setAvatar;

// ── Auth state observer ───────────────────────────────────────────
onAuthStateChanged(auth, user => {
  const loader = document.getElementById('app-loading');

  if (user) {
    setAvatar(user);
    const uid = user.uid;

    // Developer always gets premium
    if (['igorgranero86@gmail.com'].includes(user.email)) {
      localStorage.setItem('finno_plan_' + uid, 'premium');
      localStorage.setItem('finno_setup_' + uid, '1');
    }

    const state = getPlanState(uid);
    const setupDone = localStorage.getItem('finno_setup_' + uid);

    if (!setupDone && state === 'none') {
      showScreen('screen-plan');
      setTimeout(maybeShowSimTease, 100);
    } else if (setupDone) {
      showScreen('screen-loading');
      runLoadingSequence(() => {
        showScreen('screen-dashboard');
        buildDashboard();
        applyPlanUI(state);
      });
    } else {
      showScreen('screen-connect');
      showConnectState(state, uid);
    }
  } else {
    const seen = localStorage.getItem('finno_onboarding_done');
    if (!seen) {
      showScreen('screen-onboarding');
      initOnboarding();
    } else {
      showScreen('screen-splash');
    }
  }

  if (loader) {
    loader.classList.add('hide');
    setTimeout(() => loader.style.display = 'none', 500);
  }
});

// ── Onboarding ────────────────────────────────────────────────────
let obCurrent = 0;
const OB_TOTAL = 3;

export function initOnboarding() {
  obCurrent = 0;
  updateObUI();
  initObSwipe();
}
window.initOnboarding = initOnboarding;

export function obNext() {
  if (obCurrent < OB_TOTAL - 1) {
    goToSlide(obCurrent + 1);
  } else {
    obFinish();
  }
}
window.obNext = obNext;

function obSkip() { obFinish(); }
window.obSkip = obSkip;

export function goToSlide(idx) {
  obCurrent = Math.max(0, Math.min(OB_TOTAL - 1, idx));
  updateObUI();
}
window.goToSlide = goToSlide;

function updateObUI() {
  const track = document.getElementById('ob-track');
  if (track) track.style.transform = 'translateX(-' + (obCurrent * 33.333) + '%)';

  const dots = document.querySelectorAll('.ob-dot');
  dots.forEach((d, i) => {
    d.classList.toggle('active', i === obCurrent);
    d.style.width = i === obCurrent ? '22px' : '7px';
  });

  const btn = document.getElementById('ob-btn');
  const skip = document.getElementById('ob-skip');
  if (btn) {
    if (obCurrent === OB_TOTAL - 1) {
      btn.textContent = '✦ Começar agora';
      btn.style.background = 'linear-gradient(135deg, #006644, #00c896)';
      btn.style.boxShadow = '0 8px 32px rgba(0,180,120,0.4)';
    } else {
      btn.textContent = 'Próximo →';
      btn.style.background = 'linear-gradient(135deg, #003d99, #0066ff)';
      btn.style.boxShadow = '0 8px 32px rgba(0,90,220,0.35)';
    }
  }
  if (skip) skip.style.opacity = obCurrent === OB_TOTAL - 1 ? '0' : '1';

  const blob1 = document.getElementById('blob1');
  const blob2 = document.getElementById('blob2');
  if (blob1 && blob2) {
    const blobPositions = [
      { b1: 'top:-80px;right:-60px', b2: 'bottom:100px;left:-80px' },
      { b1: 'top:50%;right:-80px',   b2: 'bottom:-60px;left:20px'  },
      { b1: 'top:20px;left:-40px',   b2: 'bottom:80px;right:-60px' },
    ];
    blob1.style.cssText = 'position:absolute;border-radius:50%;opacity:0.18;pointer-events:none;width:300px;height:300px;background:radial-gradient(circle,#003d99,transparent);' + blobPositions[obCurrent].b1;
    blob2.style.cssText = 'position:absolute;border-radius:50%;opacity:0.15;pointer-events:none;width:250px;height:250px;background:radial-gradient(circle,#00c896,transparent);' + blobPositions[obCurrent].b2;
  }

  document.querySelectorAll('.ob-slide').forEach((s, i) => {
    s.classList.toggle('entering', i === obCurrent);
  });
}
window.updateObUI = updateObUI;

export function obFinish() {
  localStorage.setItem('finno_onboarding_done', '1');
  showScreen('screen-splash');
}
window.obFinish = obFinish;

function initObSwipe() {
  const el = document.getElementById('screen-onboarding');
  if (!el) return;
  let startX = 0, startY = 0;

  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      if (dx < 0 && obCurrent < OB_TOTAL - 1) goToSlide(obCurrent + 1);
      if (dx > 0 && obCurrent > 0) goToSlide(obCurrent - 1);
    }
  }, { passive: true });

  document.addEventListener('keydown', e => {
    if (document.querySelector('#screen-onboarding.active')) {
      if (e.key === 'ArrowRight') obNext();
      if (e.key === 'ArrowLeft' && obCurrent > 0) goToSlide(obCurrent - 1);
    }
  });
}
window.initObSwipe = initObSwipe;

// ── PWA: service worker + install prompt ──────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let deferredPrompt;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  const banner = document.getElementById('install-banner');
  if (banner) banner.style.display = 'flex';
});

function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(() => {
    deferredPrompt = null;
    const banner = document.getElementById('install-banner');
    if (banner) banner.style.display = 'none';
  });
}
window.installApp = installApp;

// ── Modal backdrop close ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m) m.classList.remove('open');
    });
  });
});
