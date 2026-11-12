package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"

	"github.com/int128/kubelogin/pkg/oidc"
	"github.com/int128/kubelogin/pkg/tokencache"
	"github.com/int128/kubelogin/pkg/tokencache/repository"
)

// Upstream v1.36.4 gob-encodes map fields when hashing its cache key. Map order
// can change between identical invocations. Canonicalize the complete key first;
// keep the upstream lock, token storage and keyring implementation unchanged.
type canonicalRepository struct{ base repository.Interface }

func canonicalKey(key tokencache.Key) (tokencache.Key, error) {
	data, err := json.Marshal(key) // encoding/json sorts map keys.
	if err != nil {
		return tokencache.Key{}, err
	}
	defer clear(data)
	digest := sha256.Sum256(data)
	return tokencache.Key{Username: "nebula-client-v1:" + hex.EncodeToString(digest[:])}, nil
}

func (r canonicalRepository) FindByKey(config tokencache.Config, key tokencache.Key) (*oidc.TokenSet, error) {
	key, err := canonicalKey(key)
	if err != nil {
		return nil, err
	}
	return r.base.FindByKey(config, key)
}

func (r canonicalRepository) Save(config tokencache.Config, key tokencache.Key, tokens oidc.TokenSet) error {
	key, err := canonicalKey(key)
	if err != nil {
		return err
	}
	return r.base.Save(config, key, tokens)
}

func (r canonicalRepository) Lock(config tokencache.Config, key tokencache.Key) (io.Closer, error) {
	key, err := canonicalKey(key)
	if err != nil {
		return nil, err
	}
	return r.base.Lock(config, key)
}

func (r canonicalRepository) DeleteAll(config tokencache.Config) error {
	return r.base.DeleteAll(config)
}
