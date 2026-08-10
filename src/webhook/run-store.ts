import { findRunsByPrUrl, updateRun } from '../db/runs.js';
import type { RunStore } from './github.js';

/** Webhook ハンドラが使う実行記録ストアの実装。 */
export const dbRunStore: RunStore = {
  findAllByPrUrl: async (prUrl) => {
    const runs = await findRunsByPrUrl(prUrl);
    return runs.map((run) => ({ id: run.id, repository: run.repository }));
  },
  setStatus: (id, status) => updateRun(id, { status }),
};
