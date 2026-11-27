#!/usr/bin/env bash
set -euo pipefail

# Run a command and exit with the supplied message if it fails.
run() {
    local message=$1
    shift

    "$@" || {
        local status=$?
        echo "$message ($status)" >&2
        exit "$status"
    }
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
kind_config="$script_dir/kind-config.yaml"
argocd_application="$repo_root/k8s/argocd/application.yaml"

if clusters="$(kind get clusters)"; then
    :
else
    status=$?
    echo "kind get clusters failed ($status)" >&2
    exit "$status"
fi

if grep -Fxq 'backend-lab' <<<"$clusters"; then
    echo "kind cluster 'backend-lab' already exists; skipping creation."
else
    run 'kind create cluster failed' kind create cluster --name backend-lab --config "$kind_config"
fi

# Select the intended cluster explicitly.
run 'kubectl context selection failed' kubectl config use-context kind-backend-lab

# Install Envoy Gateway.
run 'Envoy Gateway Helm install failed' helm upgrade --install eg \
    oci://docker.io/envoyproxy/gateway-helm \
    --version v1.9.2 \
    --namespace envoy-gateway-system \
    --create-namespace \
    --wait \
    --timeout 5m

# Wait for Envoy Gateway controller.
run 'Envoy Gateway rollout failed' kubectl rollout status deployment/envoy-gateway \
    -n envoy-gateway-system \
    --timeout=300s

# Install Argo CD.
run 'helm repo add failed' helm repo add argo https://argoproj.github.io/argo-helm
run 'helm repo update failed' helm repo update
run 'Argo CD Helm install failed' helm upgrade --install argocd argo/argo-cd \
    --namespace argocd \
    --create-namespace \
    --set configs.params.server\.insecure=true \
    --wait

# Build and load the application image.
run 'docker build failed' docker build -t productionbackend:local "$repo_root"
run 'kind load docker-image failed' kind load docker-image productionbackend:local --name backend-lab

# The image tag does not change, so restart running pods to pick up the new build.
if kubectl -n backend-lab get deployment/app >/dev/null 2>&1; then
    run 'kubectl rollout restart failed' kubectl -n backend-lab rollout restart deployment/app
    run 'kubectl rollout status failed' kubectl -n backend-lab rollout status deployment/app --timeout=300s
fi

# Create or update the Argo CD Application.
run 'kubectl apply failed' kubectl apply -n argocd -f "$argocd_application"
