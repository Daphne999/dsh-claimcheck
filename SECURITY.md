# Security policy

## Scope

`dsh-claimcheck` runs shell commands that the agent or the user asked it to run.
That is the product, so the security question is not "can it run commands" but
"which commands it refuses, and what it does with the output".

Design boundaries, by intent:

- **Command screening is a guardrail, not a sandbox.** [`lib/checks.js`](lib/checks.js)
  refuses a fixed set of red lines (recursive force delete, disk format, shutdown,
  `curl | sh`, destructive git, credential uploads). Everything else runs through
  the harness shell seam (`ctx.shell`), so the profile's own sandbox policy applies.
- **Paths stay inside the working directory.** `file` checks reject absolute paths
  and `..` traversal.
- **Output is bounded.** The artifact stores at most `maxOutputBytes` per check and
  marks the truncation explicitly.
- **No network, no telemetry.** The plugin does not make outbound requests and does
  not report anything anywhere. Evidence is written only under the session working
  directory.
- **Context commands inherit the harness sandbox.** If your profile runs the shell
  in a confined mode, checks run confined too.

Deliberately out of scope: cryptographic tamper-proofing. A local user with the
same privileges can run any command and write any file. The plugin's claim is
"each artifact points at the execution it actually performed and the tree it was
performed on", not "no local process can ever lie".

## Reporting a vulnerability

Open a private security advisory on this repository (Security → Report a
vulnerability). Please include the exact command or check definition, the profile
mode, and whether the harness sandbox was active. Do not open a public issue for
an unpatched bypass.
