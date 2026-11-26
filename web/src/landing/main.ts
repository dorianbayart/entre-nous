// Landing page: QR code to open this page on a phone, install help for the visitor's
// device, and the downloads (size, or unavailable).
import qrcode from 'qrcode-generator';

// the page is French (/, /fr/) or English (/en/): its few texts written from here follow it
const en = document.documentElement.lang === 'en';

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

// Donations: how far they are from their monthly goal (Liberapay, asked by the relay); shown only
// once a goal is set.
type Funding = { receiving: number; goal: number | null; currency: string };
fetch('/funding.json')
  .then((res) => (res.ok ? (res.json() as Promise<Funding>) : null))
  .catch(() => null)
  .then((f) => {
    const box = document.getElementById('funding');
    if (!box || !f || !f.goal) return;
    const pct = Math.min(100, Math.round((f.receiving / f.goal) * 100));
    const money = (n: number) =>
      new Intl.NumberFormat(en ? 'en' : 'fr', { style: 'currency', currency: f.currency, maximumFractionDigits: 0 }).format(n);
    (box.querySelector('.meter span') as HTMLElement).style.width = pct + '%';
    box.querySelector('.note')!.textContent =
      pct >= 100
        ? en
          ? `Goal reached (${money(f.goal)} a month), thank you!`
          : `Objectif atteint (${money(f.goal)} par mois), merci !`
        : en
          ? `${pct}% of the goal: ${money(f.receiving)} of ${money(f.goal)} a month.`
          : `${pct} % de l'objectif : ${money(f.receiving)} sur ${money(f.goal)} par mois.`;
    box.hidden = false;
  });

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
      ['mac', 'Mac'],
      ['android', 'Android'],
      ['windows', 'Windows'],
      ['linux', 'Linux'],
    ]) {
      const link = document.getElementById(id) as HTMLAnchorElement | null;
      const note = document.getElementById(id + '-note');
      if (!link || !note) continue;
      const size = release.files[link.href.split('/').pop()!];
      if (!size) {
        link.classList.add('disabled');
        link.removeAttribute('href');
        note.textContent = en ? `${label} app available for download soon.` : `Appli ${label} bientôt disponible au téléchargement.`;
        continue;
      }
      const mb = (size / 1024 / 1024).toFixed(1);
      const human = size < 1024 * 1024 ? `${Math.round(size / 1024)} ${en ? 'KB' : 'Ko'}` : en ? `${mb} MB` : `${mb.replace('.', ',')} Mo`;
      const slot = note.querySelector('.size'); // where the size goes, when not at the end
      if (slot) slot.textContent = ' · ' + human;
      else note.append(' · ' + human);
    }
  });
