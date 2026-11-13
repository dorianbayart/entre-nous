// Landing page: QR code to open this page on a phone, install help for the visitor's
// device, and the downloads (size, or unavailable).
import qrcode from 'qrcode-generator';

const ua = navigator.userAgent;
const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const android = /Android/.test(ua);
const mac = !ios && /Macintosh/.test(ua);
const windows = /Windows/.test(ua);
const linux = !android && /Linux/.test(ua);
const platform = ios ? 'ios' : android ? 'android' : mac ? 'mac' : windows ? 'windows' : linux ? 'linux' : 'other';
document.documentElement.dataset.platform = platform;
// the visitor's own download comes first; on a known device, the others are hidden
for (const el of document.querySelectorAll(`#${platform}, #${platform}-note`)) el.classList.add('mine');
if (document.getElementById(platform)?.classList.contains('download')) document.documentElement.classList.add('has-app');
document.querySelector<HTMLDetailsElement>(`details[data-platform="${platform}"]`)?.setAttribute('open', '');

const qr = qrcode(0, 'M');
qr.addData(location.origin + '/'); // the phone gets its own download (APK) or the web app
qr.make();
const img = document.getElementById('qr') as HTMLImageElement | null;
if (img) img.src = qr.createDataURL(5, 2);

// Downloads, from the latest release on GitHub: their size (known to the relay, which checks the
// release), or "coming soon" when the release does not have the file yet.
type Release = { version: string; files: Record<string, number> };
fetch('/release.json')
  .then((res) => (res.ok ? (res.json() as Promise<Release>) : null))
  .catch(() => null)
  .then((release) => {
    if (!release) return; // unknown: the links stay as they are
    const version = document.getElementById('version');
    if (version) {
      version.textContent = 'Version ' + release.version;
      version.hidden = false;
    }
    for (const [id, label] of [
      ['mac', 'Appli Mac'],
      ['android', 'Appli Android'],
      ['windows', 'Appli Windows'],
      ['linux', 'Appli Linux'],
    ]) {
      const link = document.getElementById(id) as HTMLAnchorElement | null;
      const note = document.getElementById(id + '-note');
      if (!link || !note) continue;
      const size = release.files[link.href.split('/').pop()!];
      if (!size) {
        link.classList.add('disabled');
        link.removeAttribute('href');
        note.textContent = label + ' bientôt disponible au téléchargement.';
        continue;
      }
      const human = size < 1024 * 1024 ? `${Math.round(size / 1024)} Ko` : `${(size / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
      const slot = note.querySelector('.size'); // where the size goes, when not at the end
      if (slot) slot.textContent = ' · ' + human;
      else note.append(' · ' + human);
    }
  });
