"""Read retained evidence only. No inference, provider transport, or grading."""
import collections
import datetime
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent


def summarize(run):
    export = run / "export"
    load = lambda name: json.loads((export / f"{name}.json").read_text())
    events = [json.loads(line) for line in (export / "events.jsonl").read_text().splitlines()]
    runs, tasks, messages, operations = [load(name) for name in ["runs", "tasks", "messages", "operations"]]
    receipts = [e for e in events if e["kind"] == "codex.turn.completed"]
    usage = collections.Counter()
    for event in receipts:
        usage.update(event["data"]["event"]["usage"])
    calls = collections.Counter(e["kind"][5:-8] for e in events
                                if e["kind"].startswith("tool.") and e["kind"].endswith(".started"))
    failures = []
    for e in events:
        if not e["kind"].startswith("tool."):
            continue
        result = e["data"].get("result") or {}
        if e["kind"].endswith(".failed") or (isinstance(result, dict) and result.get("state") == "failed"):
            failures.append({"seq": e["seq"], "agent": e["agentId"], "kind": e["kind"], "data": e["data"]})
    raw_failures, native = [], []
    raw_calls = collections.Counter()
    for path in (export / "runs").glob("*/stdout.jsonl"):
        for line in path.read_text().splitlines():
            e = json.loads(line)
            item = e.get("item", {})
            if e.get("type") != "item.completed":
                continue
            if item.get("type") in ["command_execution", "file_change"]:
                native.append({"run": path.parent.name, "item": item})
            if item.get("type") != "mcp_tool_call":
                continue
            raw_calls[item["tool"]] += 1
            bad = bool(item.get("error")) or item.get("status") == "failed"
            for content in (item.get("result") or {}).get("content", []):
                try:
                    payload = json.loads(content.get("text", ""))
                except (ValueError, TypeError):
                    continue
                if isinstance(payload, dict) and (payload.get("state") == "failed" or (payload.get("error") and payload.get("code"))):
                    bad = True
            if bad:
                raw_failures.append({"run": path.parent.name, "item": item.get("id"), "tool": item.get("tool")})
    parse = lambda value: datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    elapsed = (max(parse(r["ended_at"]) for r in runs if r["ended_at"]) -
               min(parse(r["started_at"]) for r in runs)).total_seconds()
    per_agent = []
    for r in runs:
        per_agent.append({
            "agent": r["agent_id"], "state": r["state"], "generation": r["generation"],
            "reason": r["reason"], "handoff": r["result"],
            "elapsedSeconds": (parse(r["ended_at"]) - parse(r["started_at"])).total_seconds(),
            "toolCalls": sum(e["agentId"] == r["agent_id"] and e["kind"].startswith("tool.") and e["kind"].endswith(".started") for e in events),
            "patches": [o["request"].get("changes") for o in operations if o["agent_id"] == r["agent_id"] and o["kind"] == "patch"],
        })
    total = usage["input_tokens"] + usage["output_tokens"]
    return {
        "missionState": json.loads((run / "runner-summary.json").read_text())["state"],
        "elapsedSeconds": elapsed, "launches": len(runs), "runStates": dict(collections.Counter(r["state"] for r in runs)),
        "totalToolCalls": sum(calls.values()), "toolCalls": dict(calls),
        "tasks": len(tasks), "taskStates": dict(collections.Counter(t["state"] for t in tasks)),
        "deliveries": len(messages), "unhandledDeliveries": sum(m["handled_at"] is None for m in messages),
        "operations": [{"agent": o["agent_id"], "kind": o["kind"], "state": o["state"], "request": o["request"], "error": o["error"], "result": o["result"]} for o in operations],
        "failures": failures, "rawToolFailures": raw_failures, "nativeCommandsOrEdits": native,
        "rawToolAttempts": sum(raw_calls.values()), "rawToolCalls": dict(raw_calls),
        "usageReceiptCount": len(receipts), "usageComplete": len(receipts) == len(runs),
        "reportedUsage": dict(usage), "reportedTotalTokens": total,
        "uncachedInputTokens": usage["input_tokens"] - usage["cached_input_tokens"],
        "missingExports": load("export")["missing"], "agents": per_agent,
    }


current = summarize(root / "terra-run")
baseline = summarize(root.parent / "review-2026-10-20/live-run")
inputs = root / "inputs"
result = root / "terra-run/task-result"
current["inputsUnchanged"] = all((result / p.name).exists() and (result / p.name).read_bytes() == p.read_bytes() for p in inputs.iterdir())
current["resultFiles"] = {str(p.relative_to(result)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(result.rglob("*")) if p.is_file()}
analysis = {"current": current, "baseline": baseline, "caveat": "Different instructions and application revisions; not a controlled causal benchmark. Incomplete usage receipts prohibit comparing aggregate token consumption."}
(root / "analysis.json").write_text(json.dumps(analysis, indent=2) + "\n")
keys = ["missionState", "elapsedSeconds", "launches", "totalToolCalls", "tasks", "deliveries", "unhandledDeliveries", "usageReceiptCount", "usageComplete", "reportedTotalTokens"]
print(json.dumps({name: {k: value[k] for k in keys} for name, value in [("current", current), ("baseline", baseline)]}))
