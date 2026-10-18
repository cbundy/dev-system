# Evidence storage

Screenshots, videos and reports for a PR are uploaded to the repo's own private Azure blob container by
`callum-flow-evidence-upload` (see [its README section](../images/base/README.md#callum-flow-evidence-upload)).
Each repo has one container and one SAS pair, so a credential can never read another repo's evidence. The
workspace name is part of the blob path (`<owner>/<repo>/<workspace>/<dest>/<file>`), not of the container.

## One container per repo

1. In the storage account, create a **private** container (no anonymous access) for the repo, e.g. `evidence-<repo>`.
2. Issue two **service SAS** tokens scoped to that container (never an account SAS):
   - write: permissions `cw` (create, write), container scope (`sr=c`);
   - read: permissions `r`, container scope (`sr=c`).
3. SAS expiry and the container's retention (lifecycle management) are set in Azure. Re-issue before expiry.

The tool refuses an account SAS, a SAS that is not container-scoped, a read SAS with any permission but `r`, a
write SAS without `c` and `w`, and a container URL that is not `https://<host>/<container>` with no query.

## The three files

Per repo, a folder `evidence/<owner>/<repo>/` (owner and repo lower-case) holding:

| File | Content |
|---|---|
| `container-url` | `https://<account>.blob.core.windows.net/<container>` |
| `write-sas` | the write SAS query string (a leading `?` is fine) |
| `read-sas` | the read SAS query string |

Every file is owned `1000:1000`, mode `0600`. The folder is looked up in `DEV_WORKSPACE_SECRETS_DIR`
(default `/run/secrets/dev-system-workspace`, this workspace only) first, which wins whole when it exists, then in
`DEV_SECRETS_DIR` (default `/run/secrets/dev-system`, shared by the fleet).

- **Docker:** put the folder in the `dev-system-secrets` volume (mounted read-only at `/run/secrets/dev-system`).
- **Coder:** put it in the template's `secrets_dir` on the Docker host (default `/etc/dev-system/secrets`), or in a
  workspace's own folder for one workspace.
- **Kubernetes:** mount a secret with the three keys at `/run/secrets/dev-system/evidence/<owner>/<repo>/`
  (or the workspace path).

## CI

GitHub Actions sets the environment instead: `ARTIFACT_CONTAINER_URL`, `ARTIFACT_SAS` (write) and
`ARTIFACT_READ_SAS`, used together when `ARTIFACT_SAS` is set, from repo secrets. The workspace segment is
`ci-<GITHUB_RUN_ID>`.

## Checking

`callum-flow-evidence-upload --check` in the checkout validates the setup without uploading; `dev-doctor` runs it
and reports OK, a WARN when nothing is configured (exit 78), or a FAIL when the setup is wrong (exit 1).
