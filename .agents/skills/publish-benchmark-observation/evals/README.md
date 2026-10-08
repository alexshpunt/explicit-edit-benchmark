# Check the final report

These two synthetic cases check what the agent tells the user after submission. They are extracted evidence summaries, not normalized bundles, real observations, or data to publish.

- `files/full.json`: final exact success hides five first-attempt misses. The accepted aggregate differs from this observation, shares a rank with another configuration, and has partial and quarantined candidates to exclude.
- `files/partial.json`: tasks have unequal observation counts. Cost is unknown, tokens are partial, error evidence is missing, and acceptance is pending.

`evals.json` holds the prompts and expected outcomes. Judge the agent's answers against those outcomes. Do not test whether `SKILL.md` contains particular words.

## Run a case

From the repository root, use a model you can access:

```sh
pi --print --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files \
  --tools read,bash --model PROVIDER/MODEL --thinking low \
  --session-dir .agents/tmp/observation-report/sessions \
  --skill .agents/skills/publish-benchmark-observation/SKILL.md \
  --system-prompt 'Complete only the final reporting phase. Read the requested skill and supplied evidence. Use read-only commands. Do not run benchmark trials, publish, change files, or access the network.' \
  'Read the publishing skill and give the final report for the already completed observation in .agents/skills/publish-benchmark-observation/evals/files/full.json. Use only this synthetic evidence and frozen Dataset snapshot.'
```

Use `partial.json` for the second case and say that its submission is pending. To compare an older skill, save that revision under `.agents/tmp/` and change only the `--skill` path. Give the agent that path explicitly so it does not read the current revision instead.

The reporting agent makes model calls on your account. It does not need a new benchmark run, a Hugging Face token, or network access to the Dataset. Keep generated sessions and answers private under the ignored `.agents/tmp/` directory, then remove them after review. Commit only the reusable cases and instructions.
