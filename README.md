# @lp-labs/sales-commission

Commission arithmetic in exact integer cents: flat rate, marginal tiers (each slice at its own rate),
and whole-tier plans (the reached tier's rate applies to everything), with thresholds, caps, refunds,
and cumulative period settlement that produces clawbacks. Rates are basis points and rounding happens
once, with a mode you choose.

## Install

```bash
npm install @lp-labs/sales-commission
```

ES2022 ESM and CommonJS builds ship with TypeScript declarations. There are no runtime dependencies.

## Quickstart

```js
import { calculateCommission, settleCumulative } from '@lp-labs/sales-commission';

const plan = {
  type: 'marginal',
  tiers: [{ upToCents: 100_000n, rateBps: 500 }, { rateBps: 1000 }],
};
const result = calculateCommission(plan, { salesCents: 150_000n });
if (result.commissionCents !== 10_000n) throw new Error('unexpected commission'); // 5000 + 5000

const rows = settleCumulative(plan, [
  { salesCents: 80_000n },
  { salesCents: 80_000n },
  { refundsCents: 90_000n, salesCents: 0n },
]);
console.log(rows.map((row) => row.payoutCents)); // [ 4000n, 7000n, -7500n ]
```

## API

```ts
type RoundingMode = 'floor' | 'ceil' | 'half-even' | 'half-up' | 'trunc';
interface Tier {
  upToCents?: bigint | number | null;
  rateBps: number;
}
interface FlatPlan extends PlanBase {
  type: 'flat';
  rateBps: number;
}
interface MarginalPlan extends PlanBase {
  type: 'marginal';
  tiers: readonly Tier[];
}
interface WholePlan extends PlanBase {
  type: 'whole';
  tiers: readonly Tier[];
}
type CommissionPlan = FlatPlan | MarginalPlan | WholePlan;
// PlanBase: thresholdCents?, thresholdMode?: 'excess' | 'cliff', capCents?, rounding?, negativeNet?: 'reject' | 'zero'
interface CommissionInput {
  salesCents: bigint | number;
  refundsCents?: bigint | number;
}
interface TierSlice {
  tier: number;
  amountCents: bigint;
  rateBps: number;
}
interface CommissionResult {
  netSalesCents: bigint;
  commissionableCents: bigint;
  commissionCents: bigint;
  capped: boolean;
  slices: readonly TierSlice[];
}
interface SettlementRow {
  period: number;
  cumulativeNetSalesCents: bigint;
  cumulativeCommissionCents: bigint;
  payoutCents: bigint;
}
type CommissionErrorCode = 'invalid-input' | 'negative-net';
class CommissionError extends Error {
  readonly code: CommissionErrorCode;
}
const MAX_TIERS: 1000;
const MAX_PERIODS: 10000;
const MAX_RATE_BPS: 100000;
function calculateCommission(plan: CommissionPlan, input: CommissionInput): CommissionResult;
function settleCumulative(
  plan: CommissionPlan,
  periods: readonly CommissionInput[],
): SettlementRow[];
```

- Net sales are `salesCents - refundsCents`. If refunds exceed sales, `negativeNet: 'reject'` (default)
  throws `negative-net`; `'zero'` pays nothing and reports the negative net.
- `thresholdMode: 'excess'` (default) pays only on sales above the threshold; `'cliff'` pays on all
  sales once net reaches the threshold and nothing below it.
- Tier bounds are inclusive upper limits in cents, strictly increasing, with the last tier open (omit
  `upToCents`). A tier covers `(previous bound, its bound]`. Tiers apply to the amount left after the
  threshold treatment.
- `marginal` sums `slice * rate` exactly, then rounds once; `whole` applies the rate of the tier the
  amount falls in to all of it (expect a step at each boundary).
- `capCents` limits the rounded commission and sets `capped`.
- `settleCumulative` recalculates on cumulative sales and refunds each period; the payout is the change
  in cumulative commission, so refunds in later periods produce negative payouts. Whether and how a
  clawback is recovered is your policy.

## Customization

Rounding, threshold mode, cap, and negative-net policy are all explicit plan fields. Currency and
rates are yours; nothing is converted.

## Errors

`CommissionError` for malformed plans, tiers, amounts, or policies, and for over-refunds under the
`reject` policy.

## Performance

Linear in tiers per calculation and in periods for settlement.

## Honest scope

Arithmetic for the plan you describe. It is not payroll software and gives no legal, tax, wage, or
contract advice: it does not model accelerators across plans, draws, splits, currency, or local
rules on commission payment and recovery.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
