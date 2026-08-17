import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

const connectionString = process.env.DATABASE_URL ?? process.env.DATABASE_URL3;

test(
  "decision runs isolate users and enforce idempotency, leases, cancellation, and recovery",
  {
    skip: connectionString ? false : "DATABASE_URL is not configured",
    timeout: 60_000,
  },
  async () => {
    const userId = crypto.randomUUID();
    const clients = [];
    let setupClient;

    try {
      setupClient = await openClient();
      clients.push(setupClient);
      await setupClient.query("begin");
      await setupClient.query("insert into auth.users (id) values ($1)", [userId]);

      const sessions = await setupClient.query(
        `insert into public.chat_sessions (user_id, title, status)
         values ($1, $2, 'active'),
                ($1, $3, 'active'),
                ($1, $4, 'active'),
                ($1, $5, 'active')
         returning id, title`,
        [
          userId,
          `decision-run-test-${userId}-a`,
          `decision-run-test-${userId}-b`,
          `decision-run-test-${userId}-c`,
          `decision-run-test-${userId}-d`,
        ],
      );
      const sessionIds = sessions.rows.map((row) => row.id);
      const requestIds = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      await setupClient.query(
        `insert into public.decision_runs (
           user_id, session_id, client_request_id, input_text, screenshot_path
         )
         values ($1, $2, $6, 'test-a', 'test/a.jpg'),
                ($1, $3, $7, 'test-b', 'test/b.jpg'),
                ($1, $4, $8, 'test-c', 'test/c.jpg'),
                ($1, $5, $9, 'test-d', 'test/d.jpg')
         returning id, session_id, client_request_id`,
        [userId, ...sessionIds, ...requestIds],
      );
      await setupClient.query("commit");

      const claimClientA = await openClient();
      const claimClientB = await openClient();
      const assertionClient = await openClient();
      const cancelClient = await openClient();
      const workerClient = await openClient();
      clients.push(
        claimClientA,
        claimClientB,
        assertionClient,
        cancelClient,
        workerClient,
      );

      // Two independent workers may race, but the per-user advisory lock gives
      // each of them a different run and never allows a third active lease.
      const [claimA, claimB] = await Promise.all([
        claimNextRun(claimClientA, userId),
        claimNextRun(claimClientB, userId),
      ]);
      assert.ok(claimA?.lease_token);
      assert.ok(claimB?.lease_token);
      assert.notEqual(claimA.id, claimB.id);
      const blockedThirdClaim = await claimNextRun(assertionClient, userId);
      assert.equal(blockedThirdClaim, null);

      const activeCount = await assertionClient.query(
        `select count(*)::int as count
         from public.decision_runs
         where user_id = $1 and status = 'running' and lease_expires_at > now()`,
        [userId],
      );
      assert.equal(activeCount.rows[0].count, 2);
      const initiallyQueuedSessionIds = sessionIds.filter(
        (sessionId) => sessionId !== claimA.session_id && sessionId !== claimB.session_id,
      );
      assert.equal(initiallyQueuedSessionIds.length, 2);

      // A repeated client request is rejected by the unique key; the HTTP
      // layer turns that same key into an idempotent lookup.
      await assertionClient.query("begin");
      await assertionClient.query("savepoint duplicate_request");
      await assert.rejects(
        assertionClient.query(
          `insert into public.decision_runs (
             user_id, session_id, client_request_id, screenshot_path
           ) values ($1, $2, $3, 'test/duplicate.jpg')`,
          [userId, claimA.session_id, claimA.client_request_id],
        ),
        (error) => error?.code === "23505",
      );
      await assertionClient.query("rollback to savepoint duplicate_request");
      await assertionClient.query("commit");

      const selectedRun = claimB;
      const firstMessage = await assertionClient.query(
        `insert into public.chat_messages (
           session_id, user_id, decision_run_id, role, content
         ) values ($1, $2, $3, 'user', 'test')
         on conflict (decision_run_id, role) do nothing
         returning id`,
        [selectedRun.session_id, userId, selectedRun.id],
      );
      const duplicateMessage = await assertionClient.query(
        `insert into public.chat_messages (
           session_id, user_id, decision_run_id, role, content
         ) values ($1, $2, $3, 'user', 'duplicate')
         on conflict (decision_run_id, role) do nothing
         returning id`,
        [selectedRun.session_id, userId, selectedRun.id],
      );
      assert.equal(firstMessage.rowCount, 1);
      assert.equal(duplicateMessage.rowCount, 0);

      const candidate = await assertionClient.query(
        `insert into public.purchase_candidates (
           user_id, session_id, decision_run_id, screenshot_path
         ) values ($1, $2, $3, 'test/b.jpg')
         on conflict (decision_run_id) do nothing
         returning id`,
        [userId, selectedRun.session_id, selectedRun.id],
      );
      assert.equal(candidate.rowCount, 1);
      const duplicateCandidate = await assertionClient.query(
        `insert into public.purchase_candidates (
           user_id, session_id, decision_run_id, screenshot_path
         ) values ($1, $2, $3, 'test/b-duplicate.jpg')
         on conflict (decision_run_id) do nothing
         returning id`,
        [userId, selectedRun.session_id, selectedRun.id],
      );
      assert.equal(duplicateCandidate.rowCount, 0);

      const report = await assertionClient.query(
        `insert into public.assessment_reports (
           user_id, session_id, decision_run_id, candidate_id,
           decision, decision_label, scores, summary
         ) values ($1, $2, $3, $4, 'save', 'test', '{}'::jsonb, 'test')
         on conflict (decision_run_id) do nothing
         returning id`,
        [userId, selectedRun.session_id, selectedRun.id, candidate.rows[0].id],
      );
      assert.equal(report.rowCount, 1);
      const duplicateReport = await assertionClient.query(
        `insert into public.assessment_reports (
           user_id, session_id, decision_run_id, candidate_id,
           decision, decision_label, scores, summary
         ) values ($1, $2, $3, $4, 'save', 'duplicate', '{}'::jsonb, 'duplicate')
         on conflict (decision_run_id) do nothing
         returning id`,
        [userId, selectedRun.session_id, selectedRun.id, candidate.rows[0].id],
      );
      assert.equal(duplicateReport.rowCount, 0);

      const readyTryOn = await assertionClient.query(
        `insert into public.outfit_try_on_images (
           user_id, report_id, decision_run_id, outfit_id, position,
           status, image_path
         ) values ($1, $2, $3, 'outfit-ready', 0, 'ready', 'ready.jpg')
         on conflict (decision_run_id, outfit_id) do nothing
         returning id`,
        [userId, report.rows[0].id, selectedRun.id],
      );
      assert.equal(readyTryOn.rowCount, 1);
      const failedTryOn = await assertionClient.query(
        `insert into public.outfit_try_on_images (
           user_id, report_id, decision_run_id, outfit_id, position,
           status, failure_kind
         ) values ($1, $2, $3, 'outfit-failed', 1, 'failed', 'provider_error')
         on conflict (decision_run_id, outfit_id) do nothing
         returning id`,
        [userId, report.rows[0].id, selectedRun.id],
      );
      assert.equal(failedTryOn.rowCount, 1);
      const duplicateTryOn = await assertionClient.query(
        `insert into public.outfit_try_on_images (
           user_id, report_id, decision_run_id, outfit_id, position, status
         ) values ($1, $2, $3, 'outfit-ready', 0, 'pending')
         on conflict (decision_run_id, outfit_id) do nothing
         returning id`,
        [userId, report.rows[0].id, selectedRun.id],
      );
      assert.equal(duplicateTryOn.rowCount, 0);

      // An expired child lease is recovered without discarding ready or failed
      // siblings, which is the persisted form of a partial try-on batch.
      const recoverableTryOn = await assertionClient.query(
        `insert into public.outfit_try_on_images (
           user_id, report_id, decision_run_id, outfit_id, position,
           status, lease_token, lease_expires_at
         ) values ($1, $2, $3, 'outfit-recover', 2, 'processing', $4, '-infinity'::timestamptz)
         returning id`,
        [userId, report.rows[0].id, selectedRun.id, crypto.randomUUID()],
      );
      const recoveredTryOns = await assertionClient.query(
        "select * from public.recover_expired_outfit_try_on_images(1)",
      );
      assert.ok(
        recoveredTryOns.rows.some((row) => row.image_id === recoverableTryOn.rows[0].id),
      );
      const persistedBatch = await assertionClient.query(
        `select outfit_id, status, image_path
         from public.outfit_try_on_images
         where decision_run_id = $1
         order by position`,
        [selectedRun.id],
      );
      assert.deepEqual(
        persistedBatch.rows.map((row) => [row.outfit_id, row.status, row.image_path]),
        [
          ["outfit-ready", "ready", "ready.jpg"],
          ["outfit-failed", "failed", null],
          ["outfit-recover", "pending", null],
        ],
      );

      // Cancelling a leased session also cancels its child work and invalidates
      // the old worker token before the queue slot is reused.
      const cancelled = await assertionClient.query(
        "select public.cancel_decision_runs_for_session($1, $2) as count",
        [userId, claimA.session_id],
      );
      assert.equal(cancelled.rows[0].count, 1);
      const cancelledRunState = await assertionClient.query(
        "select status, lease_token from public.decision_runs where id = $1",
        [claimA.id],
      );
      assert.equal(cancelledRunState.rows[0].status, "cancelled");
      assert.equal(cancelledRunState.rows[0].lease_token, null);
      const staleCancelledCommit = await workerClient.query(
        `update public.decision_runs
         set stage = 'deciding'
         where id = $1 and status = 'running' and lease_token = $2`,
        [claimA.id, claimA.lease_token],
      );
      assert.equal(staleCancelledCommit.rowCount, 0);

      const releasedSlotClaim = await claimNextRun(assertionClient, userId);
      assert.ok(releasedSlotClaim?.lease_token);
      assert.ok(initiallyQueuedSessionIds.includes(releasedSlotClaim.session_id));
      const archiveSessionId = initiallyQueuedSessionIds.find(
        (sessionId) => sessionId !== releasedSlotClaim.session_id,
      );
      assert.ok(archiveSessionId);

      // Expiry makes the old token unusable; a later worker receives a new one.
      await assertionClient.query(
        "update public.decision_runs set lease_expires_at = '-infinity'::timestamptz where id = $1",
        [claimB.id],
      );
      const recoveredRuns = await assertionClient.query(
        "select * from public.recover_expired_decision_runs(1)",
      );
      assert.ok(recoveredRuns.rows.some((row) => row.decision_run_id === claimB.id));
      const reclaimedB = await claimNextRun(assertionClient, userId);
      assert.equal(reclaimedB.id, claimB.id);
      assert.notEqual(reclaimedB.lease_token, claimB.lease_token);
      const staleReclaimedCommit = await workerClient.query(
        `update public.decision_runs
         set stage = 'deciding'
         where id = $1 and status = 'running' and lease_token = $2`,
        [claimB.id, claimB.lease_token],
      );
      assert.equal(staleReclaimedCommit.rowCount, 0);
      const renewed = await assertionClient.query(
        "select public.renew_decision_run_lease($1, $2, 600) as renewed",
        [reclaimedB.id, reclaimedB.lease_token],
      );
      assert.equal(renewed.rows[0].renewed, true);

      // Completion and cancellation may race; exactly one conditional terminal
      // transition wins and a late write with the old token is rejected.
      const raceToken = releasedSlotClaim.lease_token;
      const [raceCancel, raceComplete] = await Promise.all([
        cancelClient.query(
          "select public.cancel_decision_runs_for_session($1, $2) as count",
          [userId, releasedSlotClaim.session_id],
        ),
        workerClient.query(
          `update public.decision_runs
           set status = 'completed', stage = 'completed', lease_token = null,
               lease_expires_at = null, finished_at = now(), updated_at = now()
           where id = $1 and status = 'running' and lease_token = $2
             and lease_expires_at > now()`,
          [releasedSlotClaim.id, raceToken],
        ),
      ]);
      assert.ok(raceCancel.rows[0].count === 0 || raceCancel.rows[0].count === 1);
      assert.ok(raceComplete.rowCount === 0 || raceComplete.rowCount === 1);
      const raceState = await assertionClient.query(
        "select status, lease_token from public.decision_runs where id = $1",
        [releasedSlotClaim.id],
      );
      assert.ok(["completed", "cancelled"].includes(raceState.rows[0].status));
      assert.equal(raceState.rows[0].lease_token, null);
      const lateRaceCommit = await workerClient.query(
        `update public.decision_runs
         set stage = 'deciding'
         where id = $1 and status = 'running' and lease_token = $2`,
        [releasedSlotClaim.id, raceToken],
      );
      assert.equal(lateRaceCommit.rowCount, 0);

      const completedB = await workerClient.query(
        `update public.decision_runs
         set status = 'completed', stage = 'completed', lease_token = null,
             lease_expires_at = null, finished_at = now(), updated_at = now()
         where id = $1 and status = 'running' and lease_token = $2`,
        [reclaimedB.id, reclaimedB.lease_token],
      );
      assert.equal(completedB.rowCount, 1);

      // Atomic archive cancels a queued run and archives its session together.
      const archived = await assertionClient.query(
        "select public.archive_chat_session_with_decision_runs($1, $2) as archived",
        [userId, archiveSessionId],
      );
      assert.equal(archived.rows[0].archived, true);
      const archivedState = await assertionClient.query(
        `select session.status as session_status, run.status as run_status
         from public.chat_sessions as session
         join public.decision_runs as run on run.session_id = session.id
         where session.id = $1`,
        [archiveSessionId],
      );
      assert.equal(archivedState.rows[0].session_status, "archived");
      assert.equal(archivedState.rows[0].run_status, "cancelled");
    } finally {
      for (const client of clients) {
        if (client === setupClient) {
          await client.query("rollback").catch(() => {});
        }
        await client.end().catch(() => {});
      }
      await deleteAuthFixture(userId);
    }
  },
);

async function openClient() {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function deleteAuthFixture(userId) {
  const client = await openClient();
  try {
    await client.query("delete from auth.users where id = $1", [userId]);
  } finally {
    await client.end();
  }
}

async function claimNextRun(client, userId) {
  const result = await client.query(
    "select * from public.claim_next_decision_run($1, 600)",
    [userId],
  );
  return result.rows[0] ?? null;
}
