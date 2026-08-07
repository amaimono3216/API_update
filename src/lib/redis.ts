import { Redis } from 'ioredis';

import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});

/**
 * 単純な分散ロック。監視ジョブが複数インスタンスやスケジューラと手動実行で
 * 二重起動し、同じスペックを重複取得するのを防ぐ。
 */
export async function withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
  const token = `${process.pid}-${Date.now()}`;
  const acquired = await redis.set(`lock:${key}`, token, 'EX', ttlSeconds, 'NX');
  if (acquired !== 'OK') return null;

  try {
    return await fn();
  } finally {
    // 自分が取得したロックのみ解放する（TTL 切れ後に他者が取得済みの場合を考慮）
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      `lock:${key}`,
      token,
    );
  }
}

export const closeRedis = async (): Promise<void> => {
  if (redis.status !== 'end') await redis.quit();
};
