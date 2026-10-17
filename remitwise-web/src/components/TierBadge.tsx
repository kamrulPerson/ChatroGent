import type { Tier } from '../types';

export const tierInfo: Record<Tier, { name: string; blurb: string }> = {
  T1: { name: 'Read', blurb: 'Looks up balances, rates, and rules' },
  T2: { name: 'Propose', blurb: 'Prepares a plan. Nothing is sent' },
  T3: { name: 'Execute', blurb: 'Acts only after you confirm' },
};

export default function TierBadge({ tier }: { tier: Tier | 'SYS' }) {
  if (tier === 'SYS') return <span className="tier sys">System</span>;
  return <span className={'tier ' + tier.toLowerCase()}>{tier} {tierInfo[tier].name}</span>;
}
