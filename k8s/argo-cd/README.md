# Installation
## Requirements
#### Vals
```bash
export VALS_VERSION="0.38.0"
wget https://github.com/variantdev/vals/releases/download/v${VALS_VERSION}/vals_${VALS_VERSION}_darwin_arm64.tar.gz
tar xvf vals_${VALS_VERSION}_darwin_arm64.tar.gz
chmod +x vals && mv vals /usr/local/bin
vals --help
```

[DEPRECATED] - use CDKTF instead
#### helm secrets plugin
```bash
export HELM_SECRETS_VERSION="v4.6.2"
helm plugin install https://github.com/jkroepke/helm-secrets --version ${HELM_SECRETS_VERSION}
```

## Install argo-cd helm chart
```bash
export ENV=""    # specify the env
export HELM_SECRETS_BACKEND=vals

kubectl create ns argo-cd
helm dependency update
helm template -n argo-cd argo-cd -f secrets://values.yaml -f secrets://values-${ENV}.yaml ./ | kubectl apply -n argo-cd -f -
```

## Post Install
#### deploy 00-meta-app Application Manually
```bash
export ENV=""    # specify the gcp domain
cat ./manual/00-meta-app.yaml | envsubst | kubectl apply -f '-' -n argo-cd
kubectl apply -n argo-cd -f ./manual/appprojects.yaml
```

#### Remove argo-cd's helm history and release info
```bash
kubectl get secrets -n argo-cd    # list the current secrets
kubectl delete secrets -n argo-cd `kubectl get secrets -n argo-cd | grep helm.release | awk '{print $1}'`
kubectl get secrets -n argo-cd    # confirm
```
