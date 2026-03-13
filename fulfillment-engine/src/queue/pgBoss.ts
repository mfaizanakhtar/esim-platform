import PgBoss from 'pg-boss';

const connectionString = process.env.DATABASE_URL || '';
const boss = new PgBoss(connectionString);

export async function startBoss() {
  await boss.start();
  return boss;
}

export default boss;
