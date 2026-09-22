# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 2.x | Yes |
| < 2.0 | No |

## Reporting a vulnerability

Do **not** report security vulnerabilities through public GitHub issues, pull
requests, or discussions.

Instead, report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities)
for this repository, or open a draft security advisory. Include:

- A description of the issue and its impact.
- Reproduction steps or a proof-of-concept.
- The affected version and environment (OS, Node version, agent).
- Any suggested remediation.

You can expect an acknowledgement within 72 hours and a status update within
7 days. We will credit reporters in the advisory unless you ask us not to.

## Scope

This project is a governance and configuration harness. The security-relevant
surfaces are:

- **Path-scope rules** (`.claude/rules/*.md`): a rule that grants a wider path
  than its agent should hold is a security defect. The Auditor is deliberately
  denied any `src/**` write scope.
- **Pipeline configuration** (`flow.config.json`): changes that skip the Auditor
  gate or bypass the contract check are security defects.
- **Contract integrity** (`.orchestration/contracts/`): falsified empirical
  proofs defeat the entire trust model. Treat contract tampering as a
  vulnerability, not a bug.
- **Tooling** (`scripts/**`): command injection or path traversal in the
  validation and budget scripts.

## Hardening guidance for adopters

- Never store secrets in `flow.config.json`, `.yukl-intent.yml`, or rule files.
- Give agents only the path scope they need; `src/**` is never a default.
- Keep the Auditor gate enabled for changes touching auth, payments, or schemas.
- Pin your dependencies and review lockfile changes in pull requests.
