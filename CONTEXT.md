# Agent Switchboard

## Language

### Lifecycle

**Session**:
One agent conversation, identified by its harness session id, tracked from its first turn.

**Archived**:
A session that has been completed; it leaves the roster but stays listable and reversible.

**Inactive**:
An open session with no activity within `inactive_after` (72 hours).

### Runtime

**Live**:
A session whose agent process is running in this boot.

**Dormant**:
An open session with no running process.

**Interrupted**:
A dormant session whose process ended mid-turn rather than while idle.

**Managed**:
A session hosted by a pi process that `swb` started in its tmux server. Once a process is managed, every session it hosts counts, including after `/new`, `/resume`, or `/fork`. Processes it spawns, such as subagents, do not; only managed sessions can be reattached.

### Attention

**Activity**:
What a live session's agent is doing right now: **working**, **blocked** on me (e.g. permission prompt), or **idle**, its turn finished and waiting for my next prompt.

**Visit**:
The moment I last looked at a session, by focusing its pi for a second, on the **Stage** or in any other tmux client attached to it; a timestamp watermark.

**Unseen**:
A session whose agent finished a turn after my last **Visit**.

### Organization

**Deck**:
What `swb` opens: the **Roster** beside a **Stage**, in one disposable layout. Each invocation gets its own.

**Roster**:
The Deck's list of sessions, in sections: **Operators**, open sessions by **Project**, **Inactive**, then **Archived**.

**Stage**:
Internal term for the Deck's live, interactive view of the selected session; moving the Roster cursor changes which session it shows. Internal term (not in UI).

**Editor**:
The text editor for one directory, shared by every session whose working directory it is.

**Peek**:
A session's particulars and keys, shown beside its Roster row over the **Stage** while the pointer rests on the row or the cursor has just moved onto it. It never covers the Roster.

**View**:
What the **Stage** shows for a session: **pi**, its **Editor**, or a **split** of both. Each session remembers its own.

**Project**:
A git repository together with all of its worktrees; sessions outside any repository group by directory.

**Operator**:
A session whose working directory is swb's Operator folder. It coordinates the other sessions instead of working in a **Project**, belongs to none, and never goes **Inactive**.

**Group**:
A name I give a session, scoping it within its **Project**. A Group exists only while some session carries its name: the last one archived takes it away, and unarchiving one brings it back. A session with no Group falls back to its worktree's bucket under `group_by = "worktree"`, or sits directly under its **Project**.

## Relationships

- A **Session** other than an **Operator** belongs to exactly one **Project**, derived from its working directory, and to at most one **Group** within it
- A **Session** is open or **Archived**; independently, it is **Live** or **Dormant**
- **Activity** and **Unseen** apply only to open sessions
- pi-sessions **subagents** are never **Sessions** here; their parent's ledger owns them
