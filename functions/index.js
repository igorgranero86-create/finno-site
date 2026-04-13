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
