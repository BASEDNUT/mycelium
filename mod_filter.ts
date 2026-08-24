// v0.19.0 — anonymous content pre-filter (keyword + regex heuristics).
// Policy: precision > recall. Profanity, opinions, satire, edgy-but-legal stay.
// Only high-confidence solicitation/threat/NSFW-sales patterns are blocked.
// Mod queue still handles everything else (report -> queue -> resolve).
// Original code. MIT license.

export type FilterResult = { ok: boolean; reason?: string };

const NSFW_SALE = /\b(onlyfans|nudes?|porn|nsfw content|custom videos?)\b/i;
const NSFW_ACT = /\b(selling|for sale|buy|dm me|dmm|\$\d)\b/i;

const SHILL_TICKER = /\$[a-z0-9]{2,10}\b/i;
const SHILL_WORDS = /\b(buy|pump|moon|100x|1000x|guaranteed|ape in|apein|gains|rugproof|can't miss|cant miss)\b/i;
const SHILL_SALE = /\b(presale|allocation|early access|whitelist spots?|seed round)\b/i;
const SHILL_DM = /\b(dm me|dmm|pm me|message me)\b/i;
const SHILL_VENUE = /\b(t\.me|telegram group|tg group)\b/i;

const THREAT_VERB = /\b(kill|murder|assassinate|lynch|behead|execute)\b/i;
const THREAT_TARGET = /\b(you|them|him|her|us|everyone|all of you|that guy|that girl|this guy|this girl)\b/i;
const THREAT_INTENT = /\b(i will|i'll|imma|i'm going to|we should|we will|gonna|plan to|want to)\b/i;

export function anonFilter(content: string): FilterResult {
  const t = content.toLowerCase().replace(/_/g, " ");
  const words = t.split(/\s+/);
  if (words.length < 2) return { ok: true };

  // NSFW solicitation: NSFW item + sale/dm act (either order).
  if (NSFW_SALE.test(t) && NSFW_ACT.test(t)) {
    return { ok: false, reason: "nsfw-solicitation" };
  }

  // Crypto shilling: ticker + hype word.
  if (SHILL_TICKER.test(t) && SHILL_WORDS.test(t)) {
    return { ok: false, reason: "crypto-shilling" };
  }
  // Presale/allocation solicitation (with or without dm).
  if (SHILL_SALE.test(t) && (SHILL_DM.test(t) || SHILL_WORDS.test(t))) {
    return { ok: false, reason: "crypto-shilling" };
  }
  // Pump-group recruitment venues.
  if (SHILL_VENUE.test(t) && /\b(pump|moonshot|signals?|gains|gem|100x)\b/i.test(t)) {
    return { ok: false, reason: "crypto-shilling" };
  }

  // Targeted threats: intent + verb + target across the sentence.
  const hasVerb = THREAT_VERB.test(t);
  const hasTarget = THREAT_TARGET.test(t);
  const hasIntent = THREAT_INTENT.test(t);
  if (hasVerb && hasTarget && (hasIntent || /!/.test(t))) {
    return { ok: false, reason: "threat" };
  }
  // Direct imperative: "kill them", "murder him" (verb immediately followed by target).
  if (/(?:\bkill|\bmurder|\blynch|\bbehead)\s+(?:them|him|her|you|everyone|all\s+of\s+you)\b/i.test(t)) {
    return { ok: false, reason: "threat" };
  }

  return { ok: true };
}
