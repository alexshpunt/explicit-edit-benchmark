# Working in this repository

Start with `README.md`. It is the entry point: what this benchmark is, what you need, and how a run
works. Nothing about that is repeated here.

When the user asks for something, load the skill that matches it and follow that skill:

| The ask                              | The skill                                      |
| ------------------------------------ | ---------------------------------------------- |
| Run an observation and publish it    | `.agents/skills/publish-benchmark-observation` |
| Review a contributed result          | `.agents/skills/review-benchmark-candidate`    |
| Add an adapter for another agent CLI | `.agents/skills/add-benchmark-harness`         |
| Run Codex on a chosen account        | `.agents/skills/configure-codex-account`       |
| Run Copilot on a chosen account      | `.agents/skills/configure-copilot-account`     |

For anything deeper, read the document the README's "Where to read more" points at.

This repository is public. Start every change on its own branch and merge it into `main` through a
pull request. Never work directly on `main`.

Treat every local file as potentially private until you have checked it. Do not commit credentials,
account details, machine paths, private configuration, raw run output, or Linear project bindings.

Do nothing on your own initiative: no run, no commit, no publication until the user asks for it. A
full observation spends real money, so confirm the scope before starting one, and prefer one task
before the whole set.

Before you commit, run the check the README describes. It is free, it is what CI runs, and it catches
a missing seeded file, an adapter name that does not exist, and an identity literal written outside
its module.

## Renderer work

Use the dependencies and commands in `docs/multi-agent.md` and the renderer guides.
Preparation and verification can be expensive. Confirm the run and use an environment
with enough CPU and memory. Keep one heavy renderer job at a time under a shared project
lock, including jobs started from different checkouts.

Keep generated source, raw evidence and private model configuration in ignored output
folders. Use new output directories; do not overwrite earlier runs or another agent's work.
Check the actual process exit and saved report before claiming success. Model calls and
publication need explicit approval.

Machine-specific deployment rules belong in private operator skills, not this repository.
