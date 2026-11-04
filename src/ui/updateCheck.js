// "New version available": on the real website, check every few minutes (and when the
// tab comes back into view) whether a newer build has been published, and offer a reload.
// The only request it makes is for the site's own small version.json file.
import { BUILD } from '../build.js';

const EVERY_MS = 5 * 60 * 1000;

export function startUpdateCheck({ beforeReload } = {}) {
  const forced = new URLSearchParams(location.search).has('updatecheck'); // for testing anywhere
  if (!forced && !location.hostname.endsWith('github.io')) return null;   // only on the real website
  if (BUILD.commit === 'dev' || BUILD.commit === 'unknown') return null;

  const banner = document.createElement('div');
  banner.className = 'updateBanner hidden';
  banner.innerHTML = '<span>✨ A new version of the game is available.</span><button class="primary updReload">Reload</button><button class="updLater">Later</button>';
  document.body.appendChild(banner);
  let dismissedFor = null, last = 0;
  banner.querySelector('.updLater').onclick = () => { banner.classList.add('hidden'); dismissedFor = banner.dataset.commit; };
  banner.querySelector('.updReload').onclick = () => {
    try { if (beforeReload) beforeReload(); } catch { /* still reload */ }
    location.reload();
  };

  async function check() {
    last = Date.now();
    try {
      const r = await fetch(`./version.json?t=${last}`, { cache: 'no-store' });
      if (!r.ok) return;
      const v = await r.json();
      if (v && v.commit && v.commit !== BUILD.commit && v.commit !== dismissedFor) {
        banner.dataset.commit = v.commit;
        banner.classList.remove('hidden');
      }
    } catch { /* offline or blocked: try again later */ }
  }
  setInterval(check, EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 60000) check(); });
  setTimeout(check, 15000); // shortly after opening too
  return check;
}
