# Official community runs

Use the public [official run template](https://github.com/alexshpunt/explicit-edit-benchmark-run-template) when you want a result whose exact bytes are tied to an approved GitHub workflow.

Select **Use this template**, create a public repository, add `PI_AUTH_JSON` and `HF_TOKEN` as Actions secrets, then run **Run official benchmark** from the Actions tab. The workflow UI accepts only registered adapters, an exact model and package versions, reasoning, and a registered task. A one-task or other partial run is valid.

The caller invokes `official-run.yml` at a full approved commit SHA. Model execution, signing, and submission have separate credentials and permissions. The caller does not supply benchmark code, commands, checkout paths, provider URLs, environment variables, caches, or runner labels.

After inference succeeds, the workflow attests the exact result archive and starts submit-only delivery. Hugging Face downtime does not require new model calls: run **Resubmit existing official result** with the original GitHub run ID and attempt. Repeated delivery of the same execution and digest is a no-op; a conflicting digest is rejected.

A scheduled workflow in this repository verifies official candidates and publishes accepted observations automatically. Score does not affect admission. Failures and timeouts are observations. The Dataset retains the signed archive, attestation, execution identity, source workflow, policy identity, and acceptance receipt.

Ordinary local submissions remain supported. They are marked `unverified`, while approved GitHub workflow results are marked `verified`. Both stay visible in the same Dataset. Local development may use custom configs and local extensions; those inputs are deliberately unavailable in official mode. New official adapters require a reviewed code pull request and a real GitHub smoke.

Verification proves that the exact archive came from the approved workflow identity. It does not prove the provider's private model implementation, prevent hidden unrelated runs, or review every third-party package version for benchmark awareness.
