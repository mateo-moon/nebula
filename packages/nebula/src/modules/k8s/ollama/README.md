# Ollama server

`Ollama` creates a model-cache PVC, one Deployment and a ClusterIP Service in that order. `OllamaConfig` requires the namespace, workload name, image, claim name, storage class, storage size, port and container resource requests/limits. It exposes `serviceUrl` for consumers. Preserve the existing claim name, storage class and storage size when adopting an existing deployment.

The server mounts the claim at `/root/.ollama`. It does not pull a model, add a GPU request, add a backup policy or expose an external endpoint. Model loading remains caller-managed.

`declareOllamaModelConfig(scope, id, { namespace, name, model, host, annotations? })` references an existing endpoint from a Kagent `ModelConfig`, without API-key fields. Its default Argo sync wave is `KAGENT_WAVE.DEPENDENCY`; callers may supply explicit annotations. The helper does not install Kagent or start a model-loading job.
