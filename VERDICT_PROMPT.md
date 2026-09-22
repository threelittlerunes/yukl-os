You are the independent QA Auditor for the yukls-power-harness remediation. Verify every claim in the drafter's contract and produce a pass/fail verdict.

Step 1: Run the empirical proofs yourself
- npm run build
- npm run test
- npm run format:check
Record exact exit codes and full output.

Step 2: Read .orchestration/contracts/remediate_review.json - this is the drafter's contract. Verify each fix:

V-1: Does validate-config.js now check that CLAUDE.md references every rule file in .claude/rules/? Deliberately remove a reference from CLAUDE.md and confirm npm run build fails. Then revert.

V-2: Does validate-config.js now parse orca.yaml and check that every rule file appears in an agent's rules array? Deliberately remove one from orca.yaml and confirm npm run build fails. Then revert.

V-3: Are .orchestration/contracts/current_task.json and task_78cbf848c6c4.json untracked? Run git status to confirm. Is the .gitignore rule present?

V-4: Does validate-config.js now scan INTENT.md and CONTRIBUTING.md for placeholders? Confirm there are no placeholders in those files. Deliberately add one and confirm npm run build fails. Then revert.

V-5: Does .github/workflows/ci.yml no longer have the redundant "Instruction budget" step?

C-1: Does the README mechanism table now use "French and Raven base" / "Yukl tactic" / "Structural design" matching docs/YUKL_ARCHITECTURE.md section 2.3?

C-2: Does CLAUDE.md now reference all 5 rule files? Is it under 60 lines?

C-3: Does orca.yaml agents.drafter.rules now include plan-drafter.md? Does agents.auditor.rules include independent-auditor.md?

C-4: Does count-instructions.js now cite section 2.4 (not 2.1)?

C-5: Does docs/YUKL_ARCHITECTURE.md now say "no more than 60 lines" (not "fewer than")?

C-6: Does README.md have a real GitHub Actions badge (not a static placeholder)?

C-7: Does .gitattributes exist with eol=lf? Is it in REQUIRED_FILES?

C-8: Does package.json now have repository, homepage, bugs, author and files fields?

C-9: Does CONTRIBUTING.md use YOUR-USERNAME (not angle-bracket placeholder)?

C-10: Is CONTRACT_REF_RE removed from harness.js?

C-11 and C-12: Do PUBLICATION_AUDIT.md and AUDIT_REPORT.md have superseded banners?

C-13: Does INTENT.md have real constraints (not placeholders)?

Step 3: Write your verdict to .orchestration/contracts/remediate_verdict.json with: task_id, agent, role, status, timestamp, empirical_proof array, verification_checks array (one per V and C item, each with id, check description, result PASS/FAIL, evidence), verdict PASS/FAIL, verdict_rationale.

Be strict. If any fix is incomplete or incorrect, FAIL it.
