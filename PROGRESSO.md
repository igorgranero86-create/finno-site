# PROGRESSO.md — Finno App

## ✅ Concluído (sessão atual)
- `css/styles.css` — redesign Nubank, glassmorphism, responsive, logo unificado
- `js/api.js` — Firebase init, Firestore helpers, plan state, imports estáticos completos
- `js/auth.js` — todos os fluxos: email, Google (demo fallback), SMS (demo fallback), CPF
- `js/dashboard.js` — home, transações, categorias, metas, insights, contas
- `js/app.js` — orquestrador, onboarding, gate de verificação de e-mail
- `index.html` — SPA completo: splash landing, auth, onboarding, dashboard, modais
- `pages/` — shells de redirecionamento (login, dashboard, settings)
- `CLAUDE.md` — contexto de sessão com 12 regras
- Screen `screen-verify-email` com gate no `onAuthStateChanged`
- Demo mode: Google e SMS criam conta email por baixo, bypass do gate de verificação
- Filtros reordenados: Hoje → Semana → Mês em ambos os selects
- `#pwd-section` + `#current-pwd-wrap` para troca de senha com re-auth
- **Cloud Function `getPluggyAccessToken`** — credenciais Pluggy movidas para Firebase Secret Manager; frontend usa `httpsCallable`; código em `functions/index.js`
- **Cloud Function `createPluggyConnectToken`** — fluxo completo /auth → /connect_token server-side
- **Widget Pluggy Connect integrado** — `openPluggyConnect()` usa `getPluggyConnectToken()` via Cloud Function
- `firebase.json` + `.firebaserc` + `.gitignore` + `functions/.gitignore` criados
- ⚠️ **Pendente deploy manual**: `firebase deploy --only functions`
- **Estrutura de 4 planos**: Free · Plus (R$9,90) · Pro (R$14,90) · Premium (R$19,90)
- **Tela de planos** redesenhada com 4 cards, Pro destacado como "Mais popular"
- **`api.js`**: `hasAI()`, `hasBanks()`, estados `plus` e `pro` na máquina de estados
- **`dashboard.js`**: `showPlanPayment(planId)`, `processPayment()` salva plano correto, `applyPlanUI()` suporta 4 planos + banner de anúncios
- **Metas**: novo schema com `type` (casamento/viagem/casa/carro/estudo/outros) e `endDate`; metas antigas descartadas automaticamente
- **Categorias**: "Estudos" adicionada, ordem alfabética, "Transferência" removida
- **Bug IA (free)**: `pointer-events:none` no overlay do paywall — tabs e bottom nav funcionam normalmente
- **Botão remover foto**: adicionado no modal de conta, aparece/desaparece conforme foto existente
- **Banner de anúncios**: visível apenas no plano Free, clique redireciona para upgrade
- **Modal de upgrade**: 2 opções (Pro e Premium) com preços corretos
- **Modal de conta**: botões de upgrade para Pro e Premium lado a lado

## ✅ Melhorias de Retenção v3 (sessão atual — 10 features)

| Fase | Feature | Status |
|---|---|---|
| FASE 1a | Editar / excluir / duplicar transações + campo Observação | ✅ |
| FASE 1b | Reduzir upsell agressivo para assinantes Plus/Pro | ✅ |
| FASE 2 | Lançamentos recorrentes (semanal/mensal/anual) | ✅ |
| FASE 3 | Orçamento por categoria com alertas 80%/100%/acima | ✅ |
| FASE 4 | Regras de categorização automática por palavra-chave | ✅ |
| FASE 5 | Split transaction (dividir em múltiplas categorias) | ✅ |
| FASE 6 | Categorias customizáveis (CRUD + buildCatSelects dinâmico) | ✅ |
| FASE 7 | Fluxo bancário: ocultar tx, marcar transferência, deduplicação | ✅ |
| FASE 8 | UX: filtro por banco, toggle ocultas, período 6 meses, total por dia | ✅ |
| FASE 9 | Preparação cloud sync (TODO comments em todas as funções de persistência) | ✅ |

### Novos localStorage keys
- `finno_recurring_<uid>` — regras de lançamentos recorrentes
- `finno_budget_<uid>` — limites de orçamento por categoria
- `finno_cats_<uid>` — categorias customizadas
- `finno_rules_<uid>` — regras de categorização automática

### Schema de transação extendido (backward-compatible)
- Campo `id` adicionado com migração lazy em `loadUserData()`
- Novos campos opcionais: `splits[]`, `recurring`, `hidden`, `isTransfer`, `note`, `pending`

## 🔄 Em andamento
- Nenhuma tarefa incompleta identificada

## ✅ Correções v2 (sessão atual)
- **Paywall por plano** `js/dashboard.js` — `applyPlanUI()` agora chama `buildHomeInsights()` + `updateHomePlanUI()` → Premium não vê mais chip de "Desbloqueie IA"; Plus vê paywall de IA; Pro vê paywall de bancos apenas
- **DEMO_ACCOUNTS / DEMO_CATEGORIES_HOME removidos** `js/dashboard.js` — constantes não usadas eliminadas; home panel mostra dados reais ou estado vazio
- **FAB contextual** `js/dashboard.js` + `index.html` + `css/styles.css` — FAB centralizado na bottom nav (`translateY(-12px)`); `openContextFAB()` abre modal de transação em Início e modal de meta em Metas; FAB oculto (`visibility:hidden`) em Extrato, Categorias e IA
- **Bottom nav reestruturado** `index.html` — 4 itens + FAB central; `data-tab` nos nav-items; Categorias removida do bottom nav (acessível pelo top tab)
- **Modal de meta limpo** `index.html` — ordem: Categoria → Descrição → Valor alvo → Já guardei (opcional) → Data limite (opcional); categorias relevantes: Casamento, Viagem, Casa própria, Carro, Estudo/Curso, Reserva de emergência, Outros

## ✅ Correções UX (sessão atual — 11 itens)
- **Fix #1** `css/styles.css` — `.auth-tagline` margin-top: -18px → 3px (logo/tagline overlap)
- **Fix #2** `js/dashboard.js` — `applyPlanUI()`: `avatar.title` sempre "Minha conta" (sem tooltip de plano)
- **Fix #3** `index.html` — `plan-section-free`: descrição "IA e bancos bloqueados" → "Sem conexão bancária automática · Sem acesso à IA"
- **Fix #4** `js/dashboard.js` — `openPluggyConnect()` free/plus/pro: redireciona para `showUpgrade()` em vez de `screen-connect`
- **Fix #5** `css/styles.css` — `select option` e filtros: `color: var(--text)` adicionado (fundo branco nos dropdowns)
- **Fix #6** `index.html` — modal-goal: "Tipo de meta" → "Categoria"; opção "emergência 🚨" adicionada
- **Fix #7** `js/dashboard.js` + `index.html` — FAB oculto nas abas Categorias e Insights; campo data opcional no modal de transação; `GOAL_ICONS` inclui `emergencia`
- **Fix #8** `index.html` + `css/styles.css` — paywall-insights: `justify-content:center`, `overflow-y:auto`, `padding` no inner div; texto não fica cortado
- **Fix #9** `index.html` — `screen-simulation`: seção "🤖 Insights com IA" com 3 exemplos reais adicionada antes do CTA
- **Fix #10** `js/auth.js` — SMS demo: mensagem agora diz "Código de verificação do app Finno" em vez de referência ao domínio
- **Fix #11** `index.html` — register copy: "Grátis para sempre · Sem cartão de crédito" → "Plano gratuito disponível · Sem cartão de crédito"
- **Fix #12** `js/dashboard.js` — `buildHomeAccounts()`: usa `window.connectedItems` reais; se vazio, exibe estado vazio (não mais DEMO_ACCOUNTS)

## 📋 Próximos passos (por prioridade)
1. **Deploy das Cloud Functions** — `firebase deploy --only functions`
2. **Integração de pagamento real** (Stripe ou Pagar.me) — substituir formulário simulado
3. Sincronização de transações após `onSuccess` do Pluggy Connect
4. Webhook Pluggy para atualizações automáticas de itens
5. Listagem de bancos conectados com dados reais (saldo, nome da conta)
6. PWA: `manifest.json` + `service-worker.js` + ícones
3. Integração com gateway de pagamento (Stripe ou Pagar.me) para plano Premium
4. Push notifications via Firebase Cloud Messaging (alertas de gastos)
5. PWA: `manifest.json` + `service-worker.js` + ícones 192/512px
6. Tela de configurações (`/pages/settings.html`) com conteúdo real

## ⚠️ Pendências / decisões abertas
- `auth/unauthorized-domain` no Firebase Console: adicionar domínio de produção
- CPF: validação de unicidade usa Firestore `cpfs/` — definir regras de segurança
- `finno_plan_{uid}` em localStorage: sem validação server-side (fácil de burlar)
- Foto de perfil: salva em localStorage base64 — migrar para Firebase Storage

## 🏦 Integrações bancárias
| Integração | Status |
|---|---|
| Pluggy Open Finance | 🟡 Connect Token via Cloud Function pronto — aguarda deploy + testes reais |
| Firebase Auth | ✅ Estável (email, Google, SMS com fallback demo) |
| Firestore | ✅ Estável (perfis, CPFs) |
| Gateway de pagamento | 🔴 Pendente |

## 💰 Grátis vs Pago
| Funcionalidade | Free | Trial (7d) | Premium |
|---|---|---|---|
| Dashboard + transações manuais | ✅ | ✅ | ✅ |
| Metas financeiras | ✅ | ✅ | ✅ |
| Conectar banco (Pluggy) | ❌ | 1 banco | 2 bancos |
| Insights com IA | ❌ (paywall) | ✅ | ✅ |
| Alertas automáticos | ❌ | ✅ | ✅ |

## 📝 Notas de contexto
- `showScreen()` vs `showView()`: screens são telas raiz; views são sub-seções do dashboard
- `window.X = fn` obrigatório para handlers `onclick=""` no HTML (não usar addEventListener anônimo)
- Demo accounts: flag `finno_demo_google_{uid}` / `finno_demo_phone_{uid}` no localStorage
- `getPlanState()` lê localStorage — checar antes de qualquer render condicional
- `buildDashboard()` chama `buildHomeDonut`, `buildHomeInsights`, `buildHomeAccounts` em sequência
