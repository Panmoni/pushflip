# Security Review (Custom Scope)

Perform a security review of the specified files. Replace **FILES_OR_SCOPE** below with the paths you want reviewed (e.g. `programs/pushflip/src/lib.rs` or a short list of files), or pass them as the command argument. $ARGUMENTS

**Scope:** FILES_OR_SCOPE

## Focus

1. **Authentication and authorization:** Who can access what; bypass or privilege escalation risks.
2. **Input validation and injection:** Malformed accounts, invalid data, or injection vectors.
3. **Secrets and sensitive data:** No hardcoded secrets, API keys, or private keys; safe storage and logging.
4. **Cryptography:** Correct algorithms and usage; no weak or custom crypto; key handling.
5. **On-chain safety:** Account validation, signer checks, owner checks, PDA seed collisions, arithmetic overflow.
6. **Data handling:** Sensitive data lifecycle, logging, and masking.

## Output

- List findings with **severity** (Critical / High / Medium / Low), **file and location**, and a **concrete recommendation** for each.
- End with a short summary and whether you recommend changes before merge.
