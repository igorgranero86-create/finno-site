// ================================================================
// billing.js — Abstração do gateway de pagamento (Stripe default)
// ================================================================
// Para trocar para Pagar.me: reimplementar as 3 funções exportadas
// mantendo a mesma assinatura de entrada/saída.
// ================================================================

const PAID_PLANS = ['plus', 'pro', 'premium'];

// Mapa de benefícios por plano — fonte de verdade para permissões de feature
const PLAN_BENEFITS = {
  free:    { ads: true,  ai: false, banks: 0 },
  plus:    { ads: false, ai: false, banks: 0 },
  pro:     { ads: false, ai: true,  banks: 0 },
  premium: { ads: false, ai: true,  banks: 2 },
  trial:   { ads: false, ai: true,  banks: 1 },
};

/**
 * Cria uma sessão Stripe Checkout em modo subscription.
 * O uid e planId ficam em metadata para o webhook recuperar sem depender
 * de client_reference_id (que pode ser null se o customer já existir).
 *
 * @param {{ planId, uid, email, successUrl, cancelUrl, secretKey, priceId }} opts
 * @returns {{ url: string, sessionId: string }}
 */
async function createCheckoutSession({ planId, uid, email, successUrl, cancelUrl, secretKey, priceId }) {
  const Stripe = require('stripe');
  const stripe = Stripe(secretKey);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: uid,
    metadata: { uid, planId },
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Valida a assinatura do webhook Stripe e retorna o evento verificado.
 * Lança erro se a assinatura for inválida — o caller deve responder 400.
 *
 * @param {Buffer} rawBody — req.rawBody (disponível em Firebase Functions v2 onRequest)
 * @param {string} signature — header 'stripe-signature'
 * @param {string} webhookSecret — STRIPE_WEBHOOK_SECRET
 * @returns {Stripe.Event}
 */
function constructWebhookEvent(rawBody, signature, webhookSecret) {
  const Stripe = require('stripe');
  const stripe = Stripe(webhookSecret);
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/**
 * Mapeia um evento Stripe para uma atualização de plano Finno.
 * Retorna null para eventos que não requerem atualização de plano.
 *
 * Campos possíveis no retorno:
 *   uid?           — Firebase UID (presente em checkout.session.completed)
 *   customerId?    — Stripe customer ID (presente em eventos de subscription/invoice)
 *   plan?          — plano Finno a ser gravado
 *   planStatus?    — 'active' | 'past_due' | 'canceled' | 'inactive'
 *   billingProvider? — 'stripe'
 *   subscriptionId? — Stripe subscription ID (null = cancelado)
 *
 * @param {Stripe.Event} event
 * @returns {object|null}
 */
// ✅ PRODUÇÃO: todos os eventos críticos do ciclo de vida de assinatura Stripe cobertos.
// checkout.session.completed → ativa plano
// invoice.paid              → reativa após past_due
// invoice.payment_failed    → past_due (bloqueia acesso via getPlanState no frontend)
// subscription.updated      → sincroniza status
// subscription.deleted      → downgrade para free
function mapEventToPlanUpdate(event) {
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const uid            = obj.metadata?.uid || obj.client_reference_id;
      const planId         = obj.metadata?.planId;
      const customerId     = obj.customer;
      const subscriptionId = obj.subscription;
      if (!uid || !PAID_PLANS.includes(planId)) return null;
      return { uid, plan: planId, planStatus: 'active', customerId, subscriptionId, billingProvider: 'stripe' };
    }

    case 'customer.subscription.updated': {
      // Mapear status Stripe → planStatus Finno
      const planStatus = obj.status === 'active'   ? 'active'
                       : obj.status === 'past_due'  ? 'past_due'
                       : 'inactive';
      return { customerId: obj.customer, planStatus };
    }

    case 'customer.subscription.deleted': {
      // Downgrade para free ao cancelar a assinatura
      return { customerId: obj.customer, plan: 'free', planStatus: 'canceled', subscriptionId: null };
    }

    case 'invoice.payment_failed': {
      return { customerId: obj.customer, planStatus: 'past_due' };
    }

    case 'invoice.paid': {
      return { customerId: obj.customer, planStatus: 'active' };
    }

    default:
      return null;
  }
}

module.exports = { PAID_PLANS, PLAN_BENEFITS, createCheckoutSession, constructWebhookEvent, mapEventToPlanUpdate };
