# Official run releases

An official run has two separate identities:

- `configurationHash` identifies the measured agent, harness, model, reasoning, tools, extensions, rules, runtime flags, and named environment inputs. It does not contain a contributor, GitHub run, timestamp, display label, or credential.
- `executionId` identifies one producer invocation. It covers the caller repository, GitHub run ID, producer attempt, invocation name, and the sorted configuration hashes.

Retrying delivery or verification keeps the original execution identity. Re-running the producer creates a new identity. The accepted content digest is stored separately; two different bundles claiming one execution ID are a conflict.

## Release order

The three revisions are deliberately different:

1. Commit the runner and identity code. This is the immutable runner revision.
2. Commit the reusable workflow with that runner revision pinned in `actions/checkout`.
3. Commit a policy under `policies/official-runs/` that allows the workflow commit and maps it to the runner commit.

A caller pins step 2 by full commit SHA. Acceptance uses step 3 from its own trusted checkout. Candidate files cannot add a signer, runner, task, verifier, schema, or policy.

To revoke future acceptance, change an approved workflow entry from `active` to `revoked` in a reviewed policy commit. This does not rewrite accepted observations. Removing historical observations from generated comparisons is a separate exclusion decision.

## Claims and lifecycle

`verified` means that the exact archive was attested by an active workflow in the release policy and its manifest matches the policy and normalized bytes. It does not prove the provider's internal model implementation.

Task failures are measurements, not infrastructure failures. A selected subset is a valid `partial-measurement`. Failure before any task observation is an `infrastructure-failure`. Low score never changes admission.

Ordinary reviewed Dataset contributions remain `unverified`. Both paths may contain partial runs and remain visible and filterable in the same Dataset.

## Hugging Face publication authority

Canonical publication uses a Hugging Face repo trusted publisher, not a stored write token. Configure it on the Dataset settings page with these exact claims:

- provider: GitHub Actions;
- repository: `alexshpunt/explicit-edit-benchmark`;
- branch: `main`;
- workflow: `auto-accept-official.yml`.

The `accept` job requests a GitHub OIDC token with audience `https://huggingface.co` only after its trusted checkout and dependencies are ready. It exchanges that identity for a one-hour token with resource `datasets/alexshpunt/explicit-edit-benchmark`, masks the token, and keeps it only in the job environment. The workflow has no `HF_TOKEN` secret dependency.

Use the `oidc_check_only` workflow input after changing publisher settings. The check proves that the configured workflow can exchange for the canonical Dataset while the same identity cannot exchange for another Dataset. A run from another repository, branch, or workflow must fail claim matching.

## Delivery recovery

Inference, signing, and delivery are separate lifecycle stages. The attestation job uploads the original result archive, its digest, and its attestation as a retained GitHub Artifact before any Hugging Face request starts. A delivery failure therefore changes only delivery state; it never invalidates or repeats the measurement.

Hugging Face delivery may retry a bounded number of HTTP 429 and 5xx responses with backoff. After that it records `delivery-failed` and leaves the original artifact available. A submit-only `workflow_dispatch` identifies the original GitHub run, downloads that exact artifact, verifies its digest and attestation again, and resends the same bytes. It cannot accept replacement normalized files and has no model credential.

Repeated delivery keeps the original `executionId` and archive digest. The receiver treats the same pair as a no-op and different bytes for one execution as a conflict. Artifact retention defines the recovery window before acceptance. After acceptance, Hugging Face stores the archive, attestation, and receipt so recovery no longer depends on GitHub retention.
