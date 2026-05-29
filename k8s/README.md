# Kubernetes manifests — Scraper System

These manifests mirror the `docker-compose.yml` stack at the repo root and deploy
the 4-module scraper into a Kubernetes cluster. Everything runs in the `scraper`
namespace.

| Service | Kind | Image | Ports | Notes |
|---|---|---|---|---|
| `kafka` | StatefulSet + 2 Services | `apache/kafka:3.7.0` | 9092 (client), 9093 (controller) | KRaft mode (no ZooKeeper), 5Gi PVC |
| `kafka-init` | Job | `apache/kafka:3.7.0` | — | Creates topics, then exits |
| `postgres` | StatefulSet + Service | `postgres:16-alpine` | 5432 | 5Gi PVC, creds from Secret |
| `parser` | Deployment + Service | `scraper-parser` | 8080 | Gunicorn/Flask `/parse`, `/health` |
| `scraper-worker` | Deployment + Service + HPA | `scraper-scraper-worker` | 9090 (metrics) | Modules 1+3, 2–6 replicas |
| `dedup-worker` | Deployment + HPA | `scraper-dedup-worker` | — | Module 4, 2–6 replicas |

> The `sample-producer` from docker-compose is a local demo helper and is **not**
> translated here. Publish to the `scrape-requests` topic from your own producer.

## File layout (apply order)

Files are numbered so a plain `kubectl apply -f k8s/` applies them in dependency
order:

```
00-namespace.yaml        Namespace: scraper
10-secrets.yaml          Secret: scraper-secrets (PLACEHOLDERS — replace!)
20-configmaps.yaml       ConfigMaps: kafka / parser / scraper-worker / dedup-worker
30-kafka.yaml            Kafka StatefulSet + headless + ClusterIP Services
31-kafka-init-job.yaml   Job that creates the Kafka topics
40-postgres.yaml         Postgres StatefulSet + Service
50-parser.yaml           Parser Deployment + Service
60-scraper-worker.yaml   Scraper-worker Deployment + metrics Service
70-dedup-worker.yaml     Dedup-worker Deployment
80-hpa.yaml              HPAs for scraper-worker and dedup-worker
```

## Prerequisites

- A Kubernetes cluster. Local options: [kind](https://kind.sigs.k8s.io/) or
  [minikube](https://minikube.sigs.k8s.io/).
- `kubectl` configured to talk to it.
- A default StorageClass (the Kafka and Postgres PVCs use the cluster default).
  kind and minikube ship one out of the box.
- For the HPAs to actually scale: `metrics-server` installed. On minikube:
  `minikube addons enable metrics-server`. On kind, install the metrics-server
  manifest and patch it with `--kubelet-insecure-tls`.

## 1. Build and load the images

The manifests use the image names produced by `docker compose build`
(`scraper-parser`, `scraper-scraper-worker`, `scraper-dedup-worker`) with
`imagePullPolicy: IfNotPresent`, so a locally built/loaded image is used and the
cluster never tries a registry pull.

From the repo root:

```bash
docker compose build parser scraper-worker dedup-worker
```

Then load the images into your local cluster:

```bash
# kind
kind load docker-image scraper-parser scraper-scraper-worker scraper-dedup-worker

# minikube
minikube image load scraper-parser
minikube image load scraper-scraper-worker
minikube image load scraper-dedup-worker
```

> If you push the images to a registry instead, edit the `image:` fields in
> `50-parser.yaml`, `60-scraper-worker.yaml`, `70-dedup-worker.yaml` to the fully
> qualified names and change `imagePullPolicy` to `Always` (or add an
> `imagePullSecret`).

## 2. Create the namespace and the Secret

`10-secrets.yaml` contains **placeholders only**. Either edit that file before
applying, or (recommended) create the Secret imperatively so real credentials are
never committed:

```bash
kubectl apply -f k8s/00-namespace.yaml

kubectl -n scraper create secret generic scraper-secrets \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-YOUR_KEY_HERE' \
  --from-literal=POSTGRES_USER='scraper' \
  --from-literal=POSTGRES_PASSWORD='scraper' \
  --from-literal=POSTGRES_DB='scraper' \
  --from-literal=DEDUP_POSTGRES_DSN='postgresql://scraper:scraper@postgres:5432/scraper'
```

If you go the imperative route, skip `10-secrets.yaml` when applying (e.g.
`kubectl apply -f k8s/ ` will try to apply it too — that is fine, it just
overwrites with placeholders, so apply the imperative secret **after**, or delete
the file).

> Keep `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` consistent with the
> credentials embedded in `DEDUP_POSTGRES_DSN`.

## 3. Apply everything

```bash
kubectl apply -f k8s/
```

The numbered filenames give a sane order, but Kubernetes is eventually
consistent: the `scraper-worker` and `dedup-worker` pods will crash-loop briefly
until Kafka is ready and `kafka-init` has created the topics. That self-heals.

## 4. Verify

```bash
# Everything in the namespace
kubectl -n scraper get all

# Kafka should be Running and the init Job Completed
kubectl -n scraper get pods
kubectl -n scraper get job kafka-init
kubectl -n scraper logs job/kafka-init

# Confirm the topics exist
kubectl -n scraper exec kafka-0 -- \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list
# expect: parse-results, scrape-dlq, scrape-requests

# Parser health
kubectl -n scraper port-forward svc/parser 8080:8080 &
curl localhost:8080/health

# Scraper-worker metrics
kubectl -n scraper port-forward svc/scraper-worker 9090:9090 &
curl localhost:9090/metrics

# HPAs (need metrics-server)
kubectl -n scraper get hpa

# Postgres / dedup output
kubectl -n scraper exec -it postgres-0 -- \
  psql -U scraper -d scraper -c 'SELECT count(*) FROM job_postings;'
```

To feed the pipeline, produce a JSON `ParseRequest` to the `scrape-requests`
topic (the worker reads from the beginning by default):

```bash
kubectl -n scraper exec -it kafka-0 -- \
  /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic scrape-requests
```

## 5. Tear down

```bash
# Remove all workloads but keep data (PVCs persist)
kubectl delete -f k8s/

# Nuke everything including persistent volumes
kubectl delete namespace scraper
```

> `kubectl delete -f k8s/` does **not** delete the PVCs created by the
> StatefulSet `volumeClaimTemplates`. Delete the namespace (or the PVCs directly:
> `kubectl -n scraper delete pvc --all`) to reclaim storage.

## Notes / differences from docker-compose

- **Hostnames**: Compose used the service name `kafka`; here clients use the
  `kafka` ClusterIP Service, while the broker's controller quorum + advertised
  listener use the StatefulSet pod's stable DNS
  (`kafka-0.kafka-headless.scraper.svc.cluster.local`).
- **kafka-init** is a Job (run-once) rather than a `restart: on-failure`
  container; it polls Kafka until reachable before creating topics.
- **Healthchecks** become readiness/liveness probes (parser `/health`,
  scraper-worker `/metrics`, postgres `pg_isready`, kafka `--list`).
- **Replicas / HPA**: `scraper-worker` and `dedup-worker` set no static replica
  count — the HPAs own it (min 2, max 6, target 70% CPU).
- **Secrets**: `ANTHROPIC_API_KEY` and the Postgres credentials/DSN live in the
  `scraper-secrets` Secret; everything else is in ConfigMaps.
