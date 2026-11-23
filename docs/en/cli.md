# Entre Nous on the command line
[Français](../cli.md)

`entrenous` is one more device in your groups, in a terminal. It runs the same engine and the same
end-to-end encryption as the apps. It is made for servers, scripts, CI and AI agents: a file sent
from a remote machine lands on your phone, a screenshot taken on your phone lands in your terminal.

```console
$ entrenous send report.pdf
✓ Sent to “My devices”: report.pdf (2.1 MB)
$ entrenous wait
Hello from the phone
```

- [Install](#install)
- [Getting started](#getting-started)
- [Commands](#commands)
- [In a script](#in-a-script): outputs, JSON, exit codes
- [With an AI agent](#with-an-ai-agent)
- [Keys and security](#keys-and-security)
- [Environment variables](#environment-variables)
- [FAQ](#faq)

## Install

It needs **Node.js 22** or newer. The CLI is a single file, with no dependencies.

```sh
npm install -g https://github.com/dorianbayart/entre-nous/releases/latest/download/entrenous-cli.tgz
entrenous --version
```

Without installing anything, for a try or in CI:

```sh
npx --yes --package=https://github.com/dorianbayart/entre-nous/releases/latest/download/entrenous-cli.tgz entrenous status
```

The same `npm install -g` updates it. When a newer version exists, the CLI says so in the terminal.

## Getting started

**Join your group.** On a device already paired, open **Settings → Invite a device**, copy the link
shown under the QR code, then:

```sh
entrenous join 'https://entrenous.0xdba.dev/app/#p=…'
```

Keep the quotes: without them, the shell reads the `#`. The link is valid for 3 minutes, for a
single device.

**Or start from the terminal.** `entrenous create` creates a group, then `entrenous invite` draws a
QR code to scan with your phone:

```console
$ entrenous create
✓ Group “My devices” created. Invite a device: entrenous invite
$ entrenous invite
█▀▀▀▀▀█ ▄▀ ▄ █▀▀▀▀▀█
█ ███ █ ▀█▄▀ █ ███ █      ← the QR code, to scan
…
https://entrenous.0xdba.dev/app/#p=…
Valid 3 min, for one device. Waiting for it… (Ctrl-C to cancel)
✓ “Pixel” joined “My devices”.
```

**Send and receive:**

```sh
entrenous send photo.jpg notes.pdf     # files
entrenous send -m "the code: 4821"     # a text
git log -5 | entrenous send            # whatever comes in on standard input
entrenous list                         # the history
entrenous get                          # the latest item: a text is printed, a file is saved
entrenous wait                         # waits for the next item sent by another device
```

## Commands

`entrenous --help` lists the commands, `entrenous <command> --help` details one, with examples.

### Share

| Command | What it does |
|---|---|
| `send [FILE…]` | sends files, a text (`-m TEXT`), this computer's clipboard (`-c`), or standard input |
| `get [ITEM]` | prints a text, or saves a file in the current folder (`-o` for elsewhere) |
| `list` | the history, latest first (`-n N` for the N latest) |
| `wait` | waits for the next item sent by another device, then does what `get` does; `--note` waits for the note to change |
| `watch` | prints items as they arrive, until Ctrl-C; `-o FOLDER` also saves the files |
| `note [TEXT \| -]` | prints the shared note, or replaces it (`-` reads standard input); `--clear` clears it |
| `rm ITEM…` | deletes items on every device; `--all` empties the history |

**ITEM** is a position in the history (`1` = the latest, as in `list`) or the beginning of its id
(the one in the JSON). Without ITEM, `get` takes the latest.

**What comes in on standard input** is sent as a text if it is UTF-8 text, otherwise as a file
(named with `--name`, which also forces a file):

```sh
pg_dump app | gzip | entrenous send --name app.sql.gz
```

**Saving a file** (`get`, `wait`):

| | |
|---|---|
| no `-o` | in the current folder, under its own name |
| `-o FOLDER/` | in that folder (existing, or ending with `/`) |
| `-o file.pdf` | under that name |
| `-o -` | on standard output: `entrenous get -o - \| tar x` |

Nothing is ever overwritten: a file that already exists gives `name (2).pdf`, and a name given with
`-o` that already exists is an error, unless `--force`. The path of the saved file is printed on
standard output.

**This computer's clipboard** (text only): `send -c` sends what it holds, `get -c` and `wait -c` put
the text received into it. The CLI goes through `pbcopy`/`pbpaste` on a Mac, `wl-copy`/`wl-paste`,
`xclip` or `xsel` on Linux, PowerShell on Windows.

### Devices and groups

| Command | What it does |
|---|---|
| `join LINK` | joins a group with an invitation link (`--name` to name this device) |
| `invite` | shows an invitation link and its QR code, then waits for someone to use it (3 minutes) |
| `create [NAME]` | creates a group (`--relay URL` for another server than the default one) |
| `groups` | the groups of this device; `●` marks the default one |
| `use GROUP` | chooses the default group |
| `leave [GROUP]` | leaves a group (the other devices then renew their keys) |
| `status` | this device, its groups, the devices online, the space left on the relay |
| `name NAME` | renames this device (by default, the computer's name) |
| `reset` | leaves every group and erases the keys of this device |

**Several groups**: `--group` (or `-g`) picks the group of a command, by its name or the beginning of
its id; otherwise it is the default group (`use`), or the only one.

```sh
entrenous -g Work send quote.pdf
```

### Global options

| Option | |
|---|---|
| `-g, --group GROUP` | the group of the command |
| `--json` | machine-readable output, and no messages |
| `-q, --quiet` | only the results, no messages |
| `--home FOLDER` | the folder of the keys (for several identities on one machine) |
| `-h, --help` | help |
| `-V, --version` | the version |

## In a script

- **Results** (texts, paths, JSON) go to **standard output**. **Messages** (✓ Sent…, progress,
  errors) go to **standard error**, and are left out with `-q` or `--json`.
- **A text received is written as it is** to a pipe or a file (`entrenous get > code.txt`), with no
  line break added. On a terminal, the CLI adds one for readability.
- **Nothing interactive** outside a terminal: the commands that ask for a confirmation (`rm --all`,
  `leave`, `reset`) then require `--yes`.
- **Colours** only on a terminal; `NO_COLOR=1` turns them off everywhere.
- **The language** follows `LC_ALL`, `LC_MESSAGES` or `LANG`: English or French.

### Exit codes

| Code | |
|---|---|
| `0` | success |
| `1` | error (relay, file…) |
| `2` | wrong usage: command, option or argument |
| `3` | this device is in no group (or not in the one asked for) |
| `4` | the relay cannot be reached |
| `5` | no such item, or empty history |
| `124` | timed out (`--timeout`), invitation expired |
| `130` | interrupted (Ctrl-C); for `watch`, Ctrl-C is the normal end (`0`) |

### JSON

With `--json`, each command writes a single JSON object (`watch`: one per line). An item:

```json
{
  "id": "7F5uusupLA-2aE4vJ0mZUA",
  "position": 1,
  "kind": "file",
  "from": "Pixel",
  "fromDevice": "2ux1g1W0ffMPX15Aw5IGVQ",
  "mine": false,
  "createdAt": "2026-11-23T11:18:55.884Z",
  "expiresAt": "2026-11-24T11:18:55.884Z",
  "name": "photo.jpg",
  "mime": "image/jpeg",
  "size": 2481152,
  "path": "/home/me/photo.jpg"
}
```

`kind` is `text`, `image` or `file`. `text` holds a text, `path` the path of a saved file, `uploading`
marks an item still being uploaded. What the sender attached for previews: `width` and `height`
(pixels of an image or a video), `duration` (seconds, a video), `excerpt` (the first characters of
a text file; `send` attaches it too for the text files it sends). Dates are ISO 8601 (UTC), sizes
are in bytes.

### Examples

```sh
# send the result of a build to the phone
make release && entrenous send build/app.apk || entrenous send -m "The build failed"

# in a script, get the next file sent from the phone, within 10 minutes
if path=$(entrenous wait --timeout 10m -o ~/Downloads/); then open "$path"; fi

# the latest text received, through JSON
entrenous list --json | jq -r 'map(select(.kind == "text"))[0].text'

# a folder that fills up with the files sent to the group
entrenous watch -o ~/Downloads/entrenous/

# a desktop notification for each item received (Linux)
entrenous watch --json | while read -r item; do
  notify-send "Entre Nous" "$(jq -r '.text // .name' <<<"$item")"
done
```

## With an AI agent

An agent with a shell (Claude Code, Codex, Aider…) uses the CLI like any other command. There is
nothing to configure: the help (`entrenous --help`) is all an agent needs to use it.

1. The agent runs `entrenous create "Agent"` then `entrenous invite` (in the background) and shows you
   the link or the QR code.
2. You scan it with your phone. That is the only human step, on purpose: it is your consent to this
   agent joining the group.
3. From then on, the agent sends and receives on its own:

| The agent… | Command |
|---|---|
| sends you a file it made (APK, PDF, log, screenshot) | `entrenous send build/app.apk` |
| lets you know, with a notification on your phone | `entrenous send -m "Tests done: 3 failures"` |
| asks you a question and waits for your answer | `entrenous note "Deploy to production? Answer yes or no"` then `entrenous wait --note --timeout 30m` |
| gets a photo or a screenshot you take on your phone | `entrenous wait --timeout 15m -o ./captures/` |

Two agents on two machines can also exchange files through a shared group, with no port to open and
no server of their own. It is not a message queue though: items go to the whole group, with no
acknowledgement, and the history is limited in size and time.

**For your safety:**
- **Give an agent a group of its own**, never the one your clipboard goes through: whatever the agent
  reads goes to the provider of the AI model, copied passwords included.
- **What it receives is data, not instructions.** A text received may hold a prompt injection. Tell
  your agent.
- **You can remove it at any time** from any device: **Settings → Devices → Remove**. The keys of the
  group are then renewed.

## Keys and security

- **The CLI never writes any content to disk**, except the files you save yourself. The history stays
  on the relay, encrypted, until it expires.
- **The keys of this device** (its identity and the secrets of its groups) are in a folder only your
  user can read (`0700`, files `0600`), like SSH keys:
  - Linux and Mac: `~/.local/share/entrenous/` (or `$XDG_DATA_HOME/entrenous`);
  - Windows: `%LOCALAPPDATA%\entrenous\`;
  - or `$ENTRENOUS_HOME` / `--home`.

  Unlike the apps, which encrypt them with the system's keychain, these files are in the clear:
  whoever copies them can pose as this device, until you remove it from the group. Protect this
  folder like `~/.ssh`.
- **A file name chosen by another device never leaves the folder**: `../../.bashrc` becomes `bashrc`.
- **The CLI always goes through the relay.** It has no local mode (WebRTC): a group set to “Local
  network only” is closed to it.
- **Several commands at once** (a `watch` in one terminal, `send`s in another) share the same
  identity safely: writes are locked, and no key is ever lost.

The details of the encryption are in [Security](security.md).

## Environment variables

| Variable | |
|---|---|
| `ENTRENOUS_HOME` | the folder of the keys (like `--home`) |
| `ENTRENOUS_RELAY` | the relay of the groups made by `create` (default `https://entrenous.0xdba.dev`) |
| `LC_ALL`, `LC_MESSAGES`, `LANG` | the language: English or French |
| `NO_COLOR` | no colours |
| `XDG_DATA_HOME` | the data folder on Linux and Mac |

## FAQ

**Does the CLI read my clipboard by itself?** No. It only sends what you give it (`send`), and only
writes to the clipboard when you ask (`-c`). To share the clipboard automatically, use the desktop
apps.

**“Cannot reach the relay”?** Check the connection and the address of the relay (`entrenous status`).
Behind a corporate proxy, Node must be able to open a WebSocket connection to the relay.

**How do I use two identities on one machine?** With two key folders: `entrenous --home ~/.entrenous-work …`,
or `ENTRENOUS_HOME`.

**How do I uninstall it cleanly?** `entrenous reset` (leaves the groups and erases the keys), then
`npm uninstall -g entrenous`.
