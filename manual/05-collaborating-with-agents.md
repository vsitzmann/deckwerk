# Collaborating with agents

DeckWerk presentations are ordinary folders, and that folder is the agent
interface. DeckWerk does not run an agent, own an agent account, or require an
agent-specific server for a presentation on your computer.

Open the presentation in DeckWerk, click **Agent…**, and copy the displayed
deck-folder path. Open Codex, Claude Code, or another filesystem-based agent
in that folder. Its `AGENTS.md` explains the complete authoring loop.

The agent normally starts with `slide-agent context`, then either exports
existing slides with `slide-agent inspect --html` or creates an add-only page
with `slide-agent new`. It edits the resulting file beneath `edit/`. While
DeckWerk is open, saving that HTML updates the presentation automatically as
one undoable History entry. No mirrored folder or collaboration server sits
between the agent and the editor.

Each generated authoring page contains this metadata:

```html
<meta name="deckwerk-change-label" content="">
```

The agent should fill in a concise description of its intent, such as "Add the
training-pipeline overview". DeckWerk uses that text in History. If it remains
empty, DeckWerk writes an operation summary such as "Added 2 slides" or
"Updated 3 slides" rather than exposing the authoring filename.

Agents can read, reply to, and resolve comments, which makes comments a useful
way to leave precise requests on a slide or object.

## Hosted presentations

A presentation open in browser collaboration is different: the real deck
folder lives on the host, so a remote agent cannot edit it directly. In that
case **Agent…** copies a prompt for your agent. Pasted into Claude Code, Codex
or a similar agent, it has the agent start the server's bridge itself, which
creates a local mirror and keeps it synchronized with the authoritative
collaboration session. The agent sees the same files and commands, while the bridge provides
remote transport, participant attribution, shared ordering, activity, and the
source/imported scratchpad.

See [Running a headless collaboration server](06-headless-server.md) for that
workflow.
