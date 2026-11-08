package main

import (
	"reflect"
	"testing"

	"github.com/int128/kubelogin/pkg/oidc"
	"github.com/int128/kubelogin/pkg/tokencache"
)

func TestCacheKeyRetainsIdentityAndRequestBoundaries(t *testing.T) {
	key := tokencache.Key{Provider: oidc.Provider{IssuerURL: "https://issuer.example.test", ClientID: "fixture-client", ClientSecret: "fixture-credential",
		ExtraScopes: []string{"email"}, RequestHeaders: map[string]string{"X-One": "one", "X-Two": "two"}},
		AuthRequestExtraParams: map[string]string{"hd": "example.test", "access_type": "offline", "prompt": "consent"}}
	want, err := canonicalKey(key)
	if err != nil {
		t.Fatal("fixture key failed")
	}
	for pass := 0; pass < 100; pass++ {
		if pass%2 == 0 {
			key.Provider.RequestHeaders = map[string]string{}
			key.Provider.RequestHeaders["X-Two"] = "two"
			key.Provider.RequestHeaders["X-One"] = "one"
			key.AuthRequestExtraParams = map[string]string{}
			for _, name := range []string{"prompt", "access_type", "hd"} {
				key.AuthRequestExtraParams[name] = map[string]string{"hd": "example.test", "access_type": "offline", "prompt": "consent"}[name]
			}
		} else {
			key.Provider.RequestHeaders = map[string]string{}
			key.Provider.RequestHeaders["X-One"] = "one"
			key.Provider.RequestHeaders["X-Two"] = "two"
			key.AuthRequestExtraParams = map[string]string{}
			for _, name := range []string{"hd", "access_type", "prompt"} {
				key.AuthRequestExtraParams[name] = map[string]string{"hd": "example.test", "access_type": "offline", "prompt": "consent"}[name]
			}
		}
		got, err := canonicalKey(key)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatal("identical request did not retain a stable cache identity")
		}
	}
	for _, field := range []string{"issuer", "client", "credential", "scopes", "headers", "request", "username"} {
		other := key
		switch field {
		case "issuer":
			other.Provider.IssuerURL = "https://foreign.example.test"
		case "client":
			other.Provider.ClientID = "another-client"
		case "credential":
			other.Provider.ClientSecret = "another-credential"
		case "scopes":
			other.Provider.ExtraScopes = []string{"email", "profile"}
		case "headers":
			other.Provider.RequestHeaders = map[string]string{"X-Fixture": "another-context"}
		case "request":
			other.AuthRequestExtraParams = map[string]string{"hd": "foreign.example.test", "access_type": "offline", "prompt": "consent"}
		case "username":
			other.Username = "another-person"
		}
		got, err := canonicalKey(other)
		if err != nil || reflect.DeepEqual(got, want) {
			t.Fatal("changed identity/request reused another cache identity")
		}
	}
}
