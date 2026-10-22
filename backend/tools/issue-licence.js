import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign } from 'node:crypto';

const repositoryRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));

if (!args.key || !args.input || !args.output) {
  throw new Error('Usage: node tools/issue-licence.js --key <offline-private-key.pem> --input <payload.json> --output <licence.json>');
}

const privateKeyPath = resolve(args.key);
const relativeKeyPath = relative(repositoryRoot, privateKeyPath);
if (!relativeKeyPath.startsWith(`..${sep}`) && relativeKeyPath !== '..' && !isAbsolute(relativeKeyPath)) {
  throw new Error('The vendor private key must be stored outside the repository');
}

const payload = JSON.parse(await readFile(resolve(args.input), 'utf8'));
if (!Number.isInteger(payload.organizationId)
  || !Number.isInteger(payload.maxRooms) || payload.maxRooms < 1
  || !Number.isInteger(payload.maxUsers) || payload.maxUsers < 1
  || !Array.isArray(payload.modules) || !payload.modules.every((module) => typeof module === 'string')
  || typeof payload.expiresAt !== 'string'
  || !Number.isFinite(Date.parse(payload.expiresAt))
  || typeof payload.installationId !== 'string' || !payload.installationId) {
  throw new Error('Payload must contain organizationId, positive maxRooms/maxUsers, modules, expiresAt, and installationId');
}

const key = createPrivateKey({
  key: await readFile(privateKeyPath),
  passphrase: process.env.LICENSE_KEY_PASSPHRASE,
});
const signature = sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64');
await writeFile(resolve(args.output), `${JSON.stringify({ payload, signature }, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`License issued to ${resolve(args.output)}\n`);
