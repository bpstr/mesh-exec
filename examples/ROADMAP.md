# Example pilot roadmap: repository documentation inventory

Implement this roadmap in the target repository. Consult with other mesh peers,
read the shared board and inbox, and choose a useful contribution yourself.
Everyone works in the same checkout. Establish shared interfaces through the
mesh before depending on another peer's changes.

This example assumes a Node.js repository with a TypeScript check and a test
command. Adapt the file locations and verification commands to the target
repository before starting a mission.

## Goal

Add a small local command that reports Markdown documents in a repository. A
maintainer should be able to find documents, identify their first heading, and
get a repeatable JSON inventory. Use the repository's existing conventions and
test tooling.

## Requirements

### R1 — Discover documents

Find `.md` and `.markdown` files below a requested repository-relative directory.
Do not traverse `.git`, `node_modules`, or symbolic-link directories. Return
repository-relative paths in a deterministic order. Reject paths outside the
repository root with an actionable error.

### R2 — Extract a compact record

For each document, return its path, UTF-8 byte count, and first ATX heading if
one exists. Ignore headings inside fenced code blocks. Use `null` when a
document has no heading. Preserve Unicode heading text.

### R3 — Provide a CLI

Expose the inventory through the project's normal command convention. Support
a directory argument and `--json`. JSON output must have a documented stable
shape. Human-readable output should make empty results and unreadable files
understandable. Invalid arguments must produce a nonzero exit status.

### R4 — Verify behavior

Add focused tests for traversal exclusions, Unicode, heading parsing, empty
input, deterministic output, and invalid paths. Include a CLI integration test
using temporary fixture files. Existing repository checks must continue to
pass.

### R5 — Document use

Document installation or invocation, the output fields, and two realistic
examples. Include the limitations of the heading parser so users can interpret
the inventory correctly.

## Coordination and acceptance

Record a requirement manifest covering R1–R5 in the mesh. Peers should agree on
the record shape and CLI contract before integrating their contributions.
Claim resources before writing; make dependent changes against current file
hashes and decision revisions. Use consultation and review where another peer's
knowledge affects a change.

Record evidence for every requirement and resolve stale decisions or open
review concerns. Checkpoint before exiting. When no useful contribution is
available, yield with the dependency and its returned work revision.

Propose completion only when the implementation, tests, and documentation cover
the accepted manifest and the configured final verification commands pass.
The daemon's completion result determines the mission state.
