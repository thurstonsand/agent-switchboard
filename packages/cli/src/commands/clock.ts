import { recordTx } from "@swb/shared/record";
import { launchSession } from "../coordinate.ts";
import { states } from "../derive.ts";
import { type Fired, fire, nextDue } from "../schedules.ts";
import { wake } from "../sessions.ts";
import { openStore } from "../store.ts";

// `swb __clock`: the sessions server's control pane, which lives as long as the server does. It fires schedules on
// time, and starts any dormant session with mail waiting. It reads the wall clock every tick, so after the machine
// sleeps, whatever came due meanwhile fires on the first tick after it wakes.

const TICK_MS = 250;
const RECONCILE_MS = 15_000;
/** A session that won't start is tried again after this, doubling, up to WAKE_RETRY_MAX_MS. */
const WAKE_RETRY_MS = 30_000;
const WAKE_RETRY_MAX_MS = 10 * 60_000;

function log(text: string): void {
	console.error(`${new Date().toISOString()} ${text}`);
}

export async function clock(): Promise<void> {
	const db = openStore();
	const retries = new Map<string, { at: number; wait: number }>();
	let version = -1;
	let due: number | null = null;
	let reconciled = 0;

	/** Every open session with an undelivered message and no process gets one, unless it's waiting out a failed start. */
	const wakeWaiting = (now: number) => {
		reconciled = now;
		const waiting = new Set(
			db
				.all("SELECT DISTINCT target_id FROM messages WHERE delivered_at IS NULL AND cancelled_at IS NULL AND kind = 'message'")
				.map((row) => row.target_id as string),
		);
		for (const id of retries.keys()) if (!waiting.has(id)) retries.delete(id);
		if (waiting.size === 0) return;
		for (const s of states(db)) {
			if (!waiting.has(s.id) || !s.open || s.live) continue;
			const retry = retries.get(s.id);
			if (retry && now < retry.at) continue;
			const wait = retry ? Math.min(retry.wait * 2, WAKE_RETRY_MAX_MS) : WAKE_RETRY_MS;
			retries.set(s.id, { at: now + wait, wait });
			try {
				log(`waking ${s.id} for its mail: ${wake(db, s.id)}`);
			} catch (error) {
				log(`waking ${s.id} failed: ${(error as Error).message}`);
			}
		}
	};

	/** A launch that failed is news for the session that scheduled it, in its own harness. */
	const launchFailed = (l: Fired["launches"][number], error: Error) => {
		log(`launching "${l.launch.title}" failed: ${error.message}`);
		recordTx(db, () =>
			db.run(
				`INSERT INTO messages (id, kind, source_id, target_id, body, request_response, created_at, schedule_id, scheduled_for)
				 VALUES (?, 'message', ?, ?, ?, 0, ?, ?, ?)`,
				crypto.randomUUID(),
				l.source,
				l.source,
				`swb couldn't launch the new ${l.launch.harness} session "${l.launch.title}" for this schedule: ${error.message}`,
				Date.now(),
				l.scheduleId,
				l.scheduledFor,
			),
		);
	};

	log(`clock started (pid ${process.pid})`);
	for (;;) {
		const now = Date.now();
		const current = db.dataVersion();
		if (current !== version) {
			version = current;
			due = nextDue(db);
		}
		if (due !== null && due <= now) {
			const fired = fire(db, now);
			// This connection's own writes don't move data_version.
			version = -1;
			log(`fired ${fired.targets.length} message(s), ${fired.launches.length} launch(es)`);
			for (const l of fired.launches) {
				launchSession(db, {
					from: l.source,
					harness: l.launch.harness,
					goal: l.body,
					cwd: l.launch.cwd,
					title: l.launch.title,
					requestResponse: l.requestResponse,
					model: null,
					scheduled: { id: l.scheduleId, at: l.scheduledFor },
				}).then(
					(result) => log(result.text),
					(error: Error) => launchFailed(l, error),
				);
			}
			wakeWaiting(now);
		} else if (now - reconciled > RECONCILE_MS) wakeWaiting(now);
		await Bun.sleep(TICK_MS);
	}
}
