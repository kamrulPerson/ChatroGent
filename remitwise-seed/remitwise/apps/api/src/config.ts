// Product-policy / sandbox settings.
//
// Everything below is a sandbox assumption, NOT a regulatory value. Per the
// compliance spec (KYC/AML draft v2, sections 6-7) the VEL_01 / ANOM_01
// thresholds and the daily caps are ours to choose and must be labelled as
// product policy. They live here so they can be tuned and versioned.
//
// Bumping rulesVersion invalidates every stored proposal decision: the
// compliance engine re-runs with the current version at confirm time.
export const policy = {
  rulesVersion: '2.0-sandbox',
  component: 'compliance-engine',

  // VEL_01: more than this many transfers in the trailing 24h escalates.
  velocityMaxTransfers24h: Number(process.env.VELOCITY_MAX_24H) || 3,
  // ANOM_01: an amount above median * multiplier escalates.
  anomalyMultiplier: Number(process.env.ANOMALY_MULTIPLIER) || 3,

  // KYC_01: tier 1 may only move small amounts; anything at or below this cap
  // and not a tuition/remittance purpose is allowed. Tuition and cross-border
  // remittances need tier 2 (see KYC-02 / KYC-03 in the spec).
  tier1LowValueCapUSD: Number(process.env.TIER1_LOW_VALUE_CAP_USD) || 1000,
  enhancedKycPurposes: ['tuition', 'insurance', 'advance_fee', 'admission_fee'],

  // Daily caps by KYC tier (USD). Applies to the sum of transfers executed today.
  dailyCapUSDByKycTier: {
    0: Number(process.env.DAILY_CAP_TIER0_USD) || 0,
    1: Number(process.env.DAILY_CAP_TIER1_USD) || 5000,
    2: Number(process.env.DAILY_CAP_TIER2_USD) || 50000,
  } as Record<number, number>,

  // Permitted education purposes (spec enums.purposes). admission_fee and
  // advance_fee are included because ADV_01 and BEN_01 apply to them.
  purposes: ['tuition', 'living', 'incidental', 'insurance', 'admission_fee', 'advance_fee'],

  // How long a proposal stays open for confirmation.
  proposalTtlSeconds: Number(process.env.PROPOSAL_TTL_SECONDS) || 600,

  // MIN_AMT: a transfer must be at least this many USD, and the fee + FX margin
  // must stay under maxFeePct percent of the amount. Both are sandbox product
  // policy, not regulatory values.
  minTransferUSD: Number(process.env.MIN_TRANSFER_USD) || 10,
  maxFeePct: Number(process.env.MAX_FEE_PCT) || 5,

  // BD-MY only for the demo corridor set; kept in one place.
  corridors: ['BD-MY', 'BD-US', 'BD-UK', 'BD-CA', 'BD-AU'] as const,

  // CORS must be an explicit allow-list from env, never '*'.
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export type Policy = typeof policy;
