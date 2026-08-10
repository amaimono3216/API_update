// Go ソースから SDK 呼び出しの候補を抽出する。
//
// 標準入力から {"files": [{"path": ..., "content": ...}]} を受け取り、
// 呼び出しチェーン・構造体リテラルのフィールド名・行番号を JSON で返す。
//
// SDK ごとの知識は持たせず、構文上の事実だけを返す。対応づけは TypeScript 側の
// sdk-map に集約する。Go 本体の go/ast を使うのは、文法を推測で再実装しないため。
//
// このプログラムはビルド時にのみ Go ツールチェーンを必要とし、
// 実行イメージにはコンパイル済みバイナリだけを置く。
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strings"
)

const maxDepth = 8

type inputFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type input struct {
	Files []inputFile `json:"files"`
}

type importEntry struct {
	Module string `json:"module"`
	Name   string `json:"name"`
}

type callEntry struct {
	Root    string   `json:"root"`
	Chain   []string `json:"chain"`
	Line    int      `json:"line"`
	EndLine int      `json:"endLine"`
	Params  []string `json:"params"`
}

type fileResult struct {
	Path    string            `json:"path"`
	Error   *string           `json:"error"`
	Imports []importEntry     `json:"imports"`
	Clients map[string]string `json:"clients"`
	Calls   []callEntry       `json:"calls"`
}

type output struct {
	Files []fileResult `json:"files"`
}

// selectorChain は `client.Chat.Completions.New` を
// ("client", ["Chat", "Completions", "New"]) に分解する。
func selectorChain(expr ast.Expr) (string, []string) {
	var segments []string
	current := expr
	for {
		sel, ok := current.(*ast.SelectorExpr)
		if !ok {
			break
		}
		segments = append([]string{sel.Sel.Name}, segments...)
		current = sel.X
	}
	if ident, ok := current.(*ast.Ident); ok {
		return ident.Name, segments
	}
	return "", nil
}

// collectFields は構造体リテラルからフィールド名のパスを集める。
// 配列・スライス要素は `[]` を挟み、他言語の走査と同じ表記に揃える。
func collectFields(expr ast.Expr, prefix string, found map[string]struct{}, depth int) {
	if depth > maxDepth {
		return
	}

	switch node := expr.(type) {
	case *ast.UnaryExpr: // &Params{...}
		collectFields(node.X, prefix, found, depth)
	case *ast.CompositeLit:
		for _, element := range node.Elts {
			kv, ok := element.(*ast.KeyValueExpr)
			if !ok {
				// []T{{...}, {...}} のような要素
				collectFields(element, prefix+".[]", found, depth+1)
				continue
			}
			key, ok := kv.Key.(*ast.Ident)
			if !ok {
				continue
			}
			path := key.Name
			if prefix != "" {
				path = prefix + "." + key.Name
			}
			found[path] = struct{}{}
			collectFields(kv.Value, path, found, depth+1)
		}
	}
}

// callParams は呼び出し引数からパラメータ名を集める。
//
// Go では `params := &X{...}` と変数に入れてから渡すのが一般的なため、
// 引数が識別子の場合は、その変数へ代入された構造体リテラルを参照する。
func callParams(call *ast.CallExpr, structVars map[string][]string) []string {
	found := map[string]struct{}{}
	for _, arg := range call.Args {
		collectFields(arg, "", found, 0)

		if ident, ok := arg.(*ast.Ident); ok {
			for _, field := range structVars[ident.Name] {
				found[field] = struct{}{}
			}
		}
	}

	params := make([]string, 0, len(found))
	for name := range found {
		params = append(params, name)
	}
	sort.Strings(params)
	return params
}

// collectStructVars は `params := &X{Field: ...}` の変数名とフィールド名を集める。
func collectStructVars(file *ast.File) map[string][]string {
	result := map[string][]string{}

	record := func(name string, value ast.Expr) {
		fields := map[string]struct{}{}
		collectFields(value, "", fields, 0)
		if len(fields) == 0 {
			return
		}
		names := make([]string, 0, len(fields))
		for field := range fields {
			names = append(names, field)
		}
		sort.Strings(names)
		result[name] = append(result[name], names...)
	}

	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.AssignStmt:
			for i, lhs := range n.Lhs {
				if i >= len(n.Rhs) {
					break
				}
				if ident, ok := lhs.(*ast.Ident); ok {
					record(ident.Name, n.Rhs[i])
				}
			}
		case *ast.ValueSpec: // var params = &X{...}
			for i, ident := range n.Names {
				if i < len(n.Values) {
					record(ident.Name, n.Values[i])
				}
			}
		}
		return true
	})

	return result
}

// clientName は `openai.NewClient()` の `NewClient` のように、
// クライアントを生成した関数名を返す。
func clientName(expr ast.Expr) string {
	call, ok := expr.(*ast.CallExpr)
	if !ok {
		// &stripe.Client{} のような形
		if unary, ok := expr.(*ast.UnaryExpr); ok {
			return clientName(unary.X)
		}
		if lit, ok := expr.(*ast.CompositeLit); ok {
			if sel, ok := lit.Type.(*ast.SelectorExpr); ok {
				return sel.Sel.Name
			}
		}
		return ""
	}

	switch fn := call.Fun.(type) {
	case *ast.SelectorExpr:
		return fn.Sel.Name
	case *ast.Ident:
		return fn.Name
	}
	return ""
}

func analyze(fset *token.FileSet, path, content string) fileResult {
	result := fileResult{Path: path, Imports: []importEntry{}, Clients: map[string]string{}, Calls: []callEntry{}}

	file, err := parser.ParseFile(fset, path, content, parser.SkipObjectResolution)
	if err != nil {
		message := "構文エラー: " + err.Error()
		result.Error = &message
		return result
	}

	for _, spec := range file.Imports {
		module := strings.Trim(spec.Path.Value, `"`)
		name := ""
		if spec.Name != nil {
			name = spec.Name.Name
		} else {
			parts := strings.Split(module, "/")
			name = parts[len(parts)-1]
		}
		result.Imports = append(result.Imports, importEntry{Module: module, Name: name})
	}

	// 呼び出しより後ろで宣言された変数も参照できるよう、先に集めておく
	structVars := collectStructVars(file)

	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.AssignStmt:
			for i, lhs := range n.Lhs {
				if i >= len(n.Rhs) {
					break
				}
				ident, ok := lhs.(*ast.Ident)
				if !ok {
					continue
				}
				if name := clientName(n.Rhs[i]); name != "" {
					result.Clients[ident.Name] = name
				}
			}
		case *ast.CallExpr:
			root, segments := selectorChain(n.Fun)
			if root != "" && len(segments) > 0 {
				result.Calls = append(result.Calls, callEntry{
					Root:    root,
					Chain:   segments,
					Line:    fset.Position(n.Pos()).Line,
					EndLine: fset.Position(n.End()).Line,
					Params:  callParams(n, structVars),
				})
			}
		}
		return true
	})

	return result
}

func main() {
	var payload input
	if err := json.NewDecoder(os.Stdin).Decode(&payload); err != nil {
		os.Stderr.WriteString("入力を解釈できませんでした: " + err.Error())
		os.Exit(1)
	}

	fset := token.NewFileSet()
	results := make([]fileResult, 0, len(payload.Files))
	for _, f := range payload.Files {
		results = append(results, analyze(fset, f.Path, f.Content))
	}

	if err := json.NewEncoder(os.Stdout).Encode(output{Files: results}); err != nil {
		os.Stderr.WriteString("出力に失敗しました: " + err.Error())
		os.Exit(1)
	}
}
