"""Evaluate recorded discussion exchanges only; never calls a model."""
import collections
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
run = root / 'terra-run'
export = run / 'export'
events = [json.loads(line) for line in (export / 'events.jsonl').read_text().splitlines()]
runs = json.loads((export / 'runs.json').read_text())
tasks = json.loads((export / 'tasks.json').read_text())
messages = json.loads((export / 'messages.json').read_text())
coordination = json.loads((run / 'coordination.json').read_text())
receipts = [event for event in events if event['kind'] == 'codex.turn.completed']
usage = collections.Counter()
for event in receipts:
    usage.update(event['data']['event']['usage'])
tools = collections.Counter(event['kind'].removeprefix('tool.').removesuffix('.started')
                            for event in events if event['kind'].startswith('tool.') and event['kind'].endswith('.started'))
failed = [event for event in events if (event['kind'].startswith('tool.') and event['kind'].endswith('.failed')) or (event['kind'] == 'tool.mesh_send.completed' and event['data'].get('result', {}).get('state') == 'failed')]
raw_failures = []
native_commands = []
for path in (export / 'runs').glob('*/stdout.jsonl'):
    for line in path.read_text().splitlines():
        event = json.loads(line)
        item = event.get('item', {})
        if event.get('type') != 'item.completed':
            continue
        if item.get('type') in ('command_execution', 'file_change'):
            native_commands.append({'run': path.parent.name, 'item': item})
        if item.get('type') != 'mcp_tool_call':
            continue
        failed_item = bool(item.get('error')) or item.get('status') == 'failed'
        for content in (item.get('result') or {}).get('content', []):
            try:
                payload = json.loads(content.get('text', ''))
            except (ValueError, TypeError):
                continue
            if isinstance(payload, dict) and (payload.get('state') == 'failed' or (payload.get('error') and payload.get('code'))):
                failed_item = True
        if failed_item:
            raw_failures.append({'run': path.parent.name, 'itemId': item.get('id'), 'tool': item.get('tool')})
peers = {'A1', 'A2', 'A3'}
input_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (root / 'inputs').iterdir() if path.is_file()}
output_hashes = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (run / 'task-result').iterdir() if path.is_file()}
checks = {
    'three_normal_first_generation_handoffs': len(runs) == 3 and {r['agent_id'] for r in runs} == peers and all(r['state'] == 'exited' and r['generation'] == 1 and r['result']['outcome'] == 'idle' for r in runs),
    'one_request_sent_and_answered_per_peer': len(tasks) == 3 and all(t['state'] == 3 for t in tasks) and collections.Counter(t['sender_id'] for t in tasks) == {p: 1 for p in peers} and collections.Counter(t['recipient_id'] for t in tasks) == {p: 1 for p in peers},
    'six_deliveries_all_handled': len(messages) == 6 and all(m['handled_at'] is not None for m in messages),
    'one_checkpoint_per_peer': len(coordination['checkpoints']) == 3 and {c['agent_id'] for c in coordination['checkpoints']} == peers,
    'no_tool_failures': not failed and not raw_failures,
    'no_native_commands_or_edits': not native_commands,
    'efficiency_target_at_most_30_mesh_calls': sum(tools.values()) <= 30,
    'three_terminal_usage_receipts': len(receipts) == 3 and {e['agentId'] for e in receipts} == peers,
    'source_unchanged': input_hashes == output_hashes,
    'no_missing_export_artifacts': not json.loads((export / 'export.json').read_text())['missing'],
}
analysis = {'passed': all(checks.values()), 'checks': checks, 'toolCalls': dict(tools), 'totalToolCalls': sum(tools.values()), 'usage': dict(usage) if len(receipts) == 3 else None, 'partialUsage': dict(usage), 'receiptCount': len(receipts), 'failures': failed, 'rawToolFailures': raw_failures, 'nativeCommands': native_commands, 'sourceHashes': output_hashes, 'missionState': json.loads((run / 'runner-summary.json').read_text())['state'], 'scope': 'Communication exercise acceptance only; not implementation-mission acceptance.'}
if len(receipts) == 3:
    analysis['totalReportedTokens'] = usage['input_tokens'] + usage['output_tokens']
    analysis['uncachedInputTokens'] = usage['input_tokens'] - usage['cached_input_tokens']
(run / 'analysis.json').write_text(json.dumps(analysis, indent=2) + '\n')
print(json.dumps({'passed':analysis['passed'],'checks':checks,'totalToolCalls':sum(tools.values()),'totalReportedTokens':analysis.get('totalReportedTokens')}))
raise SystemExit(0 if analysis['passed'] else 1)
