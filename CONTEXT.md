# Agent Switchboard

## Language

### Lifecycle

**Session**:
One agent conversation, identified by its harness session id, tracked from its first turn. Shown by its title, or its id when it has none.

**Open**:
A session that has not been archived, whether or not its process is running.

**Archived**:
A session that has been completed; it leaves the roster but stays listable and reversible.

**Inactive**:
An open session with no activity in the last 72 hours.

### Runtime

**Live**:
A session whose agent process is running in this boot.

**Dormant**:
An open session with no running process; the roster shows it as **Idle** unless it is **Interrupted**.

**Interrupted**:
A dormant session whose process ended mid-turn rather than while idle.

**Managed**:
A session hosted by a pi process that `swb` started in its tmux server. Once a process is managed, every session it hosts counts, including after `/new`, `/resume`, or `/fork`. Processes it spawns, such as subagents, do not; only managed sessions can be reattached.

**Viewer**:
Anything attached to a managed session's tmux session, usually a **Stage**. Closing it detaches without ending the session, and several can share one session.

### Attention

**Activity**:
What a live session's agent is doing right now: **working**, **blocked** on me (e.g. permission prompt), or **idle**.

**Idle**:
The agent finished its turn and is waiting for my next prompt.

**Visit**:
The moment I last looked at a session, by opening it from the **Roster** or focusing its **Viewer**; a timestamp watermark.

**Unseen**:
A session whose agent finished a turn after my last **Visit**.

### Organization

**Deck**:
What `swb` opens: the **Roster** beside a **Stage**, in one disposable layout. Each invocation gets its own.

**Editor**:
The text editor for one directory, shared by every session whose working directory it is; it shows on the **Stage** instead of, or beside, the session.

**Stage**:
Internal term for the Deck's live, interactive view of the selected session; moving the Roster cursor changes which session it shows. Internal term (not in UI).

**View**:
What the **Stage** shows for a session: **pi**, its **Editor**, or a **split** of both. Each session remembers its own.

**Project**:
A git repository together with all of its worktrees; sessions outside any repository group by directory.

**Roster**:
The TUI's sectioned list of sessions: open sessions by **Project**, then **Inactive** by **Project**, then **Archived** flat by recency.

## Relationships

- A **Session** belongs to exactly one **Project**, derived from its working directory
- A **Session** is either **Open** or **Archived**; independently, it is **Live** or **Dormant**
- **Activity** and **Unseen** apply only to **Open** sessions
- pi-sessions **subagents** are never **Sessions** here; their parent's ledger owns them
- A **Managed** session has zero or more **Viewers**; **Live** without a **Viewer** is normal
- A **Deck** has exactly one **Stage**, showing at most one session at a time
