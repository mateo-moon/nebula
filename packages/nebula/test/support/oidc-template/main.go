// Match function-go-templating v0.9.0: Go text/template, Sprig v3.3.0,
// yaml.v3 fromYaml, and include. Execute the emitted template without Kubernetes
// or cloud access; fixtures contain generated public keys and fake TLS material.
package main

import (
 "bytes"
 "encoding/json"
 "fmt"
 "os"
 "text/template"
 sprig "github.com/Masterminds/sprig/v3"
 "gopkg.in/yaml.v3"
)

func main() {
 var input struct { Template string; Data any }
 if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil { panic(err) }
 funcs := sprig.FuncMap()
 delete(funcs, "env")
 delete(funcs, "expandenv")
 t := template.New("oidc")
 funcs["fromYaml"] = func(value string) (any, error) {
  var result any
  err := yaml.Unmarshal([]byte(value), &result)
  return result, err
 }
 funcs["include"] = func(name string, value any) (string, error) {
  var out bytes.Buffer
  err := t.ExecuteTemplate(&out, name, value)
  return out.String(), err
 }
 t, err := t.Funcs(funcs).Parse(input.Template)
 if err != nil { panic(err) }
 var out bytes.Buffer
 if err = t.Execute(&out, input.Data); err != nil { panic(err) }
 fmt.Print(out.String())
}
