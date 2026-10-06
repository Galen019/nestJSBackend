# Kind Kubernetes Lab

## Prerequisites

- Docker Desktop running
- Kind installed
- kubectl installed

## 1. Create the Kind cluster
```
kind create cluster --name backend-lab
```

## 2. Verify 
```
kubectl cluster-info
kubectl get nodes
```

## 3. Build the application image

```
docker build -t productionbackend:local .
```

## 4. Load the image into Kind

```
kind load docker-image productionbackend:local --name backend-lab
```

Verify the image is available:
```
docker exec backend-lab-control-plane crictl images
```

## 5. Deploy Kubernetes resources

```
kubectl apply -f k8s/namespace.yaml
```
Then create the remaining resources:
```
kubectl apply -f k8s/
```

Check the deployment:
```
kubectl -n backend-lab get pods
kubectl -n backend-lab get services
```

## 6. Check application logs

```
kubectl -n backend-lab logs deployment/app --all-containers
```

## 7. Access the application
Forward the application Service to localhost:
```
kubectl -n backend-lab port-forward svc/app 3000:3000
```

The API is then available at:
```
http://localhost:3000
```

## 8. Access Jaeger
Forward the Jaeger UI:
```
kubectl -n backend-lab port-forward svc/jaeger 16686:16686
```
Open:
```
http://localhost:16686
```

## 9. Run the Redis probe
With the application available:
```
npx ts-node scripts/test-redis.ts
```

## 10. Inspect Kubernetes resources

```
kubectl -n backend-lab get pods
kubectl -n backend-lab get deployments
kubectl -n backend-lab get services
kubectl -n backend-lab get configmaps
kubectl -n backend-lab get secrets
```

## 11. Clean up

```
kubectl delete namespace backend-lab
kind delete cluster --name backend-lab
```