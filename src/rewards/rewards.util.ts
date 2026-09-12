export type RewardTier = {
  name: 'Bronze' | 'Silver' | 'Gold';
  index: 1 | 2 | 3;
  min: number;
  max: number | null;
};

const POINTS_PER_1000_NAIRA = 10;
export const REFERRAL_SIGNUP_BONUS = 10;
export const REFERRAL_REFERRER_BONUS = 10;

/** 10 points for every ₦1,000 spent (F-12). */
export function pointsForAmount(nairaAmount: number): number {
  if (!Number.isFinite(nairaAmount) || nairaAmount <= 0) return 0;
  return Math.floor(nairaAmount / 1000) * POINTS_PER_1000_NAIRA;
}

export function tierForPoints(points: number): RewardTier {
  if (points >= 5000) return { name: 'Gold', index: 3, min: 5000, max: null };
  if (points >= 1000) return { name: 'Silver', index: 2, min: 1000, max: 4999 };
  return { name: 'Bronze', index: 1, min: 0, max: 999 };
}
