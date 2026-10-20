"""Offline inspection of preserved runs. Never invokes a provider."""
import collections
import json
import pathlib
import sys


def analyze(folder):
    folder = pathlib.Path(folder)
    export = folder / "export"
    runs = json.loads((export / "runs.json").read_text())
    messages = json.loads((export / "messages.json").read_text())
    tasks = json.loads((export / "tasks.json").read_text())
    tools = collections.defaultdict(lambda: {"calls": 0, "bytes": 0})
    peers = {}
    errors = []
    raw_bytes = compact_bytes = 0
    for run in runs:
        peer = {
            "state": run["state"],
            "receipts": [],
            "toolCalls": 0,
            "resultPresent": (export / "runs" / run["id"] / "result.json").exists(),
        }
        peers[run["agent_id"]] = peer
        for line in (export / "runs" / run["id"] / "stdout.jsonl").read_text().splitlines():
            event = json.loads(line)
            if event["type"] == "turn.completed":
                peer["receipts"].append(event.get("usage"))
            if event["type"] in ("error", "turn.failed"):
                errors.append({"agent": run["agent_id"], "provider": event})
            item = event.get("item", {})
            if event["type"] != "item.completed" or item.get("type") != "mcp_tool_call":
                continue
            name = item["tool"]
            tools[name]["calls"] += 1
            tools[name]["bytes"] += len(json.dumps(item.get("result")).encode())
            peer["toolCalls"] += 1
            if item.get("status") == "failed" or (item.get("result") or {}).get("isError"):
                errors.append({"agent": run["agent_id"], "tool": name, "error": item.get("error"),
                               "result": item.get("result")})
            if name != "mesh_board" or not item.get("result"):
                continue
            try:
                board = json.loads(item["result"]["content"][0]["text"])
            except (ValueError, KeyError, IndexError):
                continue
            if "requirements" not in board:
                continue
            raw_bytes += len(json.dumps(board, separators=(",", ":")).encode())
            for requirement in board["requirements"]:
                if "evidence" in requirement:
                    requirement["evidenceCount"] = len(requirement.pop("evidence"))
                requirement.pop("mission_id", None)
                requirement.pop("updated_at", None)
            for review in board.get("reviews", []):
                if review["verdict"] != "objection":
                    review.pop("reasoning", None)
            board["detail"] = "summary"
            compact_bytes += len(json.dumps(board, separators=(",", ":")).encode())
    receipts = [u for peer in peers.values() for u in peer["receipts"] if isinstance(u, dict)]
    totals = {key: sum(u.get(key, 0) for u in receipts)
              for key in ("input_tokens", "cached_input_tokens", "output_tokens")}
    totals["total_tokens"] = totals["input_tokens"] + totals["output_tokens"]
    trace = [json.loads(line) for line in (export / "events.jsonl").read_text().splitlines()]
    kinds = collections.Counter(e["kind"] for e in trace)
    coordination_path = folder / "coordination.json"
    coordination = json.loads(coordination_path.read_text()) if coordination_path.exists() else {}
    status = json.loads((export / "mission.json").read_text())
    return {
        "missionId": status["mission"]["id"],
        "missionState": status["mission"]["state"],
        "peers": peers,
        "reportedUsage": totals,
        "runsWithReceipts": sum(bool(p["receipts"]) for p in peers.values()),
        "usageNote": "Raw reported receipts only. Missing usage and monetary charges are unknown.",
        "tools": dict(sorted(tools.items(), key=lambda x: -x[1]["bytes"])),
        "toolCalls": sum(t["calls"] for t in tools.values()),
        "toolResultBytes": sum(t["bytes"] for t in tools.values()),
        "messages": len(messages),
        "unhandledMessages": sum(not m["handled_at"] for m in messages),
        "taskStates": dict(collections.Counter(t["state"] for t in tasks)),
        "reviews": len(coordination.get("reviews", [])),
        "requirements": len(coordination.get("requirements", [])),
        "eventCounts": {k: v for k, v in kinds.items()
                        if k.startswith(("mission.", "supervisor.", "codex.turn", "codex.error"))},
        "errors": errors,
        "boardProjection": {
            "originalBytes": raw_bytes,
            "summaryBytes": compact_bytes,
            "reductionPercent": round(100 * (1 - compact_bytes / raw_bytes), 2) if raw_bytes else 0,
            "note": "Deterministic projection of recorded boards, not measured token savings.",
        },
    }


if __name__ == "__main__":
    result = analyze(sys.argv[1])
    pathlib.Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in (
        "missionId", "missionState", "toolCalls", "toolResultBytes",
        "runsWithReceipts", "reportedUsage", "messages", "unhandledMessages",
        "taskStates", "boardProjection")}, indent=2))
