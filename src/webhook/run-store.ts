import { findRunByPrUrl, updateRun } from '../db/runs.js';
import type { RunStore } from './github.js';

/** Webhook ハンドラが使う実行記録ストアの実装。 */
export const dbRunStore: RunStore = {
  findByPrUrl: async (prUrl) => {
    const run = await findRunByPrUrl(prUrl);
    return run ? { id: run.id, repository: run.repository } : null;
  },
  setStatus: (id, status) => updateRun(id, { status }),
};
