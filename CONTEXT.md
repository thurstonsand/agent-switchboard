# Agent Switchboard

## Language

### Lifecycle

**Session**:
One agent conversation, identified by its harness session id, tracked from its first turn.

**Archived**:
A session that has been completed; it leaves the roster but stays listable and reversible.

**Inactive**:
An open session whose whole **Family**, leaving out its **Snoozed** members, has had no activity within `inactive_after` (72 hours).

**Snoozed**:
An open session put out of the way until a time or its next message. A timed snooze holds through any conversation; a next-message one ends with the next message or prompt. A blocked, cut-off, or errored session shows anyway, and one whose time runs out comes back Unseen.

### Runtime

**Live**:
A session whose agent process is running in this boot.

**Dormant**:
An open session with no running process.

**Cut off**:
A dormant session whose process ended mid-turn rather than while idle: its harness shut down, it was killed, or the machine restarted. When I wake it, it picks that turn back up; a wake to deliver a Message doesn't.

**Stopped**:
A turn ended early on purpose, by Esc or another session's cancel. The session is idle, and stays so.

**Errored**:
A session whose last turn its provider ended with an error. It stays idle, marked like a cut-off one, until its next turn starts.

**Managed**:
A session hosted by a harness process that `swb` started in its tmux server. Once a process is managed, every session it hosts counts, including after `/new`, `/resume`, `/clear`, or `/fork`. Processes it spawns, such as subagents, do not; only managed sessions can be reattached.

**Harness**:
The agent program a Session runs in: pi, Claude Code, or Codex.

**Line**:
A harness's integration with swb, shipped by swb: it records the harness's sessions, gives its agent swb's tools, and delivers its messages. Internal term (not in UI).

### Messages

**Message**:
Text one Session sends another through swb. It waits in swb's db until the recipient's line delivers it: mid-turn when the recipient is working and its harness allows, as a new turn when it's idle, and after waking it when it's dormant.

#**Schedule**:
A Message one Session sets up for later, once or on a cron, to itself, another Session, or a new Session it launches each time. A run missed while the machine slept fires once when it wakes, saying when it was due.

**Clock**:
The process in swb's tmux server that fires Schedules and starts dormant sessions with Messages waiting. Internal term (not in UI).

## Attention

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
The Deck's list of sessions, in sections: **Operators**, open sessions by **Project**, **Inactive**, **Snoozed**, then **Archived**.

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
A name I give a session, scoping it within its **Project**. A Group exists only while some session carries its name: the last one archived takes it away, and unarchiving one brings it back. A session another starts begins in its parent's Group, when both are in one **Project**; from then on, each one's Group is its own, and a session with none sits directly under its **Project**.

**Family**:
A session together with every session it started, and those they started, short of an **Operator**. The **Roster** nests a session under its parent while both sit in one Group or Project.

## Relationships

- A **Session** other than an **Operator** belongs to exactly one **Project**, derived from its working directory, and to at most one **Group** within it
- A **Session** is open or **Archived**; independently, it is **Live** or **Dormant**
- **Activity**, **Unseen**, and **Snoozed** apply only to open sessions; a Snoozed session is neither Unseen nor Inactive while it holds
- pi-sessions **subagents**, and Claude Code's and Codex's own subagents, are never **Sessions** here; their parent owns them
- A **Session** started by another records it as its parent; one an **Operator** started is never itself an **Operator**
