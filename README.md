# Faces CLI

Command-line interface for [Faces](https://faces.sh). Faces are causal models: compile one from an
author's source texts, then describe a situation and ask it what it would do: it proposes the options
it would weigh, strongest first. A face also steers any chat model's replies, and a decision model's
typed decisions.

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
faces choices @alice:maestro-1 --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"

# Or let it propose the question it would ask
faces choices @alice:maestro-1 --state "A startup offers me a lead role at a lower salary."

# Chat: the face steers, gpt-5.4 writes the reply
faces chat:chat @alice:maestro-1/gpt-5.4 -m "Should I take the offer?"

# Decide: typed answers from a decision model, steered by the face
faces decide @alice:maestro-1/jev-latest --state "A colleague asks you to sign a proposal you have not read." \
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
faces chat:chat / messages / responses / thread   # chat with a face on any chat model
faces decide                      # what a face would decide: yes/no, a choice, or a score
faces state:create / get / items / add / compact / close
faces conversation:create / ...   # the old name for state:*
faces session:create / get / compact / close   # an older name

faces compile:doc / compile:doc:create / list / get / edit / make / pause / reset / delete
faces compile:thread:create / list / get / edit / message / replace / make / pause / reset / delete
faces compile:upload / import / all / status / stats

faces style:upload / make / status / versions / revert / delete

faces models:list                 # the models you can name; --kind takes a list, or all
faces media:list                  # the media a document can be, with what each covers
faces benchmark:start / get / list
faces fidelity:start / turn / pick / get / run / save-thread

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

A document's `--medium` is one of the 25 media `faces media:list` shows, each with what it
covers: a keynote is a `speech`, a diary a `journal entry`. A subcategory is not accepted.

A labelled dialogue uploaded as a document is read as entirely the face's own words, other
speakers included. The document commands warn when a text file reads as a transcript.

## Naming a model

Every command that runs a face takes one `model`, written the way the API takes it: our
**upstream** model (a face and its maestro) over a **downstream** model (the model that writes the
answer), as a fraction:

| `model` | Command |
|---|---|
| `@alice:maestro-1` | `faces choices` (the upstream model answers) |
| `@alice:maestro-1/gpt-5.4` | `faces chat:*` |
| `@alice:maestro-1/jev-latest` | `faces decide` |
| `@dana~alice:maestro-1/gpt-5.4` | another account's face, published or shared with you |
| `(@alice \| @bob):maestro-1-flash/gpt-5.4` | a composite, with `\|`, `&`, `-` and `^` |

Your own face is `@alice`; another account's is `@owner~alice` (a system face is `@head~socrates`).
`maestro-1-flash` answers sooner and costs 10 times more on the upstream part. Everything after the
first `/` is the downstream model's id as `faces models:list` lists it. Quote a composite, because
the shell reads `|` and `&`. A plain model with no face is not served, and the old forms
(`alice@gpt-5.4`, a bare alias, `owner:alias`) are refused with the new form to use.

## Choices

`faces choices` asks a face what it would do (`POST /v1/choices`). Describe the situation with
`--state` (prose, at most 3,000 tokens) or `--state-id` (a [state](#states)), and ask with
`--question`:

```bash
faces choices @alice:maestro-1 --state "A startup offers me a lead role at a lower salary." --question "Should I take the offer?"
faces choices @head~socrates:maestro-1 --state-id fs_STATE_ID --question "What should the shop do?" --max-choices 3
faces choices "(@alice | @bob):maestro-1-flash" --state-file situation.txt -q "What next?"
```

With both `--state-id` and `--state`, the prose is an addendum for that one call: read with the
state, never saved to it. Anything that should persist goes in the state as premises, with
`faces state:add --premise`.

The face proposes the options it would weigh, strongest first. Leave `--question` out and it
proposes the question it would ask. With `--state-id` and a question, the options are also added
to the state: each is printed with its id (`opt_...`), and the list with its own (`cho_...`). A
premise or a decision that rests on an option names its id in `--premise-depends-on` or
`--depends-on` (the list's id names all of its options), and a decision resting on it, directly or
through a premise, is shown why the face proposed it. Prices: `faces models:list --kind upstream`.

## Chat

`faces chat:chat` sends your message to a face: the face steers, and the downstream model writes
the reply. It picks `/v1/chat/completions`, `/v1/responses` or `/v1/messages` from the model
catalog; `chat:messages` and `chat:responses` force one. `chat:thread` keeps a multi-turn
conversation under `~/.faces/threads`.

```bash
faces chat:chat @alice:maestro-1/gpt-5.4 -m "What matters most to you in your work?"
faces chat:chat "(@socrates | @nietzsche):maestro-1/claude-sonnet-4-6" -m "What is virtue?"
faces chat:thread @alice:maestro-1/gpt-5.4 -m "Should I take the offer?"
faces chat:thread --id t_THREAD_ID -m "And if they raise the salary?"
faces chat:chat @alice:maestro-1/gpt-5.4 -m "So what now?" --conversation fs_STATE_ID
```

The face's style is chosen for each request, from the face's built styles. `style:*` builds them.

## States

A state keeps the situation your agent builds on the server: **premises** (named facts, each with
a status and what it depends on), the decisions faces made, and your messages. Hand it to a face
with `faces choices --state-id`, or pass it to `chat:*` and `decide` with `--conversation`.

```bash
faces state:create @alice
faces state:add fs_STATE_ID --premise rent_rises='"12% in March"' --premise-status rent_rises=assumed \
  --premise-description rent_rises="the landlord says rent goes up 12% in March"
faces state:add fs_STATE_ID --premise can_afford=false --premise-depends-on can_afford=rent_rises \
  --premise-description can_afford="the shop can carry the higher rent"
faces decide @alice:maestro-1/jev-latest --conversation fs_STATE_ID --depends-on can_afford \
  --state "Decide about the lease." --question "Move the shop to a cheaper street?"
faces state:add fs_STATE_ID --premise rent_rises='"no rise this year"' --premise-status rent_rises=invalidated
faces choices @alice:maestro-1 --state-id fs_STATE_ID --question "What should the shop do?"
faces state:items fs_STATE_ID
```

A premise is `--premise key=value`, repeatable. The key is plain text, 1 to 120 characters on one
line, split from the value at the first `=`: `--premise 'everyone can eat=yes'`. A key that holds
`=` goes in double quotes, as a JSON string: `--premise '"a=b"=yes'`. In a list (`a,b`), a key that
holds a comma goes in double quotes too: `--depends-on '"x, y",costs under $100?'`. The
value is read as JSON when it is JSON (`50000`, `true`, `null`, `["a","b"]`) and as text otherwise;
quote it to keep a number as text: `--premise 'code="007"'`. The first time a key is used it needs
a description: `--premise-description key="what it means"`.

`--premise-role key=wanted` marks a premise as a goal, the outcome the state is working toward.
`--premise-origin key=origin` says who set it: `human`, `agent`, `tool` or `web`. For both, `key=`
clears it, and a newer value without the flag keeps what the key had.

`--premise-status key=status` is `stated` (the default), `verified`, `assumed`, `unresolved` or
`invalidated`. `--premise-depends-on key=a,b` names the premise keys, decision ids and option ids it rests
on (`key=` clears it). An option never invalidates anything. An invalidated premise invalidates everything that depends on it, and setting it
to another status restores them: `state:add` prints every status that changed, and every earlier
decision that rested on a value you changed. Nothing is decided again for you. `decide
--depends-on` says what a decision rests on, and prints its decision id to name in a later one.

`--conversation`, `--premise`, `--premise-description`, `--premise-status` and
`--premise-depends-on` work on `chat:*` and `decide`.

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
- **Connect** ($17/month): 25M choices and steering tokens a month (6.25M a week, 1.6M per 5 hours) and
  500k compile source tokens.
- **Pro** ($49/month): 75M choices and steering tokens a month (18.75M a week, 4.8M per 5 hours) and
  1.5M compile source tokens.

Past an allowance, work is paid from credits only with `api_fallback` on (`faces account:preferences`).
Choices cost $0.42 per million input tokens and $1.00 per million output tokens on `maestro-1`.
On chat and decisions the steering costs $0.42 per million input tokens plus $0.00042 a call, with no
output charge, and the downstream model its listed price plus 5%. `maestro-1-flash` is 10 times the
`maestro-1` price, on the upstream part only. Compiling costs $16 per million source tokens, $21 for a rush. Link a ChatGPT account with
`faces auth:connect openai` and interviews and style builds run on the ChatGPT plan. Current prices:
`faces models:list --kind all`.

## License

MIT. Copyright (c) 2026 Headwaters Lab Inc.
