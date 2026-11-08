// One-time / idempotent setup of the read-only warehouse connection.
//
//   ADMIN_DATABASE_URL=postgres://<superuser>@host:port/finance node scripts/warehouse-setup.mjs [--rotate]
//
// 1. Applies warehouse/*.sql (manual schema, FHSA data, workbench_ro role) as the admin.
// 2. If .env has no WAREHOUSE_DATABASE_URL yet (or --rotate), gives workbench_ro a new
//    random password and writes WAREHOUSE_DATABASE_URL into .env. The password is never printed.
import 'dotenv/config';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) { console.error('Set ADMIN_DATABASE_URL (a superuser URL for the finance DB).'); process.exit(1); }

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const files = (await readdir(join(root, 'warehouse'))).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    await client.query('BEGIN');
    await client.query(await readFile(join(root, 'warehouse', f), 'utf8'));
    await client.query('COMMIT');
    console.log(`applied ${f}`);
  }

  const envPath = join(root, '.env');
  const env = await readFile(envPath, 'utf8').catch(() => '');
  const has = /^WAREHOUSE_DATABASE_URL=/m.test(env);
  if (!has || process.argv.includes('--rotate')) {
    const password = randomBytes(24).toString('base64url');
    await client.query(`ALTER ROLE workbench_ro PASSWORD ${client.escapeLiteral(password)}`);
    const u = new URL(adminUrl);
    u.username = 'workbench_ro';
    u.password = password;
    u.search = '';
    const line = `WAREHOUSE_DATABASE_URL=${u.toString()}`;
    const next = has ? env.replace(/^WAREHOUSE_DATABASE_URL=.*$/m, line) : `${env.replace(/\n?$/, '\n')}${line}\n`;
    await writeFile(envPath, next, { mode: 0o600 });
    console.log(`${has ? 'rotated' : 'set'} workbench_ro password; WAREHOUSE_DATABASE_URL written to .env`);
  } else {
    console.log('.env already has WAREHOUSE_DATABASE_URL (pass --rotate for a new password)');
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
