/** 通知の対象となる出来事。①〜④ の節目に対応する。 */
export type NotificationEvent =
  | {
      type: 'breaking_detected';
      provider: string;
      fromVersion: string | null;
      toVersion: string;
      breakingCount: number;
      warningCount: number;
      diffId: string;
    }
  | {
      type: 'no_impact';
      provider: string;
      toVersion: string;
      repository: string;
      callSites: number;
    }
  | {
      type: 'pr_opened';
      repository: string;
      branch: string;
      url: string;
      testPassed: boolean;
      attempts: number;
    }
  | {
      type: 'pr_prepared';
      repository: string;
      branch: string;
      reason: string;
      testPassed: boolean;
    }
  | {
      type: 'fix_failed';
      repository: string;
      branch: string;
      attempts: number;
      reason: string;
    }
  | {
      type: 'pr_merged';
      repository: string;
      url: string;
    };

export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}
