"""Export every durable peer message verbatim; no inference."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
run = root / "terra-run"
rows = json.loads((run / "export/messages.json").read_text())
lines = ["# Exact peer messages", "", "Timestamps are UTC. Message text is reproduced verbatim.", ""]
for index, row in enumerate(sorted(rows, key=lambda r: (r["created_at"], r["delivery_id"])), 1):
    lines += [
        f"## {index}. {row['sender_id']} → {row['recipient_id']} — {row['created_at']}",
        "",
        f"Task: `{row['task_id']}`. Delivery: `{row['delivery_id']}`.",
        f"Acknowledgment: {row['handled_at'] or 'not acknowledged'}.",
        "",
    ]
    for part in row["message"].get("parts", []):
        value = part.get("text")
        if value is not None:
            fence = "````"
            while fence in value:
                fence += "`"
            lines += [fence + "text", value, fence, ""]
        else:
            lines += ["```json", json.dumps(part, ensure_ascii=False, indent=2), "```", ""]
if not rows:
    lines += ["No peer-to-peer message deliveries were recorded.", ""]
(root / "MESSAGES.md").write_text("\n".join(lines), encoding="utf-8")
print(f"Preserved {len(rows)} messages in MESSAGES.md; original JSON remains in export/messages.json")
