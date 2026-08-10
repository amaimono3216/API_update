"""Python ソースから SDK 呼び出しの候補を抽出する。

標準入力から {"files": [{"path": ..., "content": ...}]} を受け取り、
呼び出しチェーン・渡している引数名・行番号を JSON で返す。

SDK ごとの知識（どのモジュールがどのプロバイダか、チェーンをどのパスに対応づけるか）は
持たせず、構文上の事実だけを返す。対応づけは TypeScript 側の sdk-map に集約する。

Python 自身の ast モジュールを使うのは、文法の実装を推測で書かずに済むため。
"""

import ast
import json
import sys

MAX_DEPTH = 8


def attribute_chain(node):
    """`client.v1.customers.create` を ("client", ["v1", "customers", "create"]) に分解する。"""
    segments = []
    current = node
    while isinstance(current, ast.Attribute):
        segments.insert(0, current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        return current.id, segments
    return None, []


def collect_params(node, prefix, found, depth=0):
    """辞書リテラルからプロパティのパスを集める。配列要素は `[]` を挟む。"""
    if depth > MAX_DEPTH:
        return
    for key, value in zip(node.keys, node.values):
        if not isinstance(key, ast.Constant) or not isinstance(key.value, str):
            continue
        path = f"{prefix}.{key.value}" if prefix else key.value
        found.add(path)
        collect_value(value, path, found, depth)


def collect_value(value, path, found, depth):
    if isinstance(value, ast.Dict):
        collect_params(value, path, found, depth + 1)
    elif isinstance(value, (ast.List, ast.Tuple)):
        for element in value.elts:
            if isinstance(element, ast.Dict):
                collect_params(element, f"{path}.[]", found, depth + 1)


def call_params(node):
    """キーワード引数と、辞書リテラルで渡された引数からパラメータ名を集める。

    Python の SDK は `client.chat_postMessage(channel="#x", text="y")` のように
    キーワード引数で渡すのが基本だが、`params={...}` の形もあるため両方を見る。
    """
    found = set()

    for keyword in node.keywords:
        if keyword.arg is None:  # **kwargs は中身が分からない
            continue
        found.add(keyword.arg)
        collect_value(keyword.value, keyword.arg, found, 0)

    for arg in node.args:
        if isinstance(arg, ast.Dict):
            collect_params(arg, "", found, 0)

    return sorted(found)


class Collector(ast.NodeVisitor):
    def __init__(self):
        self.imports = []
        self.clients = {}
        self.calls = []

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.append({"module": alias.name, "name": alias.asname or alias.name})
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if node.module:
            for alias in node.names:
                self.imports.append(
                    {"module": node.module, "name": alias.asname or alias.name, "imported": alias.name}
                )
        self.generic_visit(node)

    def _record_client(self, target, value):
        """`client = WebClient(token)` のような代入からクライアント変数を拾う。"""
        if not isinstance(value, ast.Call):
            return
        callee = value.func
        name = None
        if isinstance(callee, ast.Name):
            name = callee.id
        elif isinstance(callee, ast.Attribute):
            name = callee.attr
        if name is None:
            return

        if isinstance(target, ast.Name):
            self.clients[target.id] = name
        elif isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
            # self.client = Client(...) の形
            self.clients[f"{target.value.id}.{target.attr}"] = name

    def visit_Assign(self, node):
        for target in node.targets:
            self._record_client(target, node.value)
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            self._record_client(node.target, node.value)
        self.generic_visit(node)

    def visit_Call(self, node):
        root, segments = attribute_chain(node.func)
        if root is not None and segments:
            self.calls.append(
                {
                    "root": root,
                    "chain": segments,
                    "line": node.lineno,
                    "endLine": getattr(node, "end_lineno", node.lineno) or node.lineno,
                    "params": call_params(node),
                }
            )
        self.generic_visit(node)


def analyze(path, content):
    try:
        tree = ast.parse(content, filename=path)
    except SyntaxError as error:
        return {"path": path, "error": f"構文エラー: {error}", "imports": [], "clients": {}, "calls": []}

    collector = Collector()
    collector.visit(tree)
    return {
        "path": path,
        "error": None,
        "imports": collector.imports,
        "clients": collector.clients,
        "calls": collector.calls,
    }


def main():
    payload = json.load(sys.stdin)
    results = [analyze(f["path"], f["content"]) for f in payload.get("files", [])]
    json.dump({"files": results}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
