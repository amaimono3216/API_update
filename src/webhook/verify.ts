import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GitHub Webhook の署名を検証する。
 *
 * 署名は生のリクエストボディに対する HMAC-SHA256 なので、JSON へパースする前の
 * バイト列で検証する必要がある。比較はタイミング攻撃を避けるため定数時間で行う。
 *
 * @see https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
 */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const received = Buffer.from(signatureHeader, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  // timingSafeEqual は長さが違うと例外を投げるため、先に長さを比較する
  if (received.length !== expectedBuffer.length) return false;
  return timingSafeEqual(received, expectedBuffer);
}
