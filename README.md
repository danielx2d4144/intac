# agentvoice (Stage 0)

Voice supervision for coding agents: when your agent finishes a turn or needs
you, it speaks a ~15-second pair-programmer summary — outcome, what changed,
test status, and the question it's waiting on. Full text stays on screen.

**Privacy:** the tail of the agent's last turn goes to the Anthropic API (summary)
and the summary text goes to the OpenAI TTS API — both under YOUR OWN keys.
No server, nothing stored, nothing else leaves your machine. Local usage log:
`~/.agentvoice/usage.jsonl`.

## Setup (both testers)

1. Node 22+. Clone this repo.
2. Keys — create `~/.agentvoice/config.json`:

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "OPENAI_API_KEY": "sk-..."
}
```

(Env vars work too; the config file wins because hooks don't reliably inherit
your shell env.)

## Claude Code (founder)

Add to `~/.claude/settings.json` (merge into existing `hooks` if present):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"C:\\Users\\Hi\\Desktop\\intac\\integrations\\claude-hook.mjs\"" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node \"C:\\Users\\Hi\\Desktop\\intac\\integrations\\claude-hook.mjs\"" }] }
    ]
  }
}
```

## Codex CLI (friend)

Add to `~/.codex/config.toml` (adjust the repo path):

```toml
notify = ["node", "C:\\path\\to\\intac\\hacks\\codex-hack.mjs"]
```

## Gate-week commands

```
node bin/agentvoice.mjs status    # muted or active + log path
node bin/agentvoice.mjs mute      # meetings — becomes desktop notifications (log it, ≤2h/day)
node bin/agentvoice.mjs unmute
node bin/agentvoice.mjs day       # end-of-day question (the gate metric)
node bin/agentvoice.mjs disable   # if you're turning it off — the reason is the data
```

**The gate:** both of us, 5 consecutive coding days (≥3 agent turns/day), zero
disables. Gate-fail = stop the project. Gate-pass = build Stage 1.

## Dev

```
node --test test/unit.test.mjs    # plumbing tests
node evals/run.mjs                # summarizer eval (needs working keys)
node test/smoke.mjs               # end-to-end with audio
```
