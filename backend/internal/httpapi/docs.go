package httpapi

import (
	_ "embed"
	"encoding/json"
	"html/template"
	"net/http"
	"sort"
	"strings"
)

// This is the frozen migration contract, captured from route models without
// starting the retired service. The native binary is self-contained at runtime.
//
//go:embed openapi.json
var openAPI []byte

type ContractRoute struct{ Method, Path string }

func ContractRoutes() []ContractRoute {
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(openAPI, &spec); err != nil {
		panic(err)
	}
	routes := []ContractRoute{}
	for path, methods := range spec.Paths {
		for method := range methods {
			switch method {
			case "get", "post", "put", "patch", "delete", "head", "options":
				routes = append(routes, ContractRoute{strings.ToUpper(method), path})
			}
		}
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Path == routes[j].Path {
			return routes[i].Method < routes[j].Method
		}
		return routes[i].Path < routes[j].Path
	})
	return routes
}

type apiDoc struct {
	ContractRoute
	Summary, Schema string
}

var referenceTemplate = template.Must(template.New("reference").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LDOS API</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem}summary{cursor:pointer;padding:.5rem 0}code,pre{font:14px/1.5 ui-monospace,monospace}pre{overflow:auto;padding:1rem;background:#f5f5f5}details{border-bottom:1px solid #ddd}a{color:#125aaa}</style><h1>LDOS API</h1><p>Go 业务服务 · <a href="/openapi.json">OpenAPI 3.1 JSON</a></p>{{range .}}<details><summary><code>{{.Method}} {{.Path}}</code> — {{.Summary}}</summary><pre>{{.Schema}}</pre></details>{{end}}</html>`))

func mountDocs(mux *http.ServeMux) {
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(openAPI)
	})
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(openAPI, &spec); err != nil {
		panic(err)
	}
	docs := []apiDoc{}
	for _, route := range ContractRoutes() {
		raw := spec.Paths[route.Path][strings.ToLower(route.Method)]
		var operation struct {
			Summary string `json:"summary"`
		}
		_ = json.Unmarshal(raw, &operation)
		docs = append(docs, apiDoc{route, operation.Summary, string(raw)})
	}
	for _, path := range []string{"/docs", "/redoc"} {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_ = referenceTemplate.Execute(w, docs)
		})
	}
}
