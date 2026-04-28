import crypto from 'crypto';

export default async function verifyHmac({
  rawBody,
  webhookSecret,
  signature,
}: {
  rawBody: string;
  webhookSecret: string;
  signature: string;
}): Promise<boolean> {
  const hmac = crypto.createHmac('sha256', webhookSecret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
  return signature === digest || signature === `sha256=${digest}`;
}
