// Usage: pnpm --filter @summarize/api grant <email> <credits>   (negative = revoke)
import '../config';
import { PrismaClient } from '@summarize/db';

async function main() {
  const [rawEmail, rawAmount] = process.argv.slice(2);
  const amount = Number(rawAmount);
  if (!rawEmail || !Number.isInteger(amount) || amount === 0) {
    console.error('Usage: grant <email> <credits>');
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.upsert({ where: { email }, update: {}, create: { email } });
    await prisma.creditLedger.create({ data: { userId: user.id, type: amount > 0 ? 'grant' : 'revoke', amount } });
    const { _sum } = await prisma.creditLedger.aggregate({ where: { userId: user.id }, _sum: { amount: true } });
    console.log(`${email}: ${amount > 0 ? '+' : ''}${amount} credits, balance ${_sum.amount ?? 0}`);
  } finally {
    await prisma.$disconnect();
  }
}
main();
