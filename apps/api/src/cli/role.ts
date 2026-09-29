// Usage: pnpm --filter @summarize/api role <email> <admin|user>   (existing users only)
import '../config';
import { PrismaClient } from '@summarize/db';

async function main() {
  const [rawEmail, role] = process.argv.slice(2);
  if (!rawEmail || (role !== 'admin' && role !== 'user')) {
    console.error('Usage: role <email> <admin|user>');
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();
  const prisma = new PrismaClient();
  try {
    const { count } = await prisma.user.updateMany({ where: { email, deletedAt: null }, data: { role } });
    if (!count) {
      console.error(`No user with email ${email}`);
      process.exit(1);
    }
    console.log(`${email}: role ${role}`);
  } finally {
    await prisma.$disconnect();
  }
}
main();
