// Runs the emitted Go template with the standard template engine. The small
// function map implements only the Sprig functions used by this composition,
// so tests exercise its actual conditional rendering without a cloud cluster.
package main

import (
 "bytes"
 "encoding/base64"
 "encoding/json"
 "fmt"
 "os"
 "reflect"
 "regexp"
 "strings"
 "text/template"
)

func main() {
 var input struct { Template string; Data any }
 if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil { panic(err) }
 funcs := template.FuncMap{
  "dict": func(values ...any) map[string]any {
   result := map[string]any{}
   for i := 0; i < len(values); i += 2 { result[values[i].(string)] = values[i+1] }
   return result
  },
  "list": func(values ...any) []any { return values },
  "get": func(m map[string]any, key string) any { if v, ok := m[key]; ok { return v }; return "" },
  "set": func(m map[string]any, key string, value any) map[string]any { m[key] = value; return m },
  "default": func(fallback, value any) any {
   if value == nil { return fallback }
   v := reflect.ValueOf(value)
   switch v.Kind() {
   case reflect.Map, reflect.Slice, reflect.Array, reflect.String: if v.Len() == 0 { return fallback }
   case reflect.Bool: if !v.Bool() { return fallback }
   }
   return value
  },
  "dig": func(values ...any) (any, error) {
   current := values[len(values)-1]
   fallback := values[len(values)-2]
   for _, key := range values[:len(values)-2] {
    m, ok := current.(map[string]any); if !ok { return nil, fmt.Errorf("dig: not a map") }
    current, ok = m[key.(string)]; if !ok { return fallback, nil }
   }
   return current, nil
  },
  "deepCopy": func(value any) any { b, _ := json.Marshal(value); var copy any; _ = json.Unmarshal(b, &copy); return copy },
  "toJson": func(value any) string { b, err := json.Marshal(value); if err != nil { panic(err) }; return string(b) },
  "b64dec": func(value string) string { b, err := base64.StdEncoding.DecodeString(value); if err != nil { panic(err) }; return string(b) },
  "b64enc": func(value string) string { return base64.StdEncoding.EncodeToString([]byte(value)) },
  "replace": func(old, new, value string) string { return strings.ReplaceAll(value, old, new) },
  "regexMatch": func(pattern, value string) bool { ok, _ := regexp.MatchString(pattern, value); return ok },
 }
 t, err := template.New("worker").Funcs(funcs).Parse(input.Template); if err != nil { panic(err) }
 var output bytes.Buffer
 if err = t.Execute(&output, input.Data); err != nil { panic(err) }
 fmt.Print(output.String())
}
