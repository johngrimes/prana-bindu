# prana-bindu Helm chart

Deploys [prana-bindu](../../README.md), a single-user task manager. One Node process serves the web app, the REST API (`/api/v1`) and the MCP server (`/mcp`), and stores its data in SQLite.

## Features

- Single-pod Deployment with the `Recreate` strategy, because SQLite allows only one writer.
- Optional PersistentVolumeClaim for the database and filesystem attachments. It is kept when the release is uninstalled.
- Any `PRANA_*` setting through `config` (plain environment variables) or `secretConfig` (a Secret). Changing `secretConfig` restarts the pod.
- Startup, liveness and readiness probes on the public OpenAPI document.
- Optional daily CronJob that backs up the SQLite database to S3-compatible object storage.
- Runs as the image's non-root `node` user (UID/GID 1000) with all capabilities dropped.

## Prerequisites

- Kubernetes 1.23 or later.
- Helm 3.
- A prana-bindu image. Build it from the repository root with `docker build -t prana-bindu .` and push it to a registry your cluster can pull from.
- A storage class for persistence, if you enable it.
- For anything other than `http://localhost`, a TLS-terminating ingress or load balancer. Browsers only allow passkeys on `https://` origins or `http://localhost`.

## Installation

```bash
helm install prana-bindu ./helm/prana-bindu \
  --namespace prana-bindu --create-namespace \
  --set pranaBindu.image=registry.example.com/prana-bindu:0.1.0 \
  --set pranaBindu.persistence.enabled=true \
  --set pranaBindu.config.PRANA_ORIGIN=https://tasks.example.com
```

Then enroll the first passkey. Open the printed link within 15 minutes:

```bash
kubectl --namespace prana-bindu exec deployment/prana-bindu-deployment -- prana-bindu passkey enroll
```

The other CLI commands run the same way, for example `prana-bindu token create "My script"`.

The chart does not create an Ingress. Route all paths of your ingress (including `/mcp`, `/oauth` and `/.well-known`) to the Service `<release>-service` on port `80`, and set `PRANA_ORIGIN` to the public origin, because the WebAuthn RP ID is its hostname and MCP clients use it as the OAuth issuer.

## Configuration

| Parameter | Description | Default |
| --- | --- | --- |
| `pranaBindu.image` | Container image | `prana-bindu:latest` |
| `pranaBindu.imagePullPolicy` | Image pull policy | `Always` |
| `pranaBindu.imagePullSecrets` | Pull secrets for private registries, e.g. `[{name: regcred}]` | `[]` |
| `pranaBindu.resources` | Container resource requests and limits | `{}` |
| `pranaBindu.config` | Map of environment variables, e.g. `PRANA_ORIGIN`, `PRANA_TIMEZONE`, `PRANA_BLOB_DRIVER` | `{}` |
| `pranaBindu.secretConfig` | Map of environment variables stored in a Secret, e.g. `PRANA_S3_SECRET_ACCESS_KEY` | `{}` |
| `pranaBindu.persistence.enabled` | Mount a PersistentVolumeClaim at `/data`. When disabled, `/data` is an `emptyDir` and is lost when the pod is deleted | `false` |
| `pranaBindu.persistence.size` | Requested volume size | `1Gi` |
| `pranaBindu.persistence.storageClassName` | Storage class. Unset uses the cluster default | `~` |
| `pranaBindu.persistence.accessMode` | Volume access mode | `ReadWriteOnce` |
| `pranaBindu.backup.enabled` | Create a CronJob that backs up the database to S3-compatible storage. Requires `persistence.enabled` and the `PRANA_BACKUP_S3_*` variables in `config`/`secretConfig` | `false` |
| `pranaBindu.backup.schedule` | Cron schedule for backups | `0 3 * * *` |
| `pranaBindu.backup.timeZone` | IANA time zone for `schedule`. Unset uses the kube-controller-manager's zone (usually UTC) | `~` |
| `pranaBindu.backup.successfulJobsHistoryLimit` | Completed backup jobs to keep | `3` |
| `pranaBindu.backup.failedJobsHistoryLimit` | Failed backup jobs to keep | `3` |
| `pranaBindu.backup.resources` | Backup container resource requests and limits | `{}` |
| `pranaBindu.service.type` | Service type: `ClusterIP`, `NodePort` or `LoadBalancer` | `ClusterIP` |
| `pranaBindu.service.port` | Service port | `80` |
| `pranaBindu.podSecurityContext` | Pod security context | `{runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000}` |
| `pranaBindu.securityContext` | Container security context | `{allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}` |
| `pranaBindu.terminationGracePeriodSeconds` | Grace period on shutdown. The server exits within 10 seconds of `SIGTERM` | `30` |
| `pranaBindu.nodeSelector` | Node selector | `{}` |
| `pranaBindu.tolerations` | Tolerations | `[]` |
| `pranaBindu.affinity` | Affinity rules | `{}` |

See the [application README](../../README.md#configuration) for every `PRANA_*` variable. Leave `PRANA_DATA_DIR` (`/data`) and `PRANA_PORT` (`3000`) at the image defaults: the volume mount, container port and probes depend on them.

## Examples

### Local evaluation

With no `PRANA_ORIGIN`, passkeys are bound to `http://localhost:3000`, which works through a port-forward:

```bash
helm install prana-bindu ./helm/prana-bindu \
  --set pranaBindu.image=prana-bindu:latest \
  --set pranaBindu.imagePullPolicy=IfNotPresent
kubectl port-forward service/prana-bindu-service 3000:80
```

### Production with filesystem attachments

```yaml
pranaBindu:
  image: "registry.example.com/prana-bindu:0.1.0"
  imagePullPolicy: "IfNotPresent"
  config:
    PRANA_ORIGIN: "https://tasks.example.com"
    PRANA_TIMEZONE: "Europe/London"
  persistence:
    enabled: true
    size: "5Gi"
  resources:
    requests:
      memory: "128Mi"
      cpu: "100m"
    limits:
      memory: "512Mi"
```

### Attachments in S3-compatible object storage

The database still needs the volume. Only attachments move to the bucket.

```yaml
pranaBindu:
  image: "registry.example.com/prana-bindu:0.1.0"
  config:
    PRANA_ORIGIN: "https://tasks.example.com"
    PRANA_BLOB_DRIVER: "s3"
    PRANA_S3_ENDPOINT: "https://s3.example.com"
    PRANA_S3_REGION: "us-east-1"
    PRANA_S3_BUCKET: "prana-attachments"
  secretConfig:
    PRANA_S3_ACCESS_KEY_ID: "…"
    PRANA_S3_SECRET_ACCESS_KEY: "…"
  persistence:
    enabled: true
```

### Mail Drop

[Mail Drop](../../README.md#mail-drop) turns messages in a Fastmail mailbox into inbox items. It runs in the app pod and needs outbound HTTPS to `api.fastmail.com` and `www.fastmailusercontent.com` (attachment downloads). Put the token in `secretConfig`:

```yaml
pranaBindu:
  config:
    PRANA_MAIL_DROP_MAILBOX: "Mail Drop"
  secretConfig:
    PRANA_MAIL_DROP_FASTMAIL_TOKEN: "fmu1-…"
```

Check that it started with `kubectl --namespace prana-bindu logs deployment/prana-bindu-deployment | grep 'Mail Drop'`.

### Daily database backups

A CronJob runs `prana-bindu backup`, which uploads a gzipped snapshot of the database to `<bucket>/<PRANA_BACKUP_PREFIX>prana-<UTC timestamp>.db.gz` and then deletes backups older than `PRANA_BACKUP_RETENTION_DAYS` (default 30). The snapshot is taken with SQLite's `VACUUM INTO` over a read-only connection, so it is consistent while the app keeps running. The job pod mounts the same volume, so it is scheduled onto the node running the app pod.

Attachments are not included. With the default `fs` blob driver they stay on the volume under `/data/blobs`.

```yaml
pranaBindu:
  persistence:
    enabled: true
  backup:
    enabled: true
    schedule: "0 3 * * *"
    timeZone: "Europe/London"
  config:
    PRANA_BACKUP_S3_ENDPOINT: "https://s3.example.com"
    PRANA_BACKUP_S3_REGION: "us-east-1"
    PRANA_BACKUP_S3_BUCKET: "prana-backups"
  secretConfig:
    PRANA_BACKUP_S3_ACCESS_KEY_ID: "…"
    PRANA_BACKUP_S3_SECRET_ACCESS_KEY: "…"
```

Run a backup now, outside the schedule:

```bash
kubectl --namespace prana-bindu create job --from=cronjob/prana-bindu-backup prana-bindu-backup-manual
kubectl --namespace prana-bindu logs --follow job/prana-bindu-backup-manual
```

#### Restoring a backup

Download and decompress a backup with any S3 client, for example `prana-20261031T030000Z.db.gz` into `prana.db`. Then stop the app, replace the database (removing its WAL files) through a temporary pod that mounts the volume, and start the app again:

```bash
NAMESPACE=prana-bindu RELEASE=prana-bindu
kubectl -n $NAMESPACE scale deployment/$RELEASE-deployment --replicas=0
kubectl -n $NAMESPACE wait --for=delete pod -l app.kubernetes.io/name=prana-bindu,app.kubernetes.io/instance=$RELEASE --timeout=120s
kubectl -n $NAMESPACE apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $RELEASE-restore
spec:
  securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000}
  containers:
    - name: restore
      image: busybox:1.37
      command: ["sleep", "3600"]
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
      volumeMounts: [{name: data, mountPath: /data}]
  volumes:
    - name: data
      persistentVolumeClaim: {claimName: $RELEASE-pvc}
EOF
kubectl -n $NAMESPACE wait --for=condition=Ready pod/$RELEASE-restore --timeout=120s
kubectl -n $NAMESPACE exec $RELEASE-restore -- rm -f /data/prana.db-wal /data/prana.db-shm
kubectl -n $NAMESPACE cp prana.db $RELEASE-restore:/data/prana.db
kubectl -n $NAMESPACE delete pod $RELEASE-restore
kubectl -n $NAMESPACE scale deployment/$RELEASE-deployment --replicas=1
```

## Upgrading

```bash
helm upgrade prana-bindu ./helm/prana-bindu --namespace prana-bindu --reuse-values
```

Database migrations run when the new pod starts. Because of the `Recreate` strategy, the old pod stops first, so expect a short outage.

Enabling persistence on an existing release starts with an empty database. Copy the data across first if you need it (for example `kubectl cp <pod>:/data/prana.db ./prana.db`).

## Uninstalling

```bash
helm uninstall prana-bindu --namespace prana-bindu
```

The PersistentVolumeClaim has the `helm.sh/resource-policy: keep` annotation, so the database survives. A later install with the same release name reuses it. To delete the data as well:

```bash
kubectl --namespace prana-bindu delete pvc prana-bindu-pvc
```
