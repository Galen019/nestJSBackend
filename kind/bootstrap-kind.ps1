$ErrorActionPreference = "Stop"

$clusters = kind get clusters
if ($LASTEXITCODE -ne 0) { throw "kind get clusters failed ($LASTEXITCODE)" }

if ($clusters -contains 'backend-lab') {
    Write-Host "kind cluster 'backend-lab' already exists; skipping creation."
} else {
    kind create cluster --name backend-lab --config 'kind\kind-config.yaml'
    if ($LASTEXITCODE -ne 0) { throw "kind create cluster failed ($LASTEXITCODE)" }
}

# Select the intended cluster explicitly
kubectl config use-context kind-backend-lab
if ($LASTEXITCODE -ne 0) { throw "kubectl context selection failed ($LASTEXITCODE)" }

# Install Envoy Gateway
helm upgrade --install eg `
    oci://docker.io/envoyproxy/gateway-helm `
    --version v1.9.2 `
    --namespace envoy-gateway-system `
    --create-namespace `
    --wait `
    --timeout 5m

if ($LASTEXITCODE -ne 0) { throw "Envoy Gateway Helm install failed ($LASTEXITCODE)" }

# Wait for Envoy Gateway controller
kubectl rollout status deployment/envoy-gateway `
    -n envoy-gateway-system `
    --timeout=300s

if ($LASTEXITCODE -ne 0) { throw "Envoy Gateway rollout failed ($LASTEXITCODE)" }

# Install Argo CD
helm repo add argo https://argoproj.github.io/argo-helm
if ($LASTEXITCODE -ne 0) { throw "helm repo add failed ($LASTEXITCODE)" }

helm repo update
if ($LASTEXITCODE -ne 0) { throw "helm repo update failed ($LASTEXITCODE)" }

helm upgrade --install argocd argo/argo-cd `
    --namespace argocd `
    --create-namespace `
    --wait

if ($LASTEXITCODE -ne 0) { throw "Argo CD Helm install failed ($LASTEXITCODE)" }

# Build and load the application image
docker build -t productionbackend:local .
if ($LASTEXITCODE -ne 0) { throw "docker build failed ($LASTEXITCODE)" }

kind load docker-image productionbackend:local --name backend-lab
if ($LASTEXITCODE -ne 0) { throw "kind load docker-image failed ($LASTEXITCODE)" }

# Create/update the Argo CD Application
kubectl apply -n argocd -f 'k8s\argocd\application.yaml'
if ($LASTEXITCODE -ne 0) { throw "kubectl apply failed ($LASTEXITCODE)" }
