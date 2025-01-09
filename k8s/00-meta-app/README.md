[DEPRECATED] - use CDKTF instead
# Installation
```bash
export env=""     # sepcify the gcp domain
helm dependency update
helm template -f values-${env}.yaml 00-meta-app ./ | kubectl apply -f '-' -n argo-cd
```
