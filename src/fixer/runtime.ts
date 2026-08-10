import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { TestCommand } from './test-runner.js';

/**
 * 対象リポジトリの言語ランタイム。
 *
 * 「どのコマンドでテストするか」と「どのコンテナで実行するか」を 1 か所にまとめる。
 * サンドボックス実行ではこのイメージを使い、ローカル実行ではコマンドの有無だけを見る。
 */
export interface Runtime {
  id: 'node' | 'python' | 'go' | 'rust';
  /** サンドボックス実行に使うイメージ */
  image: string;
  /** 依存関係のインストール手順。順に実行する。 */
  install: TestCommand[];
  test: TestCommand;
}

/** Python の依存を入れる仮想環境。作業コピー内に閉じ込める。 */
const VENV_DIR = '.venv';
const VENV_BIN = path.join(VENV_DIR, 'bin');
const venvBin = (name: string): string => path.join('.', VENV_BIN, name);

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * リポジトリの構成ファイルから言語ランタイムを判定する。
 *
 * 依存関係のインストール後に呼ぶと、Python は作られた仮想環境の pytest を指す。
 */
export async function detectRuntime(dir: string): Promise<Runtime | undefined> {
  const node = await detectNode(dir);
  if (node) return node;

  const python = await detectPython(dir);
  if (python) return python;

  if (await exists(path.join(dir, 'go.mod'))) {
    return {
      id: 'go',
      image: 'golang:1.24-bookworm',
      install: [{ command: 'go', args: ['mod', 'download'] }],
      test: { command: 'go', args: ['test', './...'] },
    };
  }

  if (await exists(path.join(dir, 'Cargo.toml'))) {
    return {
      id: 'rust',
      image: 'rust:1-slim-bookworm',
      install: [{ command: 'cargo', args: ['fetch'] }],
      test: { command: 'cargo', args: ['test'] },
    };
  }

  return undefined;
}

async function detectNode(dir: string): Promise<Runtime | undefined> {
  const packageJsonPath = path.join(dir, 'package.json');
  if (!(await exists(packageJsonPath))) return undefined;

  try {
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    if (!manifest.scripts?.test) return undefined;
  } catch {
    // package.json が壊れている場合は他の言語の候補にフォールバックする
    return undefined;
  }

  const install: TestCommand[] = [];
  if (await exists(path.join(dir, 'package-lock.json'))) install.push({ command: 'npm', args: ['ci'] });
  else if (await exists(path.join(dir, 'yarn.lock'))) {
    install.push({ command: 'yarn', args: ['install', '--frozen-lockfile'] });
  } else if (await exists(path.join(dir, 'pnpm-lock.yaml'))) {
    install.push({ command: 'pnpm', args: ['install', '--frozen-lockfile'] });
  }

  return {
    id: 'node',
    image: 'node:22-bookworm-slim',
    install,
    test: { command: 'npm', args: ['test', '--silent'] },
  };
}

async function detectPython(dir: string): Promise<Runtime | undefined> {
  const markers = ['requirements.txt', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'];
  let found: string | undefined;
  for (const marker of markers) {
    if (await exists(path.join(dir, marker))) {
      found = marker;
      break;
    }
  }
  if (!found) return undefined;

  // システム Python を汚さないよう、作業コピー内の仮想環境へ入れる
  const install: TestCommand[] = [];
  if (found === 'requirements.txt' || (await exists(path.join(dir, 'requirements.txt')))) {
    install.push(
      { command: 'python3', args: ['-m', 'venv', VENV_DIR] },
      { command: venvBin('pip'), args: ['install', '--quiet', '-r', 'requirements.txt'] },
      { command: venvBin('pip'), args: ['install', '--quiet', 'pytest'] },
    );
  } else if (await exists(path.join(dir, 'pyproject.toml'))) {
    install.push(
      { command: 'python3', args: ['-m', 'venv', VENV_DIR] },
      { command: venvBin('pip'), args: ['install', '--quiet', '.'] },
      { command: venvBin('pip'), args: ['install', '--quiet', 'pytest'] },
    );
  }

  const useVenv = await exists(path.join(dir, VENV_BIN, 'pytest'));
  return {
    id: 'python',
    image: 'python:3.12-slim-bookworm',
    install,
    test: useVenv ? { command: venvBin('pytest'), args: ['-q'] } : { command: 'pytest', args: ['-q'] },
  };
}
