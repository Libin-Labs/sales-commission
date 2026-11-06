import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { calculateCommission, settleCumulative, CommissionError } from '../dist/esm/index.js';

const tiers = [
  { upToCents: 100_000n, rateBps: 500 },
  { upToCents: 300_000n, rateBps: 800 },
  { rateBps: 1200 },
];
const calc = (plan, salesCents, refundsCents) =>
  calculateCommission(plan, { salesCents, refundsCents });

test('flat commission rounds once with the chosen mode', () => {
  assert.equal(calc({ type: 'flat', rateBps: 1000 }, 123_456n).commissionCents, 12_346n); // 12345.6
  assert.equal(calc({ type: 'flat', rateBps: 250 }, 10n).commissionCents, 0n); // 0.25
  assert.equal(calc({ type: 'flat', rateBps: 250, rounding: 'ceil' }, 10n).commissionCents, 1n);
  assert.equal(calc({ type: 'flat', rateBps: 5000 }, 1n).commissionCents, 0n); // 0.5 -> even
  assert.equal(calc({ type: 'flat', rateBps: 5000, rounding: 'half-up' }, 1n).commissionCents, 1n);
  assert.equal(calc({ type: 'flat', rateBps: 1000 }, 0n).commissionCents, 0n);
});

test('marginal tiers match an independent slice-by-slice oracle', () => {
  const plan = { type: 'marginal', tiers };
  const oracle = (sales) => {
    const parts = [
      [0, 100_000, 500],
      [100_000, 300_000, 800],
      [300_000, Infinity, 1200],
    ];
    let total = 0;
    for (const [lo, hi, bps] of parts) total += Math.max(0, Math.min(sales, hi) - lo) * bps;
    return Math.round(total / 10000);
  };
  for (const sales of [
    0, 1, 99_999, 100_000, 100_001, 250_000, 300_000, 300_001, 1_000_000, 123_457,
  ]) {
    const got = calc(plan, BigInt(sales)).commissionCents;
    assert.ok(Math.abs(Number(got) - oracle(sales)) <= 1, `${sales}: ${got} vs ${oracle(sales)}`);
  }
  assert.equal(calc(plan, 300_000n).commissionCents, 5000n + 16000n);
  assert.deepEqual(
    calc(plan, 150_000n).slices.map((s) => [s.tier, s.amountCents]),
    [
      [0, 100_000n],
      [1, 50_000n],
      [2, 0n],
    ],
  );
});

test('whole-tier uses inclusive upper bounds and applies one rate to everything', () => {
  const plan = { type: 'whole', tiers };
  assert.equal(calc(plan, 100_000n).commissionCents, 5000n);
  assert.equal(calc(plan, 100_001n).commissionCents, 8000n); // 100001 * 8% = 8000.08
  assert.equal(calc(plan, 300_000n).commissionCents, 24_000n);
  assert.equal(calc(plan, 300_001n).commissionCents, 36_000n);
  assert.equal(calc(plan, 1n).commissionCents, 0n);
});

test('threshold modes differ at the boundary and cap is applied last', () => {
  const excess = { type: 'flat', rateBps: 1000, thresholdCents: 10_000n };
  const cliff = { ...excess, thresholdMode: 'cliff' };
  assert.equal(calc(excess, 10_000n).commissionCents, 0n);
  assert.equal(calc(excess, 15_000n).commissionCents, 500n);
  assert.equal(calc(cliff, 9_999n).commissionCents, 0n);
  assert.equal(calc(cliff, 10_000n).commissionCents, 1000n);
  const capped = calc({ ...excess, capCents: 300n }, 15_000n);
  assert.deepEqual([capped.commissionCents, capped.capped], [300n, true]);
  assert.equal(calc({ ...excess, capCents: 500n }, 15_000n).capped, false);
  assert.equal(calc({ type: 'flat', rateBps: 1000, capCents: 0n }, 1000n).commissionCents, 0n);
});

test('refunds reduce net sales; over-refund follows the explicit policy', () => {
  const plan = { type: 'flat', rateBps: 1000 };
  assert.equal(calc(plan, 10_000n, 4_000n).commissionCents, 600n);
  assert.equal(calc(plan, 10_000n, 4_000n).netSalesCents, 6000n);
  assert.throws(
    () => calc(plan, 1000n, 2000n),
    (e) => e instanceof CommissionError && e.code === 'negative-net',
  );
  const zero = calc({ ...plan, negativeNet: 'zero' }, 1000n, 2000n);
  assert.equal(zero.commissionCents, 0n);
  assert.equal(zero.netSalesCents, -1000n);
  assert.throws(() => calc({ ...plan, negativeNet: 'allow' }, 1n), CommissionError);
});

test('cumulative settlement pays deltas and claws back after refunds', () => {
  const plan = {
    type: 'marginal',
    tiers: [{ upToCents: 100_000n, rateBps: 500 }, { rateBps: 1000 }],
  };
  const rows = settleCumulative(plan, [
    { salesCents: 80_000n },
    { salesCents: 80_000n },
    { salesCents: 0n, refundsCents: 90_000n },
  ]);
  assert.deepEqual(
    rows.map((r) => r.payoutCents),
    [4000n, 7000n, -7500n],
  ); // cumulative 4000, 11000, then 3500 at 70000 net
  assert.deepEqual(
    rows.map((r) => r.cumulativeNetSalesCents),
    [80_000n, 160_000n, 70_000n],
  );
  assert.equal(
    rows.reduce((t, r) => t + r.payoutCents, 0n),
    calc(plan, 160_000n, 90_000n).commissionCents,
  );
  assert.equal(rows.at(-1).cumulativeCommissionCents, 3500n);
  const capped = settleCumulative({ type: 'flat', rateBps: 1000, capCents: 1000n }, [
    { salesCents: 20_000n },
    { salesCents: 20_000n },
  ]);
  assert.deepEqual(
    capped.map((r) => r.payoutCents),
    [1000n, 0n],
  );
});

test('invalid plans, tiers, and amounts are rejected', () => {
  const flat = { type: 'flat', rateBps: 100 };
  for (const plan of [
    { type: 'flat', rateBps: -1 },
    { type: 'flat', rateBps: 100001 },
    { type: 'flat', rateBps: 1.5 },
    { type: 'flat', rateBps: NaN },
    { type: 'bonus' },
    { ...flat, rounding: 'nearest' },
    { ...flat, thresholdMode: 'x' },
    { ...flat, thresholdCents: -1n },
    { ...flat, capCents: -1n },
    { type: 'marginal', tiers: [] },
    { type: 'marginal', tiers: [{ upToCents: 10n, rateBps: 1 }] },
    { type: 'marginal', tiers: [{ rateBps: 1 }, { rateBps: 2 }] },
    {
      type: 'marginal',
      tiers: [{ upToCents: 10n, rateBps: 1 }, { upToCents: 10n, rateBps: 2 }, { rateBps: 3 }],
    },
    { type: 'whole', tiers: [{ upToCents: 0n, rateBps: 1 }, { rateBps: 3 }] },
    { type: 'whole', tiers: [{ upToCents: 5n, rateBps: 101_000 }, { rateBps: 3 }] },
    null,
  ]) {
    assert.throws(
      () => calc(plan, 100n),
      CommissionError,
      JSON.stringify(plan, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    );
  }
  for (const bad of [-1n, 1.5, '5', NaN, undefined])
    assert.throws(() => calc(flat, bad), CommissionError);
  assert.throws(() => calc(flat, 1n, -1n), CommissionError);
  assert.throws(() => settleCumulative(flat, []), CommissionError);
  assert.throws(() => settleCumulative(flat, [{ salesCents: -1n }]), CommissionError);
});

test('huge amounts remain exact and CJS agrees', () => {
  const big = 10n ** 30n + 1n;
  assert.equal(calc({ type: 'flat', rateBps: 10000 }, big).commissionCents, big);
  assert.equal(
    createRequire(import.meta.url)('@lp-labs/sales-commission').calculateCommission(
      { type: 'flat', rateBps: 1000 },
      { salesCents: 500 },
    ).commissionCents,
    50n,
  );
});
