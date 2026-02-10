# Kasten K10 PoC — Ubuntu x86 Kind Cluster

> **版本**：Kasten K10 v7.0.x (Starter Edition) ｜ Kind v0.24.x ｜ MinIO (S3-Compatible)
> **目標**：在本機 Ubuntu x86 上透過 Kind 叢集，完整驗證 Kasten K10 所有備份復原功能

---

## 1. PoC 架構總覽

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
│  │  │ • Catalog  │  │ • MySQL  │  │                    │ │  │
│  │  │ • Auth     │  │ • PVC    │  └────────────────────┘ │  │
│  │  │ • Executor │  │ • CRD    │                         │  │
│  │  │ • Kanister │  │          │  ┌────────────────────┐ │  │
│  │  │ • Dashboard│  └──────────┘  │  CSI Hostpath      │ │  │
│  │  └────────────┘                │  Driver + Snapshot  │ │  │
│  │                                │  Controller         │ │  │
│  │                                └────────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Browser → http://localhost:8080/k10/#/  (K10 Dashboard)    │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 環境需求

| 項目 | 最低需求 | 建議配置 |
|------|---------|---------|
| OS | Ubuntu 22.04+ x86_64 | Ubuntu 24.04 LTS |
| CPU | 4 cores | 8 cores |
| RAM | 12 GB | 16 GB |
| Disk | 50 GB | 100 GB SSD |
| Docker | 24.0+ | 27.x |
| kubectl | 1.28+ | 1.30+ |
| Helm | 3.12+ | 3.16+ |
| Kind | 0.22+ | 0.24+ |

> **注意**：K10 比 Velero 消耗更多資源，建議至少 12 GB RAM

---

## 3. 基礎環境安裝

### 3.1 安裝 Docker

```bash
sudo apt-get remove docker docker-engine docker.io containerd runc
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) \
  signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

### 3.2 安裝 kubectl、Kind、Helm

```bash
# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Kind
[ $(uname -m) = x86_64 ] && \
  curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.24.0/kind-linux-amd64
chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind

# Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

---

## 4. 建立 Kind Cluster（含 VolumeSnapshot 支援）

### 4.1 Kind 叢集配置

```yaml
# kind-k10-config.yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: k10-poc
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 30080
        hostPort: 8080
        protocol: TCP
      - containerPort: 30000
        hostPort: 9001
        protocol: TCP
      - containerPort: 30001
        hostPort: 9000
        protocol: TCP
  - role: worker
  - role: worker
```

### 4.2 建立叢集

```bash
kind create cluster --config kind-k10-config.yaml --wait 300s
kubectl cluster-info --context kind-k10-poc
kubectl get nodes
```

### 4.3 安裝 VolumeSnapshot CRDs 與 Snapshot Controller

```bash
# 安裝 VolumeSnapshot CRDs
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml

# 安裝 Snapshot Controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml

# 驗證
kubectl get crd | grep volumesnapshot
kubectl get pods -n kube-system | grep snapshot
```

### 4.4 安裝 CSI Hostpath Driver

```bash
# 部署 CSI Hostpath Driver（支援 VolumeSnapshot）
git clone https://github.com/kubernetes-csi/csi-driver-host-path.git
cd csi-driver-host-path
./deploy/kubernetes-latest/deploy.sh

# 建立 StorageClass
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: csi-hostpath-sc
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: hostpath.csi.k8s.io
reclaimPolicy: Delete
volumeBindingMode: Immediate
allowVolumeExpansion: true
EOF

# 建立 VolumeSnapshotClass
kubectl apply -f - <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-hostpath-snapclass
  annotations:
    k10.kasten.io/is-snapshot-class: "true"
driver: hostpath.csi.k8s.io
deletionPolicy: Delete
EOF

cd ..
```

---

## 5. 部署 MinIO（Location Profile 用）

```yaml
# minio-deployment.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: minio
---
apiVersion: v1
kind: Secret
metadata:
  name: minio-credentials
  namespace: minio
type: Opaque
stringData:
  MINIO_ROOT_USER: "minioadmin"
  MINIO_ROOT_PASSWORD: "minioadmin123"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
  namespace: minio
spec:
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    metadata:
      labels:
        app: minio
    spec:
      containers:
        - name: minio
          image: minio/minio:latest
          command: ["minio", "server", "/data", "--console-address", ":9001"]
          envFrom:
            - secretRef:
                name: minio-credentials
          ports:
            - containerPort: 9000
              name: api
            - containerPort: 9001
              name: console
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: minio
  namespace: minio
spec:
  type: NodePort
  selector:
    app: minio
  ports:
    - name: api
      port: 9000
      targetPort: 9000
      nodePort: 30001
    - name: console
      port: 9001
      targetPort: 9001
      nodePort: 30000
```

```bash
kubectl apply -f minio-deployment.yaml
kubectl wait --for=condition=ready pod -l app=minio -n minio --timeout=120s

# 建立 bucket
curl -LO https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x mc && sudo mv mc /usr/local/bin/

kubectl port-forward svc/minio -n minio 9000:9000 &
sleep 3
mc alias set myminio http://localhost:9000 minioadmin minioadmin123
mc mb myminio/k10-backup
mc mb myminio/k10-export
mc ls myminio
kill %1
```

---

## 6. 安裝 Kasten K10

### 6.1 執行 Pre-Flight Check

```bash
curl https://docs.kasten.io/tools/k10_primer.sh | bash
```

**預期結果**：所有檢查項目皆 PASS

### 6.2 透過 Helm 安裝 K10

```bash
# 新增 Kasten Helm repo
helm repo add kasten https://charts.kasten.io/
helm repo update

# 建立 namespace
kubectl create namespace kasten-io

# 安裝 K10（Starter Edition，免費）
helm install k10 kasten/k10 \
  --namespace kasten-io \
  --set auth.tokenAuth.enabled=true \
  --set injectKanisterSidecar.enabled=true \
  --set gateway.service.type=NodePort \
  --set gateway.service.nodePort=30080 \
  --wait --timeout=600s
```

### 6.3 驗證安裝

```bash
# 等待所有 Pod 就緒
kubectl get pods -n kasten-io --watch

# 確認所有 Pod 為 Running 狀態
kubectl get pods -n kasten-io -o wide

# 預期會有 10+ 個 Pod
```

### 6.4 取得 Dashboard Token

```bash
# 取得 token 以登入 Dashboard
SA_SECRET=$(kubectl get serviceaccount k10-k10 -o jsonpath="{.secrets[0].name}" -n kasten-io 2>/dev/null)

# 如果上面沒結果（K8s 1.24+），建立 token
TOKEN=$(kubectl create token k10-k10 -n kasten-io --duration=24h)
echo "K10 Dashboard Token:"
echo $TOKEN
```

### 6.5 存取 Dashboard

```bash
# 方法 1: NodePort（已在 Helm 安裝時設定）
echo "Dashboard URL: http://localhost:8080/k10/#/"

# 方法 2: Port-Forward（備用）
kubectl --namespace kasten-io port-forward service/gateway 8080:8000 &
echo "Dashboard URL: http://localhost:8080/k10/#/"
```

在瀏覽器開啟 `http://localhost:8080/k10/#/`，貼上 Token 登入。

---

## 7. 部署示範應用程式

### 7.1 Nginx Stateful 應用

```yaml
# demo-nginx-k10.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: demo-app
  labels:
    app: demo
    k10/backup: "enabled"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nginx-data
  namespace: demo-app
spec:
  storageClassName: csi-hostpath-sc
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
  namespace: demo-app
  labels:
    app: nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
          ports:
            - containerPort: 80
          volumeMounts:
            - name: data
              mountPath: /usr/share/nginx/html
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: nginx-data
---
apiVersion: v1
kind: Service
metadata:
  name: nginx-svc
  namespace: demo-app
spec:
  selector:
    app: nginx
  ports:
    - port: 80
      targetPort: 80
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: demo-app
data:
  APP_ENV: "production"
  LOG_LEVEL: "info"
---
apiVersion: v1
kind: Secret
metadata:
  name: app-secret
  namespace: demo-app
type: Opaque
stringData:
  DB_PASSWORD: "k10-s3cret"
  API_KEY: "k10-poc-key-12345"
```

### 7.2 MySQL StatefulSet（含 Kanister Blueprint 支援）

```yaml
# demo-mysql-k10.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: demo-db
  labels:
    app: database
    k10/backup: "enabled"
---
apiVersion: v1
kind: Secret
metadata:
  name: mysql-secret
  namespace: demo-db
stringData:
  MYSQL_ROOT_PASSWORD: "rootpass123"
  MYSQL_DATABASE: "pocdb"
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: demo-db
  labels:
    app: mysql
spec:
  serviceName: mysql
  replicas: 1
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
        - name: mysql
          image: mysql:8.0
          envFrom:
            - secretRef:
                name: mysql-secret
          ports:
            - containerPort: 3306
          volumeMounts:
            - name: mysql-data
              mountPath: /var/lib/mysql
  volumeClaimTemplates:
    - metadata:
        name: mysql-data
      spec:
        storageClassName: csi-hostpath-sc
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 2Gi
---
apiVersion: v1
kind: Service
metadata:
  name: mysql
  namespace: demo-db
spec:
  clusterIP: None
  selector:
    app: mysql
  ports:
    - port: 3306
```

### 7.3 部署與寫入測試資料

```bash
kubectl apply -f demo-nginx-k10.yaml
kubectl apply -f demo-mysql-k10.yaml

kubectl wait --for=condition=ready pod -l app=nginx -n demo-app --timeout=120s
kubectl wait --for=condition=ready pod -l app=mysql -n demo-db --timeout=180s

# 寫入 Nginx 測試內容
kubectl exec -n demo-app deploy/nginx -- \
  sh -c 'echo "<h1>K10 PoC - $(date)</h1>" > /usr/share/nginx/html/index.html'

# 寫入 MySQL 測試資料
kubectl exec -n demo-db sts/mysql -- \
  mysql -u root -prootpass123 -e \
  "USE pocdb; CREATE TABLE IF NOT EXISTS k10_data (id INT AUTO_INCREMENT PRIMARY KEY, msg VARCHAR(255), ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP); INSERT INTO k10_data (msg) VALUES ('K10 PoC initial data'), ('Application-aware backup test');"
```

---

## 8. 設定 Location Profile

### 8.1 透過 Dashboard 設定（推薦）

1. 開啟 K10 Dashboard → **Settings** → **Locations** → **New Profile**
2. 填入：
   - **Profile Name**: `minio-s3`
   - **Storage Provider**: S3 Compatible
   - **S3 Access Key**: `minioadmin`
   - **S3 Secret**: `minioadmin123`
   - **Endpoint**: `http://minio.minio.svc:9000`
   - **Bucket**: `k10-backup`
   - **Region**: 留空或填 `us-east-1`
   - **Skip SSL Verification**: ✅ 勾選
3. 按 **Save Profile**

### 8.2 透過 YAML 設定（CLI 方式）

```yaml
# k10-location-profile.yaml
apiVersion: v1
kind: Secret
metadata:
  name: k10-s3-secret
  namespace: kasten-io
type: secrets.kanister.io/aws
data:
  aws_access_key_id: bWluaW9hZG1pbg==        # base64 of minioadmin
  aws_secret_access_key: bWluaW9hZG1pbjEyMw==  # base64 of minioadmin123
---
apiVersion: config.kio.kasten.io/v1alpha1
kind: Profile
metadata:
  name: minio-s3
  namespace: kasten-io
spec:
  type: Location
  locationSpec:
    credential:
      secretType: AwsAccessKey
      secret:
        apiVersion: v1
        kind: Secret
        name: k10-s3-secret
        namespace: kasten-io
    type: ObjectStore
    objectStore:
      name: k10-backup
      objectStoreType: S3
      region: us-east-1
      endpoint: http://minio.minio.svc:9000
      skipSSLVerify: true
      pathType: ""
```

```bash
kubectl apply -f k10-location-profile.yaml
kubectl get profiles -n kasten-io
```

---

## 9. PoC 測試案例

### 測試案例 1：Application Discovery（自動應用發現）

**透過 Dashboard**：
1. 開啟 K10 Dashboard → **Applications**
2. K10 會自動掃描並顯示所有 namespace 中的應用

**透過 CLI**：
```bash
# K10 自動偵測的應用
kubectl get apps -n kasten-io
```

**預期結果**：可看到 `demo-app`、`demo-db`、`minio` 等 namespace 被自動識別

---

### 測試案例 2：On-Demand Snapshot（手動快照）

**透過 Dashboard**：
1. **Applications** → 選擇 `demo-app` → **Snapshot**
2. 選擇 Snapshot 類型，點擊 **Run**

**透過 CLI（K10 Policy CRD）**：

```yaml
# snapshot-policy-ondemand.yaml
apiVersion: config.kio.kasten.io/v1alpha1
kind: Policy
metadata:
  name: demo-app-snapshot
  namespace: kasten-io
spec:
  comment: "On-demand snapshot for demo-app"
  frequency: "@onDemand"
  actions:
    - action: backup
      backupParameters:
        profile:
          name: minio-s3
          namespace: kasten-io
  selector:
    matchExpressions:
      - key: k8s.io/metadata.name
        operator: In
        values:
          - demo-app
```

```bash
kubectl apply -f snapshot-policy-ondemand.yaml

# 手動觸發
cat <<EOF | kubectl create -f -
apiVersion: actions.kio.kasten.io/v1alpha1
kind: RunAction
metadata:
  generateName: run-demo-app-snapshot-
  namespace: kasten-io
spec:
  subject:
    kind: Policy
    name: demo-app-snapshot
    namespace: kasten-io
EOF

# 查看執行結果
kubectl get runactions -n kasten-io
```

---

### 測試案例 3：Scheduled Backup Policy（排程備份策略）

**透過 Dashboard**：
1. **Policies** → **Create New Policy**
2. 設定：
   - Name: `hourly-backup-demo`
   - Action: Snapshot
   - Frequency: Hourly
   - Select Application: `demo-app`
   - Enable Exports: ✅ 選擇 `minio-s3` Profile
   - Retention: 24 hourly, 7 daily

**透過 CLI**：

```yaml
# scheduled-policy.yaml
apiVersion: config.kio.kasten.io/v1alpha1
kind: Policy
metadata:
  name: hourly-backup-demo
  namespace: kasten-io
spec:
  comment: "Hourly backup with export to MinIO"
  frequency: "@hourly"
  retention:
    hourly: 24
    daily: 7
    weekly: 4
    monthly: 12
    yearly: 5
  actions:
    - action: backup
      backupParameters:
        profile:
          name: minio-s3
          namespace: kasten-io
    - action: export
      exportParameters:
        frequency: "@hourly"
        profile:
          name: minio-s3
          namespace: kasten-io
        exportData:
          enabled: true
  selector:
    matchExpressions:
      - key: k8s.io/metadata.name
        operator: In
        values:
          - demo-app
```

```bash
kubectl apply -f scheduled-policy.yaml
kubectl get policies -n kasten-io
```

---

### 測試案例 4：Multi-Application Policy

```yaml
# multi-app-policy.yaml
apiVersion: config.kio.kasten.io/v1alpha1
kind: Policy
metadata:
  name: multi-app-backup
  namespace: kasten-io
spec:
  comment: "Backup multiple applications"
  frequency: "@daily"
  retention:
    daily: 7
    weekly: 4
  actions:
    - action: backup
      backupParameters:
        profile:
          name: minio-s3
          namespace: kasten-io
  selector:
    matchExpressions:
      - key: k10/backup
        operator: In
        values:
          - "enabled"
```

```bash
kubectl apply -f multi-app-policy.yaml
```

**預期結果**：`demo-app` 和 `demo-db` 皆被納入（因都有 `k10/backup=enabled` label）

---

### 測試案例 5：CSI VolumeSnapshot 備份

```bash
# 確認 VolumeSnapshotClass 已標註
kubectl get volumesnapshotclass -o yaml | grep k10.kasten.io

# 建立備份並確認使用 CSI Snapshot
# 透過 Dashboard: Applications → demo-db → Snapshot
# 或觸發 Policy

# 驗證 VolumeSnapshot 被建立
kubectl get volumesnapshots -A
kubectl get volumesnapshotcontents -A
```

---

### 測試案例 6：Export to External Storage（匯出至外部儲存）

**透過 Dashboard**：
1. **Applications** → `demo-app` → 選擇已有的 Restore Point
2. 選擇 **Export** → 選擇 Location Profile → **Run Export**

**透過 Policy（自動 Export）**：

已在測試案例 3 的 Policy 中包含 export action。

```bash
# 驗證 export 資料已到 MinIO
kubectl port-forward svc/minio -n minio 9000:9000 &
sleep 2
mc ls myminio/k10-backup --recursive | head -20
kill %1
```

---

### 測試案例 7：Application Restore（應用復原）

```bash
# Step 1: 記錄目前資料
kubectl exec -n demo-app deploy/nginx -- cat /usr/share/nginx/html/index.html

# Step 2: 模擬災難
kubectl delete namespace demo-app

# Step 3: 確認已刪除
kubectl get ns demo-app 2>&1 | grep -i "not found"

# Step 4: 透過 Dashboard 復原
# Dashboard → Applications → Removed → demo-app → Restore → 選擇 Restore Point → Restore
```

**透過 CLI**：

```yaml
# restore-action.yaml
apiVersion: actions.kio.kasten.io/v1alpha1
kind: RestoreAction
metadata:
  generateName: restore-demo-app-
  namespace: kasten-io
spec:
  subject:
    kind: RestorePoint
    name: <restore-point-name>  # 從 kubectl get restorepoints -n kasten-io 取得
    namespace: kasten-io
  targetNamespace: demo-app
```

```bash
# 列出可用的 RestorePoint
kubectl get restorepoints -n kasten-io

# 建立復原動作
kubectl apply -f restore-action.yaml

# 驗證
kubectl get pods -n demo-app
kubectl exec -n demo-app deploy/nginx -- cat /usr/share/nginx/html/index.html
```

---

### 測試案例 8：Granular Restore（細粒度復原）

**透過 Dashboard**：
1. 選擇 Restore Point → **Restore**
2. 展開 **Advanced Options**
3. 選擇性勾選要復原的資源：
   - ✅ ConfigMaps
   - ✅ Secrets
   - ☐ Deployments（跳過）
4. 執行復原

---

### 測試案例 9：Transform during Restore（復原時轉換）

**透過 Dashboard**：
1. 選擇 Restore Point → **Restore**
2. 勾選 **Apply Transform**
3. 新增 Transform 規則：
   - 變更 StorageClass
   - 修改 Replica 數量
   - 修改 Annotation

**透過 CLI（TransformSet）**：

```yaml
# transform-set.yaml
apiVersion: config.kio.kasten.io/v1alpha1
kind: TransformSet
metadata:
  name: scale-down-transform
  namespace: kasten-io
spec:
  comment: "Scale down replicas during restore"
  transforms:
    - subject:
        resource: deployments
      name: reduce-replicas
      json:
        - op: replace
          path: /spec/replicas
          value: 1
    - subject:
        resource: persistentvolumeclaims
      name: change-storageclass
      json:
        - op: replace
          path: /spec/storageClassName
          value: csi-hostpath-sc
```

```bash
kubectl apply -f transform-set.yaml
```

---

### 測試案例 10：Kanister Blueprint（應用感知備份）

```yaml
# mysql-blueprint.yaml
apiVersion: cr.kanister.io/v1alpha1
kind: Blueprint
metadata:
  name: mysql-blueprint
  namespace: kasten-io
spec:
  actions:
    backup:
      outputArtifacts:
        mysqlDump:
          keyValue:
            dumpFile: "{{ .Phases.dumpDatabase.Output.dumpFile }}"
      phases:
        - func: KubeExec
          name: dumpDatabase
          objects:
            mysqlSecret:
              kind: Secret
              name: mysql-secret
              namespace: "{{ .StatefulSet.Namespace }}"
          args:
            namespace: "{{ .StatefulSet.Namespace }}"
            pod: "{{ index .StatefulSet.Pods 0 }}"
            container: mysql
            command:
              - bash
              - -o
              - errexit
              - -c
              - |
                DUMP_FILE="/tmp/pocdb-dump-$(date +%Y%m%d%H%M%S).sql"
                mysqldump -u root -p${MYSQL_ROOT_PASSWORD} pocdb > ${DUMP_FILE}
                echo "Database dump created: ${DUMP_FILE}"
                kando output dumpFile ${DUMP_FILE}
    restore:
      inputArtifacts:
        mysqlDump:
          keyValue:
            dumpFile: "{{ .ArtifactsIn.mysqlDump.KeyValue.dumpFile }}"
      phases:
        - func: KubeExec
          name: restoreDatabase
          objects:
            mysqlSecret:
              kind: Secret
              name: mysql-secret
              namespace: "{{ .StatefulSet.Namespace }}"
          args:
            namespace: "{{ .StatefulSet.Namespace }}"
            pod: "{{ index .StatefulSet.Pods 0 }}"
            container: mysql
            command:
              - bash
              - -o
              - errexit
              - -c
              - |
                mysql -u root -p${MYSQL_ROOT_PASSWORD} pocdb < {{ .ArtifactsIn.mysqlDump.KeyValue.dumpFile }}
                echo "Database restored successfully"
    delete:
      phases:
        - func: KubeExec
          name: cleanDump
          args:
            namespace: "{{ .StatefulSet.Namespace }}"
            pod: "{{ index .StatefulSet.Pods 0 }}"
            container: mysql
            command:
              - bash
              - -c
              - "rm -f /tmp/pocdb-dump-*.sql"
```

```bash
kubectl apply -f mysql-blueprint.yaml

# 為 MySQL StatefulSet 標註使用此 Blueprint
kubectl annotate statefulset mysql -n demo-db \
  kanister.kasten.io/blueprint=mysql-blueprint \
  --overwrite
```

---

### 測試案例 11：Disaster Recovery — Cross-Cluster Restore

```bash
# Step 1: 確保已有 Export 到 MinIO 的 Restore Point

# Step 2: 建立第二個 Kind Cluster
kind create cluster --name k10-target --wait 300s

# Step 3: 在目標叢集安裝 K10 + CSI Driver + VolumeSnapshot

# Step 4: 設定相同的 Location Profile（指向同一個 MinIO）

# Step 5: Dashboard → Policies → 建立 Import Policy
#   - Source Location: minio-s3
#   - 選擇要匯入的 Application

# Step 6: 從匯入的 Restore Point 執行復原
```

---

### 測試案例 12：RBAC 與 Multi-Tenancy

```yaml
# k10-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: k10-basic-user
rules:
  - apiGroups: ["apps.kio.kasten.io"]
    resources: ["applications"]
    verbs: ["get", "list"]
  - apiGroups: ["apps.kio.kasten.io"]
    resources: ["restorepoints"]
    verbs: ["get", "list", "create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: k10-team-a-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: k10-basic-user
subjects:
  - kind: ServiceAccount
    name: team-a-sa
    namespace: demo-app
```

```bash
kubectl apply -f k10-rbac.yaml
```

---

### 測試案例 13：Compliance & Reporting

**透過 Dashboard**：
1. **Dashboard** → 首頁即顯示：
   - 已保護的應用百分比
   - 備份成功/失敗統計
   - SLA 合規狀態
2. **Activity** → 查看所有備份/復原活動紀錄

```bash
# 透過 K10 API 查看合規狀態
kubectl get policies -n kasten-io -o jsonpath='{range .items[*]}{.metadata.name}: {.status.validation}{"\n"}{end}'
```

---

### 測試案例 14：License 管理

```bash
# 查看目前 License 狀態
# Dashboard → Settings → Licenses

# Starter Edition 限制：
# - 前 30 天：最多 50 Worker Nodes
# - 30 天後：最多 5 Worker Nodes
# - 功能與 Enterprise 完全相同

# 查看節點使用狀況
kubectl get nodes --no-headers | wc -l
```

---

## 10. K10 Dashboard 功能導覽

| Dashboard 頁面 | 功能 | 對應測試案例 |
|---------------|------|-------------|
| **Dashboard** | 全局保護狀態、合規報告 | 案例 13 |
| **Applications** | 自動應用發現、手動 Snapshot/Restore | 案例 1, 2, 7 |
| **Policies** | 建立/管理備份排程策略 | 案例 3, 4 |
| **Activity** | 備份/復原執行紀錄 | 全部案例 |
| **Settings > Locations** | 管理 Location Profile | 案例 6 |
| **Settings > Licenses** | License 狀態與節點使用 | 案例 14 |
| **Settings > Transforms** | 管理 Transform 規則 | 案例 9 |

---

## 11. 監控與除錯

### 11.1 K10 Pod 狀態

```bash
kubectl get pods -n kasten-io
kubectl describe pod <pod-name> -n kasten-io
```

### 11.2 查看 K10 Log

```bash
# Gateway (API / Dashboard)
kubectl logs -n kasten-io -l component=gateway -f

# Catalog
kubectl logs -n kasten-io -l component=catalog -f

# Executor (備份執行器)
kubectl logs -n kasten-io -l component=executor -f
```

### 11.3 常見問題排查

| 問題 | 排查方式 | 解決方案 |
|------|---------|---------|
| Dashboard 無法存取 | `kubectl get svc -n kasten-io` | 確認 NodePort / port-forward |
| Snapshot 失敗 | Dashboard → Activity → 查看錯誤 | 確認 VolumeSnapshotClass annotation |
| Export 失敗 | K10 logs + MinIO 連線 | 確認 Location Profile 設定 |
| CSI Driver 問題 | `kubectl get csidriver` | 重新部署 CSI Hostpath Driver |
| License 過期 | Dashboard → Settings → Licenses | 更新至最新版本 |

---

## 12. 清理環境

```bash
# 刪除 K10
helm uninstall k10 -n kasten-io
kubectl delete namespace kasten-io

# 刪除應用
kubectl delete namespace demo-app demo-db minio

# 刪除 Kind Cluster
kind delete cluster --name k10-poc
kind delete cluster --name k10-target
```

---

## 13. 功能矩陣總覽

| # | 功能 | 測試案例 | 狀態 |
|---|------|---------|------|
| 1 | Application Auto-Discovery | 案例 1 | ☐ |
| 2 | On-Demand Snapshot | 案例 2 | ☐ |
| 3 | Scheduled Backup Policy | 案例 3 | ☐ |
| 4 | Multi-Application Policy | 案例 4 | ☐ |
| 5 | CSI VolumeSnapshot | 案例 5 | ☐ |
| 6 | Export to S3 (MinIO) | 案例 6 | ☐ |
| 7 | Application Restore (DR) | 案例 7 | ☐ |
| 8 | Granular Restore | 案例 8 | ☐ |
| 9 | Transform during Restore | 案例 9 | ☐ |
| 10 | Kanister Blueprint (App-Aware) | 案例 10 | ☐ |
| 11 | Cross-Cluster DR | 案例 11 | ☐ |
| 12 | RBAC / Multi-Tenancy | 案例 12 | ☐ |
| 13 | Compliance Reporting | 案例 13 | ☐ |
| 14 | License Management | 案例 14 | ☐ |
| 15 | Web Dashboard UI | 全部案例 | ☐ |
| 16 | Retention Policy (GFS) | 案例 3 | ☐ |

---

## 14. 企業評估要點

### 優勢

- **Web Dashboard**：完整的圖形化操作介面，降低學習門檻
- **Application-Aware**：透過 Kanister Blueprint 實現應用感知備份（資料庫一致性）
- **Auto-Discovery**：自動掃描叢集中所有應用，無需手動標記
- **Transform Engine**：復原時可動態修改配置（StorageClass、Replica 等）
- **Compliance Dashboard**：內建合規報告，顯示 SLA 達成狀態
- **GFS Retention**：內建 Grandfather-Father-Son 保留策略
- **Starter Edition 免費**：功能與 Enterprise 完全相同，僅限制節點數

### 限制

- **資源消耗較大**：K10 本身需要 10+ 個 Pod，至少 4 GB RAM
- **Starter Edition 限制**：30 天後最多 5 Worker Nodes
- **非完全開源**：核心程式碼為 Proprietary（Kanister 是開源的）
- **Helm 為主要安裝方式**：無 CLI-only 備份操作（需 Dashboard 或 CRD）
- **CSI Snapshot 依賴**：需要 CSI Driver 支援 VolumeSnapshot

### 金融業合規建議

- 內建 Compliance Dashboard 可直接呈現給稽核人員
- 支援 Encryption at Rest（搭配 S3 SSE）
- Kanister Blueprint 可為 Oracle/PostgreSQL 做 Application-Consistent Backup
- 建議取得 Enterprise License 以獲得 Veeam 原廠支援
- Transform 功能可實現 DR 時的跨環境復原（Dev → DR Site）

---

## 15. Velero vs Kasten K10 快速對照

| 比較項目 | Velero | Kasten K10 |
|---------|--------|-----------|
| **授權** | Apache 2.0 完全開源 | Starter 免費 / Enterprise 付費 |
| **Web UI** | 無（純 CLI） | 完整 Dashboard |
| **Application-Aware** | 需自行寫 Hook | Kanister Blueprint 框架 |
| **Auto-Discovery** | 無 | ✅ 自動掃描 |
| **Transform** | 無 | ✅ 復原時轉換 |
| **Compliance Report** | 無 | ✅ 內建 |
| **Retention Policy** | TTL only | GFS（祖父-父-子） |
| **資源消耗** | 輕量（2-3 Pod） | 較重（10+ Pod） |
| **CSI Snapshot** | 選用 | 核心依賴 |
| **社群支援** | GitHub Issues | Veeam 原廠（Enterprise） |
| **學習曲線** | 中等（CLI） | 低（GUI 為主） |
| **適合場景** | DevOps 團隊、輕量需求 | 企業級、合規需求 |

---

> **文件版本**：v1.0
> **建立日期**：2026-02-10
> **適用環境**：PoC / 非正式環境
