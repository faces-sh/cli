# Faces CLI

Command-line interface for [Faces](https://faces.sh). Faces are causal models: compile one from an
author's source texts, then describe a situation and ask it what it would do: it proposes the options
it would weigh, strongest first. It also returns a **cause**, the principal *why* behind that author's
response in context, and typed decisions.

## Installation

```bash
npm install -g @faces-sh/cli
```

Requires Node.js >= 18. Formerly published as `faces-cli`.

## Quick start

```bash
# Register or log in: you will be asked for your password
faces auth:register --email you@example.com --username you
faces auth:login --email you@example.com

# Create a face
faces face:create --name "Alice" --alias alice --default-model gpt-5.4-mini \
  --attr gender=woman --attr age=29 --attr occupation="Works as a product designer."

# Add source texts and compile: her own writing as a document, an interview as a thread
faces compile:doc alice --file essay.txt --medium essay
faces compile:upload alice --file interview.txt --kind thread --face-speaker Alice

# Ask what it would do: the options it would weigh, strongest first
faces choices alice --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"

# Or let it propose the question it would ask
faces choices alice --state "A startup offers me a lead role at a lower salary."

# The cause alone
faces causes alice -m "Should I take the offer?"

# Decide: typed answers, with a cause per question
faces decide alice --state "A colleague asks you to sign a proposal you have not read." \
  --question "Does the speaker sign?"

# Compare and compose
faces face:diff --face alice --face bob
faces face:create --name "Alice-Bob" --alias alice-bob --formula "alice | bob"
```

## Commands

```
faces auth:login / logout / register / whoami / refresh
faces auth:connect / disconnect / connections

faces face:create / list / get / edit / delete / stats / attributes / sources
faces face:diff / neighbors / lock / unlock / publish / unpublish / share / unshare / groups
faces face:avatar:list / get / make / upload / delete
faces face:tag:add / list / remove / set / all

faces choices                     # what a face would do: its options, or the question it would ask
faces causes                      # a face's cause alone
faces decide                      # what a face would decide: yes/no, a choice, or a score
faces state:create / get / items / add / compact / close
faces conversation:create / ...   # the old name for state:*
faces session:create / get / compact / close   # an older name

faces compile:doc / compile:doc:create / list / get / edit / make / pause / reset / delete
faces compile:thread:create / list / get / edit / message / replace / make / pause / reset / delete
faces compile:upload / import / all / status / stats

faces style:upload / make / status / versions / revert / delete

faces models:list                 # the models you can name; --kind takes a list, or all
faces benchmark:start / get / list
faces fidelity:get / pick / save-thread   # starting a run is retired with chat

faces group:create / list / get / edit / delete / members / add / remove
faces group:tag:add / list / remove / set
faces user:get / follow / unfollow / followers / following

faces catalog:list / doctor / backup / restore

faces keys:create / list / revoke / update

faces billing:balance / usage / llm-costs / topup / cards / card-setup / card:default / card:remove
faces billing:subscription / subscription:activate / subscription:plan / subscription:cancel

faces account:state / preferences

faces config:set / show / clear
```

Run `faces <command> --help` for details on any command. Every command takes `--json`, and
`--toon` for a more compact encoding of the same data.

## Documents and threads

A **document** is the face's own writing: an essay, a letter, a paper, a book, a poem. Every word
in it is read as the face's. Writing about the face by someone else can also be a document, with
`--perspective third-person`.

An interview, transcript, dialogue or any other exchange between speakers is a **thread**. Upload
it with `--kind thread` and `--face-speaker` naming the face, so only the face's turns are used:

```bash
faces compile:upload alice --file interview.txt --kind thread --face-speaker Alice
faces compile:upload alice --file podcast.mp3 --kind thread --face-speaker A
```

A labelled dialogue uploaded as a document is read as entirely the face's own words, other
speakers included. The document commands warn when a text file reads as a transcript.

## Choices

`faces choices` asks a face what it would do (`POST /v1/choices`). Describe the situation with
`--state` (prose, at most 3,000 tokens) or `--state-id` (a [state](#states)), and ask with
`--question`:

```bash
faces choices alice --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"
faces choices head:socrates --state-id fs_STATE_ID --question "What should the shop do?" --max-choices 3
faces choices "(alice | bob)" --state-file situation.txt -q "What next?" --model maestro-1-flash
```

With both `--state-id` and `--state`, the prose is an addendum for that one call: read with the
state, never saved to it. Anything that should persist goes in the state as premises, with
`faces state:add --premise`.

The face proposes the options it would weigh, strongest first. Leave `--question` out and it
proposes the question it would ask. `--model` is `maestro-1` (the default) or `maestro-1-flash`,
which answers sooner and costs 10 times more when a question is asked. Prices:
`faces models:list --kind choices`.

## Chat is retired

The API's chat endpoints answer `410`, so the `chat:*` commands are removed, and so are
`fidelity:start`, `fidelity:turn` and `fidelity:run`. Use `faces choices` to ask a face. Runs made
before can still be read with `fidelity:get` and saved with `fidelity:save-thread`. `style:*` still
builds styles, which no route applies now, and `catalog:doctor --generate` is retired.

## States

A state keeps the situation your agent builds on the server: **premises** (named facts, each with
a status and what it depends on), the decisions faces made, and your messages. Hand it to a face
with `faces choices --state-id`, or pass it to `decide` and `causes` with `--conversation`.

```bash
faces state:create alice
faces state:add fs_STATE_ID --premise rent_rises='"12% in March"' --premise-status rent_rises=assumed \
  --premise-description rent_rises="the landlord says rent goes up 12% in March"
faces state:add fs_STATE_ID --premise can_afford=false --premise-depends-on can_afford=rent_rises \
  --premise-description can_afford="the shop can carry the higher rent"
faces decide alice --conversation fs_STATE_ID --depends-on can_afford \
  --state "Decide about the lease." --question "Move the shop to a cheaper street?"
faces state:add fs_STATE_ID --premise rent_rises='"no rise this year"' --premise-status rent_rises=invalidated
faces choices alice --state-id fs_STATE_ID --question "What should the shop do?"
faces state:items fs_STATE_ID
```

A premise is `--premise key=value`, repeatable. The key is 1 to 64 letters, digits, `_` or `-`. The
value is read as JSON when it is JSON (`50000`, `true`, `null`, `["a","b"]`) and as text otherwise;
quote it to keep a number as text: `--premise 'code="007"'`. The first time a key is used it needs
a description: `--premise-description key="what it means"`.

`--premise-status key=status` is `stated` (the default), `verified`, `assumed`, `unresolved` or
`invalidated`. `--premise-depends-on key=a,b` names the premise keys and decision ids it rests on
(`key=` clears it). An invalidated premise invalidates everything that depends on it, and setting it
to another status restores them: `state:add` prints every status that changed, and every earlier
decision that rested on a value you changed. Nothing is decided again for you. `decide
--depends-on` says what a decision rests on, and prints its decision id to name in a later one.

`--conversation`, `--premise`, `--premise-description`, `--premise-status` and
`--premise-depends-on` work on `decide` and `causes`.

States were called conversations, and before that sessions. The `conversation:*` and `session:*`
commands, and `--session`, still work and name the same thing.

## Authentication

Login stores a JWT at `~/.faces/config.json`. You can also authenticate with environment variables:

```bash
export FACES_API_KEY=sk-faces-...
export FACES_TOKEN=your_jwt
export FACES_BASE_URL=https://api.faces.sh   # optional override
```

## Plans

- **Free**: a $5 activation, added as credits. Everything is paid as it goes, from credits.
- **Connect** ($17/month): 25M choices and cause tokens a month (6.25M a week, 1.6M per 5 hours) and
  500k compile source tokens.
- **Pro** ($49/month): 75M choices and cause tokens a month (18.75M a week, 4.8M per 5 hours) and
  1.5M compile source tokens.

Past an allowance, work is paid from credits only with `api_fallback` on (`faces account:preferences`).
Choices cost $0.42 per million input tokens and $1.00 per million output tokens on `maestro-1`;
compiling costs $16 per million source tokens, $21 for a rush. Link a ChatGPT account with
`faces auth:connect openai` and interviews and style builds run on the ChatGPT plan. Current prices:
`faces models:list --kind all`.

## License

MIT. Copyright (c) 2026 Headwaters Lab Inc.
