#!/bin/sh
# Existing ChatGPT login; a distinct provider name permits zero retry settings.
# Config verified with `codex debug prompt-input` before any model execution.
exec /Users/bpstr/.local/bin/codex "$@" \
  -c 'model_reasoning_effort="low"' \
  -c 'model_provider="mesh-pilot"' \
  -c 'model_providers.mesh-pilot={name="Mesh pilot",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0}'
