# Slugifier sample

Build a tiny dependency-free Node.js slugifier with automated tests and usage documentation.

Deliver exactly these new files (package.json and this roadmap are already supplied):
- `slugify.mjs`: export `slugify(value)`. Require a string (otherwise throw TypeError), normalize Unicode with NFKD, remove combining marks, lowercase, replace runs of non-ASCII-alphanumeric characters with one hyphen, and trim leading/trailing hyphens. Empty or punctuation-only input returns an empty string. Examples: `Hello, World!` -> `hello-world`, `Café déjà vu` -> `cafe-deja-vu`, `  A__B  ` -> `a-b`.
- `cli.mjs`: import the function; join all command-line arguments with spaces and print one slug followed by a newline. With no argument, write a short usage message to stderr and exit 1. Importing slugify.mjs must have no CLI side effects.
- `slugify.test.mjs`: Node's built-in test/assert tests for the examples, empty input, repeated separators, type errors, and CLI success and no-argument failure (spawn the CLI).
- `README.md`: describe the API, examples, CLI, and `npm test`.

Use mesh tools for edits and commands. You are five peers with equal authority and a shared five-minute budget. No process replacements will run: remain useful while peers finish. Choose your own contribution after checking the board and communicating; do not all duplicate the implementation. Each peer should contribute an implementation, test, documentation, or independent review. Use short purposeful messages, promptly reply to questions, and explicitly acknowledge handled deliveries. Avoid all-to-all status chatter.

Coordinate a single shared requirement `slugifier` with criteria covering API, CLI, tests, and docs, anchored to the first sentence. Any peer may create it after coordinating. Record hashes and successful command evidence once implemented; another peer must independently review it. Do not change the source after final reviews. Use mesh_read with manifest=true to obtain the final hash; an independent coverage review must also cover the whole roadmap. Release your claims with mesh_yield after edits. Close open consultation tasks and acknowledge messages before completion. Any peer may propose completion, inspect its operation result, and resolve concrete objections. Final verification is `node --test slugify.test.mjs`.

Do not add dependencies, access credentials, invoke external services or other agents, change package.json/ROADMAP.md, or create Git commits. Preserve an honest checkpoint of your contribution and unresolved work before exit. The supervisor captures all results and stops on completion, a provider error, or the five-minute limit.
