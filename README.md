# Faces CLI

Command-line interface for [Faces](https://faces.sh). Faces are causal models: compile one from an
author's source texts, and when prompted it returns a **cause**, the principal *why* behind that
author's response in context. Get the cause alone, or let it steer any supported model through the
chat and decision wrappers.

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

# The cause alone
faces causes alice -m "Should I take the offer?"

# Chat: the face's cause steers the model's answer
faces chat:chat alice -m "What matters most to you?"
faces chat:chat alice -m "Tell me more" --llm claude-sonnet-4-6 --show-cause

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

faces causes                      # a face's cause alone
faces chat:chat / messages / responses / thread
faces decide                      # what a face would decide: yes/no, a choice, or a score
faces conversation:create / get / items / add / compact / close
faces session:create / get / compact / close   # the old name for conversations

faces compile:doc / compile:doc:create / list / get / edit / make / pause / reset / delete
faces compile:thread:create / list / get / edit / message / replace / make / pause / reset / delete
faces compile:upload / import / all / status / stats

faces style:upload / make / status / versions / revert / delete

faces models:list                 # the models you can name; --kind takes a list, or all
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

A labelled dialogue uploaded as a document is read as entirely the face's own words, other
speakers included. The document commands warn when a text file reads as a transcript.

## Styles

A style is built from a face's own writing in one medium, and applied on chat with `--style`:

```bash
faces style:make alice --all
faces chat:chat alice -m "Reply to the note below." --style email
```

`--medium` says what the reply is without applying a built style. A style adds roughly 2,000 to
3,500 input tokens per request.

A build runs at no charge on Connect or Pro with a linked ChatGPT account. Anywhere else it is
charged to credits at the build model's listed price, so `style:make` needs `--allow-paid`.

## Conversations

A conversation keeps the whole exchange on the server: your messages, each face's reply with its
cause, decisions, and **premises**, named facts your decisions depend on. Send only what is new on
each turn; the conversation so far is read before it.

```bash
faces conversation:create alice          # leave the face out to take any of your faces
faces chat:chat alice -m "Is this vendor worth a closer look?" --conversation fs_CONVERSATION_ID \
  --premise budget_usd=50000 --premise-description budget_usd="the most we can spend this year"
faces decide alice --conversation fs_CONVERSATION_ID --state "The vendor sent a contract." \
  --question "Does the speaker sign?"
faces conversation:add fs_CONVERSATION_ID --premise vendor_certified=false \
  --premise-description vendor_certified="the vendor holds a security audit report"
faces conversation:items fs_CONVERSATION_ID
faces conversation:compact fs_CONVERSATION_ID
faces chat:chat alice -m "So what do I tell them tomorrow?" --compaction fcmp_COMPACTION_ID
```

`--conversation`, `--premise` and `--premise-description` work on `chat:chat`, `chat:messages`,
`chat:responses`, `chat:thread`, `decide` and `causes`.

A premise is `--premise key=value`, repeatable. The key is 1 to 64 letters, digits, `_` or `-`. The
value is read as JSON when it is JSON (`50000`, `true`, `null`, `["a","b"]`) and as text otherwise;
quote it to keep a number as text: `--premise 'code="007"'`. The first time a key is used it needs
a description, given by key: `--premise-description key="what it means"`. A newer value of a key
replaces it from then on, and `conversation:add` lists every earlier decision made under the old
value. Nothing is decided again for you.

In a conversation that takes any face, each turn names its face, and `--no-causes-visible` on
`conversation:create` (or on a turn) keeps each face from reading the others' causes. Compacting
one names the face: `faces conversation:compact fs_CONVERSATION_ID alice`.

Conversations were called sessions. The `session:*` commands and `--session` still work and name
the same thing.

## Authentication

Login stores a JWT at `~/.faces/config.json`. You can also authenticate with environment variables:

```bash
export FACES_API_KEY=sk-faces-...
export FACES_TOKEN=your_jwt
export FACES_BASE_URL=https://api.faces.sh   # optional override
```

## Plans

- **Free**: a $5 activation, added as credits. Everything is paid as it goes, from credits.
- **Connect** ($17/month) and **Pro** ($49/month): monthly compile and cause allowances. Link a
  ChatGPT account with `faces auth:connect openai`, and Codex-eligible models
  (`faces models:list --chatgpt`) run on the ChatGPT plan at `/v1/responses`. The cause is still billed, from the
  allowance and then credits.

Answering models are charged at the model's listed price plus 5%. Current prices: `faces models:list`
and `faces billing:llm-costs`.

## License

MIT. Copyright (c) 2026 Headwaters Lab Inc.
