# Exclusions

The exclusion registry at `policies/exclusions/v1.json` removes known-invalid evidence from derived comparisons without deleting accepted observations or proof.

## Decision flow

1. Open a code pull request with the technical evidence.
2. Add one exact selector:
   - a canonical `configurationHash`; or
   - package name, exact version, and exact SHA-256 digest.
3. Record a plain reason and the commit that made the decision.
4. Merge the reviewed registry change and run the normal Dataset rebuild.

An active decision affects leaderboard rows, views, summaries, and badges. The published views include the registry identity, its content revision, and every profile to which a decision was applied. The accepted normalized bundles, signed archives, attestations, and acceptance receipts are copied unchanged.

To reverse a decision, change its status from `active` to `withdrawn` in another reviewed pull request. The next deterministic rebuild restores the original observations to comparisons. Do not delete the decision or edit accepted evidence.

Workflow revocation and exclusion are separate. Revoking an official workflow SHA prevents future admission; it does not remove historical observations. Historical unverified observations also remain unverified: the registry never invents an attestation or a new provenance class.

Exclusions are not a secret-removal mechanism. If credentials or dangerous private content are published, stop publication and follow an emergency removal procedure. Public safety takes priority over preserving those bytes.
