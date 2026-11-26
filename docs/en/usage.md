# Using Entre Nous
[Français](../utilisation.md)

Copy on one device, paste on another. No account: your devices form a **group**, paired by
QR code.

```mermaid
flowchart LR
  A["1. Install Entre Nous<br/>or open the web app"] --> B["2. Settings →<br/>Invite a device"]
  B --> C["3. Scan the QR code<br/>with the other device"]
  C --> D["4. Copy, paste"]
```

## 1. Install

| Device | How |
|---|---|
| Mac | download the zip from the home page and drag **Entre Nous** into Applications; the app lives in the menu bar |
| Android | download the APK and open it (Android asks you to allow the install) |
| Linux | `.deb` package (Debian, Ubuntu…) or `.AppImage` (any distribution); icon in the system tray |
| Windows | `.exe` installer; icon in the system tray |
| iPhone, iPad | open the web app in Safari, then **Share → Add to Home Screen**, and launch it from that icon |
| Other | the web app, in any recent browser |
| Terminal | `entrenous`, on the command line (Node.js 22): see [Entre Nous on the command line](cli.md) |

On first launch, a computer creates a "My devices" group on its own.

## 2. Pair your devices

1. On a device that's already paired: **Settings → Invite a device**. A QR code appears
   (valid for 3 minutes, for a single device).
2. On the new device: scan it with the camera (or **Scan a QR code** in the app), or paste the
   invitation link shown under the QR code into **Join** (on the home screen, or in Settings).
   Handy on a computer without a camera, or to send the link remotely through a messaging app.
3. Done: both devices show up in **Settings → Devices**.

![Easy pairing, by QR code or by link: the Mac shows the QR code and its link; the phone scans it, or pastes the link](../images/association-en.png)

You can create more groups (one for family, one for work): they're independent of each other.

## 3. Send

| | How to send |
|---|---|
| Mac, Linux, Windows | **just copy**: whatever you copy is sent on its own, even when no other device is connected, and so is a file copied in the file manager. **File** and **Folder** buttons, or drag a file or a folder onto the window (on a Mac, onto the menu bar icon) |
| Android | **Send clipboard**, **File** (files, or a folder), or **Share → Entre Nous** from any app |
| iPhone | **Send clipboard** (tap "Paste" in the bubble), **File** |
| Browser | Ctrl+V in the page, drag and drop, **File**; **Folder** on a computer |

- **Note**: the text field at the top syncs to every device as you type. **Send** adds it to the
  history and leaves the note in place.
- **Pause** (computers): the ⏸ button or **Pause sharing** in the icon's menu. While paused,
  nothing is read or sent on its own, and anything you copy in the meantime is never sent. To
  send what you just copied anyway: **Send clipboard** (or Cmd/Ctrl+V in the window), just as
  when **Share the clipboard automatically** is turned off in Settings (the ⏸ button then
  disappears).
- **Automatic sharing limit** (a group setting, 1 MB by default): anything larger isn't sent
  on its own; use **File**. Manual sends have no limit.

### Send a folder

A folder goes just like a file: the **Folder** button on a computer, **File → A folder…** in the
Android app, or drag it onto the window (on a Mac, onto the menu bar icon too). It shows up in the
history as a single item, with all its subfolders.

- **More than 10 files or more than 40 MB**: the app first shows you what it holds, and the free
  space on the server; **Send** sends it.
- **Copied in the Finder or Explorer**: a small folder goes on its own, like a file; a larger one
  waits for your OK (a notification tells you).
- **System files** (.DS_Store, Thumbs.db, desktop.ini) are left out. Other hidden files go.
- **Previews**: the sending device makes a preview of every photo, video and PDF; for a large
  folder this takes a few seconds ("Preparing" above the history).
- An iPhone, or a phone's browser, can't pick a folder: it receives them but can't send one (the
  Android app can).

## 4. Receive

- **Mac, Linux, Windows, Android**: whatever arrives goes straight into the clipboard. Just
  paste. A file received on a computer can also be pasted in the file manager.
- **iPhone**: tap **Copy** on the item (iOS doesn't allow writing to the clipboard without a
  user gesture).
- **History**: everything that was shared stays available on every device until it expires:
  **Copy**, **Save**, **Share**, or **Delete** (for everyone: the confirmation reads
  **Delete everywhere**). **Delete all** clears the history and the note.
- **Read receipts**: ticks at the top right of each item. One tick: a device has it; two: all of
  them do (every device of the group but the one that sent it). They change colour once the item is read (opened, copied or saved): the
  first as soon as one device has read it, the second once all of them have. Tap the ticks to see
  where each device stands. The automatic copy to the clipboard doesn't count as a read. In a
  group of two, a received item has none: they would only tell what you did.
- **Pin**: an item's pin keeps it on top of the history on every device, and on top of the
  search results too. It still expires on time, but it isn't deleted when the group keeps a
  limited number of items. If the item is older than those the group keeps, unpinning it deletes
  it: the app asks first.
- **Links**: a text holding a link has an **Open** button, which opens it in the browser.
- **QR code**: the QR code icon of a short text, or of a small text file, shows it as a QR code.
  Handy to give the Wi-Fi password to a guest: they scan it with their phone's camera, with
  nothing to install. The QR code is made on the device: nothing goes through the internet.
- **Upload in progress**: an "↑ name" line above the history shows its progress and speed on
  every device, and disappears when it's done. The item appears right away: you can **Save** it
  before the upload finishes (the download follows the upload), while **Copy** becomes available
  once the upload is complete (the apps then copy it on their own). If nothing is heard from the
  sender for 5 minutes, the item is marked "upload interrupted".
- **Download**: its progress shows in the item, in place of the buttons.

### Previews

A photo, a video, an audio file, a PDF, a text or a Markdown file opens in the app, without saving
it: tap the thumbnail, or **View** (image), **Play** (video), **Listen** (audio), **Open** (PDF,
text, Markdown). The arrows (or a
swipe on a phone, ← → on a keyboard) go from one item to the next; Escape closes.

![A formatted Markdown document on the Mac; a photo preview on the phone](../images/apercus-en.png)

- **In the history, before any download**: a photo's preview, a video's poster and length, an
  audio file's length, a PDF's first page and number of pages, the first words of a text. The sending device makes them and attaches them, encrypted, to the item;
  the server sees none of it. A preview keeps none of the photo's metadata (place, camera); the
  file itself is sent as it is. In "Local network only" mode none of this goes through the
  server: the item shows without a preview.
- **Photo**: you see it full size at once, without downloading it. It is downloaded only when you
  copy or save it. JPEG, PNG, GIF, WebP, AVIF and SVG get a preview from any device; HEIC and TIFF
  photos, when they come from an iPhone or a Mac. A photo the sending device cannot read (a HEIC
  photo sent from Chrome) arrives without a preview: save it to open it.
- **Video**: it plays while it arrives, without being downloaded whole, and you can jump forward
  or back at any time (even while the other device is still sending it). MP4 and MOV (what phones
  record); other formats, or an iPhone older than iOS 17.1, download it first. A format the device
  cannot play (HEVC on some PCs, for instance) offers **Save**.
- **Audio**: it plays while it arrives, without being downloaded whole, and you can jump forward
  or back at any time. MP3, M4A, Opus, FLAC and WAV (8, 16 or 24 bits); other formats (Ogg
  Vorbis, floating-point WAV…) download first, then play if the device can play them.
- **PDF**: its pages scroll, each drawn as it comes on screen; only the parts of the file they need
  are downloaded. **−** and **+** zoom, the percentage goes back to the width of the screen. Its text
  can be selected, and **Copy the selection** copies it; its web links (http, https, mailto) open in
  the browser, its internal links go to their page. JPEG 2000 images, rare, do not show.
- **Watch in picture-in-picture**: the video goes on in a small window above the others.
  - **Mac**: the system's own, which goes on when the Entre Nous window closes; coming back from
    it opens the window again.
  - **Android**: the app becomes the small window, with a play/pause button; leaving the app while
    a video plays does it too (Android 8 and later).
  - **Linux, Windows**: the window shrinks to the video, in the corner of the screen, on top; the
    button at the top left (on hover) brings it back to full size.
  - **Browsers**: Chrome, Edge and Safari (Mac, iPhone).
- **Text**: with line numbers, and **Wrap lines**; up to the first MB of the file (**Save** for the
  rest). **Copy the text** copies what is shown.
- **Markdown**: **Formatted** or **Plain text**. The file comes from another device: any HTML in it
  shows as text, its images are not loaded (they would tell their server who reads the file), and
  only web and e-mail links stay clickable.

![No need to wait for an upload to finish: while the phone is sending a video, the Mac and the PC are already downloading it](../images/envoi-en-cours-en.png)

- **Confirmations**: **Ask before deleting** (a device setting) applies to items and to
  **Clear** on the note; a confirmation button goes back to normal after a few seconds.
- **Notifications** (computers): when the window is closed, "Text from Pixel", never the
  content. Setting: **Notify when something arrives**.
- **Open at login** (computers): the app starts with your session, straight into the menu bar
  or the system tray.
- **New version**: the installed apps announce it ("New version available") with a download
  link; the web app updates itself.

### Received folders

**Browse** opens the folder, one level at a time, without downloading anything. A folder that only
holds photos and videos shows as a grid (**List** to switch back). Tap a file to open it in the
usual preview; the arrows go to the next file of the same folder. You can browse it while it is
still being sent.

- **Download part of it**: tick files or folders in the list (**Select** in the grid), then
  **Download**. With nothing ticked, the bottom button downloads the folder shown; **Download
  all**, in the history or at the top of the folder, takes all of it.
- **Where it goes**: the apps (Mac, Linux, Windows, Android) ask you where to save it and recreate
  the folder as it is; so do Chrome and Edge on a computer. Elsewhere (Firefox, Safari, phone
  browsers), it arrives as a ZIP. A single file is saved as usual.

### Search

The magnifier at the top opens the search (⌘F or Ctrl+F on a computer). Type a few letters: the
history only shows the items holding them, in their text, the file name, the start of a text file
or the device name. Accents and case do not matter. The chips under the field show only one type:
texts, links, images, videos, audio, documents or folders. A folder is found by its name, not by
the files inside it.

On a computer, the arrow keys choose a result and Enter copies it. Escape clears, then closes the
search. Everything happens on the device: the server sees neither what you look for nor the content.

## 5. Share with someone outside the group

To send an item of the history to someone who doesn't have Entre Nous, tap its share icon. A link
and its QR code show up at once, valid for 1 hour. The person opens it in their browser, with no
account and nothing to install: they can read the text, see the photo, watch the video, listen to
the music or download the file.

- **Lifetime**: 10 min, 1 h (default), 24 h or 7 days, to change on the link's page; the link's
  address stays the same. The link keeps working even if the item expires or is deleted from the
  group before it.
- **In the history**: the link shows up, with a dashed border, only on the device that created it:
  **Copy link**, **QR code**, **Delete**. A deleted link stops working at once.
- **End-to-end encrypted**: the key is in the link, after the `#`, and never goes through the
  server. Anyone who has the link can open the item: only send it to whoever should see it.
- **A folder** can be shared the same way: the person browses it in their browser and downloads
  what they want.
- No links with **Local network only**: the content isn't on the server.

### Receive files from someone outside the group

To collect the photos of a party or a colleague's files, tap the **Receive files** icon at the top
of the screen. A link and its QR code show up at once, valid for 24 hours. The person opens it in
their browser, with no account and nothing to install, types their first name if they want, and
picks their files: each one goes as soon as it's picked, and arrives in the history of all your
devices.

- **Message**: optional, shown on the page ("The photos from Saturday").
- **Lifetime**: 1 h, 24 h (default) or 7 days, to change on the link's page; the address stays the same.
- **In the history**: several files sent at once make a folder ("Files from Marie"), a single file
  stays a plain item. They last like the rest of the history.
- **On all your devices**: the request shows at the top of the history, with a dashed border:
  **Copy link**, **QR code**, **Delete**, from any of them. A deleted request receives nothing more;
  what already arrived stays.
- **End-to-end encrypted**: the page encrypts the files before sending them. The link lets people
  send, never read: they see nothing of your history, nor what others sent.
- No requests with **Local network only**: the files go through the server.

## 6. Group settings

Any device in the group can change them:

![Device and group settings on the Mac; the group's devices on the phone](../images/reglages-en.png)

| Setting | Options |
|---|---|
| Keep on the server for | 10 min, 1 h, 24 h (default), 7 days; after that, everything is deleted |
| History size | 1, 10 (default) or unlimited |
| Share automatically up to | 1 MB (default), 10 MB, 100 MB |
| Local network only | content goes straight from one device to another, never through the relay server |

**Direct transfers**: when two devices are on the same network, content goes from one to the
other without the internet, automatically ("· direct to Pixel" is shown). With **Local network
only**, an item is only available while its sender is connected on the same network; once the
setting is turned off, **Send to server** lets you hand it over to the relay, manually.

**Language**: the app follows the language of your system or browser (French or English, and
English for any other language); you can change it in **Settings → Language**.

## 7. Use your own server

In the apps: **Settings → Server → Server address**, then **Change server**.
See [deployment.md](deployment.md) to host a relay server.

## 8. Losing or removing a device

**Settings → Devices → Remove**, from any other device in the group. The encryption keys are
renewed: the removed device loses access to everything you share, history included; the others
keep it. **Leave** does the same for the device you're on. A group left with a single device is
dissolved: the remaining device goes back to having no group.
