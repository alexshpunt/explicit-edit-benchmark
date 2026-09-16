# Official community runs

Use the public [official run template](https://github.com/alexshpunt/explicit-edit-benchmark-run-template) when you want a result whose exact bytes are tied to an approved GitHub workflow.

Select **Use this template**, create a public repository, add `PI_AUTH_JSON` and `HF_TOKEN` as Actions secrets, then run **Run official benchmark** from the Actions tab. The workflow UI accepts only registered adapters, an exact model and package versions, reasoning, and a registered task. A one-task or other partial run is valid.

The caller invokes `official-run.yml` at a full approved commit SHA. Model execution, signing, and submission have separate credentials and permissions. The caller does not supply benchmark code, commands, checkout paths, provider URLs, environment variables, caches, or runner labels.

After inference succeeds, the workflow attests the exact result archive and starts submit-only delivery. Hugging Face downtime does not require new model calls: run **Resubmit existing official result** with the original GitHub run ID and attempt. Repeated delivery of the same execution and digest is a no-op; a conflicting digest is rejected.

A scheduled workflow in this repository verifies official candidates and publishes accepted observations automatically. Score does not affect admission. Failures and timeouts are observations. The Dataset retains the signed archive, attestation, execution identity, source workflow, policy identity, and acceptance receipt.

Ordinary local submissions remain supported. They are marked `unverified`, while approved GitHub workflow results are marked `verified`. Both stay visible in the same Dataset. Local development may use custom configs and local extensions; those inputs are deliberately unavailable in official mode. New official adapters require a reviewed code pull request and a real GitHub smoke.

Verification proves that the exact archive came from the approved workflow identity. It does not prove the provider's private model implementation, prevent hidden unrelated runs, or review every third-party package version for benchmark awareness.

## Operations and recovery

Production acceptance runs four times an hour and processes at most four official candidates in one serialized batch. The GitHub repository variable `OFFICIAL_AUTO_ACCEPT_ENABLED` is the kill switch. Set it to `false` to stop new accepts; verification data already published in Hugging Face is not changed. Maintenance-only `dry_run`, `rebuild_only`, and OIDC checks remain available through manual dispatch while the switch is off.

Use **Auto-accept official observations → Run workflow → dry_run** before changing release policy, the verifier, or the official registry. A dry run verifies the immutable candidate revision and builds the proposed append locally, but creates no Dataset commit and does not close the candidate. The Action summary reports discovered, accepted or duplicate, rejected, deferred, dry-run state, and the Dataset commit when one was created.

Temporary Hub failures are deferred. The next scheduled batch reads the current Dataset head and retries the unchanged candidate without model calls. Publishing uses a parent-checked atomic commit; a concurrent Dataset update therefore fails closed and is retried from the new head on the next batch. Submit-only recovery always reuses the retained signed artifact and existing candidate when available.

### Operator runbook

- **Disable imports:** set the GitHub repository variable `OFFICIAL_AUTO_ACCEPT_ENABLED=false`. Re-enable it with `true`, then dispatch the workflow once to drain the queue.
- **Check publishing identity:** run `oidc_check_only`. The negative exchange for another Dataset must fail and the scoped production exchange must succeed.
- **Revoke a signer:** remove or revoke its full workflow SHA in `policies/official-runs/v1.json` through a code PR. This blocks future acceptance; it does not delete historical observations.
- **Disable a package/configuration:** use the versioned registry or exclusion policy. Admission revocation and retroactive view exclusion are separate decisions.
- **Recover delivery:** rerun **Resubmit existing official result** with the original producer run ID and attempt. It performs no inference, verifies the retained bytes, resumes the existing candidate, verifies `acceptance.json`, and closes it with the contributor token.
- **Recover derived views or a missing aggregate state:** dispatch `rebuild_only`. It downloads canonical `source/`, rebuilds state, shards, leaderboard, views, summary, badges and README, then publishes one parent-checked commit.
- **Recover after commit-before-close:** rerun submit-only. It finds the existing execution, verifies the candidate commit and accepted Dataset commit, writes the receipt comment and closes the PR.
- **Parent conflict:** do not force-push. Let the next serialized batch reload the new Dataset head and reapply the immutable candidate.
- **OIDC failure:** leave candidates open, verify the Trusted Publisher repository, branch `main`, and workflow filename, then run `oidc_check_only`. Never copy a maintainer write token into a caller workflow.
- **Emergency credential response:** remove the affected caller secret, cancel its workflow, revoke the provider/HF credential, and revoke the signer SHA if trusted code may have been affected. Published proof remains immutable; use an exclusion decision rather than rewriting history.
- **Update pins:** change Actions, workflow SHAs, runner/package versions, and the caller template through reviewed PRs, then repeat dry-run and one-task smoke checks.

The full rebuild is a recovery operation, not the normal append path. No server, Worker, or private database is required.
