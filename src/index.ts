export type RoundingMode = 'floor' | 'ceil' | 'half-even' | 'half-up' | 'trunc';

export interface Tier {
  /** Inclusive upper bound of this tier in cents; omit or null for the last, open tier. */
  readonly upToCents?: bigint | number | null;
  /** Rate in basis points (100 = 1%), 0 to 100000. */
  readonly rateBps: number;
}

interface PlanBase {
  /** Sales threshold in cents. How it applies is set by `thresholdMode`. Default 0. */
  readonly thresholdCents?: bigint | number;
  /**
   * `excess`: only sales above the threshold earn commission.
   * `cliff`: nothing is earned below the threshold; at or above it, all sales earn.
   * Default `excess`.
   */
  readonly thresholdMode?: 'excess' | 'cliff';
  /** Maximum commission in cents, applied last. */
  readonly capCents?: bigint | number;
  /** Rounding of the single final division. Defaults to `half-even`. */
  readonly rounding?: RoundingMode;
  /** What to do when refunds exceed sales. Default `reject`. */
  readonly negativeNet?: 'reject' | 'zero';
}

export interface FlatPlan extends PlanBase {
  readonly type: 'flat';
  readonly rateBps: number;
}

export interface MarginalPlan extends PlanBase {
  readonly type: 'marginal';
  readonly tiers: readonly Tier[];
}

/** The rate of the tier the commissionable amount reaches applies to the whole amount. */
export interface WholePlan extends PlanBase {
  readonly type: 'whole';
  readonly tiers: readonly Tier[];
}

export type CommissionPlan = FlatPlan | MarginalPlan | WholePlan;

export interface CommissionInput {
  readonly salesCents: bigint | number;
  readonly refundsCents?: bigint | number;
}

export interface TierSlice {
  readonly tier: number;
  readonly amountCents: bigint;
  readonly rateBps: number;
}

export interface CommissionResult {
  readonly netSalesCents: bigint;
  /** Amount the rates were applied to, after threshold handling. */
  readonly commissionableCents: bigint;
  readonly commissionCents: bigint;
  readonly capped: boolean;
  readonly slices: readonly TierSlice[];
}

export interface SettlementRow {
  readonly period: number;
  readonly cumulativeNetSalesCents: bigint;
  readonly cumulativeCommissionCents: bigint;
  /** Amount due this period; negative means a clawback of earlier payouts. */
  readonly payoutCents: bigint;
}

export type CommissionErrorCode = 'invalid-input' | 'negative-net';

export class CommissionError extends Error {
  readonly code: CommissionErrorCode;
  constructor(code: CommissionErrorCode, message: string) {
    super(message);
    this.name = 'CommissionError';
    this.code = code;
  }
}

export const MAX_TIERS = 1000;
export const MAX_PERIODS = 10000;
export const MAX_RATE_BPS = 100000;
const MODES: readonly RoundingMode[] = ['floor', 'ceil', 'half-even', 'half-up', 'trunc'];

function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const away = n < 0n ? q - 1n : q + 1n;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case 'trunc':
      return q;
    case 'floor':
      return n < 0n ? away : q;
    case 'ceil':
      return n < 0n ? q : away;
    case 'half-up':
      return twice >= d ? away : q;
    case 'half-even':
      return twice > d || (twice === d && q % 2n !== 0n) ? away : q;
  }
}

function money(value: unknown, name: string, allowNegative = false): bigint {
  let result: bigint;
  if (typeof value === 'bigint') result = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
  else throw new CommissionError('invalid-input', `${name} must be a bigint or safe integer.`);
  if (!allowNegative && result < 0n)
    throw new CommissionError('invalid-input', `${name} must not be negative.`);
  return result;
}

function rate(value: unknown, name: string): bigint {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_RATE_BPS) {
    throw new CommissionError(
      'invalid-input',
      `${name} must be an integer from 0 to ${MAX_RATE_BPS}.`,
    );
  }
  return BigInt(value);
}

interface Bounded {
  upTo: bigint | null;
  rate: bigint;
}

function tiersOf(plan: MarginalPlan | WholePlan): Bounded[] {
  const list = plan.tiers;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_TIERS) {
    throw new CommissionError('invalid-input', `tiers must hold 1 to ${MAX_TIERS} entries.`);
  }
  let previous = 0n;
  return list.map((tier, index) => {
    const last = index === list.length - 1;
    const open = tier.upToCents === undefined || tier.upToCents === null;
    if (last !== open) {
      throw new CommissionError(
        'invalid-input',
        'Only the last tier may omit upToCents, and it must.',
      );
    }
    let upTo: bigint | null = null;
    if (!open) {
      upTo = money(tier.upToCents, `tiers[${index}].upToCents`);
      if (upTo <= previous) {
        throw new CommissionError(
          'invalid-input',
          'Tier bounds must be strictly increasing and positive.',
        );
      }
      previous = upTo;
    }
    return { upTo, rate: rate(tier.rateBps, `tiers[${index}].rateBps`) };
  });
}

export function calculateCommission(
  plan: CommissionPlan,
  input: CommissionInput,
): CommissionResult {
  if (typeof plan !== 'object' || plan === null)
    throw new CommissionError('invalid-input', 'plan must be an object.');
  const mode = plan.rounding ?? 'half-even';
  if (!MODES.includes(mode)) throw new CommissionError('invalid-input', 'Unknown rounding mode.');
  const thresholdMode = plan.thresholdMode ?? 'excess';
  if (thresholdMode !== 'excess' && thresholdMode !== 'cliff') {
    throw new CommissionError('invalid-input', 'Unknown thresholdMode.');
  }
  const negativeNet = plan.negativeNet ?? 'reject';
  if (negativeNet !== 'reject' && negativeNet !== 'zero') {
    throw new CommissionError('invalid-input', 'Unknown negativeNet policy.');
  }
  const threshold =
    plan.thresholdCents === undefined ? 0n : money(plan.thresholdCents, 'thresholdCents');
  const cap = plan.capCents === undefined ? null : money(plan.capCents, 'capCents');
  const sales = money(input?.salesCents, 'salesCents');
  const refunds = input.refundsCents === undefined ? 0n : money(input.refundsCents, 'refundsCents');
  let net = sales - refunds;
  if (net < 0n) {
    if (negativeNet === 'reject') {
      throw new CommissionError('negative-net', 'Refunds exceed sales.');
    }
    net = 0n;
  }
  let base: bigint;
  if (thresholdMode === 'cliff') base = net >= threshold && net > 0n ? net : 0n;
  else base = net > threshold ? net - threshold : 0n;

  let numerator = 0n;
  const slices: TierSlice[] = [];
  if (plan.type === 'flat') {
    const bps = rate(plan.rateBps, 'rateBps');
    numerator = base * bps;
    slices.push({ tier: 0, amountCents: base, rateBps: Number(bps) });
  } else if (plan.type === 'marginal' || plan.type === 'whole') {
    const tiers = tiersOf(plan);
    let lower = 0n;
    for (const [index, tier] of tiers.entries()) {
      const upper = tier.upTo;
      if (plan.type === 'marginal') {
        const top = upper === null || base < upper ? base : upper;
        const slice = top > lower ? top - lower : 0n;
        numerator += slice * tier.rate;
        slices.push({ tier: index, amountCents: slice, rateBps: Number(tier.rate) });
        if (upper === null || base <= upper) {
          for (let rest = index + 1; rest < tiers.length; rest += 1) {
            slices.push({ tier: rest, amountCents: 0n, rateBps: Number(tiers[rest]?.rate ?? 0n) });
          }
          break;
        }
        lower = upper;
      } else if (upper === null || base <= upper) {
        numerator = base * tier.rate;
        slices.push({ tier: index, amountCents: base, rateBps: Number(tier.rate) });
        break;
      }
    }
  } else {
    throw new CommissionError('invalid-input', 'Unknown plan type.');
  }
  let commission = divRound(numerator, 10000n, mode);
  const capped = cap !== null && commission > cap;
  if (capped && cap !== null) commission = cap;
  return Object.freeze({
    netSalesCents: sales - refunds < 0n ? sales - refunds : net,
    commissionableCents: base,
    commissionCents: commission,
    capped,
    slices: Object.freeze(slices),
  });
}

/**
 * Settles commission period by period on cumulative figures, so tiers, thresholds, caps and late
 * refunds are handled consistently. Each payout is the change in cumulative commission.
 */
export function settleCumulative(
  plan: CommissionPlan,
  periods: readonly CommissionInput[],
): SettlementRow[] {
  if (!Array.isArray(periods) || periods.length < 1 || periods.length > MAX_PERIODS) {
    throw new CommissionError('invalid-input', `periods must hold 1 to ${MAX_PERIODS} entries.`);
  }
  let sales = 0n;
  let refunds = 0n;
  let paid = 0n;
  return periods.map((period, index) => {
    sales += money(period?.salesCents, `periods[${index}].salesCents`);
    refunds +=
      period.refundsCents === undefined
        ? 0n
        : money(period.refundsCents, `periods[${index}].refundsCents`);
    const result = calculateCommission(plan, { salesCents: sales, refundsCents: refunds });
    const row: SettlementRow = Object.freeze({
      period: index + 1,
      cumulativeNetSalesCents: result.netSalesCents,
      cumulativeCommissionCents: result.commissionCents,
      payoutCents: result.commissionCents - paid,
    });
    paid = result.commissionCents;
    return row;
  });
}
