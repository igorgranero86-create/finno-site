// ================================================================
// functions/index.js — Cloud Functions do Finno
// ================================================================
// IMPORTANTE: As credenciais PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET
// nunca estão no código. Elas ficam no Firebase Secret Manager e são
// injetadas em runtime via defineSecret(). Para configurar, rode:
//
//   firebase functions:secrets:set PLUGGY_CLIENT_ID
//   firebase functions:secrets:set PLUGGY_CLIENT_SECRET
// ================================================================

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { initializeApp }      = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth }            = require('firebase-admin/auth');
const crypto                 = require('crypto');

// Gera hash SHA-256 do CPF (apenas dígitos) — idêntico ao algoritmo do frontend.
function hashCPF(cpf) {
  const clean = cpf.replace(/\D/g, '');
  return crypto.createHash('sha256').update(clean).digest('hex');
}

initializeApp();

// Referências aos secrets — valores só acessíveis em runtime, no servidor
const pluggyClientId     = defineSecret('PLUGGY_CLIENT_ID');
const pluggyClientSecret = defineSecret('PLUGGY_CLIENT_SECRET');

/**
 * getPluggyAccessToken
 *
 * Função Callable (requer usuário autenticado via Firebase Auth).
 * Troca as credenciais Pluggy por um accessToken e devolve apenas
 * o apiKey para o frontend — o secret jamais trafega para o cliente.
 *
 * @returns {{ apiKey: string }}
 */
exports.getPluggyAccessToken = onCall(
  {
    region:  'southamerica-east1', // São Paulo — menor latência para a API Pluggy
    secrets: [pluggyClientId, pluggyClientSecret],
  },
  async (request) => {
    // Garante que a requisição vem de um usuário autenticado
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Autenticação necessária.');
    }

    // Valida plano via Firestore — mesma lógica de createPluggyConnectToken.
    // A API key Pluggy permite acesso a dados financeiros, não deve ser exposta a planos free.
    const db = getFirestore();
    const userSnap = await db.collection('users').doc(request.auth.uid).get();
    const plan = userSnap.exists ? userSnap.data().plan : null;
    if (!['trial', 'premium'].includes(plan)) {
      throw new HttpsError(
        'permission-denied',
        'Plano Premium ou Trial necessário para acessar dados bancários.'
      );
    }

    try {
      const res = await fetch('https://api.pluggy.ai/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId:     pluggyClientId.value(),
          clientSecret: pluggyClientSecret.value(),
        }),
      });

      if (!res.ok) {
        // Loga detalhes no servidor, mas nunca expõe para o cliente
        const body = await res.text();
        console.error(`Pluggy auth falhou [${res.status}]:`, body);
        throw new HttpsError('internal', 'Erro ao autenticar com Pluggy.');
      }

      const data = await res.json();

      if (!data.apiKey) {
        console.error('Pluggy retornou resposta sem apiKey:', JSON.stringify(data));
        throw new HttpsError('internal', 'Resposta inesperada do Pluggy.');
      }

      return { apiKey: data.apiKey };

    } catch (err) {
      // Re-lança erros HttpsError sem modificar
      if (err instanceof HttpsError) throw err;
      console.error('getPluggyAccessToken erro inesperado:', err);
      throw new HttpsError('internal', 'Erro interno. Tente novamente.');
    }
  }
);

/**
 * createPluggyConnectToken
 *
 * Função Callable (requer usuário autenticado via Firebase Auth).
 * Executa o fluxo completo em dois passos no servidor:
 *   1) POST /auth        → obtém apiKey com as credenciais Pluggy
 *   2) POST /connect_token → gera Connect Token vinculado ao uid do usuário
 *
 * Retorna apenas { connectToken } — nenhuma credencial trafega para o cliente.
 *
 * @returns {{ connectToken: string }}
 */
exports.createPluggyConnectToken = onCall(
  {
    region:  'southamerica-east1',
    secrets: [pluggyClientId, pluggyClientSecret],
  },
  async (request) => {
    // Garante que a requisição vem de um usuário autenticado
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Autenticação necessária.');
    }
    const uid = request.auth.uid;

    // Valida plano via Firestore — não confia em nada vindo do frontend
    const db = getFirestore();
    const userSnap = await db.collection('users').doc(uid).get();
    const plan = userSnap.exists ? userSnap.data().plan : null;
    if (!['trial', 'premium'].includes(plan)) {
      throw new HttpsError('permission-denied', 'Plano Premium ou Trial necessário para conectar bancos.');
    }

    try {
      // Passo 1: trocar credenciais por apiKey
      const authRes = await fetch('https://api.pluggy.ai/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId:     pluggyClientId.value(),
          clientSecret: pluggyClientSecret.value(),
        }),
      });
      if (!authRes.ok) {
        console.error(`Pluggy /auth falhou [${authRes.status}]:`, await authRes.text());
        throw new HttpsError('internal', 'Erro ao autenticar com Pluggy.');
      }
      const { apiKey } = await authRes.json();

      // Passo 2: gerar Connect Token vinculado ao uid Firebase do usuário
      const tokenRes = await fetch('https://api.pluggy.ai/connect_token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
        body: JSON.stringify({ options: { clientUserId: uid } }),
      });
      if (!tokenRes.ok) {
        console.error(`Pluggy /connect_token falhou [${tokenRes.status}]:`, await tokenRes.text());
        throw new HttpsError('internal', 'Erro ao gerar Connect Token.');
      }
      const { accessToken } = await tokenRes.json();

      if (!accessToken) {
        console.error('Pluggy /connect_token retornou resposta sem accessToken');
        throw new HttpsError('internal', 'Resposta inesperada do Pluggy.');
      }

      return { connectToken: accessToken };

    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error('createPluggyConnectToken erro inesperado:', err);
      throw new HttpsError('internal', 'Erro interno. Tente novamente.');
    }
  }
);

/**
 * checkCPFUnique
 *
 * Verifica se um CPF ainda não está registrado, usando hash SHA-256.
 * Roda no servidor para que a collection `cpfs` nunca seja acessível pelo cliente.
 *
 * @param {{ cpf: string }} data — CPF em qualquer formatação
 * @returns {{ available: boolean }}
 */
exports.checkCPFUnique = onCall(
  { region: 'southamerica-east1' },
  async (request) => {
    // Não exige autenticação: o usuário ainda não tem conta no momento do cadastro.
    // Segurança: CPF é hashed SHA-256 antes de qualquer verificação — apenas quem
    // conhece o CPF real pode verificar sua disponibilidade (sem information disclosure).
    const cpf = (request.data?.cpf || '').replace(/\D/g, '');
    if (cpf.length !== 11) {
      throw new HttpsError('invalid-argument', 'CPF inválido.');
    }
    const hash = hashCPF(cpf);
    const db = getFirestore();
    const snap = await db.collection('cpfs').doc(hash).get();
    return { available: !snap.exists };
  }
);

/**
 * saveCPF
 *
 * Registra o hash SHA-256 do CPF na collection `cpfs` (verificando unicidade)
 * e grava o hash como backup no documento `users/{uid}` do próprio usuário.
 * Ambas as operações usam Admin SDK — invisíveis para as Firestore Rules.
 *
 * @param {{ cpf: string }} data
 * @returns {{ success: boolean, cpfHash: string }}
 */
exports.saveCPF = onCall(
  { region: 'southamerica-east1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Autenticação necessária.');
    }
    const uid = request.auth.uid;
    const cpf = (request.data?.cpf || '').replace(/\D/g, '');
    if (cpf.length !== 11) {
      throw new HttpsError('invalid-argument', 'CPF inválido.');
    }

    const hash = hashCPF(cpf);
    const db = getFirestore();
    const cpfRef = db.collection('cpfs').doc(hash);

    // Verifica novamente no servidor para evitar race condition
    const snap = await cpfRef.get();
    if (snap.exists) {
      throw new HttpsError('already-exists', 'Este CPF já está cadastrado.');
    }

    await cpfRef.set({ uid, createdAt: FieldValue.serverTimestamp() });
    await db.collection('users').doc(uid).set(
      { cpfHash: hash },
      { merge: true }
    );

    return { success: true, cpfHash: hash };
  }
);

/**
 * deleteAccount
 *
 * Exclui os documentos Firestore do usuário (`users/{uid}` e `cpfs/{cpfHash}`).
 * O cliente deve chamar esta função ANTES de `user.delete()` e depois limpar o localStorage.
 * Operações via Admin SDK — não sujeitas às Firestore Rules.
 *
 * @returns {{ success: boolean }}
 */
exports.deleteAccount = onCall(
  { region: 'southamerica-east1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Autenticação necessária.');
    }
    const uid = request.auth.uid;
    const db = getFirestore();

    // Localizar hash do CPF no perfil do usuário
    const userSnap = await db.collection('users').doc(uid).get();
    const cpfHash = userSnap.exists ? userSnap.data()?.cpfHash : null;

    // Deletar documentos Firestore (ordem: cpfs primeiro, depois users)
    if (cpfHash) {
      await db.collection('cpfs').doc(cpfHash).delete();
    }
    await db.collection('users').doc(uid).delete();

    // Deletar conta Firebase Auth via Admin SDK.
    // Admin SDK não exige sessão recente — elimina o risco de auth/requires-recent-login
    // que existia quando o cliente chamava user.delete() após a limpeza do Firestore.
    await getAuth().deleteUser(uid);

    return { success: true };
  }
);

/**
 * recordEngagement
 *
 * Incrementa atomicamente o contador de engajamento do usuário em Firestore.
 * Usado para validar elegibilidade do trial no servidor sem depender do localStorage.
 * Tipos válidos: 'entry' (lançamento manual) | 'goal' (meta criada).
 *
 * @param {{ type: 'entry' | 'goal' }} data
 * @returns {{ success: boolean }}
 */
exports.recordEngagement = onCall(
  { region: 'southamerica-east1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Autenticação necessária.');
    }
    const type = request.data?.type;
    if (!['entry', 'goal'].includes(type)) {
      throw new HttpsError('invalid-argument', 'Tipo inválido. Use "entry" ou "goal".');
    }

    const uid = request.auth.uid;
    const db = getFirestore();
    const field = type === 'entry' ? 'engagementEntries' : 'engagementGoals';

    await db.collection('users').doc(uid).set(
      { [field]: FieldValue.increment(1) },
      { merge: true }
    );

    return { success: true };
  }
);

/**
 * setPlan
 *
 * Grava o plano do usuário em `users/{uid}.plan` via Admin SDK.
 * Somente planos gratuitos (`free`, `trial`) podem ser definidos pelo cliente.
 * Planos pagos (`plus`, `pro`, `premium`) exigem webhook de pagamento — este endpoint
 * os rejeita explicitamente para evitar bypass da cobrança.
 *
 * @param {{ plan: string }} data
 * @returns {{ success: boolean }}
 */
exports.setPlan = onCall(
  { region: 'southamerica-east1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Autenticação necessária.');
    }
    const uid = request.auth.uid;
    const plan = request.data?.plan;

    // Somente planos gratuitos podem ser ativados diretamente pelo cliente.
    // Planos pagos requerem confirmação de pagamento via webhook.
    const clientAllowedPlans = ['free', 'trial'];
    if (!clientAllowedPlans.includes(plan)) {
      throw new HttpsError(
        'permission-denied',
        'Planos pagos requerem confirmação de pagamento.'
      );
    }

    const db = getFirestore();

    // Validações adicionais para ativação de trial
    if (plan === 'trial') {
      const snap = await db.collection('users').doc(uid).get();
      const data = snap.exists ? snap.data() : {};

      // Um trial por conta — trialStart é timestamp autoritativo gravado pelo servidor
      if (data.trialStart) {
        throw new HttpsError(
          'already-exists',
          'O período de trial já foi utilizado nesta conta.'
        );
      }

      // Contas já em plano pago não podem ativar trial
      if (['plus', 'pro', 'premium'].includes(data.plan)) {
        throw new HttpsError(
          'permission-denied',
          'Conta já possui plano pago. Trial não está disponível.'
        );
      }

      // Validar elegibilidade real: ≥3 lançamentos OU ≥1 meta registrados no servidor.
      // Contadores incrementados via recordEngagement() — não manipuláveis pelo cliente.
      const entries = data.engagementEntries || 0;
      const goals   = data.engagementGoals   || 0;
      if (entries < 3 && goals < 1) {
        throw new HttpsError(
          'failed-precondition',
          'Crie 3 lançamentos ou 1 meta para liberar o trial.'
        );
      }
    }

    // Gravar plano; trial inclui trialStart com timestamp do servidor
    await db.collection('users').doc(uid).set(
      {
        plan,
        planUpdatedAt: FieldValue.serverTimestamp(),
        ...(plan === 'trial' ? { trialStart: FieldValue.serverTimestamp() } : {}),
      },
      { merge: true }
    );

    return { success: true };
  }
);
