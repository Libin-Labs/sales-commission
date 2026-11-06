import {
  calculateCommission,
  settleCumulative,
  type CommissionPlan,
  type CommissionResult,
} from '@lp-labs/sales-commission';

const plan: CommissionPlan = {
  type: 'marginal',
  tiers: [{ upToCents: 100_000n, rateBps: 500 }, { rateBps: 800 }],
  capCents: 50_000n,
};
const result: CommissionResult = calculateCommission(plan, {
  salesCents: 200_000n,
  refundsCents: 0n,
});
const payouts: bigint[] = settleCumulative(plan, [{ salesCents: 1n }]).map(
  (row) => row.payoutCents,
);
void [result.commissionCents, payouts];
