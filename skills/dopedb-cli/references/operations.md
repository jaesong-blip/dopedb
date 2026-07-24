# Operation proposals and receipts

## Propose a mutation

Send exactly one SQL statement through stdin:

```text
printf '%s\n' 'UPDATE public.users SET active = false WHERE id = 42' |
  dopedb sql propose --connection id:<uuid> --file - --json
```

The proposal is immutable. Report the operation identifier, connection,
environment, operation kind, risk, payload hash, preview, notices, and expiry.
Do not paraphrase away destructive details.

## Approval

Only the user-facing DopeDB Desktop approval surface can approve or reject the
stored exact proposal. Agents and the CLI cannot approve. Do not search for,
invent, or simulate an approval command.

If the payload, policy, connection authority, workspace membership, or
credential revision changes, the old approval must not authorize the new state.

## Observe

```text
dopedb operation show <operation-id> --json
dopedb operation wait <operation-id> --timeout-ms 30000 --json
```

Waiting does not approve or execute a proposal by itself. It observes the
runtime-owned state machine.

Terminal states include completed, failed, rejected, cancelled, expired, and
outcome unknown. Report the exact state and receipt.

## Cancel

```text
dopedb operation cancel <operation-id> --json
```

Cancellation is best-effort after execution begins. A cancelled request is not
proof that the target transaction never committed.

## Outcome unknown

If DopeDB loses confirmation after the target commit boundary, it records
`outcome_unknown`. Never retry automatically. Ask the user to inspect the target
state and reconcile manually, then preserve that conclusion in the audit trail.
