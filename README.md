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

## Kasten K10 的優勢

### 為什麼選擇 Kasten K10？

**1. 真正的 Kubernetes 原生架構**
K10 並非將傳統備份工具移植到 K8s，而是從零開始為 Kubernetes 設計。它透過 CRD（Custom Resource Definition）定義所有操作——Policy、Profile、Blueprint、TransformSet 都是 K8s 原生資源，可以用 `kubectl`、GitOps（ArgoCD/Flux）、或 Helm 管理。

**2. 應用感知備份（Application-Aware Backup）**
傳統備份只複製磁碟區塊，無法保證資料庫一致性。K10 透過 Kanister Blueprint 在快照前執行應用層操作（如 `mysqldump`、`pg_dump`、Oracle RMAN），確保備份的資料是交易一致（transactionally consistent）的。

**3. 完整的 Web Dashboard**
相比 Velero 純 CLI 操作，K10 提供企業級圖形化介面：
- 一鍵備份/還原，降低操作門檻
- 即時合規報告（SLA 達成率、保護覆蓋率）
- 活動紀錄追蹤所有備份/還原操作，便於稽核

**4. 智慧保留策略（GFS Retention）**
支援 Grandfather-Father-Son 保留策略，例如保留 24 個小時備份、7 個每日備份、4 個每週備份、12 個每月備份、5 個年度備份，滿足金融業與合規需求。

**5. 還原時動態轉換（Transform on Restore）**
災難復原時可自動調整配置：
- 變更 StorageClass（例如從 `premium-ssd` 切換到 `standard`）
- 調整 Replica 數量（正式環境 3 副本 → DR 環境 1 副本）
- 修改 Annotation 與 Label

**6. 跨叢集災難復原（Cross-Cluster DR）**
將備份匯出至 S3/MinIO 後，可在完全不同的叢集匯入並還原，實現真正的異地備援。

**7. Starter Edition 免費且功能完整**
Starter Edition 與 Enterprise Edition 功能完全相同，僅限制 Worker Node 數量（30 天後最多 5 個），適合 PoC 與小型環境。

### 適用場景

| 場景 | K10 如何解決 |
|------|-------------|
| 金融業合規稽核 | 合規 Dashboard + 活動紀錄 + GFS 保留策略 |
| 資料庫備份一致性 | Kanister Blueprint（MySQL、PostgreSQL、MongoDB、Oracle） |
| 多租戶環境 | RBAC 控制不同團隊的備份/還原權限 |
| 混合雲 DR | 匯出至 S3/Azure Blob/GCS，跨雲還原 |
| DevOps 自助服務 | 開發者透過 Dashboard 自行還原測試資料 |

---

## MinIO 的優勢

### 為什麼在 PoC 中使用 MinIO？

**1. S3 相容 API**
MinIO 完全相容 AWS S3 API，任何支援 S3 的工具（K10、Velero、Restic、Rclone）都能直接對接，無需修改程式碼。這意味著 PoC 中驗證的配置可以無縫切換到正式的 AWS S3、GCS 或 Azure Blob。

**2. 輕量且易部署**
單一二進位檔即可啟動，在 Kubernetes 中只需一個 Pod。非常適合本地測試與 PoC 環境，不需要雲端帳號或額外費用。

**3. 高效能物件儲存**
MinIO 專為高吞吐量設計，支援：
- 糾刪碼（Erasure Coding）保護資料完整性
- 物件鎖定（Object Locking）防止勒索軟體篡改備份
- 版本控制（Versioning）保留歷史版本

**4. 企業級功能**
- **加密**：支援 SSE-S3 與 SSE-KMS 靜態加密
- **複寫**：支援跨站點複寫（Site Replication）
- **監控**：內建 Prometheus metrics 與 Web Console
- **IAM**：細粒度存取控制策略

**5. 從 PoC 到正式環境的平滑過渡**
- PoC 階段：單節點 MinIO（`emptyDir`），快速驗證
- 測試環境：MinIO + PVC，持久化儲存
- 正式環境：MinIO 分散式叢集或直接切換至 AWS S3

### MinIO 在本 PoC 中的角色

```
K10 Backup Policy
    │
    ├─ Snapshot（CSI VolumeSnapshot）→ 本地快照
    │
    └─ Export → MinIO（S3 相容）
                  │
                  ├── k10-backup/   ← 備份資料存放
                  └── k10-export/   ← 匯出資料存放（跨叢集 DR 用）
```

MinIO 在此 PoC 中扮演 **Location Profile** 的後端儲存，K10 將匯出的備份資料以 S3 協定寫入 MinIO bucket，供跨叢集還原或長期保留使用。

---

## K10 技術架構深入解析

### 元件架構

K10 由多個微服務組成，部署在 `kasten-io` namespace 中：

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kasten K10 元件架構                            │
│                                                                 │
│  ┌───────────┐    ┌──────────────┐    ┌───────────────────┐    │
│  │  Gateway   │───▶│ Dashboard BFF │───▶│  Frontend (React) │    │
│  │ (API 入口) │    │ (後端代理)    │    │  (Web UI)         │    │
│  └─────┬─────┘    └──────────────┘    └───────────────────┘    │
│        │                                                        │
│        ▼                                                        │
│  ┌───────────┐    ┌──────────────┐    ┌───────────────────┐    │
│  │   Auth     │    │   Catalog    │    │    State          │    │
│  │ (認證授權) │    │ (備份目錄)   │    │  (狀態管理)       │    │
│  └───────────┘    └──────┬───────┘    └───────────────────┘    │
│                          │                                      │
│        ┌─────────────────┼─────────────────┐                   │
│        ▼                 ▼                 ▼                   │
│  ┌───────────┐    ┌──────────────┐   ┌──────────────────┐     │
│  │ Executor   │    │  Kanister    │   │ Controller Mgr   │     │
│  │ (備份執行) │    │ (Blueprint   │   │ (Policy 排程/    │     │
│  │ ×3 副本    │    │  執行引擎)   │   │  生命週期管理)   │     │
│  └─────┬─────┘    └──────────────┘   └──────────────────┘     │
│        │                                                        │
│        ▼                                                        │
│  ┌───────────┐    ┌──────────────┐   ┌──────────────────┐     │
│  │  Crypto    │    │   Jobs       │   │  Logging /       │     │
│  │ (加密服務) │    │ (任務佇列)   │   │  Metering /      │     │
│  │            │    │              │   │  Prometheus       │     │
│  └───────────┘    └──────────────┘   └──────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### 各元件職責說明

| 元件 | Pod 名稱 | 職責 |
|------|---------|------|
| **Gateway** | `gateway` | API 入口與反向代理，處理所有外部請求，路由至對應的後端服務 |
| **Auth** | `auth-svc` | 負責 Token 驗證、RBAC 權限檢查、Multi-Tenancy 隔離 |
| **Catalog** | `catalog-svc` | 維護備份目錄（Restore Points、Artifacts 的 metadata），使用內嵌資料庫 |
| **Executor** | `executor-svc` (×3) | 實際執行備份/還原/匯出操作的工作引擎，多副本確保並行處理能力 |
| **Kanister** | `kanister-svc` | Blueprint 執行引擎，負責呼叫應用層的備份/還原邏輯（如 mysqldump） |
| **Controller Manager** | `controllermanager-svc` | 監聽 Policy CRD 變更，按排程觸發 RunAction，管理資源生命週期 |
| **Dashboard BFF** | `dashboardbff-svc` | Backend-for-Frontend 模式，為 React 前端提供聚合 API |
| **Frontend** | `frontend-svc` | React SPA，提供 Web Dashboard 介面 |
| **Crypto** | `crypto-svc` | 處理備份資料的加密/解密，管理加密金鑰 |
| **Jobs** | `jobs-svc` | 任務排隊與調度，追蹤長時間執行的備份/還原任務 |
| **State** | `state-svc` | 內部狀態管理，儲存 K10 運行時的配置與狀態資訊 |
| **Logging** | `logging-svc` | 集中式日誌收集，供 Dashboard Activity 頁面查詢 |
| **Metering** | `metering-svc` | 使用量計量（節點數、備份次數），用於 License 管理 |
| **Prometheus** | `prometheus-server` | 內建監控，收集 K10 各元件的 metrics |
| **Aggregated APIs** | `aggregatedapis-svc` | K8s API Aggregation Layer，讓 K10 的 CRD 可透過 K8s API 存取 |

### 備份流程（技術細節）

一個完整的備份流程如下：

```
使用者建立 Policy（或手動觸發 RunAction）
        │
        ▼
Controller Manager 偵測到 RunAction
        │
        ▼
Executor 開始執行備份任務
        │
        ├─ 1. 收集應用 metadata
        │     • 列舉 namespace 中所有 K8s 資源
        │     • Deployments, StatefulSets, Services, ConfigMaps, Secrets, PVCs...
        │     • 將 metadata 序列化為 JSON/YAML
        │
        ├─ 2. 執行 Kanister Blueprint（若有標註）
        │     • 檢查 StatefulSet/Deployment 是否有 kanister.kasten.io/blueprint annotation
        │     • 呼叫 Blueprint 中的 backup action
        │     • 例如：在 MySQL Pod 內執行 mysqldump
        │     • 將 dump 檔案的路徑記錄為 Output Artifact
        │
        ├─ 3. 建立 CSI VolumeSnapshot
        │     • 對每個 PVC 呼叫 CSI Snapshot API
        │     • CSI Driver 在儲存層建立 point-in-time snapshot
        │     • 等待 VolumeSnapshot 狀態變為 ReadyToUse
        │
        ├─ 4. 建立 Restore Point
        │     • 將 metadata + snapshot 參照 + artifact 打包為一個 Restore Point
        │     • 儲存在 Catalog 中
        │
        └─ 5. Export（若 Policy 包含 export action）
              • 將 VolumeSnapshot 的資料透過 CSI 讀取
              • 壓縮、加密（若啟用）
              • 上傳至 Location Profile 指定的 S3/MinIO 端點
              • 在目標 bucket 建立匯出 metadata
```

### CRD 資源模型

K10 使用多個 CRD 來管理備份生命週期：

```
config.kio.kasten.io/v1alpha1
├── Policy              ← 定義備份策略（頻率、保留、動作）
├── Profile             ← 定義儲存位置（S3 endpoint、credential）
├── TransformSet        ← 定義還原時的轉換規則
└── BlueprintBinding    ← 綁定 Blueprint 到特定 workload

cr.kanister.io/v1alpha1
└── Blueprint           ← 定義應用感知的備份/還原邏輯

actions.kio.kasten.io/v1alpha1
├── RunAction           ← 觸發 Policy 執行
├── BackupAction        ← 備份操作的執行紀錄
├── RestoreAction       ← 還原操作的執行紀錄
├── ExportAction        ← 匯出操作的執行紀錄
└── ImportAction        ← 匯入操作的執行紀錄

apps.kio.kasten.io/v1alpha1
├── Application         ← K10 自動發現的應用
└── RestorePoint        ← 備份產生的還原點
```

### CSI VolumeSnapshot 運作機制

K10 依賴 CSI（Container Storage Interface）進行 volume-level 快照：

```
K10 Executor
    │
    │ 建立 VolumeSnapshot CR
    ▼
VolumeSnapshot Controller（kube-system）
    │
    │ 呼叫 CSI Driver 的 CreateSnapshot gRPC
    ▼
CSI Hostpath Driver（本 PoC）/ 正式環境為 EBS CSI, Ceph CSI 等
    │
    │ 在儲存層建立 point-in-time snapshot
    ▼
VolumeSnapshotContent（叢集級資源）
    │
    └── 記錄 snapshot 的 handle（儲存層 ID）
        可用於建立新的 PVC（還原時使用）
```

在本 PoC 中使用的 `csi-hostpath-snapclass` 透過 annotation `k10.kasten.io/is-snapshot-class: "true"` 讓 K10 知道應該使用這個 VolumeSnapshotClass。

### Kanister Blueprint 執行機制

```
K10 Executor 偵測到 StatefulSet 有 Blueprint annotation
    │
    ▼
Kanister Service 載入 Blueprint YAML
    │
    ├── 解析 Go Template 變數
    │   • {{ .StatefulSet.Namespace }} → "demo-db"
    │   • {{ index .StatefulSet.Pods 0 }} → "mysql-0"
    │
    ├── 執行 Phase: dumpDatabase
    │   • func: KubeExec → 在 mysql-0 容器內執行 shell command
    │   • 執行 mysqldump，將結果寫入 /tmp/pocdb-dump-*.sql
    │   • kando output dumpFile → 將檔案路徑記錄為 Output Artifact
    │
    └── 記錄 Output Artifact
        • mysqlDump.keyValue.dumpFile = "/tmp/pocdb-dump-20260210.sql"
        • 此 artifact 會被還原階段的 inputArtifactNames 參照
```

### 安全性設計

| 層面 | 機制 |
|------|------|
| **認證** | Token-based Auth（ServiceAccount Token）或 OIDC（正式環境建議） |
| **授權** | K8s RBAC — ClusterRole/Role 控制對 K10 CRD 的存取權限 |
| **傳輸加密** | Gateway 支援 TLS（正式環境應啟用 Ingress + cert-manager） |
| **靜態加密** | 匯出至 S3 時支援 SSE-S3/SSE-KMS 加密 |
| **Secret 管理** | Location Profile 的 credential 儲存為 K8s Secret |
| **多租戶隔離** | 透過 namespace-scoped RBAC 限制使用者只能存取特定應用 |

---

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
