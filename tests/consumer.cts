import { calculateCommission, CommissionError } from '@lp-labs/sales-commission';

const cents: bigint = calculateCommission(
  { type: 'flat', rateBps: 1000 },
  { salesCents: 1000 },
).commissionCents;
const code: string = new CommissionError('negative-net', 'x').code;
void [cents, code];
