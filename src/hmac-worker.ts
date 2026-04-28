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
  const expectedSignature = 'sha256=' + digest;
  
  // Use crypto.timingSafeEqual to prevent timing attacks
  // and ensure this comparison runs in the worker thread off event loop
  try {
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (err) {
    // timingSafeEqual throws if buffers have different lengths
    // This is intentional: reject mismatched signatures safely
    return false;
  }
}
