// ================================================================
// dashboard.js — Dashboard rendering, charts, transactions, goals,
//                categories, insights, simulation, home panel,
//                plan management, Pluggy integration
// ================================================================

import {
  auth, db,
  doc, setDoc,
  getPlanState, getTrialDaysLeft, getBankLimit, hasAI, hasBanks,
  getPluggyConnectToken, savePlanToFirestore, recordEngagementViaCloud,
  createCheckoutSessionViaCloud
} from './api.js';

// ── DOM helpers (resolved via window, set by app.js) ─────────────
function showScreen(id) { window.showScreen?.(id); }
function toast(msg, type = 'success') { window.toast?.(msg, type); }
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
window.closeModal = closeModal;

// ── Global state ──────────────────────────────────────────────────
export let currentPlan = 'free';
window.connectedItems = window.connectedItems || [];

// ── Trial eligibility rules ───────────────────────────────────────
// Controla quando o trial de 7 dias pode ser ativado.
// Regra: ≥3 lançamentos manuais OU ≥1 meta.
// Chave isolada por uid para evitar vazamento entre usuários no mesmo browser.

function trialRulesKey() {
  const uid = auth.currentUser?.uid;
  if (!uid) return null;
  return 'finno_trial_rules_' + uid;
}

function getTrialRules() {
  const key = trialRulesKey();
  if (!key) return { manualEntriesCount: 0, goalsCount: 0, trialUnlocked: false };
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {
      manualEntriesCount: 0, goalsCount: 0, trialUnlocked: false
    };
  } catch (e) {
    return { manualEntriesCount: 0, goalsCount: 0, trialUnlocked: false };
  }
}

function saveTrialRules(rules) {
  const key = trialRulesKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(rules));
}

function evaluateTrialEligibility() {
  const rules = getTrialRules();
  const eligible = rules.manualEntriesCount >= 3 || rules.goalsCount >= 1;
  rules.trialUnlocked = eligible;
  saveTrialRules(rules);
  return eligible;
}
window.evaluateTrialEligibility = evaluateTrialEligibility;

function incrementManualEntriesCount() {
  const rules = getTrialRules();
  rules.manualEntriesCount += 1;
  saveTrialRules(rules);
  evaluateTrialEligibility();
}

function incrementGoalsCount() {
  const rules = getTrialRules();
  rules.goalsCount += 1;
  saveTrialRules(rules);
  evaluateTrialEligibility();
}

function showTrialLockedMessage() {
  const rules = getTrialRules();
  const rem = Math.max(0, 3 - rules.manualEntriesCount);
  const msg = rules.goalsCount === 0 && rem > 0
    ? `Crie ${rem} lançamento${rem > 1 ? 's' : ''} ou 1 meta para liberar seu teste grátis de 7 dias.`
    : 'Crie 3 lançamentos ou 1 meta para liberar seu teste grátis de 7 dias.';
  toast(msg, 'error');
}

function updateTrialButtonUI() {
  const eligible = evaluateTrialEligibility();
  const btn  = document.getElementById('start-trial-btn');
  const hint = document.getElementById('trial-eligibility-hint');
  if (btn) {
    btn.textContent = eligible ? '🚀 Testar grátis por 7 dias →' : '🔒 Desbloquear teste grátis →';
    btn.style.opacity = eligible ? '1' : '0.72';
  }
  if (hint) {
    if (eligible) {
      hint.textContent = '✓ Você desbloqueou o trial — clique para ativar!';
      hint.style.color = 'var(--success)';
    } else {
      const rules = getTrialRules();
      const rem = Math.max(0, 3 - rules.manualEntriesCount);
      hint.textContent = `Crie 1 meta ou ${rem} lançamento${rem !== 1 ? 's' : ''} para liberar.`;
      hint.style.color = 'var(--muted)';
    }
  }
}
window.updateTrialButtonUI = updateTrialButtonUI;

export function handleTrialUnlockFlow() {
  const eligible = evaluateTrialEligibility();
  if (eligible) {
    startTrial();
  } else {
    showTrialLockedMessage();
    updateTrialButtonUI(); // atualizar visual do botão/hint
  }
}
window.handleTrialUnlockFlow = handleTrialUnlockFlow;

// ── User data (starts empty, loaded from localStorage) ────────────
let transactions = [];   // user's manual + real transactions
let goals = [];          // user's goals

// ── Demo data (simulation screen only) ───────────────────────────
// (dados de demonstração removidos — usar apenas dados reais via Pluggy)

// ── Persist user data ─────────────────────────────────────────────
// ✅ PRODUÇÃO: localStorage funciona como cache offline-first para MVP.
// 🔜 MIGRAÇÃO FUTURA: substituir localStorage por Firestore subcollections:
//   users/{uid}/transactions/{txId}  e  users/{uid}/goals/{goalId}
//   Manter localStorage como cache local após a migração.
function saveTransactions() {
  const uid = auth.currentUser?.uid;
  if (uid) localStorage.setItem('finno_tx_' + uid, JSON.stringify(transactions));
  _insightsCache = null; // invalidar cache ao salvar
  // 🔜 MIGRAÇÃO FUTURA: await setDoc(doc(db,'users',uid,'transactions',tx.id), tx)
}

function saveGoals() {
  const uid = auth.currentUser?.uid;
  if (uid) localStorage.setItem('finno_goals_' + uid, JSON.stringify(goals));
  // 🔜 MIGRAÇÃO FUTURA: await setDoc(doc(db,'users',uid,'goals',goal.id), goal)
}

export function loadUserData() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  // 🔜 MIGRAÇÃO FUTURA: getDocs(collection(db,'users',uid,'transactions')) + cache em localStorage
  try {
    const txRaw = localStorage.getItem('finno_tx_' + uid);
    transactions = txRaw ? JSON.parse(txRaw) : [];
    // Migração lazy: adicionar id a transações antigas
    let _needsIdMigration = false;
    transactions.forEach(t => { if (!t.id) { t.id = _genId(); _needsIdMigration = true; } });
    if (_needsIdMigration) saveTransactions();
    const goalsRaw = localStorage.getItem('finno_goals_' + uid);
    const rawGoals = goalsRaw ? JSON.parse(goalsRaw) : [];
    // Descartar metas do schema antigo (sem campo 'type') — decisão confirmada pelo usuário
    goals = rawGoals.filter(g => g.type !== undefined);
  } catch(e) {
    transactions = [];
    goals = [];
  }
  // FASE 6: sincronizar selects com categorias customizadas após carregar dados
  // (buildCatSelects é definida mais abaixo, usa hoisting via window)
  setTimeout(() => { if (typeof buildCatSelects === 'function') buildCatSelects(); }, 0);
}
window.loadUserData = loadUserData;

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Retorna data local no formato YYYY-MM-DD sem depender de UTC.
// toISOString() usa UTC — no Brasil (UTC-3) às 22h já seria "amanhã" em UTC.
function _localDateStr(d) {
  const dt = d || new Date();
  const y  = dt.getFullYear();
  const m  = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ── Computed data helpers ─────────────────────────────────────────
function calcBalance() {
  // Mesmas exclusões de calcIncome/calcExpenses: transferências internas e ocultas ficam fora
  return transactions
    .filter(t => !t.isTransfer && !t.hidden)
    .reduce((s, t) => s + (t.amount || 0), 0);
}

function calcIncome(txList) {
  // Transferências internas e ocultas ficam fora dos totais
  return txList.filter(t => t.amount > 0 && !t.isTransfer && !t.hidden).reduce((s, t) => s + t.amount, 0);
}

function calcExpenses(txList) {
  return txList.filter(t => t.amount < 0 && !t.isTransfer && !t.hidden).reduce((s, t) => s + Math.abs(t.amount), 0);
}

function filterTxMonth(txList) {
  const now = new Date();
  return txList.filter(t => {
    const d = new Date((t.date || '').split('T')[0] + 'T00:00:00');
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
}

// ── Loading sequence ──────────────────────────────────────────────
export function runLoadingSequence(callback) {
  const steps = ['step1','step2','step3','step4','step5'];
  const progresses = [15, 35, 60, 80, 100];
  const fill = document.getElementById('progress-fill');
  let i = 0;

  function next() {
    if (i > 0) {
      const prev = document.getElementById(steps[i - 1]);
      if (prev) {
        prev.classList.remove('active');
        prev.classList.add('done');
        const icon = prev.querySelector('.step-icon');
        if (icon) icon.textContent = '✓';
      }
    }
    if (i < steps.length) {
      const cur = document.getElementById(steps[i]);
      if (cur) cur.classList.add('active');
      if (fill) fill.style.width = progresses[i] + '%';
      i++;
      setTimeout(next, 900 + Math.random() * 400);
    } else {
      if (fill) fill.style.width = '100%';
      setTimeout(() => { if (callback) callback(); }, 600);
    }
  }
  next();
}
window.runLoadingSequence = runLoadingSequence;

// ── Build dashboard ───────────────────────────────────────────────
export function buildDashboard() {
  if (window._pendingPaymentToast) {
    const isSuccess = window._pendingPaymentToast === 'success';
    const msg = isSuccess ? 'Pagamento recebido! Seu plano será ativado em instantes.' : 'Pagamento cancelado.';
    setTimeout(() => toast(msg, isSuccess ? 'success' : 'info'), 600);
    delete window._pendingPaymentToast;
  }
  loadUserData();
  processRecurring();
  buildHomePanel();
  buildChart();
  buildTransactions();
  buildCategories();
  buildBudgetWidget();
  buildGoals();
  buildInsights();
}
window.buildDashboard = buildDashboard;

export function buildChart() {
  const el = document.getElementById('bar-chart');
  if (!el) return;

  // Build chart from actual transactions grouped by month
  const now = new Date();
  const monthData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString('pt-BR', { month: 'short' });
    const monthTx = transactions.filter(t => {
      const td = new Date((t.date || '').split('T')[0] + 'T00:00:00');
      return td.getMonth() === d.getMonth() && td.getFullYear() === d.getFullYear();
    });
    monthData.push({
      month: label.charAt(0).toUpperCase() + label.slice(1, 3),
      income: calcIncome(monthTx),
      expense: calcExpenses(monthTx)
    });
  }

  const maxVal = Math.max(...monthData.map(d => Math.max(d.income, d.expense)), 1);
  el.innerHTML = monthData.map(d => {
    const ih = Math.round((d.income / maxVal) * 100);
    const eh = Math.round((d.expense / maxVal) * 100);
    return `<div class="bar-col">
      <div class="bar-wrap" style="display:flex;align-items:flex-end;gap:3px;width:100%;height:100%">
        <div class="bar income" style="height:${Math.max(ih,2)}%;flex:1;min-height:4px"></div>
        <div class="bar expense" style="height:${Math.max(eh,2)}%;flex:1;min-height:4px"></div>
      </div>
      <div class="bar-month">${d.month}</div>
    </div>`;
  }).join('');
}
window.buildChart = buildChart;

export function buildTransactions() {
  buildBankFilter();          // FASE 8: atualiza filtro de banco dinamicamente
  renderTransactions(transactions);
  buildRecurringList();
}
window.buildTransactions = buildTransactions;

export function buildCategories() {
  filterCategoriesByPeriod();
  buildBudgetWidget();
}
window.buildCategories = buildCategories;

export function buildGoals() {
  const grid = document.getElementById('goals-grid');
  const limitLabel = document.getElementById('goals-limit-label');
  const newBtn = document.getElementById('btn-new-goal');
  if (!grid) return;

  // Free/Plus: max 3 metas | Pro/Premium/Trial: ilimitado (cap 20)
  const limit = ['pro','premium','trial'].includes(currentPlan) ? 20 : 3;

  if (goals.length === 0) {
    if (limitLabel) limitLabel.textContent = '0 metas';
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--muted)">
      <div style="font-size:2.5rem;margin-bottom:12px">🎯</div>
      <div style="font-size:0.9rem;font-weight:600;margin-bottom:6px;color:var(--text2)">Nenhuma meta ainda</div>
      <div style="font-size:0.8rem">Clique em <b style="color:var(--accent)">+ Nova</b> para criar sua primeira meta financeira.</div>
    </div>`;
    if (newBtn) { newBtn.style.opacity = '1'; newBtn.style.pointerEvents = 'auto'; }
    return;
  }

  if (limitLabel) limitLabel.textContent = `${goals.length}/${limit} metas`;
  if (newBtn) {
    newBtn.style.opacity = goals.length >= limit ? '0.4' : '1';
    newBtn.style.pointerEvents = goals.length >= limit ? 'none' : 'auto';
    newBtn.title = goals.length >= limit ? `Limite de ${limit} metas atingido` : '';
  }

  const visible = goals.slice(0, limit);

  grid.innerHTML = visible.map((g, i) => {
    const pct = Math.min(Math.round((g.current / g.target) * 100), 100);
    const r = 30, circ = 2 * Math.PI * r;
    const dash = (pct / 100) * circ;
    const deadline = g.endDate || g.deadline || null; // suporte ao campo antigo
    const deadlineStr = deadline ? `<div style="font-size:0.7rem;color:var(--muted);margin-top:4px">📅 ${new Date(deadline + 'T00:00:00').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'})}</div>` : '';
    const daysLeft = deadline ? Math.ceil((new Date(deadline + 'T00:00:00') - new Date()) / 86400000) : null;
    const typeLabels = { casamento:'💍 Casamento', viagem:'✈️ Viagem', casa:'🏠 Casa', carro:'🚗 Carro', estudo:'📚 Estudo', outros:'🎯 Outros' };
    const typeStr = g.type ? `<div style="font-size:0.68rem;color:var(--muted);margin-top:2px">${typeLabels[g.type]||''}</div>` : '';
    const urgency = daysLeft !== null && daysLeft < 30 ? 'var(--warning)' : (g.color || 'var(--accent)');
    return `<div class="goal-card" onclick="openGoalDetail(${i})" style="cursor:pointer;transition:all 0.2s" onmouseover="this.style.borderColor='${g.color||'var(--accent)'}';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border)';this.style.transform='none'">
      <div class="icon">${g.icon || '🎯'}</div>
      <div class="gname">${g.name}</div>
      ${typeStr}
      <div class="gtarget">Meta: R$ ${g.target.toLocaleString('pt-BR')}</div>
      ${deadlineStr}
      <div class="goal-ring">
        <svg width="70" height="70" viewBox="0 0 70 70">
          <circle cx="35" cy="35" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
          <circle cx="35" cy="35" r="${r}" fill="none" stroke="${urgency}" stroke-width="5"
            stroke-dasharray="${dash} ${circ - dash}" stroke-linecap="round" transform="rotate(-90 35 35)"/>
        </svg>
        <div class="pct-text">${pct}%</div>
      </div>
      <div style="font-size:0.75rem;color:var(--muted);text-align:center;margin-top:4px">
        R$ ${g.current.toLocaleString('pt-BR')} <span style="color:var(--muted)">de</span> R$ ${g.target.toLocaleString('pt-BR')}
      </div>
      ${daysLeft !== null ? `<div style="font-size:0.7rem;text-align:center;margin-top:4px;color:${daysLeft < 30 ? 'var(--warning)' : 'var(--muted)'}">
        ${daysLeft > 0 ? daysLeft + ' dias restantes' : daysLeft === 0 ? 'Vence hoje!' : 'Prazo encerrado'}
      </div>` : ''}
    </div>`;
  }).join('');

  if (goals.length >= limit && ['free','none','plus'].includes(currentPlan)) {
    grid.innerHTML += `<div style="grid-column:1/-1;background:rgba(124,109,250,0.06);border:1px dashed rgba(124,109,250,0.3);border-radius:16px;padding:20px;text-align:center;cursor:pointer" onclick="showUpgrade('Metas ilimitadas a partir do plano Pro por R$ 14,90/mês.')">
      <div style="font-size:1.2rem;margin-bottom:8px">🔒</div>
      <div style="font-size:0.82rem;font-weight:600;margin-bottom:4px">Limite de 3 metas nos planos Free e Plus</div>
      <div style="font-size:0.75rem;color:var(--muted)">Faça upgrade para o Pro e tenha metas ilimitadas</div>
    </div>`;
  }
}
window.buildGoals = buildGoals;

export function buildInsights() {
  const list = document.getElementById('insights-list');
  if (!list) return;

  // Free/expired plan: show paywall
  if (!hasAI(currentPlan)) {
    const ic = document.getElementById('insights-content');
    const pi = document.getElementById('paywall-insights');
    if (ic) ic.style.display = 'none';
    // Garante que o paywall não cubra o tab-bar (pointer-events apenas no conteúdo)
    if (pi) { pi.style.display = 'flex'; pi.style.pointerEvents = 'none'; }
    return;
  }

  // No transactions yet
  if (transactions.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--muted)">
      <div style="font-size:2.5rem;margin-bottom:12px">💡</div>
      <div style="font-size:0.9rem;font-weight:600;margin-bottom:6px;color:var(--text2)">Ainda sem dados suficientes</div>
      <div style="font-size:0.8rem;line-height:1.6">Adicione suas transações ou conecte um banco para ver insights personalizados.</div>
    </div>`;
    const scoreEl = document.getElementById('health-score');
    if (scoreEl) scoreEl.textContent = '--';
    return;
  }

  const generated = generateInsights();
  const score = generated.score;

  const scoreEl = document.getElementById('health-score');
  const labelEl = document.getElementById('health-label');
  const subEl   = document.getElementById('health-sub');
  const barEl   = document.getElementById('health-bar');
  if (scoreEl) { scoreEl.textContent = score; scoreEl.style.color = score >= 75 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--danger)'; }
  if (labelEl) { const l = score>=80?'🟢 Excelente!':score>=65?'🟡 Boa':score>=50?'🟠 Regular':'🔴 Atenção'; labelEl.textContent = l; }
  if (subEl)   { subEl.textContent = generated.scoreSub; }
  if (barEl)   { setTimeout(() => barEl.style.width = score + '%', 300); }

  list.innerHTML = generated.insights.map((ins, i) => `
    <div class="insight-card" style="border-left:3px solid ${ins.color};margin-bottom:10px;animation:fadeIn 0.35s ${i*0.06}s ease both;opacity:0">
      <div class="insight-icon">${ins.icon}</div>
      <div class="insight-content">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
          <h4 style="font-size:0.86rem;line-height:1.3">${ins.title}</h4>
          <span style="font-size:0.62rem;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);padding:2px 7px;border-radius:99px;color:var(--muted);white-space:nowrap;flex-shrink:0">${ins.tag}</span>
        </div>
        <p style="font-size:0.79rem;line-height:1.5;color:var(--muted)">${ins.text}</p>
        ${ins.bar ? `<div style="margin-top:10px;height:4px;background:var(--surface3);border-radius:99px;overflow:hidden"><div style="height:100%;width:${ins.bar}%;background:${ins.color};border-radius:99px;transition:width 1s ease"></div></div>` : ''}
      </div>
    </div>`).join('');
}
window.buildInsights = buildInsights;

// Cache de insights — invalidado em saveTransactions()
let _insightsCache = null;

function generateInsights() {
  // Chave: comprimento + id do primeiro e último item (muda se add/remove/edit)
  const _key = transactions.length + '|' + (transactions[0]?.id || '') + '|' + (transactions[transactions.length - 1]?.id || '') + '|' + goals.length;
  if (_insightsCache && _insightsCache.key === _key) return _insightsCache.result;

  const exp   = transactions.filter(t => t.amount < 0);
  const inc   = transactions.filter(t => t.amount > 0);
  const totalIncome   = calcIncome(transactions);
  const totalExpenses = calcExpenses(transactions);
  const savings       = totalIncome - totalExpenses;
  const savingsRate   = totalIncome > 0 ? Math.round((savings / totalIncome) * 100) : 0;

  const catMap = {};
  exp.forEach(t => {
    const k = (t.cat||'Outros').replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}✓→←↑↓]+\s*/u,'').trim();
    catMap[k] = (catMap[k]||0) + Math.abs(t.amount);
  });
  const catEntries = Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
  const topCat     = catEntries[0];
  const topCatPct  = totalExpenses > 0 && topCat ? Math.round((topCat[1]/totalExpenses)*100) : 0;

  const subs      = exp.filter(t => t.cat && (t.cat.includes('Assinatura') || t.desc.match(/netflix|spotify|amazon|prime|disney|apple|youtube|globo/i)));
  const subsTotal  = subs.reduce((s,t)=>s+Math.abs(t.amount),0);
  const subNames   = [...new Set(subs.map(t=>t.desc.split(/[—\-–]/)[0].trim()))].slice(0,3);

  const delivery      = exp.filter(t => t.desc.match(/ifood|rappi|uber\s*eat|delivery/i));
  const deliveryTotal = delivery.reduce((s,t)=>s+Math.abs(t.amount),0);

  const biggestTx  = exp.slice().sort((a,b)=>Math.abs(b.amount)-Math.abs(a.amount))[0];
  const moradiaTotal = catMap['Moradia'] || 0;
  const moradiaPct   = totalIncome > 0 ? Math.round((moradiaTotal/totalIncome)*100) : 0;
  const nearGoal    = goals.length > 0 ? goals.reduce((a,b)=>(a.current/a.target)>(b.current/b.target)?a:b) : null;
  const nearGoalPct = nearGoal ? Math.min(Math.round((nearGoal.current/nearGoal.target)*100),100) : 0;

  let score = 50;
  if (savingsRate >= 20) score += 15;
  if (savingsRate >= 30) score += 10;
  if (moradiaPct <= 30)  score += 8;
  if (deliveryTotal < 150) score += 5;
  if (subsTotal < 100)   score += 5;
  if (goals.length > 0)  score += 4;
  if (nearGoalPct >= 50) score += 3;
  score = Math.min(score, 100);

  const pool = [];
  if (topCat) pool.push({ icon:'📊', color:'#0066ff', tag:'Categoria', title:`${topCat[0]}: ${topCatPct}% dos gastos`, text:`Você gastou R$ ${topCat[1].toLocaleString('pt-BR',{minimumFractionDigits:2})} em ${topCat[0].toLowerCase()} — a maior fatia do orçamento.`, bar: topCatPct, score: topCatPct > 50 ? -5 : 0 });
  if (deliveryTotal > 0) pool.push({ icon:'🛵', color: deliveryTotal>300?'#ff6b6b':'#fbbf24', tag:'Delivery', title:`R$ ${deliveryTotal.toLocaleString('pt-BR',{minimumFractionDigits:2})} em delivery`, text: deliveryTotal > 300 ? `Cozinhar em casa 3x por semana economiza até R$ 200/mês.` : `Uso moderado de delivery. Abaixo de R$ 300.`, score: deliveryTotal > 300 ? -3 : 2 });
  if (subsTotal > 0) pool.push({ icon:'📱', color:'#a78bfa', tag:'Assinaturas', title:`R$ ${subsTotal.toFixed(2).replace('.',',')} em assinaturas/mês`, text: subNames.length > 0 ? `${subNames.join(', ')} — R$ ${(subsTotal*12).toFixed(0)}/ano.` : `Cancele o que não usa há mais de 30 dias.`, score: subsTotal > 150 ? -3 : 0 });
  pool.push({ icon: savingsRate >= 20 ? '💰' : '⚠️', color: savingsRate >= 20 ? '#00c896' : '#ff6b6b', tag:'Poupança', title:`Taxa de poupança: ${savingsRate}%`, text: savingsRate >= 30 ? `Excelente! Você está poupando ${savingsRate}% da renda.` : savingsRate >= 20 ? `Dentro da meta de 20%.` : savingsRate >= 10 ? `Tente poupar ao menos 20% da renda.` : `Menos de 10% de poupança — atenção!`, bar: Math.min(savingsRate * 2, 100), score: savingsRate >= 20 ? 5 : -5 });
  if (moradiaTotal > 0) pool.push({ icon: moradiaPct > 30 ? '🏠' : '✅', color: moradiaPct > 30 ? '#ff6b6b' : '#00c896', tag:'Moradia', title:`Moradia: ${moradiaPct}% da renda`, text: moradiaPct > 30 ? `Acima dos 30% recomendados.` : `Dentro do limite ideal.`, score: moradiaPct > 30 ? -5 : 3 });
  if (biggestTx) pool.push({ icon:'💸', color:'#fbbf24', tag:'Maior gasto', title:`Maior: ${biggestTx.desc}`, text:`R$ ${Math.abs(biggestTx.amount).toLocaleString('pt-BR',{minimumFractionDigits:2})} — ${Math.round(Math.abs(biggestTx.amount)/totalExpenses*100)}% dos gastos.`, score: 0 });
  if (nearGoal) pool.push({ icon:'🎯', color:'#0066ff', tag:'Meta', title:`"${nearGoal.name}" em ${nearGoalPct}%`, text: nearGoalPct >= 80 ? `Faltam R$ ${(nearGoal.target-nearGoal.current).toLocaleString('pt-BR',{minimumFractionDigits:2})} para concluir!` : `Continue economizando para atingir sua meta.`, bar: nearGoalPct, score: nearGoalPct >= 50 ? 3 : 0 });
  if (savings > 500) pool.push({ icon:'📈', color:'#00c896', tag:'Investimento', title:`R$ ${savings.toLocaleString('pt-BR',{minimumFractionDigits:2})} para investir`, text: savings > 2000 ? `Diversifique: Tesouro Selic para liquidez, CDB para rendimento.` : `Comece com Tesouro Selic ou CDB 100% CDI.`, score: 5 });
  pool.push({ icon:'💳', color:'#f97316', tag:'Dica', title:`Nunca pague o mínimo do cartão`, text:`O rotativo cobra em média 400% ao ano. Se não puder pagar tudo, parcele — nunca o mínimo.`, score: 1 });

  const scored = pool.filter(p => p.title && p.text).sort((a,b)=>Math.abs(b.score||0)-Math.abs(a.score||0));
  const result = {
    score,
    scoreSub: `Taxa de poupança: ${savingsRate}% · Gastos: R$ ${totalExpenses.toLocaleString('pt-BR',{minimumFractionDigits:2})}`,
    insights: scored.slice(0, 8)
  };
  _insightsCache = { key: _key, result };
  return result;
}
window.generateInsights = generateInsights;

// ── Navigation / tabs ─────────────────────────────────────────────
export function switchTab(name) {
  // Atualizar top tabs por índice
  const tabNames = ['visao-geral','transacoes','categorias','metas','insights'];
  const idx = tabNames.indexOf(name);
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');

  // Sync bottom nav por data-tab
  document.querySelectorAll('.nav-item[data-tab]').forEach(n => {
    n.classList.toggle('active', n.dataset.tab === name);
  });
}
window.switchTab = switchTab;
window.showTab = switchTab;

export function switchBottomTab(el, name) {
  // Atualizar bottom nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');

  // Sync top tabs por índice
  const tabNames = ['visao-geral','transacoes','categorias','metas','insights'];
  const idx = tabNames.indexOf(name);
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
}
window.switchBottomTab = switchBottomTab;

// ── Modals ────────────────────────────────────────────────────────
export function openAddTx() {
  _resetTxModal();
  const modal = document.getElementById('modal-tx');
  if (modal) modal.classList.add('open');
}
window.openAddTx = openAddTx;

export function openGoalModal() {
  const freePlans = ['free', 'none', 'plus'];
  if (freePlans.includes(currentPlan) && goals.length >= 3) {
    showUpgrade('Desbloqueie metas ilimitadas a partir do plano Pro por R$ 14,90/mês.');
    return;
  }
  const modal = document.getElementById('modal-goal');
  if (modal) modal.classList.add('open');
}
window.openGoalModal = openGoalModal;

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
  });
});

export function addTransaction() {
  const desc = document.getElementById('tx-desc').value.trim();
  const val = parseFloat(document.getElementById('tx-val').value);
  let cat = document.getElementById('tx-cat').value;
  const type = document.getElementById('tx-type').value;
  const note = document.getElementById('tx-note')?.value.trim() || '';
  if (!desc || !val || val <= 0) { toast('Preencha descrição e valor válidos.', 'error'); return; }
  const amount = type === 'Gasto' ? -Math.abs(val) : Math.abs(val);
  const txDateInput = document.getElementById('tx-date')?.value;
  const today = _localDateStr();
  const txDate = txDateInput || today;
  // Aplicar regra automática se categoria não foi alterada do padrão
  if (cat === '🔧 Outros' || !cat) {
    const suggested = applyRulesToDesc(desc);
    if (suggested) { cat = suggested; toast(`Categoria aplicada: ${suggested}`, 'success'); }
  }
  // Verificação de duplicidade: avisa se existe tx parecida recente
  if (_checkDuplicate(desc, Math.abs(val), txDate)) {
    if (!confirm(`Existe uma transação parecida com "${desc}" no mesmo período. Deseja continuar e adicionar mesmo assim?`)) return;
  }
  const tx = { id: _genId(), date: txDate, desc, cat, amount, bank: 'Manual' };
  if (note) tx.note = note;
  transactions.unshift(tx);
  saveTransactions();
  buildTransactions();
  buildCategories();
  buildHomePanel();
  closeModal('modal-tx');
  _resetTxModal();
  toast('Transação adicionada! ✓', 'success');
  checkBudgetAlerts(tx);
  incrementManualEntriesCount();
  recordEngagementViaCloud('entry');
}
window.addTransaction = addTransaction;

// ── Estado de edição de transação ─────────────────────────────────
let _txEditingId = null;

export function openEditTx(id) {
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;
  _txEditingId = id;
  const typeEl = document.getElementById('tx-type');
  const descEl = document.getElementById('tx-desc');
  const valEl  = document.getElementById('tx-val');
  const catEl  = document.getElementById('tx-cat');
  const dateEl = document.getElementById('tx-date');
  const noteEl = document.getElementById('tx-note');
  if (typeEl) typeEl.value = tx.amount < 0 ? 'Gasto' : 'Receita';
  if (descEl) descEl.value = tx.desc || '';
  if (valEl)  valEl.value  = Math.abs(tx.amount);
  if (catEl) {
    catEl.value = tx.cat || '🔧 Outros';
    // Se categoria não existe mais no select (ex: deletada), adiciona como opção temporária
    if (catEl.value !== (tx.cat || '🔧 Outros') && tx.cat) {
      const opt = document.createElement('option');
      opt.value = tx.cat; opt.textContent = tx.cat;
      catEl.insertBefore(opt, catEl.firstChild);
      catEl.value = tx.cat;
    }
  }
  if (dateEl) dateEl.value = (tx.date || '').split('T')[0];
  if (noteEl) noteEl.value = tx.note || '';
  const titleEl = document.getElementById('modal-tx-title');
  const saveBtn = document.getElementById('modal-tx-save-btn');
  const delBtn  = document.getElementById('modal-tx-delete-btn');
  if (titleEl) titleEl.textContent = 'Editar transação';
  if (saveBtn) { saveBtn.textContent = 'Salvar alterações'; saveBtn.onclick = saveEditTx; }
  if (delBtn)  delBtn.style.display = 'block';
  document.getElementById('modal-tx').classList.add('open');
}
window.openEditTx = openEditTx;

export function saveEditTx() {
  if (!_txEditingId) return;
  const desc = document.getElementById('tx-desc').value.trim();
  const val  = parseFloat(document.getElementById('tx-val').value);
  const cat  = document.getElementById('tx-cat').value;
  const type = document.getElementById('tx-type').value;
  const note = document.getElementById('tx-note')?.value.trim() || '';
  if (!desc || !val || val <= 0) { toast('Preencha descrição e valor válidos.', 'error'); return; }
  const amount = type === 'Gasto' ? -Math.abs(val) : Math.abs(val);
  const txDateInput = document.getElementById('tx-date')?.value;
  const today = _localDateStr();
  const idx = transactions.findIndex(t => t.id === _txEditingId);
  if (idx !== -1) {
    transactions[idx] = { ...transactions[idx], desc, cat, amount, date: txDateInput || today, note: note || undefined };
  }
  saveTransactions();
  buildTransactions();
  buildCategories();
  buildHomePanel();
  _resetTxModal();
  closeModal('modal-tx');
  toast('Transação atualizada! ✓', 'success');
}
window.saveEditTx = saveEditTx;

export function deleteTx(id) {
  if (!confirm('Excluir esta transação?')) return;
  transactions = transactions.filter(t => t.id !== id);
  saveTransactions();
  buildTransactions();
  buildCategories();
  buildHomePanel();
  _resetTxModal();
  closeModal('modal-tx');
  toast('Transação excluída.', 'info');
}
window.deleteTx = deleteTx;

export function duplicateTx(id) {
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;
  const today = _localDateStr();
  const clone = { ...tx, id: _genId(), date: today };
  transactions.unshift(clone);
  saveTransactions();
  buildTransactions();
  buildHomePanel();
  toast('Transação duplicada! ✓', 'success');
}
window.duplicateTx = duplicateTx;

export function hideTx(id) {
  const idx = transactions.findIndex(t => t.id === id);
  if (idx !== -1) {
    transactions[idx].hidden = true;
    saveTransactions();
    buildTransactions();
    toast('Transação ocultada.', 'info');
  }
}
window.hideTx = hideTx;

// ── Fluxo bancário melhorado (FASE 7) ─────────────────────────────

export function markAsTransfer(id) {
  const idx = transactions.findIndex(t => t.id === id);
  if (idx === -1) return;
  const wasTransfer = transactions[idx].isTransfer;
  transactions[idx].isTransfer = !wasTransfer;
  saveTransactions();
  buildTransactions();
  buildHomePanel();
  toast(wasTransfer ? 'Removida marcação de transferência.' : '↔️ Marcada como transferência interna — não entra nos totais.', 'success');
}
window.markAsTransfer = markAsTransfer;

// Verificar se existe transação parecida (deduplicação)
// Retorna true se encontrou possível duplicata
function _checkDuplicate(desc, amount, date) {
  if (!desc || !amount) return false;
  const target = new Date(date + 'T00:00:00');
  const prefix = desc.slice(0,6).toLowerCase();
  return transactions.some(t => {
    if (Math.abs(t.amount) !== Math.abs(amount)) return false;
    const d = new Date((t.date||'').split('T')[0]+'T00:00:00');
    const dayDiff = Math.abs(Math.round((target - d) / 86400000));
    if (dayDiff > 1) return false;
    return (t.desc||'').slice(0,6).toLowerCase() === prefix;
  });
}

// Restores a hidden tx back to visible
export function unhideTx(id) {
  const idx = transactions.findIndex(t => t.id === id);
  if (idx !== -1) {
    transactions[idx].hidden = false;
    saveTransactions();
    buildTransactions();
    toast('Transação exibida novamente.', 'success');
  }
}
window.unhideTx = unhideTx;

function _resetTxModal() {
  _txEditingId = null;
  const titleEl = document.getElementById('modal-tx-title');
  const saveBtn = document.getElementById('modal-tx-save-btn');
  const delBtn  = document.getElementById('modal-tx-delete-btn');
  if (titleEl) titleEl.textContent = 'Adicionar transação';
  if (saveBtn) { saveBtn.textContent = 'Salvar transação'; saveBtn.onclick = addTransaction; }
  if (delBtn)  delBtn.style.display = 'none';
  ['tx-desc','tx-val','tx-note'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const dateEl=document.getElementById('tx-date'); if(dateEl) dateEl.value='';
  const hintEl=document.getElementById('tx-cat-hint'); if(hintEl) hintEl.style.display='none';
  // Resetar tipo e categoria para os padrões — evita herdar valores de edição anterior
  const typeEl=document.getElementById('tx-type'); if(typeEl) typeEl.value='Gasto';
  const catEl=document.getElementById('tx-cat'); if(catEl) catEl.selectedIndex=0;
}

window._deleteTxFromModal = function() { if (_txEditingId) deleteTx(_txEditingId); };

// Ícones padrão por tipo de meta
const GOAL_ICONS = { casamento:'💍', viagem:'✈️', casa:'🏠', carro:'🚗', estudo:'📚', emergencia:'🚨', outros:'🎯' };

export function addGoal() {
  const name    = document.getElementById('goal-name').value.trim();
  const target  = parseFloat(document.getElementById('goal-target').value);
  const current = parseFloat(document.getElementById('goal-current').value) || 0;
  const type    = document.getElementById('goal-type')?.value || 'outros';
  const endDate = document.getElementById('goal-end-date')?.value || '';

  if (!name)                  { toast('Informe o nome da meta.', 'error'); return; }
  if (!target || target <= 0) { toast('Informe um valor alvo válido.', 'error'); return; }

  const colors = ['#7c6dfa','#6dfac8','#fa6d9a','#fbbf24','#818cf8'];
  const icon   = GOAL_ICONS[type] || '🎯';

  goals.push({ name, icon, type, target, current, endDate, createdAt: Date.now(), color: colors[goals.length % colors.length] });
  saveGoals();
  buildGoals();
  closeModal('modal-goal');
  // Limpar campos
  ['goal-name','goal-target','goal-current'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const typeEl = document.getElementById('goal-type'); if(typeEl) typeEl.value='outros';
  const dateEl = document.getElementById('goal-end-date'); if(dateEl) dateEl.value='';
  toast('Meta criada! ✓', 'success');
  incrementGoalsCount(); // contabilizar localmente para elegibilidade do trial
  recordEngagementViaCloud('goal'); // espelhar no servidor para validação server-side
}
window.addGoal = addGoal;

export function syncData() {
  const el = document.querySelector('.nav-sync');
  if (!el) return;
  el.style.opacity = '0.5';
  el.innerHTML = '<div class="sync-dot"></div> Sincronizando...';
  setTimeout(() => { el.style.opacity = '1'; el.innerHTML = '<div class="sync-dot"></div> Sincronizado agora'; }, 2000);
}
window.syncData = syncData;

// ── Filters ───────────────────────────────────────────────────────

// Popula dinamicamente o filtro de banco com os bancos presentes nas transações
export function buildBankFilter() {
  const sel = document.getElementById('filter-bank');
  if (!sel) return;
  const banks = [...new Set(transactions.map(t => t.bank).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="all">Todas contas</option>' +
    banks.map(b => `<option value="${b}"${b===current?' selected':''}>${b}</option>`).join('');
}
window.buildBankFilter = buildBankFilter;

export function applyFilters() {
  const type   = document.getElementById('filter-type')?.value   || 'all';
  const cat    = document.getElementById('filter-cat')?.value    || 'all';
  const period = document.getElementById('filter-period')?.value || 'all';
  const bank   = document.getElementById('filter-bank')?.value   || 'all';

  let filtered = [...transactions];
  if (type === 'income')  filtered = filtered.filter(t => t.amount > 0);
  if (type === 'expense') filtered = filtered.filter(t => t.amount < 0);
  if (cat  !== 'all')     filtered = filtered.filter(t => t.cat === cat);
  if (bank !== 'all')     filtered = filtered.filter(t => t.bank === bank);

  const now = new Date(); now.setHours(23,59,59,999);
  const today = new Date(); today.setHours(0,0,0,0);
  if (period === 'today')  filtered = filtered.filter(t => new Date(t.date+'T00:00:00') >= today);
  if (period === 'week')   { const d=new Date(today); d.setDate(d.getDate()-7); filtered=filtered.filter(t=>new Date(t.date+'T00:00:00')>=d); }
  if (period === 'month')  { filtered=filtered.filter(t=>{ const d=new Date(t.date+'T00:00:00'); return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear(); }); }
  if (period === 'last30') { const d=new Date(today); d.setDate(d.getDate()-30); filtered=filtered.filter(t=>new Date(t.date+'T00:00:00')>=d); }
  if (period === 'last90') { const d=new Date(today); d.setDate(d.getDate()-90); filtered=filtered.filter(t=>new Date(t.date+'T00:00:00')>=d); }
  if (period === 'last6m') { const d=new Date(today); d.setMonth(d.getMonth()-6); filtered=filtered.filter(t=>new Date(t.date+'T00:00:00')>=d); }

  const total = filtered.reduce((s,t) => s + t.amount, 0);
  const sumEl = document.getElementById('filter-summary');
  if (sumEl) sumEl.textContent = filtered.length > 0
    ? `${filtered.length} transação(ões) · Total: R$ ${total.toLocaleString('pt-BR',{minimumFractionDigits:2})}`
    : 'Nenhuma transação encontrada.';

  renderTransactions(filtered);
}
window.applyFilters = applyFilters;

export function clearFilters() {
  ['filter-type','filter-cat','filter-period','filter-bank'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  const hidden = document.getElementById('filter-show-hidden');
  if (hidden) hidden.checked = false;
  const sumEl = document.getElementById('filter-summary');
  if (sumEl) sumEl.textContent = '';
  buildTransactions();
}
window.clearFilters = clearFilters;

const TX_PAGE_SIZE = 100; // Número de transações renderizadas por vez

// Contexto de paginação — preservado entre chamadas de "Carregar mais"
let _txPageCtx = null;

export function renderTransactions(txList) {
  const list = document.getElementById('tx-list');
  if (!list) return;
  const showHidden = document.getElementById('filter-show-hidden')?.checked;
  const visible = showHidden ? txList : txList.filter(t => !t.hidden);
  if (!visible || visible.length === 0) {
    _txPageCtx = null;
    list.innerHTML = `<div style="text-align:center;padding:48px 20px;color:var(--muted)">
      <div style="font-size:2.5rem;margin-bottom:12px">📋</div>
      <div style="font-size:0.9rem;font-weight:600;margin-bottom:6px;color:var(--text2)">Nenhuma transação ainda</div>
      <div style="font-size:0.8rem;line-height:1.6">Toque no botão <b style="color:var(--accent)">+</b> para adicionar sua primeira transação.</div>
    </div>`;
    return;
  }
  const sorted = [...visible].sort((a,b) => new Date(b.date)-new Date(a.date));
  // Salvar contexto para paginação
  _txPageCtx = { sorted, offset: 0 };
  list.innerHTML = '';
  _appendTxPage(list, sorted, 0, true);
}
window.renderTransactions = renderTransactions;

// Adiciona a próxima página de transações ao #tx-list (usado por "Carregar mais")
function _appendTxPage(list, sorted, offset, isFirst) {
  const total = sorted.length;
  const page  = sorted.slice(offset, offset + TX_PAGE_SIZE);
  const fmtDate = d => {
    const dt=new Date(d+'T00:00:00');
    const hoje=new Date(); hoje.setHours(0,0,0,0);
    const diff=Math.round((hoje-dt)/86400000);
    if(diff===0) return 'Hoje';
    if(diff===1) return 'Ontem';
    return dt.toLocaleDateString('pt-BR',{weekday:'long',day:'numeric',month:'short'});
  };
  const groups = {};
  page.forEach(tx => {
    const date = (tx.date||'').split('T')[0]||'Sem data';
    if (!groups[date]) groups[date]=[];
    groups[date].push(tx);
  });
  const frag = document.createDocumentFragment();
  // Contador de resultados (apenas na primeira página com paginação ativa)
  if (isFirst && total > TX_PAGE_SIZE) {
    const info = document.createElement('div');
    info.id = 'tx-page-info';
    info.style.cssText = 'text-align:center;font-size:0.72rem;color:var(--muted);padding:6px 0 10px;letter-spacing:0.02em';
    info.textContent = `Mostrando ${Math.min(TX_PAGE_SIZE, total)} de ${total} transações`;
    frag.appendChild(info);
  }
  Object.entries(groups).forEach(([date,txs]) => {
    const dayTotal = txs.reduce((s,t) => s+t.amount, 0);
    const dayTotalFmt = (dayTotal>=0?'+':'') + 'R$ ' + Math.abs(dayTotal).toLocaleString('pt-BR',{minimumFractionDigits:2});
    const group = document.createElement('div');
    group.className = 'tx-date-group';
    group.innerHTML = `<div class="tx-date-label" style="display:flex;justify-content:space-between;align-items:center"><span>${fmtDate(date)}</span><span style="font-size:0.72rem;color:${dayTotal>=0?'var(--success)':'var(--danger)'};font-weight:600">${dayTotalFmt}</span></div>`;
    txs.forEach(tx => {
      const amt=tx.amount||0;
      const isPos=amt>0;
      const hasSplits=tx.splits&&tx.splits.length>0;
      const catDisplay = hasSplits ? '🔀 Dividida' : (tx.cat||'🔧 Outros');
      const badges=[
        tx.isTransfer ? `<span style="font-size:0.65rem;background:rgba(100,200,255,0.12);color:#64c8ff;border-radius:99px;padding:2px 6px;margin-left:4px">Transferência</span>` : '',
        tx.pending    ? `<span style="font-size:0.65rem;background:rgba(251,191,36,0.12);color:#fbbf24;border-radius:99px;padding:2px 6px;margin-left:4px">Pendente</span>` : '',
      ].join('');
      const txEl=document.createElement('div');
      txEl.className='tx-item';
      txEl.style.cssText='position:relative';
      const txId=tx.id||'';
      txEl.innerHTML=`
        <div class="tx-emoji">${(tx.cat||'').split(' ')[0]||'💸'}</div>
        <div class="tx-info" style="min-width:0;flex:1">
          <div class="desc" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tx.desc||tx.description||'Transação'}${badges}</div>
          <div class="cat" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${catDisplay}${tx.bank?' · '+tx.bank:''}</div>
          ${tx.note?`<div style="font-size:0.72rem;color:var(--muted);font-style:italic;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tx.note}</div>`:''}
        </div>
        <div class="tx-amount ${isPos?'positive':'negative'}">${isPos?'+':''}R$ ${Math.abs(amt).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
        <button onclick="event.stopPropagation();toggleTxMenu('${txId}')" title="Opções" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;padding:4px 6px;border-radius:6px;flex-shrink:0;line-height:1">⋯</button>
        <div id="tx-menu-${txId}" style="display:none;position:absolute;right:8px;top:100%;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:6px;z-index:200;min-width:165px;box-shadow:0 8px 24px rgba(0,0,0,0.5)">
          <button onclick="openEditTx('${txId}');closeTxMenu()" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);padding:8px 12px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.83rem;border-radius:8px">✏️ Editar</button>
          <button onclick="duplicateTx('${txId}');closeTxMenu()" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);padding:8px 12px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.83rem;border-radius:8px">📋 Duplicar</button>
          <button onclick="openSplitModal('${txId}');closeTxMenu()" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);padding:8px 12px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.83rem;border-radius:8px">✂️ Dividir</button>
          <button onclick="markAsTransfer('${txId}');closeTxMenu()" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);padding:8px 12px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.83rem;border-radius:8px">${tx.isTransfer?'↩️ Remover transferência':'↔️ Transferência interna'}</button>
          ${tx.hidden
            ? `<button onclick="unhideTx('${txId}');closeTxMenu()" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);padding:8px 12px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.83rem;border-radius:8px">👁️ Exibir novamente</button>`
            : `<button onclick="hideTx('${txId}');closeTxMenu()" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);padding:8px 12px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.83rem;border-radius:8px">🙈 Ocultar</button>`}
          <button onclick="deleteTx('${txId}');closeTxMenu()" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--danger);padding:8px 12px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.83rem;border-radius:8px">🗑️ Excluir</button>
        </div>
      `;
      group.appendChild(txEl);
    });
    frag.appendChild(group);
  });
  const nextOffset = offset + TX_PAGE_SIZE;
  const remaining  = total - nextOffset;
  if (remaining > 0) {
    const loadBtn = document.createElement('button');
    loadBtn.id = 'tx-load-more';
    loadBtn.style.cssText = 'width:100%;background:none;border:1px solid var(--border);border-radius:12px;padding:13px;color:var(--muted);font-family:DM Sans,sans-serif;font-size:0.85rem;cursor:pointer;margin-top:8px';
    loadBtn.textContent = `Carregar mais ${Math.min(TX_PAGE_SIZE, remaining)} (${remaining} restantes)`;
    loadBtn.onclick = () => {
      // Marcar posição de ancoragem antes de remover o botão
      const anchor = document.createElement('div');
      anchor.id = 'tx-scroll-anchor';
      loadBtn.replaceWith(anchor);
      document.getElementById('tx-page-info')?.remove();
      _appendTxPage(list, sorted, nextOffset, false);
      // Scroll suave até onde o botão estava (ancoragem)
      requestAnimationFrame(() => {
        document.getElementById('tx-scroll-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.getElementById('tx-scroll-anchor')?.remove();
      });
    };
    frag.appendChild(loadBtn);
  }
  list.appendChild(frag);
}

export function toggleTxMenu(id) {
  document.querySelectorAll('[id^="tx-menu-"]').forEach(m => { if(m.id!==`tx-menu-${id}`) m.style.display='none'; });
  const menu=document.getElementById(`tx-menu-${id}`);
  if(menu) menu.style.display=menu.style.display==='none'?'block':'none';
}
window.toggleTxMenu = toggleTxMenu;

export function closeTxMenu() {
  document.querySelectorAll('[id^="tx-menu-"]').forEach(m => m.style.display='none');
}
window.closeTxMenu = closeTxMenu;

// ── Categories ────────────────────────────────────────────────────
export function filterCategoriesByPeriod() {
  const period = document.getElementById('cat-period-filter')?.value || 'month';
  const labelMap = { month:'Este mês', week:'Esta semana', today:'Hoje', last30:'Últimos 30 dias', last90:'Últimos 90 dias', all:'Todo período' };
  const label = document.getElementById('cat-period-label');
  if (label) label.textContent = labelMap[period] || period;
  const filtered = filterTxByPeriod(transactions, period).filter(t => t.amount < 0 && !t.isTransfer && !t.hidden);
  const total = filtered.reduce((s,t) => s + Math.abs(t.amount), 0);
  const totalEl = document.getElementById('cat-total-amount');
  if (totalEl) { const formatted = total.toLocaleString('pt-BR',{minimumFractionDigits:2}); const [int,dec] = formatted.split(','); totalEl.innerHTML = `<span>R$</span> ${int}<span style="font-size:1.2rem">,${dec}</span>`; }
  buildCategoriesFromTx(filtered);
}
window.filterCategoriesByPeriod = filterCategoriesByPeriod;

export function filterTxByPeriod(txList, period) {
  const today = new Date(); today.setHours(0,0,0,0);
  const now = new Date();
  if (period === 'today') return txList.filter(t => new Date((t.date||'').split('T')[0]+'T00:00:00') >= today);
  if (period === 'week') { const d=new Date(today); d.setDate(d.getDate()-7); return txList.filter(t=>new Date((t.date||'').split('T')[0]+'T00:00:00')>=d); }
  if (period === 'month') return txList.filter(t => { const d=new Date((t.date||'').split('T')[0]+'T00:00:00'); return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear(); });
  if (period === 'last30') { const d=new Date(today); d.setDate(d.getDate()-30); return txList.filter(t=>new Date((t.date||'').split('T')[0]+'T00:00:00')>=d); }
  if (period === 'last90') { const d=new Date(today); d.setDate(d.getDate()-90); return txList.filter(t=>new Date((t.date||'').split('T')[0]+'T00:00:00')>=d); }
  return txList;
}
window.filterTxByPeriod = filterTxByPeriod;

export function buildCategoriesFromTx(filteredTx) {
  const list = document.getElementById('cat-list');
  if (!list) return;
  const catMap = {};
  filteredTx.forEach(tx => {
    // Expande splits: cada split contribui separado ao catMap
    if (tx.splits && tx.splits.length > 0) {
      tx.splits.forEach(sp => {
        const cat = sp.cat || tx.cat || '🔧 Outros';
        if (!catMap[cat]) catMap[cat] = 0;
        catMap[cat] += Math.abs(sp.amount);
      });
    } else {
      const cat = tx.cat || tx.category || '🔧 Outros';
      if (!catMap[cat]) catMap[cat] = 0;
      catMap[cat] += Math.abs(tx.amount);
    }
  });
  const total = Object.values(catMap).reduce((a,b)=>a+b,0);
  if (total === 0) {
    list.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--muted)">
      <div style="font-size:2.5rem;margin-bottom:12px">🍩</div>
      <div style="font-size:0.9rem;font-weight:600;margin-bottom:6px;color:var(--text2)">Sem gastos no período</div>
      <div style="font-size:0.8rem">Adicione transações para ver seus gastos por categoria.</div>
    </div>`;
    return;
  }
  const colors = ['#7c6dfa','#6dfac8','#fa6d9a','#fbbf24','#818cf8','#34d399','#f87171','#94a3b8','#60a5fa','#e879f9'];
  // Sort alphabetically (by category name)
  const sorted = Object.entries(catMap).sort((a, b) => {
    const nameA = a[0].replace(/^[^\w\s]*\s*/, '').toLowerCase();
    const nameB = b[0].replace(/^[^\w\s]*\s*/, '').toLowerCase();
    return nameA.localeCompare(nameB, 'pt-BR');
  });
  list.innerHTML = sorted.map(([cat, amt], idx) => {
    const pct = total > 0 ? Math.round((amt/total)*100) : 0;
    const color = colors[idx % colors.length];
    return `<div class="cat-item" onclick="openCatDetail('${cat.replace(/'/g,"\\'")}','${document.getElementById('cat-period-filter')?.value||'month'}')" style="cursor:pointer;padding:8px;border-radius:12px;transition:background 0.15s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='none'">
      <div class="cat-row">
        <div class="name" style="gap:8px">${cat} <span style="font-size:0.7rem;color:var(--muted)">${pct}%</span></div>
        <div style="display:flex;gap:10px;align-items:center">
          <div class="amount">R$ ${amt.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
          <span style="color:var(--muted);font-size:0.8rem">›</span>
        </div>
      </div>
      <div class="cat-bar" style="margin-top:6px"><div class="cat-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  }).join('');
}
window.buildCategoriesFromTx = buildCategoriesFromTx;

let currentCatDetail = null;

export function openCatDetail(catName, period) {
  currentCatDetail = catName;
  const detail = document.getElementById('cat-detail');
  if (!detail) return;
  document.getElementById('cat-detail-icon').textContent = catName.split(' ')[0];
  document.getElementById('cat-detail-name').textContent = catName;
  if (document.getElementById('cat-detail-period')) document.getElementById('cat-detail-period').value = period || 'month';
  detail.style.display = 'flex';
  refreshCatDetail();
}
window.openCatDetail = openCatDetail;

export function refreshCatDetail() {
  const period = document.getElementById('cat-detail-period')?.value || 'month';
  const catName = currentCatDetail;
  const catTx = filterTxByPeriod(transactions, period).filter(t => (t.cat||t.category||'') === catName && t.amount < 0);
  const total = catTx.reduce((s,t) => s + Math.abs(t.amount), 0);
  document.getElementById('cat-detail-total').textContent = `R$ ${total.toLocaleString('pt-BR',{minimumFractionDigits:2})} · ${catTx.length} transação(ões)`;
  const listEl = document.getElementById('cat-detail-list');
  if (!listEl) return;
  if (catTx.length === 0) { listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:0.85rem">Nenhum gasto nesta categoria no período.</div>'; return; }
  const sorted = [...catTx].sort((a,b) => new Date(b.date)-new Date(a.date));
  listEl.innerHTML = sorted.map(tx => `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)"><div style="width:38px;height:38px;border-radius:10px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0">${(tx.cat||'').split(' ')[0]||'💸'}</div><div style="flex:1;min-width:0"><div style="font-size:0.85rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tx.desc||tx.description||'Transação'}</div><div style="font-size:0.72rem;color:var(--muted);margin-top:2px">${new Date((tx.date||'').split('T')[0]+'T00:00:00').toLocaleDateString('pt-BR')}${tx.bank ? ' · ' + tx.bank : ''}</div></div><div style="font-family:Syne,sans-serif;font-weight:700;font-size:0.92rem;color:var(--danger);flex-shrink:0">-R$ ${Math.abs(tx.amount).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div></div>`).join('');
}
window.refreshCatDetail = refreshCatDetail;

export function closeCatDetail() {
  const detail = document.getElementById('cat-detail');
  if (detail) detail.style.display = 'none';
}
window.closeCatDetail = closeCatDetail;

// ── Regras de Categorização Automática (FASE 4) ────────────────────
// TODO(cloud): migrar finno_rules_<uid> para Firestore quando disponível

function _rulesKey() { const uid=auth.currentUser?.uid; return uid?'finno_rules_'+uid:null; }
function loadRules() { const k=_rulesKey(); if(!k) return []; try { return JSON.parse(localStorage.getItem(k)||'[]'); } catch(e) { return []; } }
function saveRules(rules) { const k=_rulesKey(); if(!k) return; try { localStorage.setItem(k,JSON.stringify(rules)); } catch(e) { toast('Erro ao salvar regras.','error'); } } // TODO(cloud): substituir por Firestore batch write quando migrar

export function applyRulesToDesc(desc) {
  if (!desc) return null;
  const rules = loadRules();
  const lower = desc.toLowerCase();
  const match = rules.find(r => r.keyword && lower.includes(r.keyword.toLowerCase()));
  return match ? match.cat : null;
}
window.applyRulesToDesc = applyRulesToDesc;

// Sugestão em tempo real de categoria ao digitar descrição
export function suggestCatFromDesc(desc) {
  const catEl  = document.getElementById('tx-cat');
  const hintEl = document.getElementById('tx-cat-hint');
  if (!catEl || !hintEl) return;
  const suggested = applyRulesToDesc(desc);
  if (suggested && catEl.value !== suggested) {
    // Construção segura via DOM — sem innerHTML com dados do usuário
    hintEl.textContent = '';
    const pill = document.createElement('div');
    pill.style.cssText = 'display:flex;align-items:center;gap:6px;background:rgba(138,5,190,0.08);border:1px solid rgba(138,5,190,0.2);border-radius:8px;padding:6px 10px';

    const label = document.createElement('span');
    label.style.cssText = 'font-size:0.72rem;color:var(--accent);flex:1';
    label.textContent = '💡 Sugestão: ';
    const strong = document.createElement('strong');
    strong.textContent = suggested;
    label.appendChild(strong);

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = 'Aplicar';
    applyBtn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:0.7rem;cursor:pointer;font-family:DM Sans,sans-serif;flex-shrink:0';
    applyBtn.addEventListener('click', () => {
      catEl.value = suggested;
      hintEl.style.display = 'none';
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = '✕';
    dismissBtn.title = 'Ignorar sugestão';
    dismissBtn.style.cssText = 'background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.9rem;padding:2px 4px;line-height:1;flex-shrink:0';
    dismissBtn.addEventListener('click', () => { hintEl.style.display = 'none'; });

    pill.appendChild(label);
    pill.appendChild(applyBtn);
    pill.appendChild(dismissBtn);
    hintEl.appendChild(pill);
    hintEl.style.display = 'block';
  } else {
    hintEl.style.display = 'none';
  }
}
window.suggestCatFromDesc = suggestCatFromDesc;

export function openRulesModal() {
  buildRulesList();
  document.getElementById('modal-rules')?.classList.add('open');
}
window.openRulesModal = openRulesModal;

export function addRule() {
  const keyword = document.getElementById('rule-keyword')?.value.trim();
  const cat     = document.getElementById('rule-cat')?.value;
  if (!keyword || !cat) { toast('Preencha palavra-chave e categoria.', 'error'); return; }
  const rules = loadRules();
  if (rules.some(r => r.keyword.toLowerCase() === keyword.toLowerCase())) { toast('Já existe uma regra para essa palavra-chave.', 'error'); return; }
  rules.push({ id: _genId(), keyword, cat, createdAt: Date.now() });
  saveRules(rules);
  buildRulesList();
  const kwEl = document.getElementById('rule-keyword');
  if (kwEl) kwEl.value = '';
  toast(`Regra criada: "${keyword}" → ${cat}`, 'success');
}
window.addRule = addRule;

export function deleteRule(id) {
  saveRules(loadRules().filter(r => r.id !== id));
  buildRulesList();
  toast('Regra removida.', 'info');
}
window.deleteRule = deleteRule;

export function buildRulesList() {
  const list = document.getElementById('rules-list');
  if (!list) return;
  const rules = loadRules();
  if (rules.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted);font-size:0.82rem">Nenhuma regra criada. Adicione palavras-chave acima.</div>`;
    return;
  }
  list.innerHTML = rules.map(r => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:0.85rem;font-weight:500">"${r.keyword}"</div>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:2px">${r.cat}</div>
      </div>
      <button onclick="deleteRule('${r.id}')" style="background:none;border:1px solid var(--border);border-radius:8px;padding:5px 10px;color:var(--danger);cursor:pointer;font-size:0.75rem">✕</button>
    </div>
  `).join('');
}
window.buildRulesList = buildRulesList;

// ── Orçamento por Categoria (FASE 3) ──────────────────────────────
// TODO(cloud): migrar finno_budget_<uid> para Firestore quando disponível

function _budgetKey() { const uid=auth.currentUser?.uid; return uid?'finno_budget_'+uid:null; }
function loadBudget() { const k=_budgetKey(); if(!k) return {}; try { return JSON.parse(localStorage.getItem(k)||'{}'); } catch(e) { return {}; } }
function saveBudget(b) { const k=_budgetKey(); if(!k) return; try { localStorage.setItem(k,JSON.stringify(b)); } catch(e) { toast('Erro ao salvar orçamento.','error'); } } // TODO(cloud): substituir por Firestore batch write quando migrar

function getBudgetStatus() {
  const budget = loadBudget();
  const monthTx = filterTxMonth(transactions).filter(t => t.amount < 0 && !t.isTransfer && !t.hidden);
  const catSpent = {};
  monthTx.forEach(t => { const c=t.cat||'🔧 Outros'; catSpent[c]=Math.round(((catSpent[c]||0)+Math.abs(t.amount))*100)/100; });
  return Object.entries(budget).map(([cat,limit]) => {
    const spent = catSpent[cat] || 0;
    const pct = limit > 0 ? Math.round((spent/limit)*100) : 0;
    return { cat, limit, spent, pct };
  }).sort((a,b) => b.pct-a.pct);
}

export function openBudgetModal(cat) {
  const select = document.getElementById('budget-cat');
  if (select && cat) select.value = cat;
  const budget = loadBudget();
  const input = document.getElementById('budget-limit');
  if (input) input.value = (cat && budget[cat]) ? budget[cat] : '';
  buildBudgetLimitsList();
  document.getElementById('modal-budget')?.classList.add('open');
}
window.openBudgetModal = openBudgetModal;

export function saveBudgetLimit() {
  const cat   = document.getElementById('budget-cat')?.value;
  const limit = parseFloat(document.getElementById('budget-limit')?.value);
  if (!cat || !limit || limit <= 0) { toast('Escolha uma categoria e um limite válido.', 'error'); return; }
  const budget = loadBudget();
  budget[cat] = Math.round(limit * 100) / 100;
  saveBudget(budget);
  buildBudgetWidget();
  buildBudgetLimitsList();
  const limitEl = document.getElementById('budget-limit');
  if (limitEl) limitEl.value = '';
  toast(`Orçamento: ${cat} → R$ ${limit.toFixed(2).replace('.',',')}`, 'success');
}
window.saveBudgetLimit = saveBudgetLimit;

export function deleteBudgetLimit(cat) {
  const budget = loadBudget();
  delete budget[cat];
  saveBudget(budget);
  buildBudgetWidget();
  buildBudgetLimitsList();
  toast('Limite removido.', 'info');
}
window.deleteBudgetLimit = deleteBudgetLimit;

export function buildBudgetWidget() {
  const widget = document.getElementById('budget-widget');
  if (!widget) return;
  const status = getBudgetStatus();
  const header = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${status.length?'12px':'6px'}">
    <h3 style="font-family:Syne,sans-serif;font-size:0.95rem;font-weight:700;margin:0">Orçamento Mensal</h3>
    <button onclick="openBudgetModal()" style="background:var(--accent);border:none;border-radius:8px;padding:6px 12px;color:#fff;font-size:0.78rem;cursor:pointer;font-family:DM Sans,sans-serif">+ Limite</button>
  </div>`;
  if (status.length === 0) {
    widget.innerHTML = header + `<div style="text-align:center;padding:12px;color:var(--muted);font-size:0.8rem">Nenhum orçamento definido. Clique em "+ Limite" para controlar seus gastos.</div>`;
    return;
  }
  const items = status.map(s => {
    const barColor = s.pct >= 100 ? '#f87171' : s.pct >= 80 ? '#fbbf24' : '#4ade80';
    const barW = Math.min(s.pct, 100);
    const over = s.pct > 100 ? ` <span style="color:#f87171;font-size:0.7rem">(+R$ ${(s.spent-s.limit).toLocaleString('pt-BR',{minimumFractionDigits:2})})</span>` : '';
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:0.82rem;font-weight:500">${s.cat}</span>
        <span style="font-size:0.75rem;color:var(--muted)">R$ ${s.spent.toLocaleString('pt-BR',{minimumFractionDigits:2})} / R$ ${s.limit.toLocaleString('pt-BR',{minimumFractionDigits:2})} · ${s.pct}%${over}</span>
      </div>
      <div style="height:6px;background:var(--surface3);border-radius:99px;overflow:hidden;cursor:pointer" onclick="openBudgetModal('${s.cat.replace(/'/g,"\\'")}')">
        <div style="height:100%;width:${barW}%;background:${barColor};border-radius:99px;transition:width 0.5s ease"></div>
      </div>
    </div>`;
  }).join('');
  widget.innerHTML = header + items;
}
window.buildBudgetWidget = buildBudgetWidget;

function buildBudgetLimitsList() {
  const list = document.getElementById('budget-limits-list');
  if (!list) return;
  const budget = loadBudget();
  const entries = Object.entries(budget);
  if (entries.length === 0) { list.innerHTML = `<div style="color:var(--muted);font-size:0.8rem;padding:8px 0">Nenhum limite definido ainda.</div>`; return; }
  list.innerHTML = entries.map(([cat,lim]) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:0.83rem">${cat}</span>
      <span style="font-size:0.83rem;color:var(--accent);font-weight:600">R$ ${lim.toLocaleString('pt-BR',{minimumFractionDigits:2})}/mês</span>
      <button onclick="deleteBudgetLimit('${cat.replace(/'/g,"\\'")}');" style="background:none;border:1px solid var(--border);border-radius:8px;padding:4px 8px;color:var(--danger);cursor:pointer;font-size:0.72rem">✕</button>
    </div>
  `).join('');
}

export function checkBudgetAlerts(tx) {
  if (!tx || tx.amount >= 0) return;
  const budget = loadBudget();
  const cat = tx.cat || '🔧 Outros';
  const limit = budget[cat];
  if (!limit) return;
  const monthSpent = filterTxMonth(transactions).filter(t => t.amount < 0 && (t.cat||'🔧 Outros')===cat && !t.isTransfer).reduce((s,t)=>s+Math.abs(t.amount),0);
  const pct = Math.round((monthSpent/limit)*100);
  if (pct > 100)      toast(`🚨 ${cat} — R$ ${(monthSpent-limit).toLocaleString('pt-BR',{minimumFractionDigits:2})} acima do orçamento!`, 'error');
  else if (pct >= 100) toast(`🔴 ${cat} — limite de orçamento atingido!`, 'error');
  else if (pct >= 80)  toast(`⚠️ ${cat} — ${pct}% do orçamento mensal atingido.`, 'success');
}
window.checkBudgetAlerts = checkBudgetAlerts;

// ── Categorias Customizáveis (FASE 6) ─────────────────────────────
// TODO(cloud): migrar finno_cats_<uid> para Firestore quando disponível

// Categorias padrão (sempre disponíveis, read-only)
const _DEFAULT_CATS = [
  '🛒 Alimentação','📱 Assinaturas','👗 Compras','📚 Estudos',
  '🎮 Lazer','🏠 Moradia','💊 Saúde','🚗 Transporte',
  '💰 Salário','📈 Investimento','🔧 Outros'
];

function _catsKey() { const uid=auth.currentUser?.uid; return uid?'finno_cats_'+uid:null; }
function loadCustomCats() { const k=_catsKey(); if(!k) return []; try { return JSON.parse(localStorage.getItem(k)||'[]'); } catch(e) { return []; } }
function saveCustomCats(cats) { const k=_catsKey(); if(!k) return; try { localStorage.setItem(k,JSON.stringify(cats)); } catch(e) { toast('Erro ao salvar categorias.','error'); } } // TODO(cloud): substituir por Firestore batch write quando migrar

// Retorna TODAS as categorias: padrão (não deletadas) + customizadas não-arquivadas + fallback obrigatório
export function getAllCategories() {
  const uid = auth.currentUser?.uid;
  const deletedDefaults = uid ? JSON.parse(localStorage.getItem('finno_del_cats_' + uid) || '[]') : [];
  const defaults = _DEFAULT_CATS.filter(c => !deletedDefaults.includes(c));
  const custom = loadCustomCats().filter(c => !c.archived);
  const customNames = custom.map(c => `${c.emoji} ${c.name}`);
  const all = [...defaults, ...customNames];
  // 'Sem categoria' sempre presente como fallback obrigatório — não pode ser removida
  if (!all.includes('Sem categoria')) all.push('Sem categoria');
  return all;
}
window.getAllCategories = getAllCategories;

// Popula todos os <select> de categoria com as cats disponíveis
export function buildCatSelects() {
  const cats = getAllCategories();
  const selectIds = ['tx-cat','filter-cat','export-cat','budget-cat','rule-cat','rec-cat'];
  selectIds.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;

    // Selects que precisam da opção "Todas" (filtros)
    const hasAll   = id === 'filter-cat' || id === 'export-cat';
    // Label limpa (sem emoji) apenas no filtro de transações; exportação mantém emoji
    const stripEmoji = id === 'filter-cat';
    const allLabel = id === 'export-cat' ? 'Todas as categorias' : 'Todas categorias';

    sel.innerHTML = (hasAll ? `<option value="all">${allLabel}</option>` : '') +
      cats.map(c => {
        const label = stripEmoji ? (c.replace(/^[\p{Emoji}\s]+/u, '').trim() || c) : c;
        return `<option value="${c}"${c === current ? ' selected' : ''}>${label}</option>`;
      }).join('');
  });
}
window.buildCatSelects = buildCatSelects;

export function openCatManagerModal() {
  buildCatManagerList();
  document.getElementById('modal-cat-manager')?.classList.add('open');
}
window.openCatManagerModal = openCatManagerModal;

export function buildCatManagerList() {
  const list = document.getElementById('cat-manager-list');
  if (!list) return;
  const custom = loadCustomCats();
  const uid = auth.currentUser?.uid;
  const deletedDefaults = uid ? JSON.parse(localStorage.getItem('finno_del_cats_' + uid) || '[]') : [];
  const visibleDefaults = _DEFAULT_CATS.filter(c => !deletedDefaults.includes(c));

  const defaultHtml = visibleDefaults.map(c => `
    <div class="cat-mgr-row" style="opacity:0.7">
      <span class="cat-mgr-emoji">${c.split(' ')[0]}</span>
      <span class="cat-mgr-name">${c.replace(/^[\p{Emoji}\s]+/u,'').trim()||c}</span>
      <button class="cat-mgr-btn" onclick="deleteDefaultCat('${c.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')" title="Remover categoria padrão" style="color:var(--danger)">🗑️</button>
      <span class="cat-mgr-badge">Padrão</span>
    </div>
  `).join('');
  const customHtml = custom.length === 0 ? '' : custom.map(c => `
    <div class="cat-mgr-row" style="opacity:${c.archived?0.4:1}">
      <span class="cat-mgr-emoji">${c.emoji||'🏷️'}</span>
      <span class="cat-mgr-name">${c.name}${c.archived?' <span style="font-size:0.7rem;color:var(--muted)">(arquivada)</span>':''}</span>
      <button class="cat-mgr-btn" onclick="archiveCat('${c.id}')" title="${c.archived?'Restaurar':'Arquivar'}">${c.archived?'↩️':'📦'}</button>
      <button class="cat-mgr-btn" onclick="openCatEditor('${c.id}')">✏️</button>
    </div>
  `).join('');

  const customSection = customHtml || '<div style="font-size:0.8rem;color:var(--muted);padding:8px 0">Nenhuma categoria personalizada ainda.</div>';
  const defaultSection = visibleDefaults.length > 0
    ? '<div style="margin-top:8px;font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;padding:8px 0 4px;border-top:1px solid var(--border)">Categorias padrão</div>' + defaultHtml
    : '';
  list.innerHTML = customSection + defaultSection;
}
window.buildCatManagerList = buildCatManagerList;

export function openCatEditor(id) {
  const cats = loadCustomCats();
  const cat = id ? cats.find(c => c.id === id) : null;
  document.getElementById('cat-edit-id').value   = cat?.id || '';
  document.getElementById('cat-edit-emoji').value = cat?.emoji || '🏷️';
  document.getElementById('cat-edit-name').value  = cat?.name || '';
  const titleEl = document.getElementById('cat-editor-title');
  if (titleEl) titleEl.textContent = cat ? 'Editar categoria' : 'Nova categoria';
  document.getElementById('modal-cat-editor')?.classList.add('open');
}
window.openCatEditor = openCatEditor;

export function saveCatEditor() {
  const id    = document.getElementById('cat-edit-id')?.value;
  const emoji = document.getElementById('cat-edit-emoji')?.value.trim() || '🏷️';
  const name  = document.getElementById('cat-edit-name')?.value.trim();
  if (!name) { toast('Informe o nome da categoria.', 'error'); return; }
  const cats = loadCustomCats();
  if (id) {
    const idx = cats.findIndex(c => c.id === id);
    if (idx !== -1) cats[idx] = { ...cats[idx], emoji, name };
  } else {
    if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast('Categoria já existe.', 'error'); return; }
    cats.push({ id: _genId(), emoji, name, archived: false, createdAt: Date.now() });
  }
  saveCustomCats(cats);
  buildCatSelects();
  buildCatManagerList();
  closeModal('modal-cat-editor');
  toast(id ? `Categoria "${name}" atualizada!` : `Categoria "${emoji} ${name}" criada!`, 'success');
}
window.saveCatEditor = saveCatEditor;

export function archiveCat(id) {
  const cats = loadCustomCats();
  const cat = cats.find(c => c.id === id);
  if (!cat) return;
  cat.archived = !cat.archived;
  saveCustomCats(cats);
  buildCatSelects();
  buildCatManagerList();
  toast(cat.archived ? `"${cat.name}" arquivada.` : `"${cat.name}" restaurada.`, 'info');
}
window.archiveCat = archiveCat;

// ── Suporte ao usuário ────────────────────────────────────────────
// Abre mailto e exibe painel de fallback com opção de copiar e-mail.
// Evita janela em branco em ambientes sem cliente de e-mail configurado.
export function openSupportContact() {
  const email = 'suporte@finnoflow.com.br';
  const planLabels = { free:'Gratuito', plus:'Plus', pro:'Pro', premium:'Premium', trial:'Trial', expired:'Expirado', none:'Sem plano' };
  const planName = planLabels[currentPlan] || currentPlan || 'Gratuito';
  const uid = auth.currentUser?.uid || '';
  const subject = encodeURIComponent(`Suporte FinnoFlow · Plano ${planName} · ${new Date().toLocaleDateString('pt-BR')}`);
  const body = encodeURIComponent(`Olá, preciso de ajuda com o FinnoFlow.\n\nPlano: ${planName}\nID: ${uid.slice(0,8) || 'N/A'}\n\nDescrição do problema:\n`);
  // Tentar abrir cliente de e-mail via link temporário
  const link = document.createElement('a');
  link.href = `mailto:${email}?subject=${subject}&body=${body}`;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Exibir painel de fallback após breve delay (dá tempo para o mailto abrir)
  setTimeout(() => _showSupportPanel(email, planName), 600);
}
window.openSupportContact = openSupportContact;

function _clipboardCopy(text) {
  // Tenta Clipboard API; fallback para execCommand (ambientes sem HTTPS ou WebView antigo)
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try {
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand failed'));
    } catch (e) {
      document.body.removeChild(ta);
      reject(e);
    }
  });
}

function _showSupportPanel(email, planName) {
  const existing = document.getElementById('support-panel');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'support-panel';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9500;display:flex;align-items:flex-end;justify-content:center;padding:0 0 20px';
  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:20px 20px 0 0;padding:24px 24px 32px;max-width:480px;width:100%;box-shadow:0 -8px 32px rgba(0,0,0,0.5)';

  const title = document.createElement('div');
  title.style.cssText = 'font-family:Syne,sans-serif;font-weight:700;font-size:1rem;margin-bottom:8px';
  title.textContent = '📧 Falar com suporte';

  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:0.82rem;color:var(--muted);margin-bottom:6px;line-height:1.6';
  desc.textContent = 'Se o app de e-mail não abriu, copie o endereço abaixo e envie sua mensagem:';

  const emailEl = document.createElement('div');
  emailEl.style.cssText = 'font-size:0.88rem;font-weight:600;color:var(--text);margin-bottom:4px;user-select:all';
  emailEl.textContent = email;

  if (planName) {
    const planEl = document.createElement('div');
    planEl.style.cssText = 'font-size:0.72rem;color:var(--muted);margin-bottom:16px';
    planEl.textContent = `Plano atual: ${planName}`;
    sheet.append(title, desc, emailEl, planEl);
  } else {
    sheet.append(title, desc, emailEl);
  }

  const copyBtn = document.createElement('button');
  copyBtn.style.cssText = 'width:100%;background:var(--accent);color:#fff;border:none;border-radius:12px;padding:13px;font-family:Syne,sans-serif;font-weight:700;font-size:0.9rem;cursor:pointer;margin-bottom:8px';
  copyBtn.textContent = '📋 Copiar e-mail';
  copyBtn.onclick = () => {
    _clipboardCopy(email)
      .then(() => { toast('E-mail copiado! ✓', 'success'); overlay.remove(); })
      .catch(() => { toast('Copie: ' + email, 'info'); });
  };

  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'width:100%;background:none;border:1px solid var(--border);border-radius:12px;padding:12px;color:var(--muted);font-family:DM Sans,sans-serif;font-size:0.88rem;cursor:pointer';
  closeBtn.textContent = 'Fechar';
  closeBtn.onclick = () => overlay.remove();

  sheet.appendChild(copyBtn);
  sheet.appendChild(closeBtn);
  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// Remove categoria padrão: remapeia transações para "Sem categoria"
export function deleteDefaultCat(cat) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  // 'Sem categoria' nunca pode ser removida — é o fallback do sistema
  if (cat === 'Sem categoria') { toast('Esta categoria é obrigatória e não pode ser removida.', 'error'); return; }
  // Contar transações afetadas (principal + splits)
  let affectedCount = 0;
  transactions.forEach(t => {
    if (t.cat === cat) affectedCount++;
    if (t.splits) t.splits.forEach(s => { if (s.cat === cat) affectedCount++; });
  });
  const countMsg = affectedCount > 0
    ? `\n${affectedCount} transação(ões) serão movidas para "Sem categoria".`
    : '\nNenhuma transação usa essa categoria.';
  if (!confirm(`Remover a categoria "${cat}"?${countMsg}\n\nEssa ação não pode ser desfeita.`)) return;
  // Remap transactions
  transactions = transactions.map(t => ({
    ...t,
    cat: t.cat === cat ? 'Sem categoria' : t.cat,
    splits: t.splits ? t.splits.map(s => ({ ...s, cat: s.cat === cat ? 'Sem categoria' : s.cat })) : t.splits
  }));
  saveTransactions();
  // Persist deleted default in localStorage
  const key = 'finno_del_cats_' + uid;
  const deleted = JSON.parse(localStorage.getItem(key) || '[]');
  if (!deleted.includes(cat)) { deleted.push(cat); localStorage.setItem(key, JSON.stringify(deleted)); }
  buildCatSelects();
  buildCatManagerList();
  const suffix = affectedCount > 0 ? ` ${affectedCount} transação(ões) remapeada(s).` : '';
  toast(`Categoria removida.${suffix}`, 'info');
}
window.deleteDefaultCat = deleteDefaultCat;

// ── Split Transaction (FASE 5) ────────────────────────────────────
// Permite dividir uma transação em múltiplas categorias

let _splitTxId = null;  // id da transação sendo dividida

export function openSplitModal(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) return;
  _splitTxId = txId;
  // Configurar total disponível
  const totalEl = document.getElementById('split-total-amount');
  if (totalEl) totalEl.textContent = `R$ ${Math.abs(tx.amount).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
  document.getElementById('split-tx-desc').textContent = tx.desc || 'Transação';
  // Resetar linhas
  const container = document.getElementById('split-rows');
  if (container) container.innerHTML = '';
  // Pré-preencher com splits existentes ou 2 linhas em branco
  if (tx.splits && tx.splits.length > 0) {
    tx.splits.forEach(s => _addSplitRow(s.cat, Math.abs(s.amount), s.desc));
  } else {
    _addSplitRow(tx.cat, Math.abs(tx.amount));
    _addSplitRow();
  }
  _updateSplitProgress(Math.abs(tx.amount));
  document.getElementById('modal-split')?.classList.add('open');
}
window.openSplitModal = openSplitModal;

function _addSplitRow(cat, amount, desc) {
  const cats = getAllCategories();
  const container = document.getElementById('split-rows');
  if (!container) return;
  const rowId = _genId();
  const row = document.createElement('div');
  row.className = 'split-row';
  row.dataset.rowId = rowId;
  row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px';
  row.innerHTML = `
    <select style="flex:2;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:0.8rem;outline:none">
      ${cats.map(c => `<option${c===(cat||'')?' selected':''}>${c}</option>`).join('')}
    </select>
    <input type="number" placeholder="Valor" step="0.01" value="${amount||''}" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:0.8rem;outline:none" oninput="_updateSplitProgressFromTx()">
    <input type="text" placeholder="Obs" value="${desc||''}" style="flex:2;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:0.8rem;outline:none">
    <button onclick="this.closest('.split-row').remove();_updateSplitProgressFromTx()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:6px 8px;color:var(--danger);cursor:pointer;flex-shrink:0">✕</button>
  `;
  container.appendChild(row);
}

export function addSplitRow() {
  _addSplitRow();
  _updateSplitProgressFromTx();
}
window.addSplitRow = addSplitRow;

function _updateSplitProgressFromTx() {
  const tx = transactions.find(t => t.id === _splitTxId);
  if (tx) _updateSplitProgress(Math.abs(tx.amount));
}

function _updateSplitProgress(total) {
  const rows = document.querySelectorAll('#split-rows .split-row');
  let allocated = 0;
  rows.forEach(row => {
    const val = parseFloat(row.querySelector('input[type=number]')?.value) || 0;
    allocated += val;
  });
  allocated = Math.round(allocated * 100) / 100;
  const remaining = Math.round((total - allocated) * 100) / 100;
  const pct = total > 0 ? Math.min(Math.round((allocated / total) * 100), 100) : 0;
  const barEl = document.getElementById('split-progress-bar');
  const textEl = document.getElementById('split-progress-text');
  const warnEl = document.getElementById('split-warning');
  if (barEl) { barEl.style.width = pct + '%'; barEl.style.background = pct > 100 ? '#f87171' : pct === 100 ? '#4ade80' : '#fbbf24'; }
  if (textEl) textEl.textContent = `R$ ${allocated.toLocaleString('pt-BR',{minimumFractionDigits:2})} alocados de R$ ${total.toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
  if (warnEl) warnEl.style.display = remaining !== 0 ? 'block' : 'none';
  if (warnEl) warnEl.textContent = remaining > 0 ? `⚠️ Faltam R$ ${remaining.toLocaleString('pt-BR',{minimumFractionDigits:2})} para alocar` : `⚠️ Total excedido em R$ ${Math.abs(remaining).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
}
window._updateSplitProgressFromTx = _updateSplitProgressFromTx;

export function saveSplits() {
  const tx = transactions.find(t => t.id === _splitTxId);
  if (!tx) return;
  const total = Math.abs(tx.amount);
  const rows = document.querySelectorAll('#split-rows .split-row');
  const splits = [];
  let sum = 0;
  rows.forEach(row => {
    const cat   = row.querySelector('select')?.value;
    const amt   = parseFloat(row.querySelector('input[type=number]')?.value) || 0;
    const desc  = row.querySelector('input[type=text]')?.value.trim() || '';
    if (cat && amt > 0) { splits.push({ cat, amount: tx.amount < 0 ? -Math.abs(amt) : Math.abs(amt), desc: desc || undefined }); sum += amt; }
  });
  sum = Math.round(sum * 100) / 100;
  if (Math.abs(sum - total) > 0.01) { toast(`A soma dos splits (R$ ${sum.toLocaleString('pt-BR',{minimumFractionDigits:2})}) deve ser igual ao valor total.`, 'error'); return; }
  if (splits.length < 2) { toast('Crie ao menos 2 categorias para dividir.', 'error'); return; }
  const idx = transactions.findIndex(t => t.id === _splitTxId);
  if (idx !== -1) {
    transactions[idx].splits = splits;
    transactions[idx].cat = splits[0].cat;  // cat principal = primeiro split
  }
  saveTransactions();
  buildTransactions();
  buildCategories();
  buildHomePanel();
  closeModal('modal-split');
  toast(`✓ Transação dividida em ${splits.length} categorias.`, 'success');
}
window.saveSplits = saveSplits;

export function clearSplits(txId) {
  const id = txId || _splitTxId;
  const idx = transactions.findIndex(t => t.id === id);
  if (idx !== -1) {
    delete transactions[idx].splits;
    saveTransactions();
    buildTransactions();
    buildCategories();
    toast('Divisão removida.', 'info');
  }
  closeModal('modal-split');
}
window.clearSplits = clearSplits;

// ── Lançamentos Recorrentes (FASE 2) ──────────────────────────────
// TODO(cloud): migrar finno_recurring_<uid> para Firestore quando disponível

function _recurringKey() { const uid=auth.currentUser?.uid; return uid?'finno_recurring_'+uid:null; }
function loadRecurring() { const k=_recurringKey(); if(!k) return []; try { return JSON.parse(localStorage.getItem(k)||'[]'); } catch(e) { return []; } }
function saveRecurring(list) { const k=_recurringKey(); if(!k) return; try { localStorage.setItem(k,JSON.stringify(list)); } catch(e) { toast('Erro ao salvar recorrentes.','error'); } } // TODO(cloud): substituir por Firestore batch write quando migrar

function _advanceDate(dateStr, frequency) {
  const d = new Date(dateStr+'T00:00:00'); // T00:00:00 = parse como hora local
  if (frequency==='weekly')  d.setDate(d.getDate()+7);
  if (frequency==='monthly') d.setMonth(d.getMonth()+1);
  if (frequency==='yearly')  d.setFullYear(d.getFullYear()+1);
  return _localDateStr(d); // ← usa local, não UTC
}

export function processRecurring() {
  const recurring = loadRecurring();
  if (recurring.length === 0) return;
  const todayStr = _localDateStr();
  let generated = 0;
  let changed = false;
  recurring.forEach(rule => {
    if (!rule.active || !rule.nextDate) return;
    let safety = 0;
    while (rule.nextDate <= todayStr && safety < 365) {
      safety++;
      const tx = { id: _genId(), date: rule.nextDate, desc: rule.desc, cat: rule.cat, amount: rule.amount, bank: rule.bank || 'Recorrente', recurring: rule.id };
      if (rule.note) tx.note = rule.note;
      transactions.unshift(tx);
      rule.nextDate = _advanceDate(rule.nextDate, rule.frequency);
      generated++;
      changed = true;
    }
  });
  if (changed) {
    saveRecurring(recurring);
    saveTransactions();
    if (generated > 0) toast(`🔄 ${generated} lançamento(s) recorrente(s) gerado(s).`, 'success');
  }
}
window.processRecurring = processRecurring;

let _recurringEditingId = null;

export function openRecurringModal(id) {
  _recurringEditingId = id || null;
  const recurring = loadRecurring();
  const rule = id ? recurring.find(r => r.id === id) : null;
  const titleEl = document.getElementById('modal-recurring-title');
  const saveBtn = document.getElementById('recurring-save-btn');
  const delBtn  = document.getElementById('recurring-delete-btn');
  if (titleEl) titleEl.textContent = rule ? 'Editar recorrente' : 'Nova recorrência';
  if (saveBtn) saveBtn.onclick = rule ? () => saveRecurringEdit(id) : addRecurring;
  if (delBtn)  delBtn.style.display = rule ? 'block' : 'none';
  const today = _localDateStr();
  document.getElementById('rec-type').value  = rule ? (rule.amount < 0 ? 'Gasto' : 'Receita') : 'Gasto';
  document.getElementById('rec-desc').value  = rule?.desc || '';
  document.getElementById('rec-val').value   = rule ? Math.abs(rule.amount) : '';
  document.getElementById('rec-cat').value   = rule?.cat || '🔧 Outros';
  document.getElementById('rec-freq').value  = rule?.frequency || 'monthly';
  document.getElementById('rec-next').value  = rule?.nextDate || today;
  const noteEl = document.getElementById('rec-note');
  if (noteEl) noteEl.value = rule?.note || '';
  document.getElementById('modal-recurring')?.classList.add('open');
}
window.openRecurringModal = openRecurringModal;

export function addRecurring() {
  const desc  = document.getElementById('rec-desc')?.value.trim();
  const val   = parseFloat(document.getElementById('rec-val')?.value);
  const cat   = document.getElementById('rec-cat')?.value;
  const type  = document.getElementById('rec-type')?.value;
  const freq  = document.getElementById('rec-freq')?.value;
  const next  = document.getElementById('rec-next')?.value;
  const note  = document.getElementById('rec-note')?.value.trim() || '';
  if (!desc || !val || val <= 0 || !next) { toast('Preencha todos os campos obrigatórios.', 'error'); return; }
  const amount = type === 'Gasto' ? -Math.abs(val) : Math.abs(val);
  const rule = { id: _genId(), desc, cat, amount, bank: 'Recorrente', frequency: freq, nextDate: next, active: true, createdAt: Date.now() };
  if (note) rule.note = note;
  const recurring = loadRecurring();
  recurring.push(rule);
  saveRecurring(recurring);
  buildRecurringList();
  closeModal('modal-recurring');
  const freqLabel = { weekly:'semanal', monthly:'mensal', yearly:'anual' };
  toast(`Recorrência criada: "${desc}" (${freqLabel[freq]||freq})`, 'success');
}
window.addRecurring = addRecurring;

export function saveRecurringEdit(id) {
  const desc  = document.getElementById('rec-desc')?.value.trim();
  const val   = parseFloat(document.getElementById('rec-val')?.value);
  const cat   = document.getElementById('rec-cat')?.value;
  const type  = document.getElementById('rec-type')?.value;
  const freq  = document.getElementById('rec-freq')?.value;
  const next  = document.getElementById('rec-next')?.value;
  const note  = document.getElementById('rec-note')?.value.trim() || '';
  if (!desc || !val || val <= 0 || !next) { toast('Preencha todos os campos obrigatórios.', 'error'); return; }
  const amount = type === 'Gasto' ? -Math.abs(val) : Math.abs(val);
  const recurring = loadRecurring();
  const idx = recurring.findIndex(r => r.id === id);
  if (idx !== -1) {
    recurring[idx] = { ...recurring[idx], desc, cat, amount, frequency: freq, nextDate: next, note: note || undefined };
    saveRecurring(recurring);
  }
  buildRecurringList();
  closeModal('modal-recurring');
  toast('Recorrência atualizada!', 'success');
}
window.saveRecurringEdit = saveRecurringEdit;

export function deleteRecurring(id) {
  const useId = id || _recurringEditingId;
  if (!useId) return;
  if (!confirm('Excluir esta recorrência?')) return;
  saveRecurring(loadRecurring().filter(r => r.id !== useId));
  buildRecurringList();
  closeModal('modal-recurring');
  toast('Recorrência excluída.', 'info');
}
window.deleteRecurring = deleteRecurring;

export function toggleRecurring(id) {
  const recurring = loadRecurring();
  const r = recurring.find(x => x.id === id);
  if (r) { r.active = !r.active; saveRecurring(recurring); buildRecurringList(); toast(r.active ? '▶️ Recorrência reativada.' : '⏸️ Recorrência pausada.', 'success'); }
}
window.toggleRecurring = toggleRecurring;

export function buildRecurringList() {
  const list = document.getElementById('recurring-list');
  if (!list) return;
  const recurring = loadRecurring();
  if (recurring.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:20px 16px;color:var(--muted);font-size:0.82rem">Nenhuma recorrência criada. Clique em "+ Novo" para adicionar salário, aluguel, assinaturas etc.</div>`;
    return;
  }
  const fL = { weekly:'Semanal', monthly:'Mensal', yearly:'Anual' };
  list.innerHTML = recurring.map(r => {
    const isPos = r.amount > 0;
    const amtStr = `${isPos?'+':''}R$ ${Math.abs(r.amount).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
    const nextFmt = r.nextDate ? new Date(r.nextDate+'T00:00:00').toLocaleDateString('pt-BR') : '—';
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);opacity:${r.active?1:0.5}">
      <div style="font-size:1.3rem;flex-shrink:0">${(r.cat||'').split(' ')[0]||'🔄'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.85rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.desc}</div>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:2px">${fL[r.frequency]||r.frequency} · Próx: ${nextFmt}</div>
      </div>
      <div style="font-family:Syne,sans-serif;font-weight:700;font-size:0.88rem;color:${isPos?'var(--success)':'var(--danger)'};flex-shrink:0">${amtStr}</div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button onclick="toggleRecurring('${r.id}')" title="${r.active?'Pausar':'Reativar'}" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:4px 8px;cursor:pointer;font-size:0.8rem">${r.active?'⏸':'▶️'}</button>
        <button onclick="openRecurringModal('${r.id}')" style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:4px 8px;cursor:pointer;font-size:0.8rem">✏️</button>
      </div>
    </div>`;
  }).join('');
}
window.buildRecurringList = buildRecurringList;

// ── Goal detail ───────────────────────────────────────────────────
let currentGoalIdx = null;

export function openGoalDetail(idx) {
  currentGoalIdx = idx;
  const g = goals[idx];
  if (!g) return;
  document.getElementById('gd-icon').textContent = g.icon || '🎯';
  document.getElementById('gd-name').textContent = g.name;
  document.getElementById('gd-current').value = g.current;
  document.getElementById('gd-target').value = g.target;
  document.getElementById('gd-icon-input').value = g.icon || '🎯';
  if (g.deadline) document.getElementById('gd-deadline').value = g.deadline;
  updateGoalPreview();
  document.getElementById('modal-goal-detail').classList.add('open');
}
window.openGoalDetail = openGoalDetail;

export function updateGoalPreview() {
  const current = parseFloat(document.getElementById('gd-current')?.value) || 0;
  const target = parseFloat(document.getElementById('gd-target')?.value) || 0;
  const deadline = document.getElementById('gd-deadline')?.value;
  const pct = target > 0 ? Math.min(Math.round((current/target)*100),100) : 0;
  const pctEl = document.getElementById('gd-pct');
  const barEl = document.getElementById('gd-bar');
  const progEl = document.getElementById('gd-progress-text');
  const estEl = document.getElementById('gd-estimate');
  if (pctEl) pctEl.textContent = pct + '%';
  if (barEl) barEl.style.width = pct + '%';
  if (progEl) progEl.textContent = `R$ ${current.toLocaleString('pt-BR',{minimumFractionDigits:2})} de R$ ${target.toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
  if (estEl) {
    const remaining = target - current;
    if (remaining > 0 && deadline) {
      const daysLeft = Math.ceil((new Date(deadline + 'T00:00:00') - new Date()) / 86400000);
      const monthsLeft = Math.max(Math.ceil(daysLeft/30),1);
      const perMonth = remaining / monthsLeft;
      estEl.style.display = 'block';
      estEl.innerHTML = `📅 Faltam <b>${daysLeft > 0 ? daysLeft + ' dias' : 'prazo encerrado'}</b> · Guardar <b>R$ ${perMonth.toLocaleString('pt-BR',{minimumFractionDigits:2})}/mês</b>`;
    } else if (remaining <= 0) { estEl.style.display='block'; estEl.innerHTML='🎉 <b>Meta atingida!</b> Parabéns!'; }
    else { estEl.style.display='none'; }
  }
}
window.updateGoalPreview = updateGoalPreview;

export function saveGoalDetail() {
  if (currentGoalIdx === null) return;
  const current = parseFloat(document.getElementById('gd-current').value) || 0;
  const target = parseFloat(document.getElementById('gd-target').value) || 0;
  const deadline = document.getElementById('gd-deadline').value;
  const icon = document.getElementById('gd-icon-input').value || goals[currentGoalIdx].icon || '🎯';
  if (target <= 0) { toast('Informe um valor de meta válido.','error'); return; }
  goals[currentGoalIdx].current = current;
  goals[currentGoalIdx].target = target;
  goals[currentGoalIdx].deadline = deadline || null;
  goals[currentGoalIdx].icon = icon;
  saveGoals();
  closeModal('modal-goal-detail');
  buildGoals();
  toast('Meta atualizada! ✓','success');
}
window.saveGoalDetail = saveGoalDetail;

export function deleteGoal() {
  if (currentGoalIdx === null) return;
  if (!confirm('Excluir esta meta?')) return;
  goals.splice(currentGoalIdx, 1);
  currentGoalIdx = null;
  saveGoals();
  closeModal('modal-goal-detail');
  buildGoals();
  toast('Meta excluída.','success');
}
window.deleteGoal = deleteGoal;

export function refreshInsights() {
  buildInsights();
  if (currentPlan !== 'free' && currentPlan !== 'none') toast('Insights atualizados! ✓','success');
}
window.refreshInsights = refreshInsights;

// ── Plan management ───────────────────────────────────────────────
export function showConnectState(state, uid) {
  ['paywall','trial','expired','premium'].forEach(s => { const el=document.getElementById('connect-state-'+s); if(el) el.style.display='none'; });
  const target = (state === 'none' || state === 'free') ? 'paywall' : state;
  const el = document.getElementById('connect-state-' + target);
  if (!el) return;
  el.style.display = 'block';
  if (target === 'paywall') {
    // Atualizar botão e hint de elegibilidade do trial
    setTimeout(updateTrialButtonUI, 50);
  }
  if (state === 'trial') {
    const label = document.getElementById('trial-days-label');
    if (label) label.textContent = getTrialDaysLeft(uid) + ' dia(s) restante(s) de trial';
    restoreConnectedItems('trial');
  } else if (state === 'premium') {
    restoreConnectedItems('premium');
  }
}
window.showConnectState = showConnectState;

function restoreConnectedItems(state) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const saved = localStorage.getItem('finno_banks_' + uid);
    if (!saved) return;
    const ids = JSON.parse(saved);
    window.connectedItems = ids.map(id => ({ id, details: { connector: { name: 'Banco conectado' } } }));
    if (state === 'trial' && window.connectedItems.length > 0) {
      const listEl=document.getElementById('connected-accounts-list'); const goBtn=document.getElementById('go-dashboard-btn'); const connectBtn=document.getElementById('pluggy-connect-btn'); const itemsEl=document.getElementById('connected-items');
      if (listEl) listEl.style.display='block'; if (goBtn) goBtn.style.display='block'; if (connectBtn) connectBtn.style.display='none';
      if (itemsEl) itemsEl.innerHTML = window.connectedItems.map(i=>`<div style="display:flex;align-items:center;gap:12px;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.2);border-radius:12px;padding:12px 16px;margin-bottom:8px"><span style="font-size:1.4rem">🏦</span><div style="flex:1"><div style="font-size:0.88rem;font-weight:600">${i.details?.connector?.name||'Banco'}</div><div style="font-size:0.72rem;color:var(--success)">✓ Conectado</div></div></div>`).join('');
      const notice=document.getElementById('trial-limit-notice'); if(notice) notice.style.display='block';
    } else if (state === 'premium') { renderPremiumConnectedItems(); }
  } catch(e) {}
}
window.restoreConnectedItems = restoreConnectedItems;

function renderPremiumConnectedItems() {
  const el = document.getElementById('premium-connected-items');
  const addWrap = document.getElementById('premium-add-btn-wrap');
  if (!el) return;
  const ci = window.connectedItems || [];
  el.innerHTML = ci.length === 0 ? '<div style="text-align:center;padding:16px;color:var(--muted);font-size:0.85rem">Nenhum banco conectado ainda.</div>' : ci.map(i=>`<div style="display:flex;align-items:center;gap:12px;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.2);border-radius:12px;padding:12px 16px;margin-bottom:8px"><span style="font-size:1.4rem">🏦</span><div style="flex:1"><div style="font-size:0.88rem;font-weight:600">${i.details?.connector?.name||'Banco conectado'}</div><div style="font-size:0.72rem;color:var(--success)">✓ Conectado</div></div></div>`).join('');
  if (addWrap) { addWrap.innerHTML = ci.length >= 2 ? '<div style="background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:12px;padding:12px 16px;text-align:center;font-size:0.8rem;color:var(--muted)">🔒 Limite de 2 bancos atingido no Premium</div>' : `<button class="btn-outline" onclick="openPluggyConnect()" style="width:100%;padding:12px;margin-bottom:10px;font-size:0.85rem">+ Adicionar banco (${ci.length}/2)</button>`; }
}
window.renderPremiumConnectedItems = renderPremiumConnectedItems;

export function startTrial() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const btn = document.getElementById('start-trial-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Ativando...'; }
  setTimeout(() => {
    localStorage.setItem('finno_plan_'+uid,'trial');
    localStorage.setItem('finno_trial_start_'+uid, Date.now().toString());
    savePlanToFirestore(uid, 'trial');
    currentPlan = 'trial';
    showConnectState('trial', uid);
    toast('✓ Trial ativado! Conecte seu banco agora.','success');
  }, 800);
}
window.startTrial = startTrial;

export function skipToFree() {
  const uid = auth.currentUser?.uid;
  if (uid) {
    const cur = localStorage.getItem('finno_plan_'+uid);
    if (!cur || cur === 'none') {
      localStorage.setItem('finno_plan_'+uid,'free');
      savePlanToFirestore(uid, 'free');
    }
    localStorage.setItem('finno_setup_'+uid,'1');
  }
  currentPlan = 'free';
  showScreen('screen-loading');
  runLoadingSequence(() => { showScreen('screen-dashboard'); buildDashboard(); applyPlanUI('free'); });
}
window.skipToFree = skipToFree;

export function choosePlan(plan) {
  if (['plus','pro','premium'].includes(plan)) { showPlanPayment(plan); return; }
  const uid = auth.currentUser?.uid;
  if (uid) {
    localStorage.setItem('finno_plan_'+uid,'free');
    localStorage.setItem('finno_setup_'+uid,'1');
    savePlanToFirestore(uid, 'free');
  }
  currentPlan = 'free';
  showScreen('screen-loading');
  runLoadingSequence(() => { showScreen('screen-dashboard'); buildDashboard(); applyPlanUI('free'); });
}
window.choosePlan = choosePlan;

// Mapa de planos pagos: id → { label, price, emoji, tagline, features }
const PLAN_DEFS = {
  plus:    { label:'FinnoFlow Plus',    price:'R$ 9,90',  emoji:'✨', tagline:'Sem distrações, foco total',              features:['Sem anúncios no app','Todas as categorias','Metas financeiras (até 3)','Interface limpa premium','Suporte por e-mail'] },
  pro:     { label:'FinnoFlow Pro',     price:'R$ 14,90', emoji:'🤖', tagline:'Insights automáticos para economizar mais', features:['Tudo do Plus','IA financeira personalizada','Metas ilimitadas','Relatórios e exportação PDF','Alertas de gastos','Suporte prioritário'] },
  premium: { label:'FinnoFlow Premium', price:'R$ 19,90', emoji:'🏦', tagline:'Suas finanças no automático',              features:['Tudo do Pro','Conexão com +200 bancos','Sincronização automática','Até 2 contas bancárias','7 dias grátis para testar'] },
};

export function showPlanPayment(planId) {
  const p = PLAN_DEFS[planId] || PLAN_DEFS.premium;
  const hasTrial = planId === 'premium';
  const existing = document.getElementById('payment-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'payment-overlay';
  overlay.dataset.plan = planId;
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';
  overlay.innerHTML = `
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:32px 28px;max-width:420px;width:100%;box-shadow:0 40px 80px rgba(0,0,0,0.6)">
    <div style="text-align:center;margin-bottom:20px">
      <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#a020e0);display:flex;align-items:center;justify-content:center;font-size:1.6rem;margin:0 auto 12px">${p.emoji}</div>
      <div style="font-family:Syne,sans-serif;font-weight:800;font-size:1.2rem;margin-bottom:4px">${p.label}</div>
      <div style="font-family:Syne,sans-serif;font-weight:800;font-size:2.2rem;margin-bottom:2px">${p.price}<span style="font-size:0.9rem;font-weight:400;color:var(--muted)">/mês</span></div>
      <div style="font-size:0.78rem;color:var(--muted);font-style:italic;margin-bottom:6px">${p.tagline}</div>
      ${hasTrial ? '<div style="font-size:0.78rem;color:var(--success)">✓ 7 dias completamente grátis · cancele quando quiser</div>' : '<div style="font-size:0.76rem;color:var(--muted)">Você não será cobrado antes de confirmar</div>'}
    </div>
    <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:20px;background:var(--surface2);border-radius:14px;padding:16px">
      ${p.features.map(f=>`<div style="display:flex;align-items:center;gap:10px;font-size:0.82rem"><span style="color:var(--success)">✓</span>${f}</div>`).join('')}
    </div>
    <div style="background:var(--surface2);border-radius:16px;padding:18px;margin-bottom:16px">
      <div style="font-size:0.72rem;color:var(--muted);font-weight:600;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:12px">Dados do cartão</div>
      <input placeholder="Número do cartão" id="card-number" style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;color:var(--text);font-family:DM Sans,sans-serif;font-size:0.88rem;outline:none;margin-bottom:10px;box-sizing:border-box" maxlength="19" oninput="formatCard(this)" autocomplete="cc-number">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <input placeholder="MM/AA" id="card-expiry" style="background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;color:var(--text);font-family:DM Sans,sans-serif;font-size:0.88rem;outline:none" maxlength="5" oninput="formatExpiry(this)" autocomplete="cc-exp">
        <input placeholder="CVV" id="card-cvv" style="background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;color:var(--text);font-family:DM Sans,sans-serif;font-size:0.88rem;outline:none" maxlength="3" type="password" autocomplete="cc-csc">
      </div>
      <input placeholder="Nome no cartão" id="card-name" style="width:100%;background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:12px 14px;color:var(--text);font-family:DM Sans,sans-serif;font-size:0.88rem;outline:none;box-sizing:border-box" autocomplete="cc-name">
    </div>
    ${hasTrial ? '<div style="background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.18);border-radius:12px;padding:12px 16px;margin-bottom:14px;font-size:0.78rem;color:var(--success);text-align:center">🛡️ <strong>Você não será cobrado agora.</strong> A cobrança de R$ 19,90/mês começa após 7 dias.</div>' : ''}
    <div id="payment-error" style="display:none;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:10px;padding:10px 14px;font-size:0.8rem;color:var(--danger);margin-bottom:12px;text-align:center"></div>
    <button id="pay-btn" onclick="processPayment()" style="width:100%;background:linear-gradient(135deg,var(--accent),#a020e0);color:white;border:none;border-radius:12px;padding:15px;font-family:Syne,sans-serif;font-weight:700;font-size:0.95rem;cursor:pointer;margin-bottom:10px;box-shadow:0 8px 24px rgba(130,10,209,0.35)">
      🔒 ${hasTrial ? 'Testar grátis por 7 dias →' : `Assinar ${p.label} →`}
    </button>
    <button onclick="document.getElementById('payment-overlay').remove()" style="width:100%;background:none;border:none;color:var(--muted);padding:10px;cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.82rem">Cancelar</button>
    <div style="text-align:center;font-size:0.68rem;color:var(--muted);margin-top:10px">🔒 Pagamento seguro · SSL · BCB · Cancele a qualquer momento</div>
  </div>`;
  document.body.appendChild(overlay);
}
window.showPlanPayment = showPlanPayment;
// Alias retrocompatível para qualquer onclick="showPremiumPayment()" remanescente no HTML
window.showPremiumPayment = () => showPlanPayment('premium');

function formatCard(input) {
  let v = input.value.replace(/\D/g,'').slice(0,16);
  v = v.replace(/(\d{4})(?=\d)/g,'$1 ');
  input.value = v;
}
window.formatCard = formatCard;

export function formatExpiry(input) {
  let v = input.value.replace(/\D/g,'').slice(0,4);
  if (v.length > 2) v = v.slice(0,2)+'/'+v.slice(2);
  input.value = v;
}
window.formatExpiry = formatExpiry;

export async function processPayment() {
  const user = auth.currentUser;
  if (!user) return;

  // Descobre qual plano está sendo contratado a partir do overlay
  const planId = document.getElementById('payment-overlay')?.dataset.plan || 'premium';

  // Trial é gratuito — fluxo via setPlan CF (sem Stripe)
  if (planId === 'trial') {
    document.getElementById('payment-overlay')?.remove();
    await startTrial();
    return;
  }

  // Planos pagos: redirecionar para Stripe Checkout
  const btn = document.getElementById('pay-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Aguarde...'; }

  try {
    const url = await createCheckoutSessionViaCloud(
      planId,
      window.location.origin,
      window.location.origin
    );
    if (url) {
      window.location.href = url;
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '🔒 Tentar novamente'; }
      toast('Erro ao iniciar pagamento. Tente novamente.', 'error');
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🔒 Tentar novamente'; }
    const msg = e.code === 'functions/already-exists'
      ? 'Você já possui um plano ativo.'
      : 'Erro ao iniciar pagamento. Tente novamente.';
    toast(msg, 'error');
  }
}
window.processPayment = processPayment;
window.simulatePayment = processPayment;

export function applyPlanUI(plan) {
  currentPlan = plan;

  // Insights paywall (free, plus, expired, none)
  const pi = document.getElementById('paywall-insights');
  const ic = document.getElementById('insights-content');
  const noAI = !hasAI(plan);
  if (pi) { pi.style.display = noAI ? 'flex' : 'none'; pi.style.pointerEvents = noAI ? 'none' : ''; }
  if (ic) ic.style.display = noAI ? 'none' : 'block';

  // Nav sync bar (somente premium e trial têm banco conectado)
  const sync = document.querySelector('.nav-sync');
  if (sync) sync.style.display = hasBanks(plan) ? 'flex' : 'none';

  // Banner de anúncios (apenas plano free)
  const adBanner = document.getElementById('ad-banner');
  if (adBanner) adBanner.style.display = (plan === 'free' || plan === 'none') ? 'flex' : 'none';

  // Avatar: cor por plano
  const avatar = document.getElementById('nav-avatar');
  if (avatar) {
    const gradients = {
      premium: 'linear-gradient(135deg,#7c6dfa,#fa6d9a)',
      trial:   'linear-gradient(135deg,#6dfac8,#7c6dfa)',
      pro:     'linear-gradient(135deg,#7c6dfa,#6090ff)',
      plus:    'linear-gradient(135deg,#4a9af5,#7c6dfa)',
    };
    if (gradients[plan]) { avatar.style.background = gradients[plan]; }
    avatar.title = 'Minha conta';
  }

  // Badge de plano no modal de conta
  const badge = document.getElementById('menu-plan-badge');
  if (badge) {
    const labels = { premium:'🏦 Premium', pro:'🤖 Pro', plus:'✨ Plus', trial:'🔬 Trial ativo', free:'🆓 Gratuito', expired:'⚠️ Trial expirado', none:'🆓 Gratuito' };
    const isPaid = ['premium','pro','plus','trial'].includes(plan);
    badge.textContent = labels[plan] || '🆓 Gratuito';
    badge.style.color     = isPaid ? 'var(--accent)' : 'var(--muted)';
    badge.style.background = isPaid ? 'rgba(124,109,250,0.15)' : 'rgba(255,255,255,0.06)';
  }

  // Seção de plano no modal de conta
  const fs         = document.getElementById('plan-section-free');
  const ps         = document.getElementById('plan-section-premium');
  const upsellEl   = document.getElementById('plan-upsell-paid');
  const planEmoji  = document.getElementById('active-plan-emoji');
  const planNameEl = document.getElementById('active-plan-name');

  const isFree = plan === 'free' || plan === 'none';
  if (fs) fs.style.display = isFree ? 'block' : 'none';
  if (ps) ps.style.display = isFree ? 'none'  : 'block';

  // Emoji e nome do plano ativo
  const emojis = { premium:'🏦', pro:'🤖', plus:'✨', trial:'🔬', expired:'⚠️' };
  if (planEmoji) planEmoji.textContent = emojis[plan] || '⭐';
  if (planNameEl) {
    const names = { premium:'FinnoFlow Premium', pro:'FinnoFlow Pro', plus:'FinnoFlow Plus', trial:'Trial Premium' };
    planNameEl.textContent = names[plan] || '';
  }

  // Upsell discreto por plano (Free usa section própria, pagos usam plan-upsell-paid)
  // Regra: assinantes NÃO devem ver banners agressivos — upsell só quando faz sentido contextual
  if (upsellEl) {
    const bStyle = 'width:100%;display:flex;align-items:center;justify-content:space-between;border-radius:11px;padding:10px 14px;font-family:DM Sans,sans-serif;font-size:0.82rem;cursor:pointer;margin-bottom:6px;border:1px solid;opacity:0.85';
    if (plan === 'plus') {
      // Plus: mostrar próximos passos como sugestão, não como pressão
      upsellEl.innerHTML =
        `<div style="font-size:0.7rem;color:var(--muted);letter-spacing:0.04em;text-transform:uppercase;margin-bottom:8px">Próximos recursos disponíveis</div>
        <button onclick="closeModal('modal-account');setTimeout(()=>showPlanPayment('pro'),200)" style="${bStyle} rgba(124,109,250,0.18);background:rgba(124,109,250,0.06);color:var(--text2)">
          <span>🤖 <strong>Pro</strong> — Insights com IA</span><span style="color:var(--muted);font-size:0.78rem;white-space:nowrap">R$ 14,90/mês</span>
        </button>
        <button onclick="closeModal('modal-account');setTimeout(()=>showPlanPayment('premium'),200)" style="${bStyle} rgba(124,109,250,0.18);background:rgba(124,109,250,0.06);color:var(--text2)">
          <span>🏦 <strong>Premium</strong> — IA + banco automático</span><span style="color:var(--muted);font-size:0.78rem;white-space:nowrap">R$ 19,90/mês</span>
        </button>`;
    } else if (plan === 'pro') {
      // Pro: única sugestão discreta para o Premium
      upsellEl.innerHTML =
        `<div style="font-size:0.7rem;color:var(--muted);letter-spacing:0.04em;text-transform:uppercase;margin-bottom:8px">Próximo nível disponível</div>
        <button onclick="closeModal('modal-account');setTimeout(()=>showPlanPayment('premium'),200)" style="${bStyle} rgba(124,109,250,0.18);background:rgba(124,109,250,0.06);color:var(--text2)">
          <span>🏦 <strong>Premium</strong> — Conecte seu banco automaticamente</span><span style="color:var(--muted);font-size:0.78rem;white-space:nowrap">R$ 19,90/mês</span>
        </button>`;
    } else {
      // Premium / Trial / Expired → VIP, sem upsell
      upsellEl.innerHTML = '';
    }
  }

  // Reconstruir UI dependente do plano
  buildGoals();
  buildInsights();
  // Atualizar home panel com o plano correto (buildHomeInsights usa currentPlan)
  buildHomeInsights();
  updateHomePlanUI();
}
window.applyPlanUI = applyPlanUI;

export function confirmCancelPremium() {
  if (!confirm('Tem certeza que deseja cancelar o Premium?')) return;
  const uid = auth.currentUser?.uid;
  if (uid) {
    localStorage.setItem('finno_plan_'+uid,'free');
    savePlanToFirestore(uid, 'free');
  }
  currentPlan = 'free';
  closeModal('modal-account');
  applyPlanUI('free');
  toast('Assinatura cancelada. Voltando ao plano gratuito.','success');
}
window.confirmCancelPremium = confirmCancelPremium;

export function goToBankConnect() {
  const uid = auth.currentUser?.uid;
  const state = getPlanState(uid);
  showScreen('screen-connect');
  showConnectState(state, uid);
}
window.goToBankConnect = goToBankConnect;

export function showUpgrade(msg) {
  const el = document.getElementById('upgrade-msg');
  if (el && msg) el.textContent = msg;
  const modal = document.getElementById('modal-upgrade');
  if (modal) modal.classList.add('open');
}
window.showUpgrade = showUpgrade;

export function goToDashboard() {
  const uid = auth.currentUser?.uid;
  const alreadySetup = uid && localStorage.getItem('finno_setup_'+uid) === '1';
  if (uid) localStorage.setItem('finno_setup_'+uid,'1');
  const btn = document.getElementById('go-dashboard-btn');
  if (btn) { btn.disabled=true; btn.textContent='Acessando...'; }

  if (alreadySetup) {
    // Usuário já visitou o dashboard — ir direto sem animação de loading
    showScreen('screen-dashboard');
    buildDashboard();
    applyPlanUI(currentPlan);
  } else {
    // Primeira vez — mostrar sequência de loading
    showScreen('screen-loading');
    runLoadingSequence(() => { showScreen('screen-dashboard'); buildDashboard(); applyPlanUI(currentPlan); });
  }
}
window.goToDashboard = goToDashboard;

export function startConnect() {
  showScreen('screen-loading');
  runLoadingSequence(() => {
    const uid = auth.currentUser?.uid;
    if (uid) localStorage.setItem('finno_setup_'+uid,'1');
    showScreen('screen-dashboard');
    buildDashboard();
    applyPlanUI(currentPlan);
  });
}
window.startConnect = startConnect;

// ── Pluggy integration ────────────────────────────────────────────
export async function openPluggyConnect() {
  const uid = auth.currentUser?.uid;
  const state = getPlanState(uid);
  const limit = getBankLimit(state);
  const ci = window.connectedItems || [];

  if (!hasBanks(state)) {
    showUpgrade('Conecte seu banco com o plano Premium — 7 dias grátis para testar.');
    return;
  }
  if (state === 'expired') { showScreen('screen-connect'); showConnectState('expired', uid); return; }
  if (ci.length >= limit) {
    toast(state==='trial'?'Limite de 1 banco no trial. Assine o Premium para conectar até 2.':'Limite de 2 bancos atingido.','error');
    if (state==='trial') { const n=document.getElementById('trial-limit-notice'); if(n) n.style.display='block'; }
    return;
  }

  const btn = document.getElementById('pluggy-connect-btn') || document.getElementById('pluggy-connect-btn-premium');
  if (btn) { btn.disabled=true; btn.textContent='Gerando token...'; }

  let connectToken = null;
  try {
    connectToken = await getPluggyConnectToken();
  } catch(e) { console.warn('Pluggy connect token error:', e.message); }

  if (btn) { btn.disabled=false; btn.innerHTML='🏦 Escolher meu banco'; }
  if (!connectToken) { showPluggySetupModal(); return; }
  openPluggyModal(`https://connect.pluggy.ai?connectToken=${connectToken}`);
}
window.openPluggyConnect = openPluggyConnect;

function showPluggySetupModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:32px 28px;max-width:440px;width:100%;box-shadow:0 40px 80px rgba(0,0,0,0.5)"><div style="font-size:2rem;margin-bottom:16px;text-align:center">🏦</div><div style="font-family:Syne,sans-serif;font-weight:800;font-size:1.15rem;margin-bottom:10px;text-align:center">Configuração de servidor necessária</div><div style="color:var(--muted);font-size:0.82rem;line-height:1.7;margin-bottom:20px">A conexão bancária via Pluggy requer um servidor backend para gerar o token de conexão com segurança (requisito do Banco Central).<br><br>Em produção, configure um endpoint na sua API.</div><button onclick="this.closest('[style*=fixed]').remove()" style="width:100%;background:var(--accent);color:white;border:none;border-radius:12px;padding:14px;font-family:Syne,sans-serif;font-weight:700;cursor:pointer">Entendido</button></div>`;
  document.body.appendChild(overlay);
}
window.showPluggySetupModal = showPluggySetupModal;

function openPluggyModal(url) {
  const overlay = document.createElement('div');
  overlay.id = 'pluggy-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:9000;display:flex;flex-direction:column';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0';
  header.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span style="font-size:1.2rem">🏦</span><div><div style="font-family:Syne,sans-serif;font-weight:700;font-size:0.9rem">Conectar banco</div><div style="font-size:0.72rem;color:var(--muted)">+200 instituições</div></div></div><button id="pluggy-close-btn" style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:8px 16px;color:var(--text);cursor:pointer;font-family:DM Sans,sans-serif;font-size:0.82rem">✕ Fechar</button>`;
  const loader = document.createElement('div');
  loader.style.cssText = 'position:absolute;inset:57px 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg);gap:16px;z-index:1';
  loader.innerHTML = `<div style="font-family:Syne,sans-serif;font-weight:700;font-size:1rem">Carregando...</div><div style="width:36px;height:36px;border:3px solid rgba(124,109,250,0.2);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite"></div>`;
  const iframe = document.createElement('iframe');
  iframe.src = url; iframe.style.cssText = 'flex:1;width:100%;border:none;background:#fff;opacity:0;transition:opacity 0.3s;position:relative;z-index:2';
  iframe.allow = 'camera;microphone;clipboard-write';
  iframe.onload = () => { iframe.style.opacity='1'; loader.style.display='none'; };
  const content = document.createElement('div');
  content.style.cssText = 'flex:1;position:relative;display:flex;flex-direction:column';
  content.appendChild(loader); content.appendChild(iframe);
  overlay.appendChild(header); overlay.appendChild(content);
  document.body.appendChild(overlay);
  document.getElementById('pluggy-close-btn').onclick = () => { window.removeEventListener('message', handlePluggyMsg); overlay.remove(); };
  function handlePluggyMsg(event) {
    if (!event.origin.includes('pluggy')) return;
    const { type, data } = event.data || {};
    const successTypes = ['pluggy:connect:success','pluggy:item:created','pluggy:item:updated','pluggy:createItem'];
    if (successTypes.includes(type)) { window.removeEventListener('message', handlePluggyMsg); overlay.remove(); onBankConnected(data || {}); }
    if (['pluggy:connect:close','pluggy:close','pluggy:exit'].includes(type)) { window.removeEventListener('message', handlePluggyMsg); overlay.remove(); }
  }
  window.addEventListener('message', handlePluggyMsg);
}
window.openPluggyModal = openPluggyModal;

async function onBankConnected(itemData) {
  const uid = auth.currentUser?.uid;
  const state = getPlanState(uid);
  const limit = getBankLimit(state);
  const ci = window.connectedItems || [];
  if (ci.length >= limit) { toast('Limite de bancos atingido.','error'); return; }
  const itemId = itemData?.item?.id||itemData?.id||itemData?.itemId||('item_'+Date.now());
  const name = itemData?.connector?.name||itemData?.item?.connector?.name||'Banco conectado';
  ci.push({ id:itemId, details:{ connector:{ name } } });
  window.connectedItems = ci;
  if (uid) localStorage.setItem('finno_banks_'+uid, JSON.stringify(ci.map(i=>i.id)));
  toast('Banco conectado com sucesso! ✓','success');
  if (state === 'trial') {
    const listEl=document.getElementById('connected-accounts-list'); const itemsEl=document.getElementById('connected-items'); const goBtn=document.getElementById('go-dashboard-btn'); const connectBtn=document.getElementById('pluggy-connect-btn');
    if(listEl) listEl.style.display='block'; if(goBtn) goBtn.style.display='block'; if(connectBtn) connectBtn.style.display='none';
    if(itemsEl){const el=document.createElement('div');el.className='checkmark-anim';el.style.cssText='display:flex;align-items:center;gap:12px;background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.2);border-radius:12px;padding:12px 16px;margin-bottom:8px';el.innerHTML=`<span style="font-size:1.4rem">🏦</span><div style="flex:1"><div style="font-size:0.88rem;font-weight:600">${name}</div><div style="font-size:0.72rem;color:var(--success)">✓ Conectado</div></div>`;itemsEl.appendChild(el);}
    const notice=document.getElementById('trial-limit-notice'); if(notice) notice.style.display='block';
  } else if (state === 'premium') { renderPremiumConnectedItems(); }
}
window.onBankConnected = onBankConnected;

export function buildDashboardWithRealData(data) {
  showScreen('screen-dashboard');
  const { accounts, transactions: txs } = data;
  // Merge real transactions with user data
  if (txs && txs.length > 0) {
    const uid = auth.currentUser?.uid;
    transactions = txs.map(t => ({
      date: (t.date || '').split('T')[0],
      desc: t.description || t.descriptionRaw || 'Transação',
      cat: t.category || '🔧 Outros',
      amount: t.amount || 0,
      bank: t.bankName || 'Banco'
    }));
    if (uid) saveTransactions();
  }
  buildHomePanel();
  buildChart();
  buildTransactions();
  buildCategories();
  buildGoals();
  buildInsights();
  if (accounts) buildRealAccounts(accounts);
}
window.buildDashboardWithRealData = buildDashboardWithRealData;

export function buildRealAccounts(accounts) {
  const list = document.querySelector('.accounts-list');
  if (!list) return;
  const typeLabels = { CHECKING:'Conta Corrente', SAVINGS:'Poupança', CREDIT:'Cartão de Crédito', INVESTMENT:'Investimento' };
  const typeIcons = { CHECKING:'🏦', SAVINGS:'💰', CREDIT:'💳', INVESTMENT:'📈' };
  list.innerHTML = accounts.map(acc => {
    const isNeg=(acc.balance||0)<0; const type=typeLabels[acc.type]||acc.type||'Conta'; const icon=typeIcons[acc.type]||'🏦'; const last4=acc.number?acc.number.slice(-4):'****';
    return `<div class="account-card"><div class="account-icon" style="background:rgba(124,109,250,0.12)">${icon}</div><div class="account-info"><div class="name">${acc.bankName||acc.name||type}</div><div class="type">${type} · •••• ${last4}</div></div><div class="account-balance"><div class="amount" style="${isNeg?'color:var(--danger)':''}">${isNeg?'−':''}R$ ${Math.abs(acc.balance||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div><div class="sync-time">agora</div></div></div>`;
  }).join('');
}
window.buildRealAccounts = buildRealAccounts;

export function buildRealTransactions(txs) {
  // Update internal array and re-render
  if (txs) {
    transactions = txs.map(t => ({
      date: (t.date||'').split('T')[0],
      desc: t.description || t.descriptionRaw || 'Transação',
      cat: t.category || '🔧 Outros',
      amount: t.amount || 0,
      bank: t.bankName || ''
    }));
  }
  renderTransactions(transactions);
}
window.buildRealTransactions = buildRealTransactions;

export function buildRealCategories(txs) {
  if (txs) buildCategoriesFromTx(txs.filter(t => t.amount < 0).map(t => ({
    cat: t.category || '🔧 Outros',
    amount: t.amount
  })));
}
window.buildRealCategories = buildRealCategories;

// ── Home panel ────────────────────────────────────────────────────
let homePeriod = 'month';

export function buildHomePanel() {
  updateHomeGreeting();
  buildHomeDonut();
  buildHomeInsights();
  updateHomePlanUI();
  animateHomeBalance();
}
window.buildHomePanel = buildHomePanel;

function updateHomeGreeting() {
  const user = auth.currentUser;
  const nameEl = document.getElementById('home-user-name');
  if (!nameEl) return;
  const name = user?.displayName || user?.email?.split('@')[0] || '';
  const firstName = name.split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  nameEl.textContent = firstName ? greeting + ', ' + firstName + ' 👋' : 'Bem-vindo ao FinnoFlow 👋';
}
window.updateHomeGreeting = updateHomeGreeting;

function animateHomeBalance() {
  const intEl = document.getElementById('home-balance-int');
  const decEl = document.querySelector('#panel-visao-geral .home-balance-value span:last-child');
  if (!intEl) return;

  // Calculate actual balance from user's transactions
  const balance = calcBalance();
  const dur = 800;
  const start = Date.now();

  function tick() {
    const p = Math.min((Date.now()-start)/dur,1);
    const eased = 1 - Math.pow(1-p,3);
    const val = balance * eased;
    const formatted = Math.abs(val).toLocaleString('pt-BR',{minimumFractionDigits:2});
    const parts = formatted.split(',');
    intEl.textContent = (val < 0 ? '-' : '') + parts[0];
    if (decEl) decEl.textContent = ',' + (parts[1] || '00');
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Update metrics
  const monthTx = filterTxMonth(transactions);
  const monthIncome = calcIncome(monthTx);
  const monthExpenses = calcExpenses(monthTx);

  const expEl = document.getElementById('home-expenses');
  const incEl = document.getElementById('home-income');
  const avEl = document.getElementById('home-available');
  if (expEl) expEl.textContent = monthExpenses > 0 ? 'R$ ' + monthExpenses.toLocaleString('pt-BR',{maximumFractionDigits:0}) : 'R$ 0';
  if (incEl) incEl.textContent = monthIncome > 0 ? 'R$ ' + monthIncome.toLocaleString('pt-BR',{maximumFractionDigits:0}) : 'R$ 0';
  if (avEl) avEl.textContent = 'R$ ' + Math.max(0, monthIncome - monthExpenses).toLocaleString('pt-BR',{maximumFractionDigits:0});

  // Sync label
  const syncEl = document.getElementById('home-sync-text');
  if (syncEl && (currentPlan === 'premium' || currentPlan === 'trial')) {
    syncEl.textContent = 'Atualizado automaticamente';
  } else if (syncEl) {
    syncEl.textContent = transactions.length > 0 ? 'Atualizado manualmente' : 'Adicione transações para começar';
  }
}
window.animateHomeBalance = animateHomeBalance;

export function setHomePeriod(btn, period) {
  homePeriod = period;
  document.querySelectorAll('.period-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');

  const periodTx = filterTxByPeriod(transactions, period);
  const income = calcIncome(periodTx);
  const expenses = calcExpenses(periodTx);
  const available = Math.max(0, income - expenses);

  const expEl=document.getElementById('home-expenses');
  const incEl=document.getElementById('home-income');
  const avEl=document.getElementById('home-available');
  if(expEl) expEl.textContent = 'R$ ' + expenses.toLocaleString('pt-BR',{maximumFractionDigits:0});
  if(incEl) incEl.textContent = 'R$ ' + income.toLocaleString('pt-BR',{maximumFractionDigits:0});
  if(avEl)  avEl.textContent  = 'R$ ' + available.toLocaleString('pt-BR',{maximumFractionDigits:0});
  buildHomeDonut();
}
window.setHomePeriod = setHomePeriod;

export function buildHomeDonut() {
  const svg = document.getElementById('home-donut');
  const legendEl = document.getElementById('home-chart-legend');
  const totalEl = document.getElementById('home-donut-total');
  if (!svg || !legendEl) return;

  // Use real user data
  const periodTx = filterTxByPeriod(transactions, homePeriod).filter(t => t.amount < 0);

  if (periodTx.length === 0) {
    // Show empty state
    svg.innerHTML = `<circle cx="55" cy="55" r="38" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="14"/>`;
    if (totalEl) totalEl.textContent = 'R$0';
    legendEl.innerHTML = `<div style="font-size:0.75rem;color:rgba(180,210,255,0.4);text-align:center">Sem dados</div>`;
    return;
  }

  const catMap = {};
  periodTx.forEach(t => { const cat = t.cat || '🔧 Outros'; catMap[cat] = (catMap[cat]||0) + Math.abs(t.amount); });
  const cats = Object.entries(catMap).sort((a,b) => b[1]-a[1]).slice(0,6).map(([cat, amount], i) => {
    const colors = ['#0066ff','#00c896','#ff6b6b','#fbbf24','#a78bfa','#34d399'];
    return { name: cat.replace(/^[^\s]+\s/, ''), icon: cat.split(' ')[0] || '💸', amount, color: colors[i % colors.length] };
  });
  const total = cats.reduce((s,c)=>s+c.amount,0);
  if (totalEl) totalEl.textContent = total >= 1000 ? 'R$'+(total/1000).toFixed(1)+'k' : 'R$'+total.toLocaleString('pt-BR',{maximumFractionDigits:0});

  const cx=55,cy=55,r=38,stroke=14,circ=2*Math.PI*r;
  let offset=0;
  let svgInner=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="${stroke}"/>`;
  cats.forEach(cat=>{
    const pct=cat.amount/total;
    const dash=pct*circ;
    const gap=2;
    svgInner+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cat.color}" stroke-width="${stroke-2}" stroke-dasharray="${Math.max(dash-gap,0)} ${circ-Math.max(dash-gap,0)}" stroke-dashoffset="${-offset}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset+=dash;
  });
  svg.innerHTML = svgInner;

  legendEl.innerHTML = cats.slice(0,4).map(cat=>{
    const pct=Math.round((cat.amount/total)*100);
    return `<div style="display:flex;align-items:center;gap:8px"><div style="width:8px;height:8px;border-radius:2px;background:${cat.color};flex-shrink:0"></div><div style="flex:1;min-width:0;display:flex;align-items:center;justify-content:space-between;gap:4px"><span style="font-size:0.75rem;color:rgba(180,210,255,0.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${cat.icon} ${cat.name}</span><span style="font-size:0.72rem;font-weight:700;color:#fff;white-space:nowrap">${pct}%</span></div></div>`;
  }).join('');
}
window.buildHomeDonut = buildHomeDonut;

export function buildHomeInsights() {
  const el = document.getElementById('home-insights-chips');
  if (!el) return;

  // Sem IA (free, plus, none, expired): insight do mês com dados reais + CTA suave
  if (!hasAI(currentPlan)) {
    // Atualizar título da seção para "💡 Insight do mês"
    const titleEl = document.getElementById('insights-section-title');
    if (titleEl) titleEl.innerHTML = '💡 Insight do mês <a onclick="showUpgrade(\'Ative a IA para ver análises completas dos seus gastos.\')">Ver mais →</a>';

    const txMonth = filterTxMonth(transactions);
    const expMonth = txMonth.filter(t => t.amount < 0);
    const incMonth = txMonth.filter(t => t.amount > 0);
    const totalExpMonth = expMonth.reduce((s, t) => s + Math.abs(t.amount), 0);
    const totalIncMonth = incMonth.reduce((s, t) => s + t.amount, 0);

    // Categoria com mais gastos no mês
    const catMap = {};
    expMonth.forEach(t => {
      const k = (t.cat || 'Outros').replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}✓→←↑↓]+\s*/u, '').trim();
      catMap[k] = (catMap[k] || 0) + Math.abs(t.amount);
    });
    const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
    const topPct = topCat && totalExpMonth > 0 ? Math.round(topCat[1] / totalExpMonth * 100) : 0;

    const ctaMsg = currentPlan === 'plus'
      ? 'Você já tem o Plus! Faça upgrade para o Pro por R$ 14,90/mês e ative a IA financeira.'
      : 'Ative a IA para ver análises completas dos seus gastos.';

    let html = '';

    if (transactions.length === 0) {
      // Empty state encorajador
      html = `<div class="home-insight-chip">
        <div class="home-insight-icon" style="background:rgba(74,154,245,0.12)">📝</div>
        <div class="home-insight-text"><strong>Registre sua primeira transação</strong> para ver um resumo dos seus gastos aqui.</div>
      </div>`;
    } else {
      // Insight 1: maior categoria com estimativa de economia anual
      if (topCat && totalExpMonth > 0) {
        const cut10 = Math.round(topCat[1] * 0.1);
        const annualSavings = cut10 * 12;
        const annualTxt = cut10 > 0
          ? ` Reduzindo R$ ${cut10.toLocaleString('pt-BR')}/mês você economiza <strong>R$ ${annualSavings.toLocaleString('pt-BR')}/ano</strong>.`
          : '';
        html += `<div class="home-insight-chip">
          <div class="home-insight-icon" style="background:rgba(252,186,3,0.12)">💡</div>
          <div class="home-insight-text">Seu maior gasto foi <strong>${topCat[0]}</strong> (${topPct}%).${annualTxt}</div>
        </div>`;
      }
      // Insight 2: taxa de poupança (só se tiver renda registrada)
      if (totalIncMonth > 0 && totalExpMonth > 0) {
        const savingsRate = Math.round(((totalIncMonth - totalExpMonth) / totalIncMonth) * 100);
        if (savingsRate > 0) {
          html += `<div class="home-insight-chip">
            <div class="home-insight-icon" style="background:rgba(0,200,150,0.12)">💰</div>
            <div class="home-insight-text">Você poupou <strong>${savingsRate}%</strong> da renda este mês.${savingsRate >= 20 ? ' Ótimo resultado! 🎉' : ' Tente chegar a 20%.'}</div>
          </div>`;
        }
      }
    }

    // CTA suave — 1 linha, não dominante
    html += `<div onclick="showUpgrade('${ctaMsg}')"
      style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(124,109,250,0.07);border:1px solid rgba(124,109,250,0.15);border-radius:13px;cursor:pointer;margin-top:2px">
      <span style="font-size:0.95rem">✨</span>
      <span style="flex:1;font-size:0.76rem;color:var(--muted);line-height:1.4">${currentPlan === 'plus' ? 'Ative a IA para análises completas' : 'Desbloqueie análises automáticas com o Pro'}</span>
      <span style="font-size:0.72rem;color:var(--accent);font-weight:700;white-space:nowrap">R$ 14,90 →</span>
    </div>`;

    el.innerHTML = html;
    return;
  }

  // Pro/Premium/trial: restaurar título padrão
  const titleElAI = document.getElementById('insights-section-title');
  if (titleElAI) titleElAI.innerHTML = 'Insights <a onclick="switchTab(\'insights\')">Ver análise completa →</a>';

  // Pro/Premium/trial: mostrar insights reais ou empty state
  if (transactions.length === 0) {
    el.innerHTML = `<div class="home-insight-chip"><div class="home-insight-icon" style="background:rgba(130,10,209,0.12)">💡</div><div class="home-insight-text"><strong>Adicione transações</strong> para receber insights personalizados sobre seus gastos.</div></div>`;
    return;
  }

  const generated = generateInsights();
  const top2 = generated.insights.slice(0, 2);
  el.innerHTML = top2.map(ins => `<div class="home-insight-chip" onclick="switchTab('insights')" style="cursor:pointer"><div class="home-insight-icon" style="background:${ins.color}22">${ins.icon}</div><div class="home-insight-text"><strong>${ins.title}</strong> — ${ins.text.split('.')[0]}.</div><div class="home-insight-arrow">›</div></div>`).join('');
}
window.buildHomeInsights = buildHomeInsights;

export function updateHomePlanUI() {
  const uid = auth.currentUser?.uid;
  const state = getPlanState(uid);
  const ctaEl = document.getElementById('home-bank-cta');
  const accsEl = document.getElementById('home-accounts-section');
  const syncEl = document.getElementById('home-sync-text');

  if (hasBanks(state)) {
    if (ctaEl) ctaEl.style.display = 'none';
    if (accsEl) accsEl.style.display = 'block';
    if (syncEl) syncEl.textContent = 'Atualizado automaticamente';
    buildHomeAccounts();
  } else {
    if (ctaEl) ctaEl.style.display = 'block';
    if (accsEl) accsEl.style.display = 'none';
    const manualText = transactions.length > 0 ? 'Dados inseridos manualmente' : 'Conecte seu banco para sincronizar';
    if (syncEl) syncEl.textContent = state === 'pro' ? 'IA ativa · dados inseridos manualmente' : manualText;
  }
}
window.updateHomePlanUI = updateHomePlanUI;

function buildHomeAccounts() {
  const el = document.getElementById('home-accounts-list');
  if (!el) return;

  // Usar itens reais conectados via Pluggy; se vazio, exibir estado vazio
  const ci = window.connectedItems || [];
  if (ci.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:20px 16px;color:var(--muted);font-size:0.82rem">
      <div style="font-size:1.6rem;margin-bottom:8px">🏦</div>
      <div>Nenhum banco conectado ainda.</div>
      <div style="margin-top:4px;font-size:0.75rem;opacity:0.7">Os saldos aparecerão aqui após conectar.</div>
    </div>`;
    return;
  }

  const accounts = ci.map(item => ({
    name: item.details?.connector?.name || 'Banco',
    type: item.details?.type || 'Conta',
    last4: '',
    balance: item.details?.balance ?? null,
    color: '#820AD1',
    icon: '🏦'
  }));

  el.innerHTML = accounts.map(acc => {
    const isNeg = acc.balance !== null && acc.balance < 0;
    const balanceStr = acc.balance !== null
      ? `${isNeg?'−':''}R$ ${Math.abs(acc.balance).toLocaleString('pt-BR',{minimumFractionDigits:2})}`
      : '—';
    const balColor = isNeg ? '#ff6b6b' : '#fff';
    const last4Part = acc.last4 ? ` · •••• ${acc.last4}` : '';
    return `<div class="home-account-row"><div class="home-account-dot"></div><div style="font-size:1.2rem">${acc.icon}</div><div style="flex:1;min-width:0"><div style="font-size:0.85rem;font-weight:600;color:#e8f0ff">${acc.name}</div><div style="font-size:0.72rem;color:rgba(180,210,255,0.5);margin-top:1px">${acc.type}${last4Part}</div></div><div style="text-align:right;flex-shrink:0"><div style="font-family:Syne,sans-serif;font-weight:700;font-size:0.9rem;color:${balColor}">${balanceStr}</div><div style="font-size:0.65rem;color:#00c896;margin-top:1px">● conectado</div></div></div>`;
  }).join('');
}
window.buildHomeAccounts = buildHomeAccounts;

// ── Simulation ────────────────────────────────────────────────────
const SIM_DATA = {
  balance: 3250.00, bank: 'Nubank', income: 6000.00, expenses: 2750.00,
  categories: [
    { name:'Moradia',     icon:'🏠', amount:1200, color:'#7c6dfa', bg:'rgba(124,109,250,0.12)' },
    { name:'Alimentação', icon:'🛒', amount:800,  color:'#6dfac8', bg:'rgba(109,250,200,0.12)' },
    { name:'Lazer',       icon:'🎮', amount:450,  color:'#fa6d9a', bg:'rgba(250,109,154,0.12)' },
    { name:'Transporte',  icon:'🚗', amount:300,  color:'#fbbf24', bg:'rgba(251,191,36,0.12)'  },
  ],
  transactions: [
    { date:'Hoje',  icon:'🛒', desc:'Supermercado Extra',  cat:'Alimentação', amount:-187.40, color:'rgba(109,250,200,0.12)' },
    { date:'Hoje',  icon:'💰', desc:'Salário',             cat:'Receita',     amount:6000.00, color:'rgba(74,222,128,0.12)'  },
    { date:'Ontem', icon:'🏠', desc:'Aluguel',             cat:'Moradia',     amount:-1200.00,color:'rgba(124,109,250,0.12)' },
    { date:'Ontem', icon:'🎮', desc:'Netflix',             cat:'Lazer',       amount:-44.90,  color:'rgba(250,109,154,0.12)' },
    { date:'Ontem', icon:'🚗', desc:'Uber',                cat:'Transporte',  amount:-28.50,  color:'rgba(251,191,36,0.12)'  },
    { date:'Seg',   icon:'☕', desc:'Cafeteria',           cat:'Alimentação', amount:-32.00,  color:'rgba(109,250,200,0.12)' },
    { date:'Seg',   icon:'💊', desc:'Farmácia',            cat:'Saúde',       amount:-67.80,  color:'rgba(248,113,113,0.12)' },
    { date:'Dom',   icon:'🎬', desc:'Cinema',              cat:'Lazer',       amount:-72.00,  color:'rgba(250,109,154,0.12)' },
  ]
};

let simPreviousScreen = 'screen-plan';

export function showSimulation() {
  const active = document.querySelector('.screen.active');
  if (active) simPreviousScreen = active.id;
  showScreen('screen-simulation');
  renderSimulation();
}
window.showSimulation = showSimulation;

export function exitSimulation() {
  showScreen(simPreviousScreen || 'screen-plan');
}
window.exitSimulation = exitSimulation;

export function goToConnectFromSim() {
  const uid = auth.currentUser?.uid;
  const state = getPlanState(uid);
  showScreen('screen-connect');
  showConnectState(state === 'none' || state === 'free' ? 'free' : state, uid);
}
window.goToConnectFromSim = goToConnectFromSim;

export function renderSimulation() {
  animateBalance();
  renderDonut();
  renderSimCatBars();
  renderSimTransactions();
  setTimeout(() => { const bar=document.getElementById('sim-health-bar'); if(bar) bar.style.width='78%'; }, 600);
}
window.renderSimulation = renderSimulation;

export function animateBalance() {
  const el = document.getElementById('sim-balance-display');
  if (!el) return;
  const target = SIM_DATA.balance;
  const duration = 1200;
  const start = Date.now();
  function tick() {
    const progress = Math.min((Date.now()-start)/duration,1);
    const eased = 1 - Math.pow(1-progress,3);
    el.textContent = 'R$ ' + (target*eased).toLocaleString('pt-BR',{minimumFractionDigits:2});
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
window.animateBalance = animateBalance;

export function renderDonut() {
  const svg = document.getElementById('sim-donut');
  const legendEl = document.getElementById('sim-legend');
  if (!svg || !legendEl) return;
  const total = SIM_DATA.categories.reduce((s,c)=>s+c.amount,0);
  const cx=60,cy=60,r=44,stroke=18,circ=2*Math.PI*r;
  let offset=0,svgContent='';
  SIM_DATA.categories.forEach(cat=>{const pct=cat.amount/total;const dash=pct*circ;svgContent+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cat.color}" stroke-width="${stroke}" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-offset}" stroke-linecap="butt" transform="rotate(-90 ${cx} ${cy})"/>`;offset+=dash;});
  svgContent+=`<text x="${cx}" y="${cy-4}" text-anchor="middle" fill="#f0f0f8" font-family="Syne" font-weight="800" font-size="11">R$</text>`;
  svgContent+=`<text x="${cx}" y="${cy+10}" text-anchor="middle" fill="#f0f0f8" font-family="Syne" font-weight="800" font-size="13">${(total/1000).toFixed(1)}k</text>`;
  svg.innerHTML = svgContent;
  legendEl.innerHTML = SIM_DATA.categories.map(cat=>{const pct=Math.round((cat.amount/total)*100);return`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="width:10px;height:10px;border-radius:3px;background:${cat.color};flex-shrink:0"></div><div style="flex:1;min-width:0"><div style="font-size:0.78rem;font-weight:500">${cat.icon} ${cat.name}</div><div style="font-size:0.7rem;color:var(--muted)">R$ ${cat.amount.toLocaleString('pt-BR')} · ${pct}%</div></div></div>`;}).join('');
}
window.renderDonut = renderDonut;

function renderSimCatBars() {
  const el = document.getElementById('sim-cat-bars');
  if (!el) return;
  const total = SIM_DATA.categories.reduce((s,c)=>s+c.amount,0);
  el.innerHTML = SIM_DATA.categories.map(cat => {
    const pct = Math.round((cat.amount/total)*100);
    return `<div class="sim-cat-bar-row"><div style="display:flex;justify-content:space-between;margin-bottom:5px;font-size:0.8rem"><span>${cat.icon} ${cat.name}</span><span style="font-weight:600">R$ ${cat.amount.toLocaleString('pt-BR')}</span></div><div style="height:6px;background:rgba(255,255,255,0.06);border-radius:99px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${cat.color};border-radius:99px;transition:width 1s ease"></div></div></div>`;
  }).join('');
}
window.renderSimCatBars = renderSimCatBars;

function renderSimTransactions() {
  const el = document.getElementById('sim-tx-list');
  if (!el) return;
  el.innerHTML = SIM_DATA.transactions.map(tx => {
    const isPos = tx.amount > 0;
    return `<div class="sim-tx-item"><div class="sim-tx-icon" style="background:${tx.color}">${tx.icon}</div><div style="flex:1;min-width:0"><div style="font-size:0.85rem;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${tx.desc}</div><div style="font-size:0.72rem;color:var(--muted);margin-top:2px">${tx.date} · ${tx.cat}</div></div><div style="font-family:Syne,sans-serif;font-weight:700;font-size:0.88rem;color:${isPos?'var(--success)':'var(--text)'};">${isPos?'+':''}R$ ${Math.abs(tx.amount).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div></div>`;
  }).join('');
}
window.renderSimTransactions = renderSimTransactions;

// ── maybeShowSimTease ─────────────────────────────────────────────
export function maybeShowSimTease() {
  // Called from app.js after showing screen-plan
  // No auto-simulation needed currently
}
window.maybeShowSimTease = maybeShowSimTease;

// ── Exportação de dados (Excel + PDF) ────────────────────────────

const _fmtBRL     = v => `R$ ${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
const _stripEmoji = s => (s || '').replace(/^[\p{Emoji}\s]+/u, '').trim();
const _catName    = t => (t.splits && t.splits.length > 0) ? 'Múltiplas categorias' : (_stripEmoji(t.cat) || 'Sem categoria');
const _round2     = v => Math.round(v * 100) / 100;
const _PERIOD_LABELS = {
  month: 'Este mês', last30: 'Últimos 30 dias', last90: 'Últimos 90 dias',
  last6m: 'Últimos 6 meses', all: 'Todo período'
};

function exportFilename(ext) {
  const now = new Date();
  return `finnoflow-relatorio-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}.${ext}`;
}

function filterTxForExport(txList, period) {
  if (period === 'last6m') {
    const d = new Date();
    d.setMonth(d.getMonth() - 6); d.setHours(0, 0, 0, 0);
    return txList.filter(t => new Date((t.date||'').split('T')[0]+'T00:00:00') >= d);
  }
  return filterTxByPeriod(txList, period);
}

function getExportTransactions() {
  const period = document.getElementById('export-period')?.value || 'month';
  const type   = document.getElementById('export-type')?.value   || 'all';
  const cat    = document.getElementById('export-cat')?.value    || 'all';
  let filtered = filterTxForExport([...transactions], period);
  if (type === 'income')  filtered = filtered.filter(t => t.amount > 0);
  if (type === 'expense') filtered = filtered.filter(t => t.amount < 0);
  if (cat !== 'all')      filtered = filtered.filter(t => t.cat === cat);
  return filtered;
}

function updateExportPreview() {
  const filtered = getExportTransactions();
  const period   = document.getElementById('export-period')?.value || 'month';
  const label    = _PERIOD_LABELS[period] || period;
  const income   = _round2(calcIncome(filtered));
  const expenses = _round2(calcExpenses(filtered));

  const balance   = _round2(income - expenses);
  const previewEl = document.getElementById('export-preview');
  if (previewEl) {
    if (filtered.length === 0) {
      previewEl.innerHTML = `<span style="color:var(--muted)">Nenhuma transação no período selecionado.</span>`;
    } else {
      const balColor = balance >= 0 ? '#4ade80' : '#f87171';
      previewEl.innerHTML =
        `Você está exportando <strong>${filtered.length} transação(ões)</strong> · ${label}<br>` +
        `<span style="color:#4ade80">↑ Receitas: ${_fmtBRL(income)}</span> &nbsp; ` +
        `<span style="color:#f87171">↓ Despesas: ${_fmtBRL(expenses)}</span><br>` +
        `<span style="color:${balColor}">Saldo: ${_fmtBRL(balance)}</span>`;
    }
  }

  const warnEl = document.getElementById('export-count-warning');
  if (warnEl) {
    if (filtered.length > 1000) {
      warnEl.textContent = `⚠️ ${filtered.length} transações selecionadas — o arquivo pode demorar alguns segundos.`;
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }
  }
}
window.updateExportPreview = updateExportPreview;

export function openExportModal() {
  const uid = auth.currentUser?.uid;
  if (!['pro','premium','trial'].includes(getPlanState(uid))) {
    showUpgrade('Exporte seus dados em Excel ou PDF a partir do FinnoFlow Pro.');
    return;
  }
  document.getElementById('modal-export').classList.add('open');
  updateExportPreview();
}
window.openExportModal = openExportModal;

export function exportToExcel() {
  if (typeof XLSX === 'undefined') { toast('Biblioteca não carregada. Recarregue a página.', 'error'); return; }
  const filtered = getExportTransactions();
  const btn = document.querySelector('#modal-export .btn-outline');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando...'; }

  requestAnimationFrame(() => setTimeout(() => {
    try {
      const period      = document.getElementById('export-period')?.value || 'month';
      const periodLabel = _PERIOD_LABELS[period] || period;

      // ── Constantes de estilo ──
      const BORDER_THIN = (rgb) => ({ style: 'thin', color: { rgb } });
      const mkBorder = (rgb) => ({ top: BORDER_THIN(rgb), bottom: BORDER_THIN(rgb), left: BORDER_THIN(rgb), right: BORDER_THIN(rgb) });
      const BORDER_HEADER = mkBorder('5B21B6');
      const BORDER_DATA   = mkBorder('DDDDDD');
      const FMT_BRL = '"R$ "#,##0.00';

      const S_HEADER = {
        font:      { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 },
        fill:      { patternType: 'solid', fgColor: { rgb: '6D28D9' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border:    BORDER_HEADER
      };
      const S_SECTION = {
        font:  { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 },
        fill:  { patternType: 'solid', fgColor: { rgb: '4C1D95' } },
        border: BORDER_HEADER
      };
      const mkRow = (fillRgb) => ({ fill: { patternType: 'solid', fgColor: { rgb: fillRgb } }, border: BORDER_DATA });
      const mkVal = (fillRgb, fontRgb) => ({ font: { bold: true, color: { rgb: fontRgb } }, fill: { patternType: 'solid', fgColor: { rgb: fillRgb } }, border: BORDER_DATA, alignment: { horizontal: 'right' } });

      // ── Aba Transações ──
      const txHeaders = ['Data','Descrição','Categoria','Subcategoria','Tipo','Valor (R$)','Conta/Banco','Origem','Observação'];
      const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
      const txRows = sorted.flatMap(t => {
        const base = [
          new Date(t.date + 'T00:00:00').toLocaleDateString('pt-BR'),
          t.desc || '',
          _catName(t),
          (t.splits && t.splits.length > 0) ? t.splits.map(s => _stripEmoji(s.cat) || s.cat).join(', ') : '—',
          t.amount > 0 ? 'Receita' : 'Despesa',
          _round2(t.amount),
          t.bank || 'Manual',
          (t.bank && t.bank !== 'Manual') ? 'Banco' : 'Manual',
          t.note || '—'
        ];
        return [base];
      });

      const wsTx = XLSX.utils.aoa_to_sheet([txHeaders, ...txRows]);
      const range = XLSX.utils.decode_range(wsTx['!ref'] || 'A1');

      // Cabeçalho (linha 0) — roxo com texto branco
      for (let c = 0; c <= range.e.c; c++) {
        const ref = XLSX.utils.encode_cell({ r: 0, c });
        if (!wsTx[ref]) wsTx[ref] = { t: 's', v: '' };
        wsTx[ref].s = S_HEADER;
      }

      // Linhas de dados — verde receita, vermelho despesa
      for (let r = 1; r <= range.e.r; r++) {
        const isIncome   = txRows[r - 1]?.[4] === 'Receita';
        const fillRgb    = isIncome ? 'DCFCE7' : 'FEF2F2';
        const valFillRgb = isIncome ? 'BBF7D0' : 'FECACA';
        const valFontRgb = isIncome ? '166534' : '991B1B';

        for (let c = 0; c <= range.e.c; c++) {
          const ref = XLSX.utils.encode_cell({ r, c });
          if (!wsTx[ref]) wsTx[ref] = { t: 's', v: '' };
          if (c === 5) {
            wsTx[ref].s = mkVal(valFillRgb, valFontRgb);
            wsTx[ref].z = FMT_BRL;
          } else {
            wsTx[ref].s = mkRow(fillRgb);
          }
        }
      }

      wsTx['!cols']       = [{ wch: 12 },{ wch: 34 },{ wch: 18 },{ wch: 14 },{ wch: 10 },{ wch: 16 },{ wch: 18 },{ wch: 10 },{ wch: 20 }];
      wsTx['!freeze']     = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
      wsTx['!autofilter'] = { ref: 'A1:I1' };
      wsTx['!sheetViews'] = [{ showGridLines: false }];

      // ── Aba Resumo ──
      const income   = _round2(calcIncome(filtered));
      const expenses = _round2(calcExpenses(filtered));
      const balance  = _round2(income - expenses);

      // catMap: mesmas exclusões de calcIncome/calcExpenses para consistência de totais
      const catMap = {};
      filtered.forEach(t => {
        if (t.isTransfer || t.hidden) return;
        if (t.splits && t.splits.length > 0) {
          t.splits.forEach(sp => {
            const c = _stripEmoji(sp.cat) || sp.cat || 'Sem categoria';
            catMap[c] = _round2((catMap[c] || 0) + (t.amount < 0 ? -sp.amount : sp.amount));
          });
        } else {
          const c = _catName(t);
          catMap[c] = _round2((catMap[c] || 0) + t.amount);
        }
      });
      const catRows = Object.entries(catMap)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .map(([c, v]) => {
          const isInc = v > 0;
          const absV  = _round2(Math.abs(v));
          const pct   = isInc
            ? (income   > 0 ? (absV / income   * 100).toFixed(1) + '%' : '—')
            : (expenses > 0 ? (absV / expenses * 100).toFixed(1) + '%' : '—');
          return [c, isInc ? 'Receita' : 'Despesa', absV, pct];
        });

      const summaryData = [
        ['FinnoFlow — Relatório Financeiro', periodLabel, '', ''],
        ['Gerado em', new Date().toLocaleDateString('pt-BR'), '', ''],
        [],
        ['RESUMO DO PERÍODO', '', '', ''],
        ['Item', 'Valor (R$)', '', ''],
        ['Total Receitas',  income,   '', ''],
        ['Total Despesas',  expenses, '', ''],
        ['Saldo Final',     balance,  '', ''],
        [],
        ['TOTAIS POR CATEGORIA', '', '', ''],
        ['Categoria', 'Tipo', 'Total (R$)', '% do Tipo'],
        ...catRows
      ];
      const wsSum = XLSX.utils.aoa_to_sheet(summaryData);
      const sumRange = XLSX.utils.decode_range(wsSum['!ref'] || 'A1');

      // Linha 0 — título principal
      for (let c = 0; c <= 3; c++) {
        const cell = wsSum[XLSX.utils.encode_cell({ r: 0, c })];
        if (cell) cell.s = { font: { bold: true, sz: 13, color: { rgb: '4C1D95' } }, fill: { patternType: 'solid', fgColor: { rgb: 'EDE9FE' } }, border: BORDER_DATA };
      }
      // Linha 1 — data geração
      for (let c = 0; c <= 3; c++) {
        const cell = wsSum[XLSX.utils.encode_cell({ r: 1, c })];
        if (cell) cell.s = { font: { sz: 9, color: { rgb: '6B7280' } }, fill: { patternType: 'solid', fgColor: { rgb: 'EDE9FE' } }, border: BORDER_DATA };
      }
      // Linha 3 — seção RESUMO
      for (let c = 0; c <= 3; c++) {
        const cell = wsSum[XLSX.utils.encode_cell({ r: 3, c })];
        if (cell) cell.s = S_SECTION;
      }
      // Linha 4 — cabeçalho colunas resumo
      for (let c = 0; c <= 1; c++) {
        const cell = wsSum[XLSX.utils.encode_cell({ r: 4, c })];
        if (cell) cell.s = S_HEADER;
      }
      // Linhas 5–7 — receitas, despesas, saldo
      [
        { r: 5, isInc: true  },
        { r: 6, isInc: false },
        { r: 7, isInc: balance >= 0 }
      ].forEach(({ r, isInc }) => {
        const fillRgb = isInc ? 'DCFCE7' : 'FEF2F2';
        const fontRgb = isInc ? '166534' : '991B1B';
        const cA = wsSum[XLSX.utils.encode_cell({ r, c: 0 })];
        const cB = wsSum[XLSX.utils.encode_cell({ r, c: 1 })];
        if (cA) cA.s = { font: { bold: true }, fill: { patternType: 'solid', fgColor: { rgb: fillRgb } }, border: BORDER_DATA };
        if (cB) { cB.s = mkVal(fillRgb, fontRgb); cB.z = FMT_BRL; }
      });
      // Linha 9 — seção CATEGORIAS
      for (let c = 0; c <= 3; c++) {
        const cell = wsSum[XLSX.utils.encode_cell({ r: 9, c })];
        if (cell) cell.s = S_SECTION;
      }
      // Linha 10 — cabeçalho categorias
      for (let c = 0; c <= 3; c++) {
        const cell = wsSum[XLSX.utils.encode_cell({ r: 10, c })];
        if (cell) cell.s = S_HEADER;
      }
      // Linhas 11+ — dados por categoria
      for (let r = 11; r <= sumRange.e.r; r++) {
        const typeCell = wsSum[XLSX.utils.encode_cell({ r, c: 1 })];
        const isInc    = typeCell?.v === 'Receita';
        const fillRgb  = isInc ? 'DCFCE7' : 'FEF2F2';
        const valFill  = isInc ? 'BBF7D0' : 'FECACA';
        const valFont  = isInc ? '166534' : '991B1B';
        for (let c = 0; c <= 3; c++) {
          const ref = XLSX.utils.encode_cell({ r, c });
          if (!wsSum[ref]) wsSum[ref] = { t: 's', v: '' };
          if (c === 2) { wsSum[ref].s = mkVal(valFill, valFont); wsSum[ref].z = FMT_BRL; }
          else         { wsSum[ref].s = mkRow(fillRgb); }
        }
      }

      wsSum['!cols']       = [{ wch: 28 },{ wch: 12 },{ wch: 16 },{ wch: 12 }];
      wsSum['!freeze']     = { xSplit: 0, ySplit: 11, topLeftCell: 'A12', activePane: 'bottomLeft', state: 'frozen' };
      wsSum['!sheetViews'] = [{ showGridLines: false }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, wsTx, 'Transações');
      XLSX.utils.book_append_sheet(wb, wsSum, 'Resumo');
      XLSX.writeFile(wb, exportFilename('xlsx'));

      closeModal('modal-export');
      toast('✓ Excel exportado com sucesso!', 'success');
    } catch(e) {
      console.error('Export Excel error:', e);
      toast('Erro ao gerar Excel. Tente novamente.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📊 Excel'; }
    }
  }, 50));
}
window.exportToExcel = exportToExcel;

export function exportToPDF() {
  if (typeof jspdf === 'undefined') { toast('Biblioteca não carregada. Recarregue a página.', 'error'); return; }
  const filtered = getExportTransactions();
  const btn = document.querySelector('#modal-export .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando...'; }

  requestAnimationFrame(() => setTimeout(() => {
    try {
      const { jsPDF } = jspdf;
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const MARGIN = 18, PAGE_W = 210, ACCENT = [138, 5, 190];
      const period      = document.getElementById('export-period')?.value || 'month';
      const periodLabel = _PERIOD_LABELS[period] || period;
      const userName    = auth.currentUser?.displayName || auth.currentUser?.email || 'Usuário';
      const dateStr     = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

      // ── Header roxo ──
      doc.setFillColor(...ACCENT);
      doc.rect(0, 0, PAGE_W, 28, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
      doc.text('FinnoFlow', MARGIN, 16);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(`${userName}  ·  ${periodLabel}  ·  Gerado em ${dateStr}`, MARGIN, 23);

      // ── Cards de resumo ──
      const income   = _round2(calcIncome(filtered));
      const expenses = _round2(calcExpenses(filtered));
      const balance  = _round2(income - expenses);
      let y = 38;
      doc.setTextColor(30, 30, 50); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      doc.text('Resumo do período', MARGIN, y);
      y += 6;
      const boxW = (PAGE_W - MARGIN * 2 - 8) / 3;
      [
        { label: 'Receitas', value: _fmtBRL(income),   color: [34, 197, 94] },
        { label: 'Despesas', value: _fmtBRL(expenses),  color: [248, 113, 113] },
        { label: 'Saldo',    value: _fmtBRL(balance),   color: balance >= 0 ? [34, 197, 94] : [248, 113, 113] }
      ].forEach((item, i) => {
        const bx = MARGIN + i * (boxW + 4);
        doc.setFillColor(245, 245, 252); doc.roundedRect(bx, y, boxW, 18, 3, 3, 'F');
        doc.setFontSize(8); doc.setTextColor(120, 120, 140); doc.setFont('helvetica', 'normal');
        doc.text(item.label, bx + 4, y + 7);
        doc.setFontSize(10); doc.setTextColor(...item.color); doc.setFont('helvetica', 'bold');
        doc.text(item.value, bx + 4, y + 14);
      });
      y += 26;

      // ── Gráfico de barras horizontais (top 7 categorias de despesa) ──
      // catMap PDF: mesmas exclusões de calcExpenses para consistência de totais
      const catMap = {};
      filtered.filter(t => t.amount < 0 && !t.isTransfer && !t.hidden).forEach(t => {
        if (t.splits && t.splits.length > 0) {
          t.splits.forEach(sp => {
            const c = _stripEmoji(sp.cat) || sp.cat || 'Sem categoria';
            catMap[c] = _round2((catMap[c] || 0) + Math.abs(sp.amount));
          });
        } else {
          const c = _catName(t);
          catMap[c] = _round2((catMap[c] || 0) + Math.abs(t.amount));
        }
      });
      const catEntries = Object.entries(catMap).sort((a, b) => b[1] - a[1]);

      if (catEntries.length > 0) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(30, 30, 50);
        doc.text('Gastos por categoria', MARGIN, y);
        y += 5;
        const maxVal    = catEntries[0][1];
        const BAR_MAX_W = 100, BAR_H = 5, BAR_GAP = 3, LABEL_W = 38;
        catEntries.slice(0, 7).forEach(([cat, val]) => {
          const barW = maxVal > 0 ? (val / maxVal) * BAR_MAX_W : 0;
          doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(60, 60, 80);
          doc.text(cat.length > 16 ? cat.slice(0, 15) + '…' : cat, MARGIN, y + BAR_H - 1);
          doc.setFillColor(228, 224, 240);
          doc.rect(MARGIN + LABEL_W, y, BAR_MAX_W, BAR_H, 'F');
          doc.setFillColor(...ACCENT);
          if (barW > 0) doc.rect(MARGIN + LABEL_W, y, barW, BAR_H, 'F');
          doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(30, 30, 50);
          doc.text(_fmtBRL(val), MARGIN + LABEL_W + BAR_MAX_W + 2, y + BAR_H - 1);
          y += BAR_H + BAR_GAP;
        });
        y += 5;
      }

      // ── Tabela de transações ──
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(30, 30, 50);
      doc.text('Transações', MARGIN, y);
      doc.autoTable({
        startY: y + 4,
        head: [['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor', 'Banco']],
        body: [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date)).map(t => [
          new Date(t.date + 'T00:00:00').toLocaleDateString('pt-BR'),
          t.desc || '', _catName(t),
          t.amount > 0 ? 'Receita' : 'Despesa',
          (t.amount > 0 ? '+ ' : '- ') + _fmtBRL(t.amount),
          t.bank || 'Manual'
        ]),
        styles:      { fontSize: 8, cellPadding: 3, font: 'helvetica', textColor: [30, 30, 50] },
        headStyles:  { fillColor: ACCENT, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 248, 252] },
        columnStyles: { 0:{cellWidth:22}, 1:{cellWidth:52}, 2:{cellWidth:30}, 3:{cellWidth:20}, 4:{cellWidth:30}, 5:{cellWidth:20} },
        margin: { left: MARGIN, right: MARGIN }
      });

      // ── Tabela de categorias com % ──
      if (catEntries.length > 0) {
        const totalExp = _round2(calcExpenses(filtered));
        const afterTx  = doc.lastAutoTable.finalY + 8;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(30, 30, 50);
        doc.text('Detalhamento por categoria', MARGIN, afterTx);
        doc.autoTable({
          startY: afterTx + 4,
          head:  [['Categoria', 'Total', '% do total']],
          body:  catEntries.map(([c, v]) => [
            c,
            _fmtBRL(v),
            totalExp > 0 ? (v / totalExp * 100).toFixed(1) + '%' : '—'
          ]),
          styles:     { fontSize: 9, cellPadding: 3, font: 'helvetica', textColor: [30, 30, 50] },
          headStyles: { fillColor: ACCENT, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
          alternateRowStyles: { fillColor: [248, 248, 252] },
          columnStyles: { 0:{cellWidth:80}, 1:{cellWidth:40}, 2:{cellWidth:28} },
          margin: { left: MARGIN, right: MARGIN }
        });
      }

      // ── Rodapé paginado ──
      const pages = doc.internal.getNumberOfPages();
      for (let p = 1; p <= pages; p++) {
        doc.setPage(p);
        doc.setFontSize(7); doc.setTextColor(160, 160, 180); doc.setFont('helvetica', 'normal');
        doc.text(`FinnoFlow · Relatório gerado em ${dateStr} · Página ${p} de ${pages}`, MARGIN, 290);
      }

      doc.save(exportFilename('pdf'));
      closeModal('modal-export');
      toast('✓ PDF exportado com sucesso!', 'success');
    } catch(e) {
      console.error('Export PDF error:', e);
      toast('Erro ao gerar PDF. Tente novamente.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📄 PDF'; }
    }
  }, 50));
}
window.exportToPDF = exportToPDF;
