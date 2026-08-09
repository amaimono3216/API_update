import { pool } from './pool.js';

export interface DeliveryRecord {
  deliveryId: string;
  event: string;
  action?: string | undefined;
  repository?: string | undefined;
}

/**
 * Webhook 配信を記録する。
 *
 * GitHub は配信失敗時に同じ delivery_id で再送するため、既に処理済みの場合は false を返す。
 * 呼び出し側はこれを見て二重処理を避ける。
 */
export async function recordDelivery(record: DeliveryRecord): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO webhook_deliveries (delivery_id, event, action, repository)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [record.deliveryId, record.event, record.action ?? null, record.repository ?? null],
  );
  return rowCount === 1;
}

export interface DeliveryRow {
  id: string;
  delivery_id: string;
  event: string;
  action: string | null;
  repository: string | null;
  received_at: Date;
}

export async function listDeliveries(limit = 20): Promise<DeliveryRow[]> {
  const { rows } = await pool.query<DeliveryRow>(
    `SELECT id, delivery_id, event, action, repository, received_at
       FROM webhook_deliveries ORDER BY received_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
