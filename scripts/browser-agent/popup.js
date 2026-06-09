chrome.storage.local.get(['status', 'connectedAt'], (data) => {
  const statusEl = document.getElementById('status');
  const dotEl    = document.getElementById('dot');
  const textEl   = document.getElementById('statusText');
  const infoEl   = document.getElementById('info');

  if (data.status === 'connected') {
    statusEl.className = 'badge connected';
    dotEl.className    = 'dot dot-green';
    textEl.textContent = 'متصل بالسيرفر ✓';
    if (data.connectedAt) {
      const d = new Date(data.connectedAt);
      infoEl.textContent = 'متصل منذ: ' + d.toLocaleTimeString('ar-EG');
    }
  } else {
    statusEl.className = 'badge disconnected';
    dotEl.className    = 'dot dot-amber';
    textEl.textContent = 'غير متصل — يحاول الاتصال...';
    infoEl.textContent = 'تأكد من اتصالك بالإنترنت وأن السيرفر يعمل.';
  }
});
