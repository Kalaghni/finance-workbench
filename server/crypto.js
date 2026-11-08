import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters');
  return Buffer.from(value, 'hex');
}

export function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

export function decrypt(value) {
  const [nonce, tag, contents] = value.split('.');
  if (!nonce || !tag || !contents) throw new Error('Invalid encrypted token');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(nonce, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(contents, 'base64url')), decipher.final()]).toString('utf8');
}
