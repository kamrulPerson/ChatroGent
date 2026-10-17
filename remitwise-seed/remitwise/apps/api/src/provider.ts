import crypto from 'crypto';

export interface SubmitInput {
  proposal: any;
}

export interface SubmitResult {
  receiptId: string;
}

// Simulated payment provider. It always succeeds unless failure is forced,
// which lets the confirm flow exercise the "debit then refund" path. Failure is
// triggered by PROVIDER_FAIL_MODE=always or a route provider name containing
// "FAIL" (e.g. routeProvider: "FAIL-SANDBOX"), so tests can drive it per request.
export class MockPaymentProvider {
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const providerName = String(input?.proposal?.quoteSnapshot?.provider ?? '');
    if (process.env.PROVIDER_FAIL_MODE === 'always' || /FAIL/i.test(providerName)) {
      throw new Error('simulated provider failure');
    }
    const receiptId = 'RW-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    return { receiptId };
  }
}
