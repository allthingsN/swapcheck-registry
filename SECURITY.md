# Security policy

The Swapcheck CLI trusts this registry to tell it when models change, so a forged or wrong entry is a security problem, not just a data bug.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/allthingsN/swapcheck-registry/security/advisories/new). Do not open a public issue. For problems in the CLI, the Action or the MCP server, report to [allthingsN/swapcheck](https://github.com/allthingsN/swapcheck/security/advisories/new) instead.

We aim to acknowledge reports within three working days and to tell you what we plan to do within ten. We are a very small team, so these are goals and not guarantees. We will credit you unless you prefer otherwise.

## What is in scope

- A way to get a snapshot accepted that was not signed with the registry key, or to make `dist/snapshot.json` and its signature disagree without the check failing.
- A provider page that makes a parser write a wrong date, a wrong replacement model or text that ends up in code, pull requests or CI output.
- A way for a pull request or issue from outside the project to run code with the signing key or with write access.
- Any secret in this repository or its history.

Wrong data from a provider's own page is a data issue. Please open a normal issue with the source link.

## How the registry is protected

| Promise | How |
| --- | --- |
| Snapshots are authenticated | Every snapshot is signed with Ed25519. The CLI pins `registry-public.pem` and refuses a snapshot whose signature fails. |
| The signing key is only used by the scheduled update | It is stored as a repository secret and read only by the `update` workflow, which runs on a schedule or by hand, never on pull requests. |
| Unconfirmed changes wait for a person | Changes backed only by secondary sources go to a `registry-update-*` branch and a review issue. Only changes confirmed by a provider's own page are pushed to `main` directly. |
| Parsers never run fetched content | Pages are parsed as text. Nothing fetched is executed. |
| Dependencies stay small | The scripts have no npm dependencies, and every GitHub Action is pinned to a commit. |
