const enabled = document.getElementById('enabled');
const siteOn = document.getElementById('siteOn');
const siteLabel = document.getElementById('site');

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch {}
  siteLabel.textContent = host || 'Not available on this page';
  siteOn.disabled = !host;

  const { enabled: on = true, disabledSites = [] } = await chrome.storage.sync.get(['enabled', 'disabledSites']);
  enabled.checked = on;
  siteOn.checked = !disabledSites.includes(host);

  enabled.addEventListener('change', () => chrome.storage.sync.set({ enabled: enabled.checked }));
  siteOn.addEventListener('change', async () => {
    const { disabledSites = [] } = await chrome.storage.sync.get('disabledSites');
    const next = disabledSites.filter((h) => h !== host);
    if (!siteOn.checked) next.push(host);
    await chrome.storage.sync.set({ disabledSites: next });
  });
})();
