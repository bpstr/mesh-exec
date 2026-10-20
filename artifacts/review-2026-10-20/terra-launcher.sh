#!/bin/sh
# Existing ChatGPT-authenticated Codex launcher. No API credentials or proxy.
exec /Users/bpstr/.local/bin/codex "$@" \
  -c 'model_reasoning_effort="low"' \
  -c 'model_providers.openai.request_max_retries=0' \
  -c 'model_providers.openai.stream_max_retries=0'
