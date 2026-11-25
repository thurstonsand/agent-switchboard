import { recordTx } from "@swb/shared/record";
import { PENDING_MESSAGE } from "@swb/shared/states";
import { launchSession } from "../coordinate.ts";
import { states } from "../derive.ts";
import { type Fired, fire, newSessionName, nextDue } from "../schedules.ts";
import { wake } from "../sessions.ts";
import { openStore, setReload } from "../store.ts";
import { hostPane, SESSIONS, SWB, tmuxTry } from "../tmux.ts";

// `swb __clock`: the sessions server's control pane, which lives as long as the server does. It fires schedules on
// time, starts any dormant session with mail waiting, and keeps the search index warm. It reads the wall clock every
// tick, so after the machine sleeps, whatever came due meanwhile fires on the first tick after it wakes.

const TICK_MS = 250;
const RECONCILE_MS = 15_000;
/**
 * Every start the clock makes is one try to have a session take what waits on it, a message or a reload; it gets
 * WAKE_ATTEMPTS, each WAKE_BACKOFF_MS after the last, doubling. Taking what waited starts its tries over: a reload is
 * taken once the harness its start began registers, a message once its line takes it, so a start that quits before
 * then used one up. Out of tries, the clock stops starting it and records why: it shows failed to start, and what waited stays
 * waiting, until a start it didn't make, a person's or a sender's, has it take it.
 */
const WAKE_ATTEMPTS = 3;
const WAKE_BACKOFF_MS = 30_000;

const MAILED = `SELECT DISTINCT target_id AS id FROM messages WHERE ${PENDING_MESSAGE} AND kind = 'message'`;

/** Every session something waits on: an undelivered message, or a reload its line quits for, or that is coming back up. */
const WAITING = `${MAILED} UNION SELECT session_id FROM marks WHERE reload IS NOT NULL`;
/** The index syncs at most this often, in its own process, so a search finds little left to catch up on. */
const SYNC_GAP_MS = 5_000;

function log(text: string): void {
	console.error(`${new Date().toISOString()} ${text}`);
}

export async function clock(): Promise<void> {
	const db = openStore();
	/** Why the clock's last start of each session failed, when wake itself refused; one that started and quit leaves none. */
	const refusals = new Map<string, string>();
	let version = -1;
	let due: number | null = null;
	let reconciled = 0;
	const registered = new Set<string>();

	/**
	 * A session starts with remain-on-exit on, so a harness that dies before it registers leaves its last words for the
	 * Deck to show. Once registered, its pane goes when the harness quits, however it was started, unless it's on the
	 * Deck, whose window keeps it for the roster to swap out; and it's no longer starting. Up with nothing waiting on it,
	 * it took what did, so its tries start over now, not when the clock next looks.
	 */
	const settleHosts = () => {
		const hosts = new Map(
			db.all("SELECT tmux_session, session_id FROM runtimes").map((row) => [row.tmux_session as string, row.session_id as string]),
		);
		for (const host of registered) if (!hosts.has(host)) registered.delete(host);
		const waiting = new Set(db.all(WAITING).map((row) => row.id as string));
		for (const [host, id] of hosts) {
			if (registered.has(host)) continue;
			registered.add(host);
			if (!waiting.has(id)) startOver(id);
			const pane = hostPane(host);
			if (pane) tmuxTry(SESSIONS, "set", "-p", "-u", "-t", pane, "remain-on-exit", ";", "set", "-p", "-u", "-t", pane, "@swb_starting");
		}
	};

	/**
	 * Every open session with no process and something waiting on it gets a start, unless it's waiting out its last one
	 * or failed to start. A reload that waited for idle leaves a session cut off meanwhile as it is.
	 */
	const wakeWaiting = (now: number) => {
		reconciled = now;
		const waiting = new Set(db.all(WAITING).map((row) => row.id as string));
		const tries = new Map(
			db
				.all("SELECT session_id, wake_attempts, woken_at FROM marks WHERE wake_attempts IS NOT NULL")
				.map((row) => [row.session_id as string, { n: row.wake_attempts as number, at: row.woken_at as number }]),
		);
		const took = [...tries.keys()].filter((id) => !waiting.has(id));
		for (const id of took) {
			startOver(id);
			tries.delete(id);
		}
		if (waiting.size === 0) return;
		const mailed = new Set(db.all(MAILED).map((row) => row.id as string));
		for (const s of states(db)) {
			if (!waiting.has(s.id) || !s.open || s.live || s.failedToStart) continue;
			if (s.reload === "idle" && s.cutOff) {
				recordTx(db, () => setReload(db, s.id, null));
				continue;
			}
			const tried = tries.get(s.id);
			if (tried && now < tried.at + WAKE_BACKOFF_MS * 2 ** (tried.n - 1)) continue;
			if (tried && tried.n >= WAKE_ATTEMPTS) {
				const why =
					refusals.get(s.id) ?? (mailed.has(s.id) ? "it stopped before it took its messages" : "it stopped before it came back up");
				log(`giving up on ${s.id} after ${WAKE_ATTEMPTS} starts: ${why}`);
				recordTx(db, () => db.run("UPDATE marks SET wake_failure = ? WHERE session_id = ?", why, s.id));
				refusals.delete(s.id);
				continue;
			}
			recordTx(db, () =>
				db.run(
					`INSERT INTO marks (session_id, wake_attempts, woken_at) VALUES (?, 1, ?)
					 ON CONFLICT (session_id) DO UPDATE SET wake_attempts = coalesce(wake_attempts, 0) + 1, woken_at = excluded.woken_at`,
					s.id,
					now,
				),
			);
			try {
				const host = wake(db, s.id, s.reload ?? "idle");
				refusals.delete(s.id);
				log(`waking ${s.id} for its ${s.reload ? "reload" : "mail"} (try ${(tried?.n ?? 0) + 1} of ${WAKE_ATTEMPTS}): ${host}`);
			} catch (error) {
				refusals.set(s.id, (error as Error).message);
				log(`waking ${s.id} failed: ${(error as Error).message}`);
			}
		}
	};

	/** A session that took what waited on it, or has nothing waiting any more, starts its tries over. */
	const startOver = (id: string) => {
		recordTx(db, () => db.run("UPDATE marks SET wake_attempts = NULL, woken_at = NULL, wake_failure = NULL WHERE session_id = ?", id));
		refusals.delete(id);
	};

	/** Whether a reload waits for a session its line has quit, which a data_version change is the first sign of. */
	const reloadWaiting = () => db.get("SELECT 1 FROM marks WHERE reload IS NOT NULL") !== undefined;

	/** A launch that failed is news for the session that scheduled it, in its own harness. */
	const launchFailed = (l: Fired["launches"][number], error: Error) => {
		log(`launching "${l.launch.title}" failed: ${error.message}`);
		recordTx(db, () =>
			db.run(
				`INSERT INTO messages (id, kind, source_id, target_id, body, report_back, created_at, schedule_id, scheduled_for)
				 VALUES (?, 'message', ?, ?, ?, 0, ?, ?, ?)`,
				crypto.randomUUID(),
				l.source,
				l.source,
				`swb couldn't launch ${newSessionName(l.launch)} for this schedule: ${error.message}`,
				Date.now(),
				l.scheduleId,
				l.scheduledFor,
			),
		);
	};

	let stale = true;
	let syncing = false;
	let synced = 0;
	const warm = (now: number) => {
		if (!stale || syncing || now - synced < SYNC_GAP_MS) return;
		stale = false;
		syncing = true;
		synced = now;
		Bun.spawn([SWB, "recall", "sync"], { stdio: ["ignore", "ignore", "inherit"] }).exited.then((code) => {
			syncing = false;
			if (code !== 0) log(`indexing exited ${code}`);
		});
	};

	log(`clock started (pid ${process.pid})`);
	for (;;) {
		const now = Date.now();
		// A tick that fails, as one reading an invalid config.toml does, is tried again: a clock that exited would leave
		// every schedule unfired, with nothing on screen to say so.
		try {
			const current = db.dataVersion();
			if (current !== version) {
				version = current;
				stale = true;
				due = nextDue(db);
				settleHosts();
				if (reloadWaiting()) wakeWaiting(now);
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
						model: l.launch.model,
						effort: l.launch.effort,
						agent: l.launch.agent,
						briefing: l.body,
						cwd: l.launch.cwd,
						title: l.launch.title,
						group: l.launch.group,
						reportBack: l.reportBack,
						scheduled: { id: l.scheduleId, at: l.scheduledFor },
					}).then(
						(result) => log(result.text),
						(error: Error) => launchFailed(l, error),
					);
				}
				wakeWaiting(now);
			} else if (now - reconciled > RECONCILE_MS) wakeWaiting(now);
			warm(now);
		} catch (error) {
			log(`tick failed: ${(error as Error).message}`);
		}
		await Bun.sleep(TICK_MS);
	}
}
