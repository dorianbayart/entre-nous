# entrenous

**Entre Nous in your terminal**: a smart clipboard, shared across all your devices (phone, Mac,
PC, browser), end-to-end encrypted, ephemeral, no account, no trace. Send a file from a server to your phone,
get a photo from your phone into a script, let an AI agent hand you what it made.

```console
$ entrenous send build/app.apk
✓ Sent to “My devices”: app.apk (48.2 MB)
$ entrenous wait --timeout 10m
Hello from the phone
```

[Documentation](https://github.com/dorianbayart/entre-nous/blob/master/docs/en/cli.md) ·
[Documentation en français](https://github.com/dorianbayart/entre-nous/blob/master/docs/cli.md) ·
[Entre Nous](https://entrenous.0xdba.dev)

## Install

Node.js 22 or newer. One file, no dependencies.

```sh
npm install -g https://github.com/dorianbayart/entre-nous/releases/latest/download/entrenous-cli.tgz
```

## Start

```sh
entrenous join 'https://entrenous.0xdba.dev/app/#p=…'   # link from Settings → Invite a device
# or
entrenous create && entrenous invite                     # then scan the QR code with your phone
```

## Use

```sh
entrenous send report.pdf photo.jpg      # files
entrenous send -m "the code: 4821"       # a text
git diff | entrenous send                # standard input
entrenous list                           # the history
entrenous get                            # print the latest text, or save the latest file
entrenous wait --timeout 10m             # wait for the next item from another device
entrenous watch -o ~/Downloads/          # save everything that arrives, until Ctrl-C
entrenous note "Deploy? yes/no"          # the shared note, live on every device
entrenous status                         # this device, its groups, who is online
```

Every command has `--help` and `--json`. Results go to stdout, messages to stderr; exit codes are
documented (`124` on timeout, `3` without a group…), so it fits in scripts and in AI agents' hands.

## Security

Same engine and same encryption as the apps (X-Wing post-quantum key exchange, XChaCha20-Poly1305,
Ed25519): the relay only ever sees encrypted data. The CLI writes no content to disk, only this
device's keys, in a folder readable by your user alone (`~/.local/share/entrenous`,
`%LOCALAPPDATA%\entrenous`). [How it works](https://github.com/dorianbayart/entre-nous/blob/master/docs/en/security.md).

## License

AGPL-3.0-or-later
