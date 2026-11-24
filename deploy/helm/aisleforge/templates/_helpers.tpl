{{- define "af.name" -}}{{ .Release.Name }}{{- end -}}
{{- define "af.labels" -}}
app.kubernetes.io/part-of: aisleforge
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
{{- define "af.image" -}}{{ .root.Values.image.registry }}/{{ .component }}:{{ required "image.tag is required (immutable tag)" .root.Values.image.tag }}{{- end -}}
{{/* Numeric ids are required: with runAsNonRoot the kubelet cannot verify a NAMED image user ("USER node") and
     refuses to start the container (found in the first kind deployment). */}}
{{- define "af.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ .uid | default 1000 }}
runAsGroup: {{ .uid | default 1000 }}
seccompProfile: { type: RuntimeDefault }
{{- end -}}
{{- define "af.containerSecurity" -}}
allowPrivilegeEscalation: false
capabilities: { drop: [ALL] }
{{- end -}}
{{/* Schema migrations (+ optional demo seed) before the app container starts. Idempotent and advisory-locked, so
     concurrent replicas are safe; retries until the database is reachable. */}}
{{- define "af.migrateInit" -}}
{{- if .root.Values.migrations.enabled }}
initContainers:
  - name: migrate
    image: {{ include "af.image" (dict "root" .root "component" .component) }}
    imagePullPolicy: {{ .root.Values.image.pullPolicy }}
    command: ["node", "init-db.mjs"]
    env:
      - name: DATABASE_URL
        valueFrom: { secretKeyRef: { name: {{ .root.Values.secrets.existingSecret }}, key: DATABASE_URL } }
      {{- if .root.Values.migrations.seed }}
      - name: SEED_PASSWORD
        valueFrom: { secretKeyRef: { name: {{ .root.Values.secrets.existingSecret }}, key: SEED_PASSWORD } }
      {{- end }}
    securityContext: {{- include "af.containerSecurity" . | nindent 6 }}
    resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 192Mi } }
{{- end }}
{{- end -}}
