const hosts = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

export async function plaid(path, payload) {
  const environment = process.env.PLAID_ENV || 'sandbox';
  if (!hosts[environment]) throw new Error('PLAID_ENV must be sandbox, development, or production');
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) throw new Error('Set PLAID_CLIENT_ID and PLAID_SECRET in .env');
  const response = await fetch(hosts[environment] + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID, 'PLAID-SECRET': process.env.PLAID_SECRET },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error_message || 'Plaid request failed');
    error.code = data.error_code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export const cents = amount => amount == null ? null : Math.round(Number(amount) * 100);
