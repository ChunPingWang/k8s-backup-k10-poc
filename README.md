# Kasten K10 Backup & Restore PoC on Kind

A hands-on Proof of Concept for **Kasten K10** (by Veeam), a Kubernetes-native data management platform. This PoC runs entirely on a local **Kind** cluster with **MinIO** as the S3-compatible object store.

## What is Kasten K10?

Kasten K10 is an enterprise-grade backup and disaster recovery platform purpose-built for Kubernetes. Unlike traditional backup tools, K10 understands Kubernetes-native concepts — namespaces, Deployments, StatefulSets, PVCs, ConfigMaps, Secrets — and backs them up as cohesive "applications."

**Key capabilities:**
- **Application Auto-Discovery** — automatically detects all workloads in your cluster
- **Policy-Based Backup** — scheduled or on-demand, with GFS (Grandfather-Father-Son) retention
- **Application-Aware Backup** — Kanister Blueprints enable database-consistent snapshots (e.g., `mysqldump` before snapshot)
- **Granular Restore** — restore entire namespaces, or pick individual resources (ConfigMaps, Secrets, PVCs)
- **Transform on Restore** — modify StorageClass, replica count, or annotations during recovery
- **Export & Cross-Cluster DR** — export backups to S3/MinIO and import into a different cluster
- **Web Dashboard** — full GUI for managing policies, monitoring compliance, and running restores
- **RBAC & Multi-Tenancy** — control who can backup/restore which applications

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Ubuntu x86 Host                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                Kind Cluster (k8s)                      │  │
│  │                                                        │  │
│  │  ┌────────────┐  ┌──────────┐  ┌────────────────────┐ │  │
│  │  │ kasten-io  │  │ demo-app │  │  minio namespace   │ │  │
│  │  │ namespace  │  │ namespace│  │                    │ │  │
│  │  │            │  │          │  │  • S3 Object Store │ │  │
│  │  │ • Gateway  │  │ • Nginx  │  │  • Console UI     │ │  │
│  │  │ • Catalog  │  │ • PVC    │  │                    │ │  │
│  │  │ • Auth     │  │          │  └────────────────────┘ │  │
│  │  │ • Executor │  └──────────┘                         │  │
│  │  │ • Kanister │  ┌──────────┐  ┌────────────────────┐ │  │
│  │  │ • Dashboard│  │ demo-db  │  │  CSI Hostpath      │ │  │
│  │  └────────────┘  │ namespace│  │  Driver + Snapshot  │ │  │
│  │                  │ • MySQL  │  │  Controller         │ │  │
│  │                  │ • PVC    │  └────────────────────┘ │  │
│  │                  └──────────┘                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Browser → http://localhost:8080/k10/#/  (K10 Dashboard)    │
└──────────────────────────────────────────────────────────────┘
```

## Prerequisites

| Tool | Minimum | Recommended |
|------|---------|-------------|
| OS | Ubuntu 22.04+ x86_64 | Ubuntu 24.04 LTS |
| CPU | 4 cores | 8 cores |
| RAM | 12 GB | 16 GB |
| Disk | 50 GB | 100 GB SSD |
| Docker | 24.0+ | 27.x+ |
| kubectl | 1.28+ | 1.30+ |
| Helm | 3.12+ | 3.16+ |
| Kind | 0.22+ | 0.24+ |

> K10 runs 17+ pods, so 12 GB RAM is the practical minimum.

## Quick Start

The full step-by-step guide is in [`kasten-k10-poc-kind-ubuntu.md`](kasten-k10-poc-kind-ubuntu.md). Here's the summary:

### 1. Create the Kind Cluster

```bash
kind create cluster --config kind-k10-config.yaml --wait 300s
```

### 2. Install VolumeSnapshot Support

```bash
# CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# Snapshot Controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml

# CSI Hostpath Driver
git clone https://github.com/kubernetes-csi/csi-driver-host-path.git
cd csi-driver-host-path && ./deploy/kubernetes-latest/deploy.sh && cd ..
```

### 3. Deploy MinIO (S3 Backend)

```bash
kubectl apply -f minio-deployment.yaml
```

### 4. Install Kasten K10

```bash
helm repo add kasten https://charts.kasten.io/ && helm repo update
kubectl create namespace kasten-io
helm install k10 kasten/k10 \
  --namespace kasten-io \
  --set auth.tokenAuth.enabled=true \
  --set injectKanisterSidecar.enabled=true \
  --set gateway.service.type=NodePort \
  --set gateway.service.nodePort=30080 \
  --wait --timeout=600s
```

### 5. Deploy Demo Applications

```bash
kubectl apply -f demo-nginx-k10.yaml
kubectl apply -f demo-mysql-k10.yaml
```

### 6. Configure K10

```bash
kubectl apply -f k10-location-profile.yaml   # MinIO location profile
kubectl apply -f mysql-blueprint.yaml         # Kanister blueprint for MySQL
kubectl apply -f snapshot-policy-ondemand.yaml
kubectl apply -f scheduled-policy.yaml
kubectl apply -f multi-app-policy.yaml
kubectl apply -f transform-set.yaml
kubectl apply -f k10-rbac.yaml
```

### 7. Access the Dashboard

```bash
TOKEN=$(kubectl create token gateway -n kasten-io --duration=24h)
echo "URL: http://localhost:8080/k10/#/"
echo "Token: $TOKEN"
```

Open `http://localhost:8080/k10/#/` in your browser and paste the token to log in.

## Project Files

| File | Purpose |
|------|---------|
| `kind-k10-config.yaml` | Kind cluster config (1 control-plane + 2 workers, port mappings) |
| `minio-deployment.yaml` | MinIO S3-compatible object store deployment |
| `demo-nginx-k10.yaml` | Nginx demo app with PVC, ConfigMap, Secret |
| `demo-mysql-k10.yaml` | MySQL StatefulSet demo with persistent storage |
| `k10-location-profile.yaml` | K10 Location Profile pointing to MinIO |
| `mysql-blueprint.yaml` | Kanister Blueprint for application-aware MySQL backup |
| `snapshot-policy-ondemand.yaml` | On-demand snapshot policy |
| `scheduled-policy.yaml` | Hourly backup with export and GFS retention |
| `multi-app-policy.yaml` | Label-based multi-application backup policy |
| `transform-set.yaml` | Restore-time transformation rules (scale down, change StorageClass) |
| `k10-rbac.yaml` | RBAC rules for multi-tenant access control |
| `kasten-k10-poc-kind-ubuntu.md` | Complete PoC guide with 14 test cases |

## Key Concepts

### Policies
A Policy defines **what** to back up, **when**, and **where**. Policies can be scheduled (`@hourly`, `@daily`) or on-demand (`@onDemand`). Each policy includes actions like `backup` and `export`.

### Location Profiles
A Profile tells K10 where to store backup data externally. This PoC uses an S3-compatible MinIO endpoint. In production, this could be AWS S3, Azure Blob, GCS, or NFS.

### Restore Points
Every successful backup creates a Restore Point — a point-in-time snapshot of an entire application (all its K8s resources + volume data). You restore from these.

### Kanister Blueprints
Blueprints define application-specific backup/restore logic. For example, the MySQL blueprint runs `mysqldump` before taking a volume snapshot, ensuring database consistency.

### TransformSets
Rules applied during restore to modify resources — e.g., change StorageClass from `premium-ssd` to `standard`, or scale replicas from 3 to 1 for a DR environment.

## PoC Test Cases

| # | Test Case | Method |
|---|-----------|--------|
| 1 | Application Auto-Discovery | Dashboard: Applications page |
| 2 | On-Demand Snapshot | CLI: RunAction CRD or Dashboard |
| 3 | Scheduled Backup (Hourly + Export) | Policy with `@hourly` frequency |
| 4 | Multi-Application Policy | Label selector: `k10/backup=enabled` |
| 5 | CSI VolumeSnapshot | Verify `kubectl get volumesnapshots -A` |
| 6 | Export to S3 (MinIO) | Check MinIO bucket contents |
| 7 | Full Application Restore | Delete namespace, restore from Dashboard |
| 8 | Granular Restore | Restore selected resources only |
| 9 | Transform during Restore | Apply TransformSet to change config |
| 10 | Kanister Blueprint (MySQL) | Application-aware backup with mysqldump |
| 11 | Cross-Cluster DR | Export + Import between two Kind clusters |
| 12 | RBAC & Multi-Tenancy | ServiceAccount-scoped access |
| 13 | Compliance Reporting | Dashboard compliance dashboard |
| 14 | License Management | Dashboard: Settings > Licenses |

## Velero vs Kasten K10

| Feature | Velero | Kasten K10 |
|---------|--------|------------|
| **License** | Apache 2.0 (fully open source) | Starter free / Enterprise paid |
| **Web UI** | None (CLI only) | Full Dashboard |
| **App-Aware Backup** | Manual hooks | Kanister Blueprint framework |
| **Auto-Discovery** | No | Yes |
| **Transform on Restore** | No | Yes |
| **Compliance Reports** | No | Built-in |
| **Retention Policy** | TTL only | GFS (Grandfather-Father-Son) |
| **Resource Usage** | Light (2-3 pods) | Heavy (17+ pods) |
| **Best For** | DevOps teams, lightweight needs | Enterprise, compliance-driven orgs |

## Cleanup

```bash
# Remove K10
helm uninstall k10 -n kasten-io
kubectl delete namespace kasten-io

# Remove demo apps
kubectl delete namespace demo-app demo-db minio

# Delete Kind cluster
kind delete cluster --name k10-poc
```

## License

This PoC uses Kasten K10 **Starter Edition** which is free and functionally identical to Enterprise, with a node limit (5 nodes after 30 days). See [Kasten Docs](https://docs.kasten.io/) for details.
