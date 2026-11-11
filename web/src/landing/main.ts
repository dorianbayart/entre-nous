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

// Downloads: their size, or "coming soon" when the file is not on the relay
for (const [id, label] of [
  ['mac', 'Appli Mac'],
  ['android', 'Appli Android'],
  ['windows', 'Appli Windows'],
  ['linux', 'Appli Linux'],
]) {
  const link = document.getElementById(id) as HTMLAnchorElement | null;
  const note = document.getElementById(id + '-note');
  if (!link || !note) continue;
  fetch(link.href, { method: 'HEAD' })
    .then((res) => {
      if (!res.ok) throw new Error();
      const size = Number(res.headers.get('Content-Length') || 0);
      if (!size) return;
      const human = size < 1024 * 1024 ? `${Math.round(size / 1024)} Ko` : `${(size / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
      const slot = note.querySelector('.size'); // where the size goes, when not at the end
      if (slot) slot.textContent = ' · ' + human;
      else note.append(' · ' + human);
    })
    .catch(() => {
      link.classList.add('disabled');
      link.removeAttribute('href');
      note.textContent = label + ' bientôt disponible au téléchargement.';
    });
}
