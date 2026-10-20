"""Read recorded pilot evidence only. No providers or model calls."""
import collections
import datetime
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
run = root / 'sol-run'
export = run / 'export'
events = [json.loads(line) for line in (export / 'events.jsonl').read_text().splitlines()]
runs = json.loads((export / 'runs.json').read_text())
messages = json.loads((export / 'messages.json').read_text())
tasks = json.loads((export / 'tasks.json').read_text())
grant = json.loads((run / 'authorization-consumed.json').read_text())
end = (run / 'finished-at.txt').read_text().strip()
receipts = [event for event in events if event['kind'] == 'codex.turn.completed']
counts = collections.Counter(event['kind'].removeprefix('tool.').removesuffix('.started')
                             for event in events if event['kind'].startswith('tool.') and event['kind'].endswith('.started'))
failures = [{key: event[key] for key in ('seq', 'at', 'agentId', 'kind', 'data')}
            for event in events if event['kind'].startswith('tool.') and event['kind'].endswith('.failed')]
patches = [event for event in events if event['kind'] == 'workspace.operation.applied']
analysis = {
    'missionId': grant.get('missionId', json.loads((run / 'runner-summary.json').read_text())['missionId']),
    'model': grant['model'],
    'startedAt': grant['startedAt'], 'finishedAt': end,
    'elapsedSeconds': (datetime.datetime.fromisoformat(end.replace('Z', '+00:00')) - datetime.datetime.fromisoformat(grant['startedAt'].replace('Z', '+00:00'))).total_seconds(),
    'runs': [{key: item[key] for key in ('agent_id', 'generation', 'state', 'started_at', 'ended_at', 'reason')} for item in runs],
    'toolCalls': dict(counts), 'totalToolCalls': sum(counts.values()),
    'failures': failures, 'appliedPatches': len(patches),
    'messageDeliveries': len(messages), 'unhandledDeliveries': sum(item['handled_at'] is None for item in messages),
    'tasks': len(tasks), 'taskStates': dict(collections.Counter(item['state'] for item in tasks)),
    'usageReceipts': len(receipts),
    'tokenUsage': None if not receipts else [event['data']['event']['usage'] for event in receipts],
    'usageCaveat': 'All workers were aborted at the tool ceiling before terminal usage receipts. Unknown is not zero; no token reduction or cost claim is supported.',
    'exportMissing': json.loads((export / 'export.json').read_text())['missing'],
    'sourceHashes': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted((run / 'task-result').iterdir()) if path.is_file()},
}
(run / 'analysis.json').write_text(json.dumps(analysis, indent=2) + '\n')
print(json.dumps({key: analysis[key] for key in ('elapsedSeconds', 'totalToolCalls', 'appliedPatches', 'messageDeliveries', 'unhandledDeliveries', 'tasks', 'usageReceipts')}))
