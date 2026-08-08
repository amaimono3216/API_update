import type { Workspace } from './workspace.js';
import type { CodeEdit, EditApplyResult } from './types.js';

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

/**
 * LLM が生成した編集を、文字列の完全一致置換として適用する。
 *
 * ファイル全体を書き換えさせるより、置換対象を明示させるほうが安全。
 * 一致しない・複数箇所に一致するといった失敗は検出可能な形で返り、
 * そのまま LLM へのフィードバックとして次の試行に渡せる。
 */
export async function applyEdits(workspace: Workspace, edits: CodeEdit[]): Promise<EditApplyResult> {
  const applied: CodeEdit[] = [];
  const failures: EditApplyResult['failures'] = [];

  // 同一ファイルへの複数編集を順に反映するため、内容をメモリ上で持ち回る
  const contents = new Map<string, string>();

  for (const edit of edits) {
    // 作業ディレクトリ外への操作はフィードバックして再試行させる類の失敗ではなく、
    // 即座に中断すべき異常として扱う
    workspace.resolve(edit.file);

    if (edit.oldString === edit.newString) {
      failures.push({ edit, reason: '置換前後の文字列が同一です' });
      continue;
    }

    let current = contents.get(edit.file);
    if (current === undefined) {
      try {
        current = await workspace.readFile(edit.file);
      } catch (error) {
        failures.push({ edit, reason: `ファイルを読めません: ${String(error)}` });
        continue;
      }
    }

    const occurrences = countOccurrences(current, edit.oldString);
    if (occurrences === 0) {
      failures.push({ edit, reason: 'oldString がファイル内に見つかりません（空白やインデントを含めて一致させてください）' });
      continue;
    }
    if (occurrences > 1) {
      failures.push({ edit, reason: `oldString が ${occurrences} 箇所に一致します。前後の行を含めて一意にしてください` });
      continue;
    }

    contents.set(edit.file, current.replace(edit.oldString, edit.newString));
    applied.push(edit);
  }

  for (const [file, content] of contents) {
    await workspace.writeFile(file, content);
  }

  return { applied, failures };
}
