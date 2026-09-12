import { PrismaService } from '../prisma/prisma.service';

// Excludes 0/O and 1/I/L so codes read back over the phone without ambiguity.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}

/** Retries on the (astronomically unlikely) chance of a collision with an existing code. */
export async function generateUniqueReferralCode(
  prisma: PrismaService,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const exists = await prisma.customer.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique referral code');
}
