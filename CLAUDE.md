# Operational rules

## Never `SELECT *` against production -- name columns explicitly

Ad-hoc diagnostic queries against the live database (e.g. via SSM) must
list columns explicitly, never `SELECT *` or `SELECT g.*`. Several tables
carry live credentials, and a `SELECT *` prints them straight into
whatever output the query lands in (terminal, logs, a conversation
transcript) with no warning:

- `ghl_accounts.access_token`, `ghl_accounts.refresh_token` -- live GHL
  OAuth tokens, usable against that location's real data until GHL
  expires or the owner revokes them from GHL's own side (there is no
  revoke API).
- `users.password_hash` / `password_salt`, `pending_signups.password_hash`
  / `password_salt`
- `users.invite_token_hash`

This happened once already (an incident where `SELECT *` on
`ghl_accounts` printed a real access/refresh token pair into a
conversation). The app's own code already gets this right -- every
API-facing query (`listGhlAccountsForTenant`,
`listGhlAccountsWithStatusForTenant`, etc.) names safe columns only and
never returns tokens to the client -- ad-hoc debugging queries need the
same discipline.
