# Task collaboration, artifacts, and personal Git accounts

Task collaboration is governed by the existing Governance service. A requester or Realm administrator can grant a task to individual users or departments with `viewer` or `contributor` access. Department grants are resolved against each user's current primary department; an optional descendant flag includes active child departments. Grants inherit down the task tree, so collaborators can follow child-agent tasks without duplicating ACL rows. Removing a grant takes effect on the next request.

Run attachments are durable deliverables separate from the immutable execution result. Governance stores artifact metadata and audit history in PostgreSQL. The Lumo host stores bytes in the existing realm-scoped object store under a content-addressed key, and checks the recorded length and SHA-256 before serving downloads. Uploads are limited to 50 MiB. Publishing through the current connector API is limited to 512 KiB per file because the connector gateway request envelope is bounded to 1 MiB.

## Personal account authorization

The OAuth grant is owned by `(realm, connector, user)`. Each user starts the OAuth flow from the connector directory, authorizes with their own GitHub or GitLab account, and can refresh or disconnect only that account. Managed OAuth connectors resolve only the current caller's grant and never fall back to a realm-wide user token. Access and refresh tokens remain in Vault; PostgreSQL stores lifecycle state. Existing realm-shared OAuth rows are disconnected during schema initialization and their Vault keys are queued for cleanup. Reauthorization, refresh, disconnect, and expiration also queue retired Vault keys for delayed deletion. Connector gateway audit records remain attributable to the acting user.

Register one OAuth application per provider and configure the exact public callback URL:

```text
https://<your-lumo-host>/auth/connector-oauth/callback
```

Store the OAuth application's client ID and client secret in Vault, then replace the `clientIdRef`, `clientSecretRef`, and `callbackUrl` placeholders in the example connector manifests. Do not put a user's access token into a manifest or connector environment variable; users connect their own accounts through the OAuth panel.

The starter manifests are [GitHub](../../platform/shared/connectors/github.oauth.example.json) and [GitLab](../../platform/shared/connectors/gitlab.oauth.example.json). They declare only the four operations used by artifact publishing. Register them in the connector gateway under the matching IDs `github` and `gitlab`.

GitHub's `repo` OAuth scope is broad for private repositories. A GitHub App is preferable where the deployment can use its narrower repository permissions; the connector must still obtain a user-authorized token if operations need to act as the user. GitLab's `api` scope is also broad and should be reviewed against the organization's OAuth policy before enabling the connector.

## Publish flow

The user chooses a provider, repository, target branch, and file path on a persisted task artifact. Lumo verifies contributor access and artifact integrity, then uses the current user's connector OAuth token to:

1. Read the target branch head.
2. Create a new `lumo/task-*` branch.
3. Commit the artifact file to that branch.
4. Create a draft pull request or merge request.

The operation never merges automatically. If the last API call fails after the branch or file commit succeeded, those partial changes remain in the user's repository and can be inspected or removed there.
