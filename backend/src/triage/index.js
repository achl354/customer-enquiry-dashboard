const { classify: ruleBasedClassify, domainOf } = require('./classify');
const aiClassifier = require('../ai/classifier');

const COMPANY_DOMAIN = 'jdhealthcare.com.au';
const KNOWN_NOISE_SENDERS = ['quarantine@messaging.microsoft.com', 'learntocare.com.au'];

// Obvious internal chatter and known noise senders are cheap to catch with
// plain rules and never need a model call — save the AI classifier for
// enquiries that actually need judgement.
function shortCircuitCategory(email) {
  const senderDomain = domainOf(email.senderEmail);
  const senderEmail = (email.senderEmail || '').toLowerCase();
  const isNoise = KNOWN_NOISE_SENDERS.some((n) => senderEmail.includes(n) || senderDomain.includes(n));
  if (isNoise) return 'SPAM_NOTIFICATION';

  const recipients = email.recipients || [];
  const isInternalSender = senderDomain === COMPANY_DOMAIN;
  const hasExternalRecipient = recipients.some((r) => domainOf(r) !== COMPANY_DOMAIN);
  if (isInternalSender && !hasExternalRecipient) return 'INTERNAL';

  return null;
}

/**
 * Classify an email for triage. Cheap, unambiguous cases (internal-only
 * threads, known spam senders) are resolved with plain rules. Everything
 * else goes through the AI classifier when configured (ANTHROPIC_API_KEY
 * set), falling back to the full rule-based classifier if the API call
 * fails or no key is configured.
 */
async function classifyEmail(email) {
  if (shortCircuitCategory(email)) {
    return { ...ruleBasedClassify(email), confidence: 1, classifiedBy: 'rules' };
  }

  if (aiClassifier.isConfigured()) {
    try {
      const result = await aiClassifier.classify(email);
      return { ...result, classifiedBy: 'ai' };
    } catch (err) {
      console.error('[triage] AI classification failed, falling back to rules:', err.message);
      return { ...ruleBasedClassify(email), confidence: null, classifiedBy: 'rules-fallback' };
    }
  }

  return { ...ruleBasedClassify(email), confidence: null, classifiedBy: 'rules' };
}

module.exports = { classifyEmail };
