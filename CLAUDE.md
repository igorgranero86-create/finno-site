# CLAUDE.md — Contexto do Projeto Finno

## Sobre o projeto
App de finanças pessoais estilo fintech (Nubank-like). SPA mobile-first com autenticação Firebase, conexão bancária via Open Finance (Pluggy API) e insights com IA. Planos: Gratuito (manual) e Premium (automático + IA).

## Stack técnica
- **Frontend:** HTML5 + CSS3 + Vanilla JS (ES Modules, sem bundler)
- **Auth:** Firebase Auth 10.12.0 (email/senha, Google OAuth, SMS/OTP)
- **DB:** Firestore (perfis, CPFs únicos) + localStorage (transações, metas, fotos)
- **Banco:** Pluggy API (Open Finance BCB) — cliente direto, sem backend
- **Fontes:** Google Fonts (Syne + DM Sans)
- **PWA:** Service Worker + install prompt

## Estrutura de pastas
```
Index/
├── index.html          ← SPA completa (todas as telas, modais, HTML)
├── css/styles.css      ← Design system completo (1282 linhas)
├── js/
│   ├── api.js          ← Firebase init + exports + Pluggy + plan state (179L)
│   ├── app.js          ← Entry point, onAuthStateChanged, navegação, onboarding (280L)
│   ├── auth.js         ← Todos os fluxos de auth + conta + foto (845L)
│   └── dashboard.js    ← Dashboard, gráficos, transações, metas, insights (1404L)
└── pages/              ← Shells redirect para index.html (login/dashboard/settings)
```

## Arquivos-chave (ler primeiro ao retomar)
1. `PROGRESSO.md` — estado atual e próximos passos
2. `js/api.js` — exports Firebase, helpers de plano (getPlanState, etc.)
3. `js/app.js` — roteamento pós-login (onAuthStateChanged)
4. Seção relevante de `js/dashboard.js` ou `js/auth.js` conforme a tarefa

## Convenções de código
- Comentários em português, código em inglês
- Funções exportadas como ES module **e** atribuídas em `window.X` (para uso em `onclick`)
- Estado de plano: `'none' | 'free' | 'trial' | 'expired' | 'premium'`
- Dados do usuário em localStorage: chave `finno_<tipo>_<uid>`
- Contas demo de fallback: `finno_demo_google_<uid>` e `finno_demo_phone_<uid>`

## Decisões arquiteturais
- **Sem framework:** Vanilla JS com ES Modules. Sem React/Vue/build step.
- **Estado via window:** funções exportadas ficam em `window` para `onclick` inline no HTML
- **localStorage first:** transações e metas ficam no browser; Firestore só para perfil e CPF
- **Demo mode:** Google e SMS têm fallback automático (cria conta email por baixo) quando Firebase não está configurado no domínio
- **Pluggy client-side:** `PLUGGY_CLIENT_ID` exposto no frontend — aceitável para MVP, deve ir para backend em produção
- **Free vs Premium:** `getPlanState(uid)` em `api.js` é a fonte de verdade; `applyPlanUI()` em `dashboard.js` aplica restrições na UI

## Comandos úteis
```bash
# Abrir direto no browser (Chrome)
start index.html
# Ou servir localmente (evita restrições de CORS/módulos)
npx serve .
python -m http.server 8080
```

## ⚙️ Regras de sessão (ler sempre)

1. Nunca leia mais de 150 linhas de um arquivo sem avisar o usuário.
2. Liste arquivos antes de abrir qualquer um. Nunca abra mais de 3 arquivos por vez sem avisar.
3. Pergunte antes de assumir contexto ou tomar decisões arquiteturais, especialmente em fluxos de pagamento e autenticação bancária.
4. Prefira editar arquivos existentes a criar novos.
5. Após 10 trocas de mensagem na sessão, avise e sugira salvar contexto e reiniciar para evitar perda de contexto.
6. Ao final de cada sessão ou quando solicitado "salvar contexto", atualize PROGRESSO.md antes de encerrar.
7. Para correções de bug: pergunte qual arquivo/linha tem o problema antes de ler qualquer coisa.
8. Nunca refatore ou melhore código fora do escopo da correção pedida.
9. Para correções em arquivos críticos de lógica financeira (cálculos, saldo, transações), mostre o antes/depois e aguarde confirmação. Para correções de UI, estilo ou texto, pode aplicar diretamente.
10. Escopo mínimo: altere apenas o necessário para resolver o problema, nada além.
11. Para código de integração bancária (APIs, Open Finance, webhooks), nunca altere sem mostrar o antes/depois e aguardar confirmação, independente do tamanho da mudança.
12. Para qualquer funcionalidade que envolva distinção entre versão grátis e paga, confirme explicitamente em qual versão a alteração deve ser aplicada antes de escrever qualquer código.
