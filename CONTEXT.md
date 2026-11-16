# Agent Switchboard

## Language

### Lifecycle

- **Session**: One agent conversation, identified by its harness session id, tracked from its first turn.
- **Archived**: A session that has been completed; it leaves the roster but stays listable and reversible.
- **Inactive**: An open session whose whole **Family** has had no activity within `inactive_after`.
- **Snoozed**: An open session put out of the way until a time or its next message.

### Runtime

- **Live**: A session whose agent process is running in this boot.
- **Dormant**: An open session with no running process.
- **Cut off**: A dormant session whose process ended mid-turn rather than while idle: its harness shut down, it was killed, or the machine restarted. When I wake it, it picks that turn back up.
- **Stopped**: A turn ended early on purpose, by Esc or another session's cancel. The session is idle, and stays so.
- **Errored**: A session whose last turn its provider ended with an error.
- **Managed**: A session hosted by a harness process that `swb` started in its tmux server. Once a process is managed, every session it hosts counts, including after `/new`, `/resume`, `/clear`, or `/fork`. Only managed sessions can be reattached.
- **Harness**: The agent program a Session runs in: pi, Claude Code, or Codex.
- **Line**: A harness's integration with swb, shipped by swb: it records the harness's sessions, gives its agent swb's tools, and delivers its messages. Internal term (not in UI).

### Messages

- **Message**: Text one Session sends another through swb.
- **Schedule**: A Message one Session sets up for later, once or on a cron, to itself, another Session, or a new Session it launches each time.
- **Clock**: The process in swb's tmux server that fires Schedules and starts dormant sessions with Messages waiting. Internal term (not in UI).

### Attention

- **Activity**: What a live session's agent is doing right now: **working**, **blocked** on me (e.g. permission prompt), or **idle**.
- **Visit**: The moment I last looked at a session.
- **Unseen**: A session whose agent finished a turn and I have not yet **visited**.

### Organization

- **Deck**: What `swb` opens: the **Roster** beside a **Stage**. There is one persistent instance, shared by every terminal that opens it.
- **Roster**: The Deck's list of sessions, in sections: **Operators**, open sessions by **Project**, **Inactive**, **Snoozed**, then **Archived**.
- **Stage**: The Deck's live, interactive view of the selected session. Internal term (not in UI).
- **Editor**: The text editor for one directory, shared by every session whose working directory it is.
- **Peek**: A session's particulars and keys, shown beside its Roster row on focus.
- **Overlay**: A box the Deck shows over its panes without moving them or taking the keyboard: a **Peek**, the picker's launch card, its menu. Internal term (not in UI).
- **View**: What the **Stage** shows for a session: some combination of the **agent**, **Editor**, and a shell.
- **Project**: A git repository together with all of its worktrees. Sessions outside a repository use the directory.
- **Operator**: A special session that coordinates other sessions, not associated with any particular **Project**.
- **Group**: A name I associate with alike sessions in a project, as a way to organize the **Roster**.
- **Family**: A session together with every session it started, and those they started, except for **Operators**.

## Relationships

- A **Session** other than an **Operator** belongs to exactly one **Project**, derived from its working directory, and to at most one **Group** within it
- A **Session** is open or **Archived**; independently, it is **Live** or **Dormant**
- **Activity**, **Unseen**, and **Snoozed** apply only to open sessions; a Snoozed session is neither Unseen nor Inactive while it holds
- pi-sessions **subagents**, and Claude Code's and Codex's own subagents, are never **Sessions** here; their parent owns them
- A **Session** started by another records it as its parent; one an **Operator** started is never itself an **Operator**
